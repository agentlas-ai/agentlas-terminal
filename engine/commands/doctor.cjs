"use strict";
/*
 * doctor — 런타임·데이터·자격증명 건강 점검.
 * 이 명령은 사용자가 명시적으로 요청한 현재 상태 관측만 한다.
 * 자동 복구는 프로젝트 컨트롤러와 저장된 모델 우선순위가 맡으며, 이 명령은
 * 오류 문자열을 분류하거나 설정을 자동 변경하지 않는다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { dbPath, userDataDir } = require("../core/paths.cjs");
const { listAvailableCliRuntimes, activeRuntimeRow } = require("../runtimes/detect.cjs");
const { runtimeAuthEvidence } = require("../runtimes/auth-evidence.cjs");
const { resolvedModelRole } = require("../runtimes/roles.cjs");

function roleDetail(selection, role, en) {
  if (!selection) return en ? "not set" : "미설정";
  const provider = selection.kind === "byok" ? selection.backend || "byok" : selection.kind;
  return [
    `${role}=${provider}${selection.model ? `/${selection.model}` : ""}`,
    selection.effort ? `effort=${selection.effort}` : null,
    role === "worker" && selection.inherit
      ? (en ? "inherits orchestrator" : "오케스트레이터 상속")
      : null,
  ].filter(Boolean).join(" · ");
}

function run(ctx, args = []) {
  const en = ctx.lang === "en";
  // clig.dev: 스크립트 소비자를 위한 기계 계약. 사람용 줄과 같은 사실만 담는다.
  if (args.includes("--json")) {
    const db = ctx.db();
    const clis = listAvailableCliRuntimes().map((c) => ({ kind: c.kind, path: c.path, authEvidence: runtimeAuthEvidence(c.kind).status }));
    const active = activeRuntimeRow(db);
    return (() => {
      ctx.out(JSON.stringify({
        database: { path: dbPath(), exists: fs.existsSync(dbPath()) },
        runtimes: clis,
        activeRuntime: active ? { ...active, authEvidence: runtimeAuthEvidence(active.kind).status } : null,
        modelRoles: {
          orchestrator: resolvedModelRole(db, "orchestrator"),
          worker: resolvedModelRole(db, "worker"),
        },
        cloudSession: Boolean(process.env.AGENTLAS_SESSION) || fs.existsSync(path.join(userDataDir(), "auth", "cli-session.v1.json")),
      }, null, 2));
      return 0;
    })();
  }
  let failures = 0;
  let warnings = 0;
  const ok = (label, detail) => ctx.out(`  ${ctx.ui.green("✓")} ${label}${detail ? ctx.ui.dim(" — " + detail) : ""}`);
  const bad = (label, detail) => { failures += 1; ctx.out(`  ${ctx.ui.red("✗")} ${label}${detail ? ctx.ui.dim(" — " + detail) : ""}`); };
  const warn = (label, detail) => { warnings += 1; ctx.out(`  ${ctx.ui.yellow ? ctx.ui.yellow("!") : "!"} ${label}${detail ? ctx.ui.dim(" — " + detail) : ""}`); };

  // 1) 데이터
  const p = dbPath();
  if (fs.existsSync(p)) {
    try {
      const db = ctx.db();
      const agents = db.prepare("SELECT COUNT(*) AS n FROM installed_agents").get();
      ok(en ? "database" : "데이터베이스", `${p} (${agents ? agents.n : 0} agents)`);
    } catch (e) {
      bad(en ? "database" : "데이터베이스", e.message);
    }
  } else {
    bad(en ? "database" : "데이터베이스", (en ? "missing: " : "없음: ") + p);
  }

  // 2) 런타임 — 설치 여부와 인증 흔적은 다른 축이다. which()만 보면 로그아웃
  // 상태에서도 all clear가 나간다(2026-08-05 실측). 각 CLI가 로그인 시 남기는
  // 로컬 산출물을 증거로 관측하고, 증거≠증명이므로 문구도 단정하지 않는다.
  const clis = listAvailableCliRuntimes();
  if (clis.length) {
    const evidences = clis.map((c) => ({ kind: c.kind, evidence: runtimeAuthEvidence(c.kind) }));
    const annotated = evidences.map(({ kind, evidence }) => {
      if (evidence.status === "none") return `${kind}(${en ? "no sign-in evidence" : "로그인 흔적 없음"})`;
      return kind; // evidence 또는 unknown — 검사법이 없는 런타임을 미로그인으로 표시하지 않는다
    });
    ok(en ? "runtimes" : "런타임", annotated.join(", "));
    // 신규 설치 상태: 검사 가능한 런타임 전부가 흔적 없음이면 첫 실행이 거의
    // 확실히 실패한다 — 활성 런타임 행이 아직 없어도 여기서 경고한다.
    const checkable = evidences.filter(({ evidence }) => evidence.status !== "unknown");
    if (checkable.length && checkable.every(({ evidence }) => evidence.status === "none")) {
      warn(
        en ? "runtime sign-in" : "런타임 로그인",
        en
          ? "no detected runtime has local sign-in evidence — sign in to one before running (e.g. claude / codex login / gemini)"
          : "감지된 어떤 런타임에도 로그인 흔적이 없습니다 — 실행 전에 하나는 로그인하세요 (예: claude / codex login / gemini)",
      );
    }
  } else {
    bad(en ? "runtimes" : "런타임", en
      ? "no agent CLI on PATH (claude / codex / gemini / kimi / grok / cursor-agent)"
      : "PATH에 에이전트 CLI 없음 (claude / codex / gemini / kimi / grok / cursor-agent)");
    // 막다른 길 방지: 무엇을 설치해야 하는지 그 자리에서 알려준다.
    ctx.out(ctx.ui.dim("      npm i -g @anthropic-ai/claude-code  ·  @openai/codex  ·  @google/gemini-cli"));
  }
  try {
    const db = ctx.db();
    const active = activeRuntimeRow(db);
    if (active) {
      const detail = `${active.kind}${active.model ? ` (${active.model})` : ""}`;
      // 활성 런타임은 모든 실행이 지나는 문이다 — 로그인 흔적이 없으면 all clear
      // 가 아니라 경고다. 흔적 없음 = 미로그인 "가능성"이므로 단정하지 않는다.
      const evidence = runtimeAuthEvidence(active.kind);
      if (evidence.status === "none") {
        const bin = { "claude-code": "claude", codex: "codex", gemini: "gemini" }[active.kind] || active.kind;
        warn(
          en ? "active runtime" : "활성 런타임",
          en
            ? `${detail} — no local sign-in evidence; runs may fail until you sign in (try: ${bin} login)`
            : `${detail} — 로그인 흔적이 없습니다. 로그인 전에는 실행이 실패할 수 있습니다 (시도: ${bin} login)`,
        );
      } else {
        ok(en ? "active runtime" : "활성 런타임", detail);
      }
    }
    const orchestrator = resolvedModelRole(db, "orchestrator");
    const worker = resolvedModelRole(db, "worker");
    if (orchestrator && worker) {
      ok(
        en ? "model roles" : "모델 역할",
        `${roleDetail(orchestrator, "orchestrator", en)} · ${roleDetail(worker, "worker", en)}`,
      );
    }
  } catch { /* db issue already reported */ }

  // 3) 로그인 상태 (세션 파일 관측만 — 네트워크 호출 없음)
  const sessionFile = path.join(userDataDir(), "auth", "cli-session.v1.json");
  if (process.env.AGENTLAS_SESSION) {
    ok(en ? "cloud session" : "클라우드 세션", "AGENTLAS_SESSION env");
  } else if (fs.existsSync(sessionFile)) {
    ok(en ? "cloud session" : "클라우드 세션", sessionFile);
  } else {
    ctx.out(`  ${ctx.ui.dim("·")} ${en ? "cloud session" : "클라우드 세션"}${ctx.ui.dim(en ? " — not signed in (agentlas login)" : " — 로그인 안 됨 (agentlas login)")}`);
  }

  ctx.out("");
  if (failures) {
    ctx.out(en ? `doctor: ${failures} problem(s) found` : `doctor: 문제 ${failures}건`);
    return 1;
  }
  if (warnings) {
    // 경고가 있으면 "이상 없음"이라고 말하지 않는다 — 그 문구가 첫 실행 실패를
    // 배신으로 만든다. 경고는 실행을 막지 않으므로 exit 0.
    ctx.out(en ? `doctor: ${warnings} warning(s) — runnable, but check the lines above` : `doctor: 경고 ${warnings}건 — 실행은 가능하나 위 항목을 확인하세요`);
    return 0;
  }
  ctx.out(en ? "doctor: all clear" : "doctor: 이상 없음");
  return 0;
}

module.exports = { run };
