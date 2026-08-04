"use strict";
/*
 * graph — 저장된 자동화 그래프를 터미널에서 보고 실행 요청한다.
 *
 * 실행 주체는 데스크탑 스케줄러다. 터미널은 그래프를 "지금 실행 대상"으로 표시할 뿐이며,
 * 데스크탑이 꺼져 있으면 아무 일도 일어나지 않는다 — 그 사실을 숨기지 않고 그대로 말한다.
 * (표시해 놓고 "실행했습니다"라고 답하면, 사용자는 돌아가지 않은 자동화를 돌아갔다고 믿는다.)
 *
 * 공유 DB(데스크탑과 동일 파일)를 읽고 쓴다. 스키마 소유권은 데스크탑에 있으므로
 * 여기서는 컬럼을 만들지 않고, 없는 컬럼은 없는 대로 다룬다.
 */
const readline = require("node:readline");

function graphRows(ctx, db) {
  if (!ctx.tableExists(db, "automations")) return [];
  const hasGraph = ctx.columnExists(db, "automations", "graph_json");
  const hasTriggerType = ctx.columnExists(db, "automations", "trigger_type");
  const cols = [
    "id", "name", "enabled", "next_run_at", "last_run_at",
    hasGraph ? "graph_json" : "NULL AS graph_json",
    hasTriggerType ? "trigger_type" : "NULL AS trigger_type",
  ].join(", ");
  return db.prepare(`SELECT ${cols} FROM automations ORDER BY name`).all();
}

function parseGraph(row) {
  if (!row.graph_json) return null;
  try {
    const parsed = JSON.parse(row.graph_json);
    return parsed && Array.isArray(parsed.nodes) ? parsed : null;
  } catch {
    return null;
  }
}

function triggerKind(row, graph) {
  if (row.trigger_type && row.trigger_type !== "schedule") return "input";
  const trigger = graph?.nodes?.find((n) => n.type === "trigger");
  const configured = trigger?.config?.kind;
  return configured === "input" ? "input" : "cron";
}

function describe(ctx, row, graph, en) {
  const kind = triggerKind(row, graph);
  const nodeCount = graph?.nodes?.length ?? 0;
  const state = row.enabled ? (en ? "on" : "켜짐") : (en ? "off" : "꺼짐");
  const when = row.next_run_at
    ? new Date(row.next_run_at).toLocaleString()
    : (en ? "not scheduled" : "예약 없음");
  const kindLabel = kind === "cron"
    ? (en ? "schedule" : "예약")
    : (en ? "input" : "입력");
  return `${ctx.ui.bold(row.name)}  ${ctx.ui.dim(`${kindLabel} · ${nodeCount} ${en ? "steps" : "단계"} · ${state} · ${when}`)}`;
}

function findGraph(rows, needle) {
  const lowered = String(needle || "").trim().toLowerCase();
  if (!lowered) return null;
  return rows.find((row) => row.name.toLowerCase() === lowered)
    ?? rows.find((row) => row.id === needle)
    ?? rows.find((row) => row.name.toLowerCase().includes(lowered))
    ?? null;
}

function listGraphs(ctx) {
  const db = ctx.db();
  const rows = graphRows(ctx, db);
  const en = ctx.lang === "en";
  if (!rows.length) {
    ctx.out(en
      ? "No automation graphs saved yet. Build one in the desktop app under Graph."
      : "저장된 자동화 그래프가 없습니다. 데스크탑 앱의 Graph에서 만들 수 있습니다.");
    return 0;
  }
  ctx.out(ctx.ui.bold(en ? "Saved graphs" : "저장된 그래프"));
  for (const row of rows) {
    ctx.out("  " + describe(ctx, row, parseGraph(row), en));
  }
  ctx.out("");
  ctx.out(ctx.ui.dim(en
    ? "Run one with: agentlas graph run \"<name>\""
    : "실행하려면: agentlas graph run \"<이름>\""));
  return 0;
}

function showGraph(ctx, needle) {
  const db = ctx.db();
  const rows = graphRows(ctx, db);
  const en = ctx.lang === "en";
  const row = findGraph(rows, needle);
  if (!row) {
    ctx.err(en ? `No graph matches "${needle}".` : `"${needle}"와 맞는 그래프가 없습니다.`);
    return 1;
  }
  const graph = parseGraph(row);
  ctx.out(describe(ctx, row, graph, en));
  if (!graph) {
    ctx.out("  " + ctx.ui.dim(en
      ? "This automation has no visual graph yet (single-prompt automation)."
      : "이 자동화에는 아직 시각 그래프가 없습니다(단일 프롬프트 자동화)."));
    return 0;
  }
  ctx.out("");
  for (const node of graph.nodes) {
    const effect = node.config?.effect;
    const approval = node.config?.approval;
    const marks = [
      effect === "mutation" ? (en ? "changes things outside" : "바깥을 바꿈") : null,
      approval === "ask" || (effect === "mutation" && approval !== "auto")
        ? (en ? "asks first" : "확인 후 실행")
        : null,
    ].filter(Boolean);
    ctx.out(`  ${ctx.ui.accent(node.type)}  ${node.label || node.id}${marks.length ? ctx.ui.dim(`  — ${marks.join(", ")}`) : ""}`);
  }
  return 0;
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(String(answer || "").trim())));
}

async function runGraph(ctx, needle, flags) {
  const db = ctx.db();
  const rows = graphRows(ctx, db);
  const en = ctx.lang === "en";
  const row = findGraph(rows, needle);
  if (!row) {
    ctx.err(en ? `No graph matches "${needle}".` : `"${needle}"와 맞는 그래프가 없습니다.`);
    ctx.err(en ? "See what is saved with: agentlas graph list" : "저장된 목록: agentlas graph list");
    return 1;
  }
  const graph = parseGraph(row);
  const kind = triggerKind(row, graph);

  if (!flags.yes && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (kind === "cron") {
        const nextRun = row.next_run_at
          ? new Date(row.next_run_at).toLocaleString()
          : (en ? "not scheduled" : "예약 없음");
        const answer = await ask(rl, en
          ? `"${row.name}" runs on a schedule (next: ${nextRun}). Run it now? [y/N] `
          : `"${row.name}"은(는) 예약 실행입니다(다음: ${nextRun}). 지금 실행할까요? [y/N] `);
        if (!/^y(es)?$/i.test(answer)) {
          ctx.out(en ? "Left as is." : "그대로 두었습니다.");
          return 0;
        }
      } else {
        const label = graph?.nodes?.find((n) => n.type === "trigger")?.config?.promptLabel;
        const answer = await ask(rl, en
          ? `${label || "Input for this graph"}: `
          : `${label || "이 그래프에 넘길 입력"}: `);
        if (!answer) {
          ctx.err(en ? "This graph needs an input to start." : "이 그래프는 입력이 있어야 시작합니다.");
          return 1;
        }
        flags.input = answer;
      }
    } finally {
      rl.close();
    }
  }

  // 실행 요청 = "지금 예약". 데스크탑 스케줄러가 60초 주기로 due를 집어간다.
  const now = new Date().toISOString();
  const updated = db.prepare(
    "UPDATE automations SET next_run_at = ? WHERE id = ? AND enabled = 1",
  ).run(now, row.id);
  if (updated.changes !== 1) {
    ctx.err(en
      ? `"${row.name}" is switched off, so a run request would sit unread. Turn it on in the desktop app first.`
      : `"${row.name}"이(가) 꺼져 있어 실행 요청이 읽히지 않습니다. 데스크탑 앱에서 먼저 켜 주세요.`);
    return 1;
  }
  ctx.out(en
    ? `Requested a run of "${row.name}".`
    : `"${row.name}" 실행을 요청했습니다.`);
  // 여기서 "실행했습니다"라고 말하면 거짓이 된다 — 실행 주체는 데스크탑이다.
  ctx.out(ctx.ui.dim(en
    ? "The desktop app picks this up within a minute while it is running. If it is closed, the run happens the next time you open it."
    : "데스크탑 앱이 켜져 있으면 1분 안에 가져갑니다. 꺼져 있으면 다음에 앱을 열 때 실행됩니다."));
  if (flags.input) {
    ctx.out(ctx.ui.dim(en
      ? "Note: input-triggered graphs currently take their input in the desktop app; the value you typed was not attached."
      : "참고: 입력 트리거 그래프의 입력은 현재 데스크탑 앱에서 받습니다. 방금 입력한 값은 전달되지 않았습니다."));
  }
  return 0;
}

async function run(ctx, args = []) {
  const en = ctx.lang === "en";
  const rest = args.filter((a) => a !== "-y" && a !== "--yes");
  const flags = { yes: args.includes("-y") || args.includes("--yes") };
  const sub = (rest[0] || "list").toLowerCase();
  const target = rest.slice(1).join(" ").trim();

  if (sub === "list" || sub === "ls") return listGraphs(ctx);
  if (sub === "show") {
    if (!target) {
      ctx.err(en ? "Usage: agentlas graph show \"<name>\"" : "사용법: agentlas graph show \"<이름>\"");
      return 1;
    }
    return showGraph(ctx, target);
  }
  if (sub === "run") {
    if (!target) {
      ctx.err(en ? "Usage: agentlas graph run \"<name>\"" : "사용법: agentlas graph run \"<이름>\"");
      return 1;
    }
    return runGraph(ctx, target, flags);
  }
  // 목록에 없는 하위 명령을 조용히 list로 처리하면, 오타가 성공처럼 보인다.
  ctx.err(en
    ? `Unknown subcommand "${sub}". Try: list, show, run.`
    : `모르는 하위 명령 "${sub}"입니다. list, show, run 중에서 고르세요.`);
  return 1;
}

module.exports = { run };
