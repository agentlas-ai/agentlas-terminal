"use strict";
/*
 * creds — 프로젝트 자격증명 저장 (v1 cmdCreds/cmdCredsFile 11210–11368 포팅).
 *
 * 계약:
 *  - 값은 .env / credentials.env(0600) / (Electron 한정) keychain vault 에만 저장.
 *    soul memory와 local-credentials.map.json 에는 사실(env 이름·상대경로)만 남긴다.
 *  - keytar는 Electron 런타임에서만 사용한다. standalone Node에서 서명 없는
 *    keytar 호출은 macOS 키체인에 막혀 무한 대기하고 process.exit로도 안 죽는다
 *    (v1 실사고) — 절대 우회하지 않는다.
 *  - 비밀 값은 어떤 경로로도 stdout/stderr에 출력하지 않는다.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");
const { loadArch } = require("../core/db.cjs");
const { activeProjectPath } = require("../project/state.cjs");
const { upsertEnvLine } = require("../project/env-file.cjs");
const {
  localCredentialConfigCli,
  ensureLocalCredentialStoreCli,
  ensureSoulCredentialIndexCli,
  upsertLocalCredentialMapCli,
  projectScopedGlobalEnvKeyCli,
  safeCredentialDestRelCli,
} = require("../project/credentials.cjs");

// 데스크탑과 공유하는 키체인 서비스/키 접두어 (v1 상수 그대로).
const SERVICE = "com.agentlas.desktop";
const ENV_PREFIX = "env:";

function isElectronRuntime() {
  return !!(process.versions && process.versions.electron);
}
function readKeytar() {
  try {
    return require("keytar");
  } catch {
    return null;
  }
}

function parseCredFlags(args) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        f[a.slice(2)] = next;
        i++;
      } else {
        f[a.slice(2)] = true;
      }
    }
  }
  return f;
}

// `agentlas creds file`은 일반 CLI 명령이므로 상대경로 기준은 사용자가 명령을 실행한
// 셸 cwd다. 런타임 격리용 agent-cwd를 쓰면 실제 프로젝트 파일을 조용히 못 찾는다.
function resolveCredentialSourcePath(source, cwd) {
  return path.resolve(cwd || process.cwd(), source);
}

async function cmdCredsFile(ctx, args) {
  const fail = (msg) => { ctx.err(msg); return 1; };
  const f = parseCredFlags(args);
  const source = typeof f.source === "string" ? f.source : typeof f.path === "string" ? f.path : "";
  if (!source) return fail("usage: agentlas creds file --source <path> [--provider <name>] [--env <ENV_NAME>] [--dest <relative-path>] [--project <path>] [--force]");
  const project = typeof f.project === "string" && f.project ? f.project : activeProjectPath(ctx.db());
  if (!project) return fail("creds file requires a project path");
  const provider = typeof f.provider === "string" && f.provider ? f.provider : "credential_file";
  const envKey = typeof f.env === "string" && f.env ? f.env.trim() : "";
  if (envKey && !/^[A-Z][A-Z0-9_]*$/.test(envKey)) return fail("credential env name must look like ENV_NAME");

  const arch = loadArch();
  const cfg = localCredentialConfigCli(arch);
  const projectName = path.basename(project) || "Project";
  ensureLocalCredentialStoreCli(project, projectName, arch);
  ensureSoulCredentialIndexCli(project, projectName, arch);

  const sourceAbs = resolveCredentialSourcePath(source);
  let stat;
  try { stat = fs.statSync(sourceAbs); } catch { return fail(`credential source not found: ${source}`); }
  if (!stat.isFile()) return fail(`credential source is not a file: ${source}`);

  const base = path.basename(sourceAbs);
  const lower = base.toLowerCase();
  const defaultDir = lower.includes("google-services") || lower.includes("googleservice-info")
    ? cfg.credentialsDir
    : cfg.signingDir;
  let destRel;
  try {
    destRel = safeCredentialDestRelCli(
      typeof f.dest === "string" && f.dest ? f.dest : path.join(defaultDir, base),
    );
  } catch (e) {
    return fail(String((e && e.message) || e));
  }
  const destAbs = path.join(project, destRel);
  if (!path.resolve(destAbs).startsWith(path.resolve(project) + path.sep)) {
    return fail("credential destination must stay inside the project");
  }
  if (fs.existsSync(destAbs) && !f.force) return fail(`credential destination already exists: ${destRel} (use --force to replace)`);

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(sourceAbs, destAbs);
  try { fs.chmodSync(destAbs, 0o600); } catch { /* best-effort */ }

  const targets = [destRel];
  if (envKey) {
    try { upsertEnvLine(path.join(project, ".env"), envKey, destRel); targets.push("project .env"); }
    catch (e) { ctx.err(".env write failed: " + e.message); }
    const scopedKey = projectScopedGlobalEnvKeyCli(project, envKey);
    try { upsertEnvLine(path.join(userDataDir(), "credentials.env"), scopedKey, destAbs); targets.push("global project env"); } catch { /* best-effort */ }
    try { upsertEnvLine(path.join(os.homedir(), ".agentlas", "credentials.env"), scopedKey, destAbs); } catch { /* best-effort */ }
  }

  upsertLocalCredentialMapCli(project, projectName, arch, {
    id: typeof f.id === "string" && f.id ? f.id : `${provider}:${envKey || destRel}`,
    provider,
    env: envKey ? [envKey] : [],
    localFiles: [destRel],
    owner: "project",
    valueMaterialized: true,
    storage: envKey ? ["project_file", "project_env", "global_project_env"] : ["project_file"],
    requiredFor: typeof f.requiredFor === "string" && f.requiredFor ? [f.requiredFor] : [],
    staleCheck: typeof f.staleCheck === "string" && f.staleCheck ? f.staleCheck : "Validate access before release or deploy.",
  });

  ctx.out(`✓ saved credential file for ${provider} — ${targets.join(", ")}.`);
  return 0;
}

/** KEY=value 파일에서 KEY 이름만 뽑는다 — 값은 절대 읽어 돌려주지 않는다. */
function envKeyNames(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/))
      .filter(Boolean)
      .map((m) => m[1]);
  } catch {
    return null; // 파일 없음/읽기 불가 — 목록에서 침묵이 아니라 부재로 표시
  }
}

/*
 * creds list — 어떤 자격증명 "이름"이 어디에 저장돼 있는지.
 * 배경(2026-08-05 감사, 결함 H): save/file만 있어 저장한 것을 확인할 방법이
 * 없었다. 계약은 상단과 동일 — 값은 어떤 경로로도 출력하지 않는다. 키 이름과
 * 저장 위치까지만. (키체인 vault는 standalone에서 keytar를 부르면 무한 대기하는
 * v1 실사고가 있어 조회조차 하지 않는다 — 부재가 아니라 "미조회"로 표시.)
 */
function cmdCredsList(ctx) {
  const ko = ctx.lang !== "en";
  const project = activeProjectPath(ctx.db());
  const stores = [];
  if (project) stores.push({ label: (ko ? "프로젝트 .env — " : "project .env — ") + path.join(project, ".env"), keys: envKeyNames(path.join(project, ".env")) });
  stores.push({ label: (ko ? "전역 credentials.env — " : "global credentials.env — ") + path.join(userDataDir(), "credentials.env"), keys: envKeyNames(path.join(userDataDir(), "credentials.env")) });
  stores.push({ label: "~/.agentlas/credentials.env", keys: envKeyNames(path.join(os.homedir(), ".agentlas", "credentials.env")) });

  let any = false;
  for (const store of stores) {
    if (store.keys === null) continue; // 파일 자체가 없으면 줄을 만들지 않는다
    any = true;
    ctx.out(ctx.ui.bold(store.label));
    if (!store.keys.length) ctx.out(ctx.ui.dim(ko ? "  (비어 있음)" : "  (empty)"));
    for (const key of store.keys) ctx.out(`  ${key}${ctx.ui.dim("=•••")}`);
  }
  if (isElectronRuntime()) {
    ctx.out(ctx.ui.dim(ko ? "키체인 vault: 데스크탑에서 확인" : "keychain vault: inspect in Desktop"));
  } else {
    ctx.out(ctx.ui.dim(ko
      ? "키체인 vault는 standalone 터미널에서 조회하지 않습니다(서명 없는 keytar 호출은 키체인에 막혀 멈춥니다)."
      : "The keychain vault is not queried from the standalone terminal (unsigned keytar calls hang on the OS keychain)."));
  }
  if (!any) ctx.out(ko ? "저장된 자격증명 파일이 없습니다. agentlas creds save 로 추가하세요." : "No credential files yet. Add one with: agentlas creds save");
  return 0;
}

async function run(ctx, args) {
  const fail = (msg) => { ctx.err(msg); return 1; };
  const sub = args[0];
  if (sub === "file") return cmdCredsFile(ctx, args.slice(1));
  if (sub === "list" || sub === "ls") return cmdCredsList(ctx);
  if (sub !== "save") {
    return fail('usage: agentlas creds save --provider <name> --key <ENV_NAME> --value <value> [--project <path>] OR agentlas creds file --source <path> [--env <ENV_NAME>] OR agentlas creds list');
  }
  const f = parseCredFlags(args.slice(1));
  const key = typeof f.key === "string" ? f.key.trim() : "";
  let value = f.value === undefined || f.value === true ? "" : String(f.value);
  /*
   * 비밀은 argv에 실리면 안 된다(clig.dev: never read secrets from flags) —
   * 셸 히스토리와 `ps` 출력에 평문으로 남는다. `--value -` 는 stdin에서 읽는다:
   *   printf '%s' "$SECRET" | agentlas creds save --key X --value -
   * argv로 직접 준 경우는 기존 사용을 깨지 않되, 노출 사실을 그 자리에서 알린다.
   */
  if (value === "-") {
    value = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
    if (!value) return fail("creds save --value - expected the secret on stdin, but stdin was empty");
  } else if (value) {
    ctx.err(ctx.lang === "ko"
      ? "참고: --value 로 준 비밀은 셸 히스토리·ps 에 남습니다. 다음부터는 stdin 을 쓰세요: printf '%s' \"$SECRET\" | agentlas creds save --key X --value -"
      : "Note: a secret passed via --value lands in shell history and `ps`. Prefer stdin next time: printf '%s' \"$SECRET\" | agentlas creds save --key X --value -");
  }
  if (!key || !value) return fail("creds save requires --key and --value (use `--value -` to read the secret from stdin)");
  const provider = typeof f.provider === "string" && f.provider ? f.provider : key;
  const project = typeof f.project === "string" && f.project ? f.project : activeProjectPath(ctx.db());
  const targets = [];
  const arch = loadArch();
  const projectName = project ? path.basename(project) || "Project" : "Project";
  if (project) {
    ensureLocalCredentialStoreCli(project, projectName, arch);
    ensureSoulCredentialIndexCli(project, projectName, arch);
  }

  // 1) keychain vault — project-scoped when a project is active.
  // standalone(비-Electron)에서는 키체인 쓰기가 프롬프트로 멈출 수 있어 건너뛴다;
  // 값은 아래 .env/credentials.env 파일에 저장되므로 런타임 주입에 지장 없다.
  const keytar = isElectronRuntime() ? readKeytar() : null;
  if (keytar) {
    const vaultKey = project ? projectScopedGlobalEnvKeyCli(project, key) : key;
    try { await keytar.setPassword(SERVICE, ENV_PREFIX + vaultKey, value); targets.push(project ? "project vault" : "vault"); }
    catch (e) { ctx.err("vault save failed: " + e.message); }
  }
  // 2) 프로젝트 .env (평문)
  if (project) {
    try { upsertEnvLine(path.join(project, ".env"), key, value); targets.push("project .env"); }
    catch (e) { ctx.err(".env write failed: " + e.message); }
    // 3) 프로젝트 메모리 노트 (.agentlas/project-soul-memory.md) — 값 자체는 .env/vault에, 여기엔 사실만
    try {
      const soulDir = path.join(project, ".agentlas");
      fs.mkdirSync(soulDir, { recursive: true });
      fs.appendFileSync(
        path.join(soulDir, "project-soul-memory.md"),
        `\n- Connected ${provider}: ${key} saved in local credential store during first setup.\n`,
        "utf8",
      );
    } catch { /* best-effort */ }
    try {
      upsertLocalCredentialMapCli(project, projectName, arch, {
        id: `${provider}:${key}`,
        provider,
        env: [key],
        localFiles: [],
        owner: "project",
        valueMaterialized: true,
        storage: ["project_env", "project_vault", "global_project_env"],
        staleCheck: "Validate access before release or deploy.",
      });
    } catch { /* best-effort */ }
  }
  // 4) 전역 로컬 env — 프로젝트가 있으면 프로젝트 이름이 붙은 키로 저장
  const globalKey = project ? projectScopedGlobalEnvKeyCli(project, key) : key;
  try { upsertEnvLine(path.join(userDataDir(), "credentials.env"), globalKey, value); targets.push(project ? "global project env" : "global memory"); } catch { /* best-effort */ }
  try { upsertEnvLine(path.join(os.homedir(), ".agentlas", "credentials.env"), globalKey, value); } catch { /* best-effort */ }

  ctx.out(`✓ connected ${provider} — saved ${key} to ${targets.join(", ") || "(nowhere — check keytar)"}.`);
  return 0;
}

module.exports = { run, resolveCredentialSourcePath };
