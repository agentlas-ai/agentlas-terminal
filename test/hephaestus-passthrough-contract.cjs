"use strict";
/*
 * hephaestus-passthrough-contract — 오프라인 계약 테스트.
 *
 * 검증하는 계약 (v1 legacy-v1-engine-snapshot 디스패처 매핑):
 *   1. `hep` 패스스루가 인자를 토씨 그대로(verbatim) 자식에 전달한다.
 *   2. 1급 별칭 매핑: build→hep-build, connect→hep-connect, call→hep-call,
 *      browser→hep-browser, legacy-network→hep-network, netadmin→network,
 *      journal→stormbreaker journal, route→route <q> --project <cwd> --runtime terminal.
 *   3. 런타임 부재 = 정직 정지: exit 1 + v1 안내 문구가 stderr에 나온다. 폴백 없음.
 *   4. v1 인자 가드: 무인자 build/call/legacy-network·빈 route·잘못된 research
 *      서브커맨드는 usage 실패 exit 1 (라우터 오라우팅 방지).
 *
 * 네트워크·실제 Hephaestus 불필요: HEPHAESTUS_BIN을 argv를 파일로 에코하는
 * 가짜 실행 파일로 지정한다.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hep-contract-"));
const userData = path.join(tmp, "userdata");
const emptyHome = path.join(tmp, "empty-home");
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(emptyHome, { recursive: true });

// runCwd 샌드박스가 실제 userData를 건드리지 않도록 격리 (require 전에 설정).
process.env.AGENTLAS_USER_DATA_DIR = userData;

// 가짜 Hephaestus: 받은 argv를 한 줄에 하나씩 $FAKE_ARGV_OUT에 기록하고 exit 0.
const fakeBin = path.join(tmp, "fake-hephaestus");
fs.writeFileSync(
  fakeBin,
  '#!/bin/sh\n: > "$FAKE_ARGV_OUT"\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$FAKE_ARGV_OUT"; done\nexit 0\n',
);
fs.chmodSync(fakeBin, 0o755);

const runtimeMod = require("../engine/hephaestus/runtime.cjs");

function makeCtx() {
  const outLines = [];
  const errLines = [];
  return {
    lang: "en",
    out: (s = "") => outLines.push(String(s)),
    err: (s = "") => errLines.push(String(s)),
    outLines,
    errLines,
  };
}

let argvFileSeq = 0;
async function runWithFake(commandFile, args, ctx = makeCtx()) {
  const argvFile = path.join(tmp, `argv-${argvFileSeq++}.txt`);
  process.env.HEPHAESTUS_BIN = fakeBin;
  process.env.FAKE_ARGV_OUT = argvFile;
  const code = await require(`../engine/commands/${commandFile}`).run(ctx, args);
  const forwarded = fs.existsSync(argvFile)
    ? fs.readFileSync(argvFile, "utf8").split("\n").filter((line, i, all) => i < all.length - 1 || line !== "")
    : null;
  return { code, forwarded, ctx };
}

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`FAIL  ${name}\n      ${String((error && error.message) || error)}\n`);
  }
}

(async () => {
  // 1) hep 패스스루 — 인자 토씨 그대로 (공백 포함 인자 보존)
  await check("hep forwards args verbatim", async () => {
    const args = ["wizard", "--fancy", "hello world", "--limit", "3"];
    const { code, forwarded } = await runWithFake("hep.cjs", args);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(forwarded, args);
  });

  // 2) hep 무인자 → HEP_USAGE, exit 0, 자식 스폰 없음
  await check("hep with no args prints HEP_USAGE without spawning", async () => {
    const { code, forwarded, ctx } = await runWithFake("hep.cjs", []);
    assert.strictEqual(code, 0);
    assert.strictEqual(forwarded, null);
    assert.ok(ctx.outLines.join("\n").includes("네이티브 패스스루"));
  });

  // 3) build → hep-build "<request>"
  await check("build maps to hep-build with the request", async () => {
    const { code, forwarded } = await runWithFake("build.cjs", ["make me a code review agent"]);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(forwarded, ["hep-build", "make me a code review agent"]);
  });

  // 4) 나머지 1급 별칭 매핑 (v1 디스패처와 동일)
  await check("alias commands map to their v1 hep routes", async () => {
    const cases = [
      ["connect.cjs", ["telegram"], ["hep-connect", "telegram"]],
      ["call.cjs", ["seo,writer", "launch context"], ["hep-call", "seo,writer", "launch context"]],
      ["browser.cjs", ["https://example.com"], ["hep-browser", "https://example.com"]],
      ["legacy-network.cjs", ["ship the landing page"], ["hep-network", "ship the landing page"]],
      ["netadmin.cjs", ["status"], ["network", "status"]],
      ["journal.cjs", ["verify", "--run-id", "r-1"], ["stormbreaker", "journal", "verify", "--run-id", "r-1"]],
    ];
    for (const [file, args, expected] of cases) {
      const { code, forwarded } = await runWithFake(file, args);
      assert.strictEqual(code, 0, `${file} exit code`);
      assert.deepStrictEqual(forwarded, expected, `${file} forwarded argv`);
    }
  });

  // 5) route --json — v1: --json은 raw 모드 스위치로 소비되고 네이티브 호출은
  //    route <query> --project <projectCwd> --runtime terminal 이다.
  await check("route --json maps to the v1 route argv shape", async () => {
    const ctx = makeCtx();
    const { code, forwarded } = await runWithFake("route.cjs", ["ship", "my app", "--json"], ctx);
    assert.strictEqual(code, 0);
    const projectCwd = runtimeMod.create(ctx).projectCwd();
    assert.deepStrictEqual(forwarded, ["route", "ship my app", "--project", projectCwd, "--runtime", "terminal"]);
  });

  // 6) v1 인자 가드 — usage 실패 exit 1 (오라우팅 방지)
  await check("v1 argument guards fail closed with usage", async () => {
    const guards = [
      ["build.cjs", []],
      ["call.cjs", []],
      ["legacy-network.cjs", []],
      ["route.cjs", ["--json"]],
      ["research.cjs", ["everything about penguins"]],
      ["netadmin.cjs", ["nuke"]],
      ["journal.cjs", ["status"]],
    ];
    for (const [file, args] of guards) {
      const ctx = makeCtx();
      const code = await require(`../engine/commands/${file}`).run(ctx, args);
      assert.strictEqual(code, 1, `${file} guard exit code`);
      assert.ok(ctx.errLines.join("\n").includes("usage:"), `${file} guard usage on stderr`);
    }
  });

  // 7) 런타임 부재 = 정직 정지 (exit 1 + v1 안내 문구, 폴백 없음).
  //    env를 비우고 HOME을 빈 임시 폴더로 돌려 bin 후보 사다리를 실경로로
  //    실패시킨다. 이 머신에는 /Applications/Agentlas.app 번들이 실제로
  //    설치되어 있어 env만으로는 Core python 폴백을 비울 수 없으므로, darwin
  //    머신 전역 후보만 DI 이음새(resolveCoreRuntimeRoot → null)로 비운다 —
  //    v1도 create(deps) 주입 팩토리였고, 검증 대상 계약은 "부재 → 정직
  //    정지 메시지"다.
  await check("missing runtime is an honest stop (exit 1 + guidance)", async () => {
    const saved = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      HEPHAESTUS_BIN: process.env.HEPHAESTUS_BIN,
      HEPHAESTUS_RUNTIME_ROOT: process.env.HEPHAESTUS_RUNTIME_ROOT,
      HEPHAESTUS_CAREER_GRAPH_BIN: process.env.HEPHAESTUS_CAREER_GRAPH_BIN,
    };
    delete process.env.HEPHAESTUS_BIN;
    delete process.env.HEPHAESTUS_RUNTIME_ROOT;
    delete process.env.HEPHAESTUS_CAREER_GRAPH_BIN;
    process.env.HOME = emptyHome;
    process.env.PATH = "/usr/bin:/bin";
    let stderrText = "";
    const realWrite = process.stderr.write;
    process.stderr.write = (chunk) => { stderrText += String(chunk); return true; };
    let code;
    try {
      const runtime = runtimeMod.create(makeCtx(), { resolveCoreRuntimeRoot: () => null });
      assert.strictEqual(runtime.hephaestusBin(), null, "discovery must find nothing");
      code = await runtime.runHephaestusInteractive(["wizard"]);
    } finally {
      process.stderr.write = realWrite;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.strictEqual(code, 1);
    assert.ok(stderrText.includes("Hephaestus 런타임이 없습니다"), "honest-stop message");
    assert.ok(stderrText.includes("설치: https://agentlas.cloud"), "install guidance");
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length) {
    process.stdout.write(`hephaestus-passthrough-contract: ${failures.length} FAILED\n`);
    process.exit(1);
  }
  process.stdout.write("hephaestus-passthrough-contract: PASS\n");
})().catch((error) => {
  process.stdout.write(`hephaestus-passthrough-contract: CRASH ${String((error && error.stack) || error)}\n`);
  process.exit(1);
});
