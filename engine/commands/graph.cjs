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
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const pkgLib = require("../graph/package.cjs");

function graphRows(ctx, db) {
  if (!ctx.tableExists(db, "automations")) return [];
  const hasGraph = ctx.columnExists(db, "automations", "graph_json");
  const hasTriggerType = ctx.columnExists(db, "automations", "trigger_type");
  const hasTarget = ctx.columnExists(db, "automations", "target_id");
  const cols = [
    // 실행 시각을 안 읽으면 내보낸 패키지의 매니페스트가 schedule: null이 되고,
    // 설치하는 쪽이 기본값을 지어낸다 — 받는 사람 컴퓨터에서 **다른 시각에 도는** 자동화가 된다.
    "schedule",
    "id", "name", "enabled", "next_run_at", "last_run_at",
    hasGraph ? "graph_json" : "NULL AS graph_json",
    hasTriggerType ? "trigger_type" : "NULL AS trigger_type",
    // 노드가 ref를 선언하지 않으면 자동화의 대상 에이전트를 상속한다 — 패키지의
    // 가장 중요한 의존성이 여기 있으므로 반드시 함께 읽는다.
    hasTarget ? "target_type" : "NULL AS target_type",
    hasTarget ? "target_id" : "NULL AS target_id",
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

// 입력 트리거 계약 — 데스크탑 shared/graph-trigger-input.ts 와 같은 규칙이어야 한다.
// 어긋나면 화면은 "주제"를 묻고 커널은 다른 이름을 찾아, 값을 넣었는데 빈 채로 돈다.
const DEFAULT_TRIGGER_INPUT_VAR = "input";

/** 어떤 단계도 만들어 주지 않는데 누군가 읽는 값들 — 밖에서 들어와야 하는 값이다. */
function unproducedVariables(graph) {
  const produced = new Set();
  for (const node of graph?.nodes ?? []) {
    for (const key of ["produces", "to"]) {
      const value = node.config?.[key];
      if (typeof value === "string" && value.trim()) produced.add(value.trim());
    }
  }
  const referenced = [];
  for (const node of graph?.nodes ?? []) {
    const text = `${node.config?.prompt ?? ""}\n${node.config?.text ?? ""}\n${node.config?.template ?? ""}`;
    for (const match of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
      if (!produced.has(match[1]) && !referenced.includes(match[1])) referenced.push(match[1]);
    }
  }
  return referenced;
}

/** 이 그래프가 시작할 때 사람에게 값을 받아야 하는가. */
function graphInputRequirement(graph, en) {
  const trigger = graph?.nodes?.find((n) => n.type === "trigger");
  if (!trigger) return null;
  const unproduced = unproducedVariables(graph);
  const declaredName = typeof trigger.config?.produces === "string" && trigger.config.produces.trim()
    ? trigger.config.produces.trim()
    : null;
  // 이름 선언이 없어도, 아무 단계도 만들지 않는 값이 정확히 하나면 그것이 사람이 넣을 값이다.
  const varName = declaredName
    ?? (unproduced.length === 1 ? unproduced[0] : DEFAULT_TRIGGER_INPUT_VAR);
  const kind = trigger.config?.kind;
  const declaredInput = kind === "input" || kind === "manual";
  if (!declaredInput && !unproduced.includes(varName)) return null;
  const label = typeof trigger.config?.promptLabel === "string" && trigger.config.promptLabel.trim()
    ? trigger.config.promptLabel.trim()
    : (en ? "Input for this graph" : "이 그래프에 넘길 값");
  return { varName, label };
}

function triggerKindOfManifest(manifest) {
  return manifest?.trigger?.kind === "input" ? "input" : "cron";
}

function describe(ctx, row, graph, en) {
  const kind = triggerKind(row, graph);
  const nodeCount = graph?.nodes?.length ?? 0;
  const state = row.enabled ? (en ? "on" : "켜짐") : (en ? "off" : "꺼짐");
  // 입력으로 시작하는 그래프는 예약 시각이 의미가 없다. 그 시각을 보여주면
  // 사용자는 그때 저절로 돌 거라고 읽는다 — 실제로는 값을 넣어야만 돈다.
  const when = kind === "input"
    ? (en ? "runs when you give it a value" : "값을 넣으면 실행")
    : row.next_run_at
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
  const exact = rows.find((row) => row.name.toLowerCase() === lowered)
    ?? rows.find((row) => row.id === needle);
  if (exact) return exact;
  const partial = rows.filter((row) => row.name.toLowerCase().includes(lowered));
  // 여러 개가 걸리면 하나를 골라 주지 않는다. 조용히 고르면 사용자가 본 적 없는
  // 비슷한 이름의 자동화가 실행된다(실측: "글 다듬기" → "(친구가 준 것)" 사본이 돌았다).
  if (partial.length > 1) return { ambiguous: partial };
  return partial[0] ?? null;
}

/** 이름이 여러 개 걸렸을 때, 고르지 말고 후보를 보여준다. */
function reportAmbiguous(ctx, needle, matches, en) {
  ctx.err(en
    ? `"${needle}" matches ${matches.length} automations. Say which one:`
    : `"${needle}"에 자동화 ${matches.length}개가 걸립니다. 어느 것인지 정확히 적어 주세요:`);
  for (const row of matches) ctx.err(`  · ${row.name}`);
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
  if (row?.ambiguous) { reportAmbiguous(ctx, needle, row.ambiguous, en); return 1; }
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
  const requirement = graphInputRequirement(graph, en);
  if (requirement) {
    ctx.out("  " + ctx.ui.dim(en
      ? `Starts from a value you provide — ${requirement.label}`
      : `시작할 때 값을 받습니다 — ${requirement.label}`));
  }
  ctx.out("");
  renderGraphTree(ctx, graph, en);
  const problems = graphProblems(graph, en);
  if (problems.length) {
    ctx.out("");
    ctx.out(ctx.ui.red(en
      ? `This graph will stop when it runs (${problems.length}):`
      : `이대로 실행하면 도중에 멈춥니다 (${problems.length}건):`));
    for (const p of problems) {
      ctx.out(`  ⚠ ${p.what}`);
      ctx.out(`    ${ctx.ui.dim(p.fix)}`);
    }
  }
  // 그대로 복사해 쓸 수 있는 명령. 예전에는 값이 필요한 그래프인지 화면에서만 알려주고
  // **넣는 방법은 안 알려줘서**, 사용자가 실패한 뒤에야 --input을 알게 됐다.
  ctx.out("");
  ctx.out(ctx.ui.dim(en ? "Run it with:" : "실행하려면:"));
  ctx.out(requirement
    ? `  agentlas graph run "${row.name}" --input "<${requirement.label}>"`
    : `  agentlas graph run "${row.name}"`);
  return 0;
}

/**
 * 실행하기 전에 알 수 있는 결함을 찾는다.
 * 예전에는 `show`가 결함을 하나도 표시하지 않아, **돌려서 실패시켜야만** 알 수 있었다.
 * 자동화는 사람이 없는 동안 도는 것이라, 실패를 새벽에 발견하게 된다.
 */
function graphProblems(graph, en) {
  const problems = [];
  const nodes = new Map((graph.nodes ?? []).map((n) => [n.id, n]));
  const out = new Map();
  for (const edge of graph.edges ?? []) {
    if (!out.has(edge.source)) out.set(edge.source, []);
    out.get(edge.source).push(edge);
  }
  for (const node of graph.nodes ?? []) {
    const label = node.label || node.id;
    if (node.type === "condition") {
      const edges = out.get(node.id) ?? [];
      const undeclared = edges.filter((e) => e.sourceHandle !== "true" && e.sourceHandle !== "false");
      if (undeclared.length) {
        problems.push({
          what: en
            ? `Branch "${label}" has ${undeclared.length} outgoing link(s) that do not say yes or no.`
            : `갈림길 "${label}"에서 나가는 연결 ${undeclared.length}개가 "예"인지 "아니오"인지 정해져 있지 않습니다.`,
          fix: en
            ? "Open it in the desktop app and reconnect from the yes / no outlets."
            : "데스크탑 앱에서 열어 참·거짓 출구에서 다시 이으세요.",
        });
      }
      if (!edges.length) {
        problems.push({
          what: en ? `Branch "${label}" leads nowhere.` : `갈림길 "${label}" 뒤에 아무것도 이어져 있지 않습니다.`,
          fix: en ? "Connect what should happen on each side." : "각 갈래 뒤에 할 일을 이으세요.",
        });
      } else if (!edges.some((e) => e.sourceHandle === "true") || !edges.some((e) => e.sourceHandle === "false")) {
        const missing = edges.some((e) => e.sourceHandle === "true")
          ? (en ? "no" : "아니오") : (en ? "yes" : "예");
        problems.push({
          what: en
            ? `Branch "${label}" has nothing on its "${missing}" side — it stops there when it goes that way.`
            : `갈림길 "${label}"의 "${missing}" 쪽에 아무것도 없습니다 — 그쪽으로 가면 거기서 멈춥니다.`,
          fix: en ? "Connect that side, or make it end there on purpose." : "그쪽에도 다음 단계를 잇거나, 거기서 끝나도 되게 두세요.",
        });
      }
    }
    // 되돌아가는 연결에 반복 횟수가 없으면 실행 자체가 거절된다.
    for (const edge of out.get(node.id) ?? []) {
      const target = nodes.get(edge.target);
      if (!target) {
        problems.push({
          what: en ? `"${label}" links to a step that no longer exists.` : `"${label}"이(가) 없는 단계로 이어져 있습니다.`,
          fix: en ? "Remove or repoint that link in the desktop app." : "데스크탑 앱에서 그 연결을 지우거나 다시 이으세요.",
        });
      }
    }
  }
  // 밖에서 받아야 하는 값이 여럿이면 무엇을 넣어야 하는지 정할 수 없다.
  const unproduced = unproducedVariables(graph);
  if (unproduced.length > 1) {
    problems.push({
      what: en
        ? `Nothing in this graph produces these values: ${unproduced.join(", ")}. Only one value can be supplied at the start.`
        : `이 그래프 안에서 아무도 만들지 않는 값이 여럿입니다: ${unproduced.join(", ")}. 시작할 때 넣을 수 있는 값은 하나뿐입니다.`,
      fix: en
        ? "Make the earlier steps produce them, or reduce them to one."
        : "앞 단계가 그 값들을 만들게 하거나, 시작 값을 하나로 줄이세요.",
    });
  }
  return problems;
}

/** 노드 한 줄. 무엇인지, 바깥을 바꾸는지, 어떤 값을 만들고 쓰는지. */
function nodeLine(ctx, node, en) {
  const effect = node.config?.effect;
  const approval = node.config?.approval;
  const marks = [
    effect === "mutation" ? (en ? "changes things outside" : "바깥을 바꿈") : null,
    approval === "ask" || (effect === "mutation" && approval !== "auto")
      ? (en ? "asks first" : "확인 후 실행")
      : null,
    node.config?.consumes ? `${en ? "uses" : "사용"} {{${node.config.consumes}}}` : null,
    node.config?.produces ? `${en ? "makes" : "생성"} {{${node.config.produces}}}` : null,
  ].filter(Boolean);
  if (node.type === "condition") {
    // 갈림길 이름은 만든 사람이 지은 것이라 실제 규칙과 다를 수 있다(실측: 이름은
    // "길이가 충분한가?"인데 실제로는 어떤 단어가 들어 있는지를 봤다).
    // 사람이 예측하려면 이름이 아니라 규칙을 봐야 한다.
    const rule = conditionRule(node, en);
    if (rule) marks.unshift(rule);
  }
  return `${ctx.ui.accent(kindWord(node.type, en))}  ${node.label || node.id}`
    + (marks.length ? ctx.ui.dim(`  — ${marks.join(", ")}`) : "");
}

/** 갈림길이 실제로 무엇을 보는지 한 줄로. 모르는 연산은 지어내지 않고 그대로 보여준다. */
function conditionRule(node, en) {
  const cfg = node.config || {};
  const v = cfg.var;
  if (typeof v !== "string" || !v.trim()) return null;
  const value = cfg.value;
  const shown = typeof value === "string" ? `"${value}"` : String(value ?? "");
  switch (cfg.op) {
    case "contains": return en ? `yes when {{${v}}} contains ${shown}` : `{{${v}}}에 ${shown}이(가) 들어 있으면 예`;
    case "truthy": return en ? `yes when {{${v}}} has a value` : `{{${v}}}에 값이 있으면 예`;
    case "falsy": return en ? `yes when {{${v}}} is empty` : `{{${v}}}이(가) 비어 있으면 예`;
    case "eq": return en ? `yes when {{${v}}} equals ${shown}` : `{{${v}}}이(가) ${shown}과 같으면 예`;
    case "neq": return en ? `yes when {{${v}}} differs from ${shown}` : `{{${v}}}이(가) ${shown}과 다르면 예`;
    case "gt": return en ? `yes when {{${v}}} > ${shown}` : `{{${v}}}이(가) ${shown}보다 크면 예`;
    case "lt": return en ? `yes when {{${v}}} < ${shown}` : `{{${v}}}이(가) ${shown}보다 작으면 예`;
    default: return en ? `checks {{${v}}} with "${cfg.op ?? "?"}"` : `{{${v}}}을(를) "${cfg.op ?? "?"}"(으)로 검사`;
  }
}

/** 내부 타입 이름을 그대로 보여주지 않는다 — 사용자는 "condition"이 뭔지 알 이유가 없다. */
/**
 * 노드 종류를 사람 말로.
 *
 * ★터미널은 데스크탑과 **같은 SQLite**를 읽는데 스키마 판이 뒤따라온다(터미널 부트스트랩
 * v86 vs 데스크탑 v89). 그래서 이 버전이 모르는 노드 종류를 만나는 것은 **고장이 아니라
 * 정상**이다. 실제로 `eval` 이 이 표에 빠져 있었고, 원문이 그대로 찍혀서 마치 아는 종류인
 * 것처럼 보였다.
 *
 * 규칙(레지스트리 06 §2.5): 모르는 값은 **그 항목만** 강등하고 원문을 보존해 보여준다.
 * 목록을 버리거나 에러로 올리지 않는다 — 이 플랫폼은 모르는 코드 1개에 후보집합을 통째로
 * 폐기한 사고를 겪었다.
 */
const vocabulary = require("../graph/vocabulary.generated.cjs");

function kindWord(type, en) {
  const ko = {
    trigger: "시작", agent: "에이전트", tool: "도구", action: "행동",
    condition: "갈림길", eval: "검증", transform: "변환", output: "출력",
  };
  const enWords = {
    trigger: "start", agent: "agent", tool: "tool", action: "action",
    condition: "branch", eval: "check", transform: "transform", output: "output",
  };
  const read = vocabulary.readEnum(type, vocabulary.GRAPH_NODE_KINDS);
  if ("unknown" in read) {
    // 이 버전이 모르는 종류 — 지어내지 않고 그렇다고 말한다(원문 보존).
    return vocabulary.degradedLabel(read, en ? "en" : "ko");
  }
  return (en ? enWords[read.known] : ko[read.known]) || read.known;
}

/**
 * 배선을 보여준다. 예전에는 노드를 평평한 목록으로만 찍어서, 갈림길이 어디로 갈라지는지
 * 화면 없는 표면에서는 알 방법이 아예 없었다 — 그래프의 핵심이 배선인데 그것만 빠져 있었다.
 */
function renderGraphTree(ctx, graph, en) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = new Map();
  for (const edge of graph.edges ?? []) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge);
  }
  const hasIncoming = new Set((graph.edges ?? []).map((e) => e.target));
  const roots = graph.nodes.filter((n) => !hasIncoming.has(n.id));
  const seen = new Set();

  const walk = (nodeId, depth, branchLabel, backEdge) => {
    const node = nodes.get(nodeId);
    if (!node) return;
    const indent = "  ".repeat(depth + 1);
    const prefix = branchLabel ? ctx.ui.dim(`${branchLabel} `) : "";
    if (seen.has(nodeId)) {
      // 되돌아가는 연결(루프). 다시 펼치면 끝나지 않으므로 되돌아간다는 사실만 말한다.
      const cap = typeof backEdge?.maxIterations === "number" ? backEdge.maxIterations : null;
      const capText = cap === null
        ? (en ? " — no repeat limit set, so it will refuse to run" : " — 반복 횟수가 정해져 있지 않아 실행이 거절됩니다")
        : (en ? ` — up to ${cap} more time(s)` : ` — 최대 ${cap}바퀴까지`);
      ctx.out(`${indent}${prefix}↩ ${ctx.ui.dim(en
        ? `back to "${node.label || node.id}"${capText}`
        : `"${node.label || node.id}"(으)로 되돌아감${capText}`)}`);
      return;
    }
    seen.add(nodeId);
    ctx.out(`${indent}${prefix}${nodeLine(ctx, node, en)}`);
    const edges = outgoing.get(nodeId) ?? [];
    for (const edge of edges) {
      const handle = edge.sourceHandle;
      const label = handle === "true"
        ? (en ? "[yes]" : "[예]")
        : handle === "false"
          ? (en ? "[no]" : "[아니오]")
          : "";
      walk(edge.target, depth + 1, label, edge);
    }
  };

  for (const root of roots) walk(root.id, 0, "", null);
  // 어디에서도 닿지 않는 노드는 조용히 숨기지 않는다 — 만들어 놓고 안 이어진 단계다.
  const orphans = graph.nodes.filter((n) => !seen.has(n.id));
  if (orphans.length) {
    ctx.out("");
    // ★"실행되지 않는다"고 쓰면 안 된다. 들어오는 연결이 없는 단계는 **따로 시작되는 단계**로
    // 실제로 실행된다(실측: "아무도 안 부르는 단계"가 done으로 끝났다).
    // 화면이 실행되지 않는다고 말해 놓고 실행되면, 사용자는 그래프를 보고 결과를 예측할 수 없다.
    ctx.out("  " + ctx.ui.dim(en
      ? "Not wired to the start — each of these starts on its own, at the same time:"
      : "시작과 이어져 있지 않은 단계 — 각각 따로, 시작과 동시에 실행됩니다:"));
    for (const node of orphans) ctx.out(`    ${nodeLine(ctx, node, en)}`);
  }
}

/**
 * 시작 값을 대기열에 넣는다. 데스크탑 스키마 v88의 automation_run_inputs를 쓴다.
 * 자리가 아직 없는(구버전) 데스크탑이면 false — 값이 전달된 것처럼 말하지 않기 위해서다.
 */
function enqueueRunInput(ctx, db, automationId, payload) {
  if (!ctx.tableExists || !ctx.tableExists(db, "automation_run_inputs")) return false;
  try {
    db.prepare(
      `INSERT INTO automation_run_inputs (id, automation_id, payload_json, requested_by, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(crypto.randomUUID(), automationId, JSON.stringify(payload), "terminal", new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(String(answer || "").trim())));
}

async function runGraph(ctx, needle, flags) {
  const db = ctx.db();
  const rows = graphRows(ctx, db);
  const en = ctx.lang === "en";
  const row = findGraph(rows, needle);
  if (row?.ambiguous) { reportAmbiguous(ctx, needle, row.ambiguous, en); return 1; }
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
        const requirement = graphInputRequirement(graph, en);
        const answer = await ask(rl, `${requirement?.label ?? (en ? "Input for this graph" : "이 그래프에 넘길 값")}: `);
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

  // 시작 값이 필요한 그래프는 값 없이 요청하지 않는다. 값 없이 보내면 빈 채로 실행돼,
  // 사용자가 요청한 적 없는 내용이 만들어진다.
  const requirement = graphInputRequirement(graph, en);
  if (requirement && !flags.input) {
    ctx.err(en
      ? `"${row.name}" starts from a value you provide — ${requirement.label}.`
      : `"${row.name}"은(는) 시작할 때 값을 받습니다 — ${requirement.label}.`);
    ctx.err(ctx.ui.dim(en
      ? `Run it like this:\n  agentlas graph run "${row.name}" --input "<${requirement.label}>"`
      : `이렇게 실행하세요:\n  agentlas graph run "${row.name}" --input "<${requirement.label}>"`));
    return 1;
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
  if (requirement && flags.input) {
    // 값은 대기열에 넣는다. 다음 실행 1회가 이 값을 집어간다(한 번만 소비된다).
    const enqueued = enqueueRunInput(ctx, db, row.id, { [requirement.varName]: flags.input });
    if (!enqueued) {
      ctx.err(en
        ? "The value could not be attached to this run. Update the desktop app, then try again."
        : "이번 실행에 값을 붙이지 못했습니다. 데스크탑 앱을 업데이트한 뒤 다시 시도해 주세요.");
      return 1;
    }
    ctx.out(ctx.ui.dim(en
      ? `Attached ${requirement.label}: ${flags.input}`
      : `${requirement.label}: ${flags.input} — 이번 실행에 함께 넘겼습니다.`));
  }
  return 0;
}



/**
 * graph new — 자연어 한 문장에서 시작해, 만들 수 있을 만큼 알아낼 때까지 되묻고 그래프를 만든다.
 *
 * 두 가지를 코드가 강제한다(프롬프트 문구가 아니라):
 *  · 모델은 **청사진만** 말한다. 노드와 연결은 buildGraphFromBlueprint 가 짓는다.
 *  · 청사진이 검증을 못 넘으면 "완성"이 아니라 **질문**으로 되돌아간다.
 * 그래서 실행 시각·바깥으로 나가는지·반복 상한은 지어내지지 않는다.
 */
async function newGraph(ctx, request, flags) {
  // 인터뷰의 말은 저장된 언어 설정이 아니라 **사용자가 방금 쓴 말**을 따라간다.
  // 설정만 따르면 한국어로 말한 사람에게 "for example"이 섞여 나온다(실측).
  const en = /[\uac00-\ud7a3]/.test(String(request || "")) ? false : ctx.lang === "en";
  const db = ctx.db();
  if (!request) {
    ctx.err(en
      ? 'Say what you want run for you, in your own words.\n  agentlas graph new "weekday mornings at 8, pull three blog topics"'
      : '자동으로 돌릴 일을 그대로 적어 주세요.\n  agentlas graph new "평일 아침 8시에 블로그 글감 세 개 뽑아줘"');
    return 1;
  }
  // 파이프로 답을 넣어도 된다 — 답이 떨어지면 무엇이 더 필요했는지 말하고 멈춘다.
  // (조용히 기본값으로 채우면, 사용자가 정한 적 없는 자동화가 만들어진다.)
  const piped = !process.stdin.isTTY;

  const interview = require("../graph/interview.cjs");
  const { askModel } = require("../graph/ask-model.cjs");
  let state = interview.startInterview(request);

  // 파이프로 들어온 답은 **미리 전부 읽어 둔다.** readline은 입력 스트림이 끝나면 닫히므로,
  // 질문마다 물으면 두 번째 질문에서 "readline was closed"로 죽는다(실측).
  const queued = piped ? await readAllLines() : [];
  let queueAt = 0;
  const rl = piped ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const nextAnswer = async (promptText) => {
    if (piped) return queueAt < queued.length ? queued[queueAt++] : "";
    return ask(rl, promptText);
  };

  try {
    ctx.out(ctx.ui.dim(en
      ? "Working out what to build. I will ask only what is not mine to decide."
      : "무엇을 만들지 정리합니다. 임의로 정하면 안 되는 것만 여쭙겠습니다."));

    let built = null;
    let announcedFallback = false;
    for (let round = 0; round < interview.MAX_INTERVIEW_ROUNDS; round += 1) {
      const answer = await askModel(ctx, interview.buildInterviewPrompt(state), {});
      if (!answer.ok) {
        ctx.err(answer.reason);
        ctx.err(ctx.ui.dim(answer.nextAction));
        return 1;
      }
      // 고른 런타임이 안 돌아 다른 것으로 넘어갔으면 말한다 — 조용히 바꾸면
      // 사용자는 자기가 고른 모델이 만든 줄 안다.
      if (answer.fellBackFrom && !announcedFallback) {
        announcedFallback = true;
        ctx.out(ctx.ui.dim(en
          ? `${answer.fellBackFrom} did not answer, so ${answer.runtime} is building this.`
          : `${answer.fellBackFrom}이(가) 응답하지 않아 ${answer.runtime}(으)로 진행합니다.`));
      }
      const parsed = interview.parseInterviewTurn(answer.text, state);
      if (!parsed.ok) {
        ctx.err(parsed.reason);
        ctx.err(ctx.ui.dim(parsed.nextAction));
        return 1;
      }
      // ★모델이 형식을 틀렸다 — 사람이 답을 안 준 게 아니다. 무엇이 틀렸는지 돌려주고
      //   정해진 횟수만큼 스스로 고치게 한다. "구체적으로 적어 주세요"로 떠넘기면
      //   막다른 길이 된다: 무엇이 틀렸는지 사람은 모르고, 우리는 안다.
      if (parsed.turn.kind === "retry") {
        state.attempts = [...(state.attempts || []), { round, problems: parsed.turn.problems }];
        if ((state.attempts || []).length > interview.MAX_SELF_CORRECTIONS) {
          const tried = [...new Set(state.attempts.flatMap((a) => a.problems))].slice(0, 3);
          ctx.err(en
            ? `Tried ${interview.MAX_SELF_CORRECTIONS + 1} times and kept hitting the same wall: ${tried.join(" / ")}`
            : `${interview.MAX_SELF_CORRECTIONS + 1}번 다시 만들어 봤지만 같은 자리에서 막혔습니다: ${tried.join(" / ")}`);
          ctx.err(ctx.ui.dim(en
            ? "Describe it differently, or build it on the desktop canvas."
            : "만들고 싶은 것을 다른 말로 적어 주시거나, 데스크탑 캔버스에서 직접 만들어 보세요."));
          return 1;
        }
        ctx.out(ctx.ui.dim(en ? "Fixing what didn't fit and trying again…" : "맞지 않는 부분을 고쳐 다시 만드는 중…"));
        continue;
      }
      if (parsed.turn.kind === "blueprint") {
        built = interview.buildGraphFromBlueprint(parsed.turn.blueprint);
        if (!built.ok) {
          // 청사진 검증은 통과했는데 짓는 데서 걸렸다 — 이것도 형식 문제라 같은 규율.
          state.attempts = [...(state.attempts || []), { round, problems: built.problems.map((p) => p.reason) }];
          if ((state.attempts || []).length <= interview.MAX_SELF_CORRECTIONS) {
            ctx.out(ctx.ui.dim(en ? "Fixing what didn't fit and trying again…" : "맞지 않는 부분을 고쳐 다시 만드는 중…"));
            built = null;
            continue;
          }
          ctx.err(en ? "Could not build it after all:" : "끝내 만들지 못했습니다:");
          for (const p of built.problems) ctx.err(`  · ${p.reason}`);
          return 1;
        }
        built.blueprint = parsed.turn.blueprint;
        break;
      }

      // 질문 — 하나씩 묻는다. 한꺼번에 쏟으면 사람이 답을 포기한다.
      // 끝이 안 보이면 도중에 그만두므로 몇 바퀴째인지 함께 보여준다.
      ctx.out("");
      ctx.out(ctx.ui.dim(en
        ? `Not mine to decide (round ${round + 1} of ${interview.MAX_INTERVIEW_ROUNDS}):`
        : `임의로 정하면 안 되는 항목입니다 (${round + 1}번째 / 최대 ${interview.MAX_INTERVIEW_ROUNDS}번):`));
      const given = [];
      for (const q of parsed.turn.questions) {
        ctx.out(ctx.ui.bold(`  ${q.question}`));
        if (q.why) ctx.out(ctx.ui.dim(`    ${q.why}`));
        if (q.choices && q.choices.length) {
          ctx.out(ctx.ui.dim(`    ${en ? "for example" : "예를 들면"} — ${q.choices.join(" / ")}`));
        }
        const text = await nextAnswer("  > ");
        if (!text) {
          ctx.err("");
          ctx.err(en
            ? `Stopped here without an answer to: ${q.question}`
            : `답을 받지 못해 여기서 멈췄습니다: ${q.question}`);
          ctx.err(ctx.ui.dim(en
            ? "Nothing was saved. Answer \"you decide\" and I take the safest option and name what I chose.\n"
              + "The run time, anything that goes outside, and repeat limits I keep asking about."
            : "저장된 것은 없습니다. 판단이 서지 않으면 \"알아서 해주세요\"라고 답해 주시면\n"
              + "가장 안전한 쪽으로 정하고 무엇을 골랐는지 알려 드립니다.\n"
              + "다만 실행 시각, 바깥으로 나가는 동작, 반복 횟수는 계속 여쭙니다."));
          return 1;
        }
        if (piped) ctx.out(`  > ${text}`);
        given.push({ questionId: q.id, question: q.question, answer: text });
        ctx.out("");
      }
      state = interview.recordAnswers(state, given);
    }

    if (!built) {
      ctx.err(en
        ? "I asked as much as I should and still could not pin it down."
        : "여쭤볼 만큼 여쭤봤는데도 정하지 못했습니다.");
      ctx.err(ctx.ui.dim(en
        ? "Try describing it in smaller pieces, one automation at a time."
        : "한 번에 하나씩, 더 작게 나눠서 말씀해 주시면 다시 해보겠습니다."));
      return 1;
    }

    // 저장 전에 만든 것을 보여주고 확인을 받는다. 자동화는 사람이 없는 동안 도는 것이라
    // "만들어 뒀습니다"로 끝내면 안 된다.
    const bp = built.blueprint;
    ctx.out("");
    ctx.out(ctx.ui.bold(bp.name));
    ctx.out(ctx.ui.dim(`  ${bp.goal}`));
    ctx.out("");
    renderGraphTree(ctx, built.graph, en);
    const mutations = built.graph.nodes.filter((n) => n.config && n.config.effect === "mutation");
    if (mutations.length) {
      ctx.out("");
      ctx.out(en ? "Steps that go outside (locked to ask first):" : "바깥으로 나가는 단계 (실행 전에 확인하도록 잠급니다):");
      for (const n of mutations) ctx.out(`  · ${n.label}`);
    }
    ctx.out("");
    // 갈림길 방향은 코드가 검증할 수 없다 — 사람이 읽고 답해야 한다.
    // 실측: 만들어진 갈림길 3개가 전부 거꾸로였고, 그림을 안 보면 알 수 없었다.
    const branchLines = interview.describeBranches(bp, en ? "en" : "ko");
    if (branchLines.length) {
      ctx.out("");
      ctx.out(en ? "Check the branches — is this the right way round?" : "갈림길이 이 방향이 맞나요?");
      for (const line of branchLines) ctx.out(`  ${line}`);
    }
    ctx.out("");
    ctx.out(built.triggerType === "schedule"
      ? (en ? `Runs ${interview.humanSchedule(built.scheduleHuman, "en")}` : `${interview.humanSchedule(built.scheduleHuman, "ko")}에 실행`)
      : (en ? "Runs only when you give it a value." : "값을 넣을 때만 실행합니다."));

    if (!flags.yes) {
      const confirm = await nextAnswer(en ? "\nSave this? [Y/n] " : "\n이대로 저장할까요? [Y/n] ");
      if (/^n(o)?$/i.test(confirm)) {
        ctx.out(en ? "Nothing was saved." : "저장하지 않았습니다.");
        return 0;
      }
    }

    // 이름이 겹치면 덮어쓰지 않는다.
    const existing = graphRows(ctx, db).find((row) => row.name === bp.name);
    const name = existing ? `${bp.name} (2)` : bp.name;
    const target = pickDefaultAgent(ctx, db);
    const id = `graph-${crypto.randomUUID()}`;
    try {
      db.prepare(
        `INSERT INTO automations
           (id, name, schedule, target_type, target_id, prompt_template, enabled, created_by, created_at, next_run_at, graph_json)
         VALUES (?, ?, ?, 'agent', ?, ?, 0, 'user', ?, NULL, ?)`,
      ).run(id, name, built.scheduleHuman, target, name, new Date().toISOString(), JSON.stringify(built.graph));
    } catch (err) {
      ctx.err(en ? `Could not save: ${err.message}` : `저장하지 못했습니다: ${err.message}`);
      return 1;
    }
    ctx.out("");
    ctx.out(en
      ? `Saved "${name}". Switched off, so it does not run until you turn it on.`
      : `"${name}" 저장했습니다. 꺼진 상태라 직접 켜기 전에는 돌지 않습니다.`);
    if (existing) {
      ctx.out(ctx.ui.dim(en
        ? `An automation named "${bp.name}" already existed, so this one was saved as "${name}".`
        : `"${bp.name}" 이름이 이미 있어서 "${name}"(으)로 저장했습니다.`));
    }
    ctx.out(ctx.ui.dim(en ? "Look it over:" : "내용 확인:"));
    ctx.out(`  agentlas graph show "${name}"`);
    ctx.out(ctx.ui.dim(en ? "Turn it on when it looks right:" : "확인 뒤 켜기:"));
    ctx.out(`  agentlas automation on ${id}`);
    return 0;
  } finally {
    if (rl) rl.close();
  }
}

/** 파이프로 들어온 답을 전부 읽는다. */
function readAllLines() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf.split(/\r?\n/).map((l) => l.trim())));
    process.stdin.on("error", () => resolve([]));
  });
}

/** 노드가 대상을 선언하지 않으면 자동화의 대상 에이전트를 상속한다. 없으면 기본 오케스트레이터. */
function pickDefaultAgent(ctx, db) {
  try {
    if (!ctx.tableExists(db, "installed_agents")) return "builtin-agentlas-orchestrator";
    const row = db.prepare(
      "SELECT id FROM installed_agents WHERE id = 'builtin-agentlas-orchestrator' LIMIT 1",
    ).get();
    if (row) return row.id;
    const any = db.prepare("SELECT id FROM installed_agents ORDER BY installed_at LIMIT 1").get();
    return (any && any.id) || "builtin-agentlas-orchestrator";
  } catch {
    return "builtin-agentlas-orchestrator";
  }
}

function exportGraph(ctx, needle, outPath) {
  const db = ctx.db();
  const rows = graphRows(ctx, db);
  const en = ctx.lang === "en";
  const row = findGraph(rows, needle);
  if (row?.ambiguous) { reportAmbiguous(ctx, needle, row.ambiguous, en); return 1; }
  if (!row) {
    ctx.err(en ? `No graph matches "${needle}".` : `"${needle}"와 맞는 그래프가 없습니다.`);
    return 1;
  }
  const graph = parseGraph(row);
  if (!graph) {
    ctx.err(en
      ? "This automation has no visual graph to export yet."
      : "이 자동화에는 아직 내보낼 시각 그래프가 없습니다.");
    return 1;
  }
  const built = pkgLib.buildPackage({ automation: row, graph });
  if (built.blocked) {
    // 지울 수 없는 비밀이 남았는데 내보내면, 사용자는 빠진 줄 알고 공유한다.
    ctx.err(en
      ? `Export stopped: ${built.blockers.length} value(s) look like credentials and cannot be blanked automatically.`
      : `내보내기를 멈췄습니다: 자격증명처럼 보이는 값 ${built.blockers.length}건을 자동으로 빈칸 처리할 수 없습니다.`);
    for (const blocker of built.blockers) {
      ctx.err(`  · ${blocker.nodeId}.${blocker.field} — ${blocker.reason}`);
      ctx.err(`    ${blocker.nextAction}`);
    }
    return 1;
  }
  // 기본 파일 이름은 자동화마다 달라야 한다. 예전에는 언제나 graph.agentgraph.json 이라
  // 두 번째 내보내기가 **말없이 첫 번째를 덮어썼다**(실측: 먼저 뽑은 것이 사라졌다).
  const safeName = String(built.package.manifest.name || "graph")
    .replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "graph";
  const target = path.resolve(outPath || `${safeName}.agentgraph.json`);
  if (!outPath && fs.existsSync(target)) {
    ctx.err(en
      ? `${target} already exists. Pass a file name to write somewhere else:\n  agentlas graph export "<name>" <file>`
      : `${target} 파일이 이미 있습니다. 덮어쓰지 않았습니다. 다른 이름을 주세요:\n  agentlas graph export "<이름>" <파일>`);
    return 1;
  }
  fs.writeFileSync(target, JSON.stringify(built.package, null, 2) + "\n", "utf8");
  // 전체 경로를 보여준다 — 어디에 저장됐는지 모르면 친구에게 보낼 수가 없다.
  ctx.out(en ? `Wrote ${target}` : `저장했습니다: ${target}`);
  const findings = built.findings;
  // 뽑을 때마다 "친구에게 보내도 되는가"에 답한다. 예전에는 파일을 직접 열어
  // scrubReport 같은 영어 필드를 해독해야만 알 수 있었다(실측).
  if (findings.length) {
    ctx.out(ctx.ui.dim(en ? "Removed before packaging:" : "패키징 전에 지운 것:"));
    for (const f of findings) ctx.out(ctx.ui.dim(`  · ${f.nodeId}.${f.field} — ${f.rule} (${f.action})`));
  } else {
    ctx.out(ctx.ui.dim(en
      ? "Checked for passwords, keys and personal paths — none were found in this graph."
      : "비밀번호·키·개인 경로가 있는지 훑었고, 이 그래프에는 없었습니다."));
  }
  const blanks = built.package.manifest.vaultTemplate;
  if (blanks.length) {
    ctx.out(en ? "Whoever installs this must fill:" : "받는 사람이 채워야 하는 것:");
    for (const b of blanks) ctx.out(`  · ${b.key}`);
  }
  const mutations = built.package.manifest.permissionsSummary.mutationNodes;
  if (mutations.length) {
    ctx.out(en ? "Steps that change something outside:" : "바깥을 바꾸는 단계:");
    for (const m of mutations) ctx.out(`  · ${m.label}`);
  }
  return 0;
}

function inspectPackage(ctx, filePath) {
  const en = ctx.lang === "en";
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (err) {
    // 이름을 넣은 것이 거의 확실하면 ENOENT를 그대로 던지지 않는다. 사용자는
    // show/run/export 를 전부 이름으로 썼기 때문에 여기도 이름일 거라고 생각한다(실측 3/4명).
    const looksLikeName = !String(filePath).includes("/") && !/\.(json|agentgraph)$/i.test(String(filePath));
    if (looksLikeName && err && err.code === "ENOENT") {
      ctx.err(en
        ? `This command reads a package file, not a saved automation. To look at "${filePath}" that is already saved, use:\n  agentlas graph show "${filePath}"`
        : `이 명령은 저장된 자동화가 아니라 **패키지 파일**을 읽습니다. 이미 저장된 "${filePath}"을(를) 보려면:\n  agentlas graph show "${filePath}"`);
      return 1;
    }
    ctx.err(en ? `Could not read ${filePath}: ${err.message}` : `${filePath}을(를) 읽지 못했습니다: ${err.message}`);
    return 1;
  }
  const problems = pkgLib.verifyPackage(parsed);
  if (problems.length) {
    ctx.err(en ? "This package cannot be used:" : "이 패키지는 사용할 수 없습니다:");
    for (const problem of problems) ctx.err(`  · ${problem}`);
    return 1;
  }
  const manifest = parsed.manifest;
  ctx.out(`${ctx.ui.bold(manifest.name)}  ${ctx.ui.dim(`${manifest.version} · ${parsed.graph.nodes.length} ${en ? "steps" : "단계"}`)}`);
  const checklist = pkgLib.bindingChecklist(parsed);
  if (!checklist.length) {
    ctx.out(en ? "Nothing to fill in — it can run as is." : "채울 것이 없습니다 — 그대로 실행할 수 있습니다.");
  } else {
    ctx.out(en ? "Before it can run, fill in:" : "실행하려면 먼저 채워야 합니다:");
    for (const item of checklist) {
      if (item.kind === "vault-key") ctx.out(`  · ${en ? "key" : "키"} ${item.key}`);
      else if (item.kind === "agent") ctx.out(`  · ${en ? "agent" : "에이전트"} ${item.slug}${item.source === "hub" ? ctx.ui.dim(en ? " (borrowed from the network)" : " (네트워크에서 빌림)") : ""}`);
      else ctx.out(`  · MCP ${item.serverSlug}`);
    }
  }
  const mutations = manifest.permissionsSummary?.mutationNodes ?? [];
  if (mutations.length) {
    ctx.out(en ? "It changes things outside at:" : "바깥을 바꾸는 지점:");
    for (const m of mutations) ctx.out(`  · ${m.label}`);
  }
  // 설치는 아직 데스크탑이 소유한다 — 여기서 "설치했다"고 말하지 않는다.
  ctx.out(ctx.ui.dim(en
    ? "This command only reads the file. Install it with: agentlas graph install <file>"
    : "패키지 설치는 데스크탑 앱에서 합니다. 이 명령은 읽기만 합니다."));
  return 0;
}

function installPackage(ctx, filePath, flags = {}) {
  const en = ctx.lang === "en";
  const db = ctx.db();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (err) {
    // 이름을 넣은 것이 거의 확실하면 ENOENT를 그대로 던지지 않는다. 사용자는
    // show/run/export 를 전부 이름으로 썼기 때문에 여기도 이름일 거라고 생각한다(실측 3/4명).
    const looksLikeName = !String(filePath).includes("/") && !/\.(json|agentgraph)$/i.test(String(filePath));
    if (looksLikeName && err && err.code === "ENOENT") {
      ctx.err(en
        ? `This command reads a package file, not a saved automation. To look at "${filePath}" that is already saved, use:\n  agentlas graph show "${filePath}"`
        : `이 명령은 저장된 자동화가 아니라 **패키지 파일**을 읽습니다. 이미 저장된 "${filePath}"을(를) 보려면:\n  agentlas graph show "${filePath}"`);
      return 1;
    }
    ctx.err(en ? `Could not read ${filePath}: ${err.message}` : `${filePath}을(를) 읽지 못했습니다: ${err.message}`);
    return 1;
  }
  const problems = pkgLib.verifyPackage(parsed);
  if (problems.length) {
    ctx.err(en ? "This package cannot be installed:" : "이 패키지는 설치할 수 없습니다:");
    for (const problem of problems) ctx.err(`  · ${problem}`);
    return 1;
  }
  const manifest = parsed.manifest;
  // --name 을 주면 그 이름으로 나란히 설치한다. 이 옵션이 없으면 사용자는 같은 자동화를
  // 두 벌 가질 방법이 없어, JSON을 손으로 고치는 수밖에 없었다(실측).
  const installName = typeof flags.name === "string" && flags.name.trim()
    ? flags.name.trim()
    : manifest.name;
  const existing = graphRows(ctx, db).find((row) => row.name === installName);
  if (existing) {
    ctx.err(en
      ? `An automation named "${installName}" already exists, and this command never overwrites your work.`
      : `"${installName}" 이름의 자동화가 이미 있습니다. 이 명령은 기존 작업을 덮어쓰지 않습니다.`);
    ctx.err(ctx.ui.dim(en
      ? `Install it alongside the existing one with a different name:\n  agentlas graph install <file> --name "${installName} (2)"`
      : `다른 이름으로 나란히 설치하려면:\n  agentlas graph install <파일> --name "${installName} (2)"`));
    return 1;
  }

  // 받는 사람 계정에는 아직 아무것도 채워지지 않았다. 켜진 채로 설치하면
  // 빈 금고·없는 에이전트로 첫 스케줄에 바로 실패한다 — 꺼진 채로 들어온다(D14).
  const checklist = pkgLib.bindingChecklist(parsed);
  const target = manifest.dependencies?.agents?.[0];
  // 실행 시각을 지어내면 보낸 사람과 **다른 시각에 도는** 자동화가 된다.
  // 시각이 안 실려 온 패키지는 시각 없이 설치하고, 사람이 정하라고 말한다.
  const packagedSchedule = typeof manifest.trigger?.schedule === "string" && manifest.trigger.schedule.trim()
    ? manifest.trigger.schedule.trim()
    : null;
  const now = new Date().toISOString();
  const id = `graph-${crypto.randomUUID()}`;
  try {
    db.prepare(
      `INSERT INTO automations
         (id, name, schedule, target_type, target_id, prompt_template, enabled, created_by, created_at, next_run_at, graph_json)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'user', ?, NULL, ?)`,
    ).run(
      id,
      installName,
      packagedSchedule ?? "unscheduled",
      target?.source === "hub" ? "hub" : "agent",
      target?.slug || "builtin-agentlas-orchestrator",
      installName,
      now,
      JSON.stringify(parsed.graph),
    );
  } catch (err) {
    ctx.err(en ? `Install failed: ${err.message}` : `설치하지 못했습니다: ${err.message}`);
    return 1;
  }

  ctx.out(en
    ? `Installed "${installName}" — switched off, so nothing runs yet.`
    : `"${installName}"을(를) 설치했습니다 — 꺼진 상태라 아직 아무것도 돌지 않습니다.`);
  if (!packagedSchedule && triggerKindOfManifest(manifest) === "cron") {
    ctx.out(en
      ? "This package did not carry a run time, so none was set. Pick one in the desktop app before switching it on."
      : "이 패키지에는 실행 시각이 실려 있지 않아 시각을 정하지 않았습니다. 데스크탑 앱에서 시각을 정한 뒤 켜세요.");
  } else if (packagedSchedule) {
    const sched = require("../graph/interview.cjs").humanSchedule;
    ctx.out(ctx.ui.dim(en ? `Runs ${sched(packagedSchedule, "en")}` : `${sched(packagedSchedule, "ko")}에 실행`));
  }
  // 이미 가진 것까지 "채우라"고 하면, 사용자는 채울 수 없는 항목을 앞에 두고 멈춘다.
  // (실측: 원본과 똑같은 에이전트를 쓰는 사본인데도 그 에이전트를 채우라고 요구했고,
  //  아무것도 안 채운 채 켜니 그냥 돌았다 — 요구 자체가 거짓이었다.)
  const missing = checklist.filter((item) => {
    if (item.kind !== "agent") return true;
    try {
      if (!ctx.tableExists(db, "installed_agents")) return true;
      const owned = db.prepare("SELECT 1 FROM installed_agents WHERE id = ? OR slug = ? LIMIT 1")
        .get(item.slug, item.slug);
      return !owned;
    } catch {
      return true;
    }
  });
  if (missing.length) {
    ctx.out(en ? "Missing on this computer — add these in the desktop app, then switch it on:" : "이 컴퓨터에 없는 것 — 데스크탑 앱에서 아래를 채운 뒤 켜세요:");
    for (const item of missing) {
      if (item.kind === "vault-key") ctx.out(`  · ${en ? "key" : "키"} ${item.key}`);
      else if (item.kind === "agent") ctx.out(`  · ${en ? "agent" : "에이전트"} ${item.slug}${item.source === "hub" ? ctx.ui.dim(en ? " (borrowed from the network — costs credits)" : " (네트워크에서 빌림 — 크레딧 소모)") : ""}`);
      else ctx.out(`  · MCP ${item.serverSlug}`);
    }
  } else if (checklist.length) {
    ctx.out(ctx.ui.dim(en
      ? "Everything it needs is already on this computer."
      : "이 자동화가 쓰는 것은 이미 이 컴퓨터에 다 있습니다."));
  }
  const mutations = manifest.permissionsSummary?.mutationNodes ?? [];
  if (mutations.length) {
    ctx.out(en ? "It changes things outside at:" : "바깥을 바꾸는 지점:");
    for (const m of mutations) ctx.out(`  · ${m.label}`);
    ctx.out(ctx.ui.dim(en
      ? "Those steps stop and ask before they run unless you set them to automatic."
      : "그 단계들은 자동 허용으로 바꾸지 않는 한 실행 전에 멈추고 묻습니다."));
  }
  ctx.out(ctx.ui.dim(en
    ? "Nothing runs until you switch it on. The desktop app can simulate it first — the terminal cannot."
    : "켜기 전에는 아무것도 실행되지 않습니다. 실제로 나가지 않는 시뮬레이션은 데스크탑 앱에서만 됩니다."));
  return 0;
}

async function run(ctx, args = []) {
  const en = ctx.lang === "en";
  // --input "<값>" 은 값을 하나 받는 플래그다. 값까지 함께 걷어내지 않으면
  // 그 값이 그래프 이름의 일부로 붙어 "맞는 그래프가 없다"는 엉뚱한 실패가 된다.
  const rest = [];
  const flags = { yes: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-y" || arg === "--yes") { flags.yes = true; continue; }
    if (arg === "--input" || arg === "-i") { flags.input = String(args[i + 1] ?? "").trim(); i += 1; continue; }
    if (arg.startsWith("--input=")) { flags.input = arg.slice("--input=".length).trim(); continue; }
    rest.push(arg);
  }
  const sub = (rest[0] || "list").toLowerCase();
  const target = rest.slice(1).join(" ").trim();

  if (sub === "help" || sub === "--help" || sub === "-h" || sub === "?") {
    ctx.out(ctx.ui.bold(en ? "agentlas graph — saved automations" : "agentlas graph — 저장된 자동화"));
    ctx.out(en ? '  new "<what you want>"     build one by talking it through' : '  new "<하고 싶은 일>"       말로 설명하면 만들어 줍니다');
    ctx.out(en ? "  list                      what is saved" : "  list                      저장된 것 목록");
    ctx.out(en ? "  show \"<name>\"             steps, wiring, and problems" : "  show \"<이름>\"             단계·배선·문제점");
    ctx.out(en ? "  run \"<name>\" [--input \"<value>\"]  ask the desktop app to run it" : "  run \"<이름>\" [--input \"<값>\"]   데스크탑 앱에 실행을 요청");
    ctx.out(en ? "  export \"<name>\" [file]    write a shareable package file" : "  export \"<이름>\" [파일]     남에게 줄 수 있는 파일로 저장");
    ctx.out(en ? "  inspect <file>            read a package file before installing" : "  inspect <파일>            설치 전에 패키지 파일 확인");
    ctx.out(en ? "  install <file> [--name \"<new name>\"]  install a package file" : "  install <파일> [--name \"<새 이름>\"]  패키지 파일 설치");
    ctx.out("");
    ctx.out(ctx.ui.dim(en
      ? "-y skips the confirmation question. Graphs are built and edited in the desktop app."
      : "-y 를 붙이면 확인 질문을 건너뜁니다. 그래프를 만들고 고치는 일은 데스크탑 앱에서 합니다."));
    return 0;
  }
  if (sub === "new" || sub === "create" || sub === "add" || sub === "만들기") {
    return newGraph(ctx, target, flags);
  }
  if (sub === "list" || sub === "ls") return listGraphs(ctx);
  if (sub === "show") {
    if (!target) {
      ctx.err(en ? "Usage: agentlas graph show \"<name>\"" : "사용법: agentlas graph show \"<이름>\"");
      return 1;
    }
    return showGraph(ctx, target);
  }
  if (sub === "export") {
    if (!target) {
      ctx.err(en ? "Usage: agentlas graph export \"<name>\" [file]" : "사용법: agentlas graph export \"<이름>\" [파일]");
      return 1;
    }
    const parts = rest.slice(1);
    const outPath = parts.length > 1 && /\.json$/i.test(parts[parts.length - 1]) ? parts.pop() : null;
    return exportGraph(ctx, parts.join(" ").trim(), outPath);
  }
  if (sub === "install") {
    if (!target) {
      ctx.err(en ? "Usage: agentlas graph install <file>" : "사용법: agentlas graph install <파일>");
      return 1;
    }
    return installPackage(ctx, target, flags);
  }
  if (sub === "inspect") {
    if (!target) {
      ctx.err(en ? "Usage: agentlas graph inspect <file>" : "사용법: agentlas graph inspect <파일>");
      return 1;
    }
    return inspectPackage(ctx, target);
  }
  if (sub === "run") {
    if (!target) {
      ctx.err(en ? "Usage: agentlas graph run \"<name>\"" : "사용법: agentlas graph run \"<이름>\"");
      return 1;
    }
    return runGraph(ctx, target, flags);
  }
  // 만들기·고치기를 시도한 경우에는 "그런 명령 없음"으로 끝내지 않는다. 사용자는
  // 오타를 낸 게 아니라 **여기서 되는 일이 아니라는 사실**을 모르는 것이고,
  // 어디로 가야 하는지 말해 주지 않으면 목록만 보다 포기한다.
  const AUTHORING = new Set([
    "make", "edit", "update", "delete", "remove", "rename",
    "enable", "disable", "on", "off", "수정",
  ]);
  if (AUTHORING.has(sub)) {
    ctx.err(en
      ? `Graphs are built and edited in the Agentlas desktop app (Automation → the graph canvas). The terminal can only look at saved graphs and ask for a run.`
      : `그래프를 만들고 고치는 일은 Agentlas 데스크탑 앱에서 합니다(자동화 → 그래프 화면). 터미널에서는 저장된 그래프를 보고 실행을 요청하는 것까지만 됩니다.`);
    ctx.err(ctx.ui.dim(en
      ? `Here you can: list, show <name>, run <name>, export <name>, inspect <file>, install <file>.`
      : `여기서 되는 것: list, show <이름>, run <이름>, export <이름>, inspect <파일>, install <파일>.`));
    return 1;
  }
  // 목록에 없는 하위 명령을 조용히 list로 처리하면, 오타가 성공처럼 보인다.
  ctx.err(en
    ? `Unknown subcommand "${sub}". Try: list, show, run, export, inspect, install.`
    : `모르는 하위 명령 "${sub}"입니다. list, show, run, export, inspect, install 중에서 고르세요.`);
  return 1;
}

module.exports = { run };
