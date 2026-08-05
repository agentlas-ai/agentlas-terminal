"use strict";
/*
 * roles — 오케스트레이터/워커 모델 역할 조회·설정.
 *
 * 배경(2026-08-05 감사, 결함 C): `list`와 `doctor`는 model_roles를 보여주는데
 * 터미널 어디에도 쓰기 경로가 없었다(전 코드베이스 SELECT만). 바꾸려면 데스크탑을
 * 열어야 했고, REPL `/model`은 지역 변수 대입이라 검증도 저장도 안 됐다.
 *
 * 계약:
 *  - 스키마 소유권은 데스크탑(v79)에 있다. 여기서는 테이블·컬럼을 만들지 않는다 —
 *    테이블이 없으면 정직 정지 + 데스크탑 안내. 있는 행에 UPSERT만 한다.
 *  - kind는 데스크탑과 같은 어휘(RUNTIME_BIN + byok 계열)로 검증한다. PATH에
 *    없는 CLI도 저장은 허용하되(미리 설정) 그 자리에서 알린다 — 조용한 저장 금지.
 *  - worker --inherit 는 스키마 CHECK(worker만 inherit 가능)를 그대로 따른다.
 *  - 모델 id는 제공자마다 열린 어휘라 존재 검증하지 않는다(워크로드 라우팅의
 *    EFFORTS 주석과 같은 원칙: 화이트리스트를 게이트로 쓰지 않는다).
 */
const { RUNTIME_BIN, whichSync } = require("../runtimes/detect.cjs");
const { runtimeAuthEvidence } = require("../runtimes/auth-evidence.cjs");
const { MODEL_ROLE_TABLE, VALID_ROLES, resolvedModelRole, roleMembers } = require("../runtimes/roles.cjs");
const { runWriteTransaction } = require("../agentlas-sqlite-policy.cjs");
const { EFFORTS } = require("../agentlas-workload-routing.cjs");

// 데스크탑 RuntimeKind 어휘(runtimes/detect.cjs 주석과 동일). CLI가 아닌 종류는
// which 검사 대상이 아니다.
const KNOWN_KINDS = new Set([...Object.keys(RUNTIME_BIN), "byok", "ollama", "lmstudio", "mlx"]);

function fmt(selection, en) {
  if (!selection) return en ? "not set" : "미설정";
  const bits = [
    `${selection.kind}${selection.model ? `/${selection.model}` : ""}`,
    selection.effort ? `effort=${selection.effort}` : null,
    selection.inherit ? (en ? "(inherits orchestrator)" : "(오케스트레이터 상속)") : null,
  ];
  return bits.filter(Boolean).join(" ");
}

function show(ctx) {
  const en = ctx.lang === "en";
  const db = ctx.db();
  ctx.out(ctx.ui.bold(en ? "Model roles" : "모델 역할"));
  for (const role of ["orchestrator", "worker"]) {
    const resolved = resolvedModelRole(db, role);
    ctx.out(`  ${role.padEnd(13)} ${fmt(resolved, en)}`);
    const pool = roleMembers(db, role);
    if (pool.length) {
      ctx.out(ctx.ui.dim(`  ${" ".repeat(13)} ${en ? "pool: " : "풀: "}${pool.map((m) => `${m.position}.${m.kind}${m.model ? `/${m.model}` : ""}`).join("  ")}`));
    }
  }
  ctx.out("");
  ctx.out(ctx.ui.dim(en
    ? 'Change: agentlas roles set <orchestrator|worker> <runtime> [--model <id>] [--effort <level>]  ·  worker inherit: agentlas roles set worker --inherit'
    : '변경: agentlas roles set <orchestrator|worker> <runtime> [--model <id>] [--effort <level>]  ·  워커 상속: agentlas roles set worker --inherit'));
  return 0;
}

function parseSetFlags(args) {
  const rest = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--model") { flags.model = String(args[++i] ?? "").trim(); continue; }
    if (arg.startsWith("--model=")) { flags.model = arg.slice(8).trim(); continue; }
    if (arg === "--effort") { flags.effort = String(args[++i] ?? "").trim().toLowerCase(); continue; }
    if (arg.startsWith("--effort=")) { flags.effort = arg.slice(9).trim().toLowerCase(); continue; }
    if (arg === "--inherit") { flags.inherit = true; continue; }
    rest.push(arg);
  }
  return { rest, flags };
}

function set(ctx, args) {
  const en = ctx.lang === "ko" ? false : true;
  const ko = !en;
  const { rest, flags } = parseSetFlags(args);
  const role = String(rest[0] || "").toLowerCase();
  const kindArg = rest[1] ? String(rest[1]).toLowerCase() : null;

  const usage = ko
    ? "사용법: agentlas roles set <orchestrator|worker> <runtime> [--model <id>] [--effort <level>] | agentlas roles set worker --inherit"
    : "Usage: agentlas roles set <orchestrator|worker> <runtime> [--model <id>] [--effort <level>] | agentlas roles set worker --inherit";

  if (!VALID_ROLES.has(role)) { ctx.err(usage); return 1; }
  if (flags.inherit && role !== "worker") {
    ctx.err(ko ? "--inherit 는 worker 역할에만 씁니다 (스키마 계약)." : "--inherit applies to the worker role only (schema contract).");
    return 1;
  }
  if (!flags.inherit && !kindArg) { ctx.err(usage); return 1; }
  if (kindArg && !KNOWN_KINDS.has(kindArg)) {
    ctx.err((ko ? "모르는 런타임 종류: " : "unknown runtime kind: ") + kindArg);
    ctx.err(ko
      ? `가능한 값: ${[...KNOWN_KINDS].join(" · ")}`
      : `valid kinds: ${[...KNOWN_KINDS].join(" · ")}`);
    return 1;
  }
  if (flags.effort !== undefined && !EFFORTS.includes(flags.effort)) {
    ctx.err((ko ? "모르는 effort 값: " : "unknown effort level: ") + flags.effort + ` (${EFFORTS.join("|")})`);
    return 1;
  }

  const db = ctx.db();
  // 스키마 창조 금지 — 테이블은 데스크탑 마이그레이션 v79가 만든다.
  if (!ctx.tableExists(db, MODEL_ROLE_TABLE)) {
    ctx.err(ko
      ? "model_roles 테이블이 아직 없습니다. 스키마는 데스크탑 앱이 소유합니다 — 데스크탑을 한 번 실행하면 생성됩니다."
      : "The model_roles table does not exist yet. Desktop owns this schema — run the desktop app once to create it.");
    return 1;
  }

  let kind = kindArg;
  let model = flags.model !== undefined ? (flags.model || null) : undefined;
  let inherit = 0;
  if (flags.inherit) {
    // 상속 = 워커가 오케스트레이터를 따른다. 스키마상 kind NOT NULL이라
    // 현재 오케스트레이터의 좌표를 복사해 두되 inherit=1로 표시한다(리더 부재 시 정직 정지).
    const orchestrator = resolvedModelRole(db, "orchestrator");
    if (!orchestrator) {
      ctx.err(ko ? "상속할 오케스트레이터 설정이 없습니다. 먼저 orchestrator를 설정하세요." : "No orchestrator to inherit from. Set the orchestrator first.");
      return 1;
    }
    kind = orchestrator.kind;
    if (model === undefined) model = orchestrator.model;
    inherit = 1;
  }

  const now = new Date().toISOString();
  runWriteTransaction(db, () => {
    const existing = db.prepare("SELECT * FROM model_roles WHERE role=?").get(role);
    if (existing) {
      // kind가 바뀌면 이전 모델 id는 새 런타임의 어휘가 아니다(예: kimi에 opus).
      // --model 미지정 시 유지가 아니라 초기화 — 무의미한 좌표를 승계하지 않는다.
      const keepModel = existing.kind === kind ? existing.model : null;
      db.prepare(
        "UPDATE model_roles SET kind=?, model=?, effort=?, inherit=?, updated_at=? WHERE role=?",
      ).run(
        kind,
        model === undefined ? keepModel : model,
        flags.effort === undefined ? existing.effort : (flags.effort === "none" ? null : flags.effort),
        inherit,
        now,
        role,
      );
    } else {
      db.prepare(
        "INSERT INTO model_roles (role, kind, model, effort, inherit, updated_at) VALUES (?,?,?,?,?,?)",
      ).run(role, kind, model === undefined ? null : model, flags.effort === undefined || flags.effort === "none" ? null : flags.effort, inherit, now);
    }
  });

  const saved = resolvedModelRole(db, role);
  ctx.out(`${ctx.ui.green("✓")} ${role} = ${fmt(saved, en)}`);

  // 저장은 됐지만 실행이 안 될 수 있는 상태는 그 자리에서 말한다 — 조용한 저장 금지.
  const bin = RUNTIME_BIN[kind];
  if (bin && !whichSync(bin)) {
    ctx.out(ctx.ui.dim(ko
      ? `참고: '${bin}' 실행 파일이 PATH에 없습니다. 설치 전에는 이 역할의 실행이 실패합니다.`
      : `Note: '${bin}' is not on PATH. Runs with this role will fail until it is installed.`));
  } else if (bin) {
    const evidence = runtimeAuthEvidence(kind);
    if (evidence.status === "none") {
      ctx.out(ctx.ui.dim(ko
        ? `참고: ${kind} 로그인 흔적이 없습니다. 로그인 전에는 실행이 실패할 수 있습니다.`
        : `Note: no local sign-in evidence for ${kind}. Runs may fail until you sign in.`));
    }
  }
  return 0;
}

function run(ctx, args = []) {
  const en = ctx.lang === "en";
  const [sub, ...rest] = args;
  if (!sub || sub === "show" || sub === "list") return show(ctx);
  if (sub === "set") return set(ctx, rest);
  if (sub === "help" || sub === "--help" || sub === "-h") {
    // SELF_HELP_COMMANDS 계약: --help 는 스텁이 아니라 실제 안내여야 한다.
    ctx.out(en
      ? [
        "agentlas roles — orchestrator/worker model roles (persisted, shared with Desktop)",
        "  roles                                  show both roles and their pools",
        "  roles set <orchestrator|worker> <runtime> [--model <id>] [--effort <level>]",
        "  roles set worker --inherit             worker follows the orchestrator",
        "",
        `  runtimes: ${[...KNOWN_KINDS].join(" · ")}`,
        "  REPL /model and /runtime are session-scoped — this command is the persistent path.",
      ].join("\n")
      : [
        "agentlas roles — 오케스트레이터/워커 모델 역할 (영구 저장, 데스크탑과 공유)",
        "  roles                                  두 역할과 풀 조회",
        "  roles set <orchestrator|worker> <runtime> [--model <id>] [--effort <level>]",
        "  roles set worker --inherit             워커가 오케스트레이터를 따름",
        "",
        `  런타임: ${[...KNOWN_KINDS].join(" · ")}`,
        "  REPL /model·/runtime 은 세션 한정입니다 — 영구 설정은 이 명령입니다.",
      ].join("\n"));
    return 0;
  }
  ctx.err(en ? `unknown roles subcommand: ${sub} (show · set)` : `모르는 roles 하위 명령: ${sub} (show · set)`);
  return 1;
}

module.exports = { run };
