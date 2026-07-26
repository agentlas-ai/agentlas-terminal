#!/usr/bin/env node
"use strict";
/*
 * Hub 에이전트 설치 계약 테스트 (오프라인 — 네트워크 없이 callTool 주입).
 *
 * 검증 계약:
 *  1. call_only Hub 자산은 소스 설치 정직 거절 (로컬 위장 설치 금지, DB 무변화).
 *  2. 신규 설치 → installed_agents 행 + entity_kind + materialize된 파일.
 *  3. 재설치 멱등 — 같은 slug는 UPDATE(중복 행 금지), 파일은 새 스냅샷으로 교체.
 *  4. 저널 롤백 — materialize(디스크 스왑)까지 성공한 뒤 DB 커밋이 실패하면
 *     restore.rollback()이 이전 파일 스냅샷을 복원하고 저널/스테이징/백업을 남기지
 *     않는다 (DB 행과 파일이 함께 커밋/롤백되는 crash-recovery 계약).
 *  5. 무결성 실패(파일 sha 불일치)는 스테이징 단계에서 거절 — 기존 설치 무손상.
 *  6. 크래시 저널(prepared) 복구 — recoverCloudInstallJournals가 스테이징/저널을
 *     치우고 destination을 보존한다.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

// 반드시 모듈 require 전에 격리된 userData를 잡는다 (공유 실DB 오염 금지).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-hub-install-test-"));
process.env.AGENTLAS_USER_DATA_DIR = tmpRoot;

const { bootstrapDbIfMissing } = require("../bin/agentlas.cjs");
const { openDb } = require("../engine/core/db.cjs");
const {
  installHubAgent,
  cloudHashPackage,
  recoverCloudInstallJournals,
  writeCloudInstallJournal,
} = require("../engine/hub/install.cjs");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** 테스트 픽스처: v1 해시(path-sha256-v1) 클라우드 패키지 리스팅 생성. */
function makeListing(slug, { entryText, extraFiles = [], delivery } = {}) {
  const files = [
    { path: "AGENTS.md", text: entryText || `# ${slug}\nYou are a test hub agent.` },
    ...extraFiles,
  ].map((f) => {
    const bytes = Buffer.from(f.text, "utf8");
    return {
      path: f.path,
      bytes: bytes.length,
      sha256: f.sha256 || sha256(bytes),
      contentBase64: bytes.toString("base64"),
    };
  });
  const totalBytes = files.reduce((n, f) => n + Buffer.from(f.contentBase64, "base64").length, 0);
  return {
    slug,
    name: `Test ${slug}`,
    nameEn: `Test ${slug}`,
    tagline: "contract fixture",
    taglineEn: "contract fixture",
    trustGrade: "A",
    visibility: "visible",
    ...(delivery ? { delivery } : {}),
    cloudPackage: {
      packageHash: cloudHashPackage(files),
      fileCount: files.length,
      totalBytes,
      files,
    },
  };
}

const fakeCallTool = (listingBySlug) => async (name, args) => {
  assert.equal(name, "marketplace.get_manifest");
  assert.equal(args.kind, "agent");
  return listingBySlug[args.slug] || null;
};

async function main() {
  const boot = bootstrapDbIfMissing();
  assert.ok(boot.created, "fresh AGENTLAS_USER_DATA_DIR must bootstrap a new DB");
  const db = openDb();
  const installRoot = path.join(tmpRoot, "cloud-agent-installs");

  // ── 0. 미지 slug → 정직한 not found ──
  await assert.rejects(
    () => installHubAgent(db, "no-such-agent", { callTool: fakeCallTool({}) }),
    /Hub agent not found: no-such-agent/,
  );

  // ── 1. call_only 자산은 설치 거절 + DB 무변화 ──
  await assert.rejects(
    () => installHubAgent(db, "call-only-agent", {
      callTool: fakeCallTool({ "call-only-agent": { slug: "call-only-agent", name: "Call Only", delivery: { mode: "call_only" } } }),
    }),
    /call-only and cannot be installed from source.*agentlas call call-only-agent/s,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM installed_agents WHERE slug='call-only-agent'").get().n, 0,
    "call_only refusal must not insert a row",
  );

  // ── 2. 신규 설치: 행 + entity_kind + materialize ──
  const v1 = makeListing("contract-agent", { entryText: "# v1\nfirst version body" });
  const installed = await installHubAgent(db, "contract-agent", {
    callTool: fakeCallTool({ "contract-agent": v1 }),
  });
  assert.equal(installed.slug, "contract-agent");
  assert.equal(installed.localPath, path.join(installRoot, "contract-agent"));
  const row1 = db.prepare("SELECT * FROM installed_agents WHERE slug='contract-agent'").get();
  assert.ok(row1, "fresh install must insert an installed_agents row");
  assert.equal(row1.name, "Test contract-agent");
  assert.equal(row1.entity_kind, "agent", "entity_kind must be recorded (team body-veto contract)");
  assert.equal(row1.trust_grade, "A");
  const agentsMd = path.join(installRoot, "contract-agent", "AGENTS.md");
  assert.match(fs.readFileSync(agentsMd, "utf8"), /first version body/);
  assert.match(row1.system_prompt, /IMMUTABLE CLOUD AGENT ROOT/, "package entry must drive the system prompt");
  assert.ok(
    fs.existsSync(path.join(installRoot, "contract-agent", ".agentlas-cloud-package.json")),
    "restore marker must exist",
  );
  assert.ok(
    !fs.existsSync(path.join(installRoot, ".contract-agent.install-journal.json")),
    "successful install must clear its journal",
  );

  // ── 2b. 팀 마커가 있으면 entity_kind=team (detectKind 승계) ──
  const team = makeListing("contract-team", {
    entryText: "# team\nceo brain",
    extraFiles: [{ path: "TEAM.md", text: "team marker" }],
  });
  await installHubAgent(db, "contract-team", { callTool: fakeCallTool({ "contract-team": team }) });
  assert.equal(
    db.prepare("SELECT entity_kind FROM installed_agents WHERE slug='contract-team'").get().entity_kind,
    "team",
  );

  // ── 3. 재설치 멱등: 같은 slug UPDATE, 중복 행 없음, 파일 스냅샷 교체 ──
  const v2 = makeListing("contract-agent", {
    entryText: "# v2\nsecond version body",
    extraFiles: [{ path: "docs/notes.md", text: "extra file in v2" }],
  });
  v2.name = "Test contract-agent v2";
  const re = await installHubAgent(db, "contract-agent", { callTool: fakeCallTool({ "contract-agent": v2 }) });
  assert.equal(re.slug, "contract-agent");
  const rows = db.prepare("SELECT * FROM installed_agents WHERE slug='contract-agent'").all();
  assert.equal(rows.length, 1, "reinstall must not duplicate the slug row");
  assert.equal(rows[0].id, row1.id, "reinstall must keep the same agent id");
  assert.equal(rows[0].name, "Test contract-agent v2", "reinstall must update the row");
  assert.match(fs.readFileSync(agentsMd, "utf8"), /second version body/);
  assert.ok(fs.existsSync(path.join(installRoot, "contract-agent", "docs", "notes.md")));

  // ── 4. 저널 롤백: 디스크 스왑 후 DB 커밋 실패 → 파일/DB 모두 이전 상태로 ──
  const v3 = makeListing("contract-agent", { entryText: "# v3\nmust never survive" });
  // UPDATE installed_agents 문장만 폭파하는 사보타주 DB 래퍼 — materialize는 성공하고
  // runWriteTransaction 내부 mutate가 실패하는 crash 창을 재현한다.
  const sabotage = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql) => {
          if (/^UPDATE installed_agents SET name=/.test(sql)) {
            throw new Error("forced-db-failure");
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(
    () => installHubAgent(sabotage, "contract-agent", { callTool: fakeCallTool({ "contract-agent": v3 }) }),
    /forced-db-failure/,
  );
  const rowAfter = db.prepare("SELECT * FROM installed_agents WHERE slug='contract-agent'").get();
  assert.equal(rowAfter.name, "Test contract-agent v2", "failed commit must leave the previous DB row");
  assert.equal(rowAfter.installed_at, rows[0].installed_at, "failed commit must not advance installed_at");
  assert.match(fs.readFileSync(agentsMd, "utf8"), /second version body/, "rollback must restore the previous file snapshot");
  assert.ok(fs.existsSync(path.join(installRoot, "contract-agent", "docs", "notes.md")), "rollback must restore all previous files");
  const leftovers = fs.readdirSync(installRoot).filter((n) => n.startsWith(".contract-agent."));
  assert.deepEqual(leftovers, [], `rollback must clear journal/staging/backup, saw: ${leftovers.join(", ")}`);

  // ── 5. 무결성 실패(sha 불일치)는 스테이징에서 거절 — 기존 설치 무손상 ──
  const corrupt = makeListing("contract-agent", { entryText: "# corrupt\nbad bytes" });
  corrupt.cloudPackage.files[0].sha256 = "0".repeat(64);
  await assert.rejects(
    () => installHubAgent(db, "contract-agent", { callTool: fakeCallTool({ "contract-agent": corrupt }) }),
    /file integrity failed/,
  );
  assert.match(fs.readFileSync(agentsMd, "utf8"), /second version body/, "corrupt package must not touch the live install");
  assert.deepEqual(
    fs.readdirSync(installRoot).filter((n) => n.startsWith(".contract-agent.")), [],
    "corrupt package must leave no journal/staging",
  );

  // ── 6. 크래시 저널(prepared) 복구: 스테이징/저널 제거, destination 보존 ──
  const staging = path.join(installRoot, ".contract-agent.installing-crash");
  const backup = path.join(installRoot, ".contract-agent.backup-crash");
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(staging, "half-written.md"), "crash leftovers", { mode: 0o600 });
  writeCloudInstallJournal(path.join(installRoot, ".contract-agent.install-journal.json"), {
    schemaVersion: 1,
    slug: "contract-agent",
    phase: "prepared",
    destination: path.join(installRoot, "contract-agent"),
    staging,
    backup,
    hadExisting: true,
    dbExpected: { slug: "contract-agent" },
  });
  const recovered = recoverCloudInstallJournals(db);
  assert.equal(recovered, 1);
  assert.ok(!fs.existsSync(staging), "prepared-journal recovery must remove the staging dir");
  assert.ok(!fs.existsSync(path.join(installRoot, ".contract-agent.install-journal.json")));
  assert.match(fs.readFileSync(agentsMd, "utf8"), /second version body/, "recovery must keep the committed install");

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log("hub-install-contract: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
