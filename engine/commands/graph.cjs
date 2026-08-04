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
  const requirement = graphInputRequirement(graph, en);
  if (requirement) {
    ctx.out("  " + ctx.ui.dim(en
      ? `Starts from a value you provide — ${requirement.label}`
      : `시작할 때 값을 받습니다 — ${requirement.label}`));
  }
  ctx.out("");
  renderGraphTree(ctx, graph, en);
  return 0;
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
  return `${ctx.ui.accent(kindWord(node.type, en))}  ${node.label || node.id}`
    + (marks.length ? ctx.ui.dim(`  — ${marks.join(", ")}`) : "");
}

/** 내부 타입 이름을 그대로 보여주지 않는다 — 사용자는 "condition"이 뭔지 알 이유가 없다. */
function kindWord(type, en) {
  const ko = {
    trigger: "시작", agent: "에이전트", tool: "도구", action: "행동",
    condition: "갈림길", transform: "변환", output: "출력",
  };
  const enWords = {
    trigger: "start", agent: "agent", tool: "tool", action: "action",
    condition: "branch", transform: "transform", output: "output",
  };
  return (en ? enWords[type] : ko[type]) || type;
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

  const walk = (nodeId, depth, branchLabel) => {
    const node = nodes.get(nodeId);
    if (!node) return;
    const indent = "  ".repeat(depth + 1);
    const prefix = branchLabel ? ctx.ui.dim(`${branchLabel} `) : "";
    if (seen.has(nodeId)) {
      // 되돌아가는 연결(루프). 다시 펼치면 끝나지 않으므로 되돌아간다는 사실만 말한다.
      ctx.out(`${indent}${prefix}↩ ${ctx.ui.dim(en
        ? `back to "${node.label || node.id}" (loop)`
        : `"${node.label || node.id}"(으)로 되돌아감 (반복)`)}`);
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
      walk(edge.target, depth + 1, label);
    }
  };

  for (const root of roots) walk(root.id, 0, "");
  // 어디에서도 닿지 않는 노드는 조용히 숨기지 않는다 — 만들어 놓고 안 이어진 단계다.
  const orphans = graph.nodes.filter((n) => !seen.has(n.id));
  if (orphans.length) {
    ctx.out("");
    ctx.out("  " + ctx.ui.dim(en
      ? "Not connected to the start — these never run:"
      : "시작과 이어지지 않아 실행되지 않는 단계:"));
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
      ? `"${row.name}" starts from a value you provide (${requirement.label}). Run it without -y so it can ask, or pass --input "<value>".`
      : `"${row.name}"은(는) 시작할 값이 필요합니다(${requirement.label}). -y 없이 실행해 값을 입력하거나 --input "<값>" 으로 넘기세요.`);
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


function exportGraph(ctx, needle, outPath) {
  const db = ctx.db();
  const rows = graphRows(ctx, db);
  const en = ctx.lang === "en";
  const row = findGraph(rows, needle);
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
  const target = outPath || `${built.package.manifest.slug || "graph"}.agentgraph.json`;
  fs.writeFileSync(path.resolve(target), JSON.stringify(built.package, null, 2) + "\n", "utf8");
  ctx.out(en ? `Wrote ${target}` : `${target} 파일로 저장했습니다.`);
  const findings = built.findings;
  if (findings.length) {
    ctx.out(ctx.ui.dim(en ? "Removed before packaging:" : "패키징 전에 지운 것:"));
    for (const f of findings) ctx.out(ctx.ui.dim(`  · ${f.nodeId}.${f.field} — ${f.rule} (${f.action})`));
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
    ? "Installing a package is done in the desktop app; this command only reads it."
    : "패키지 설치는 데스크탑 앱에서 합니다. 이 명령은 읽기만 합니다."));
  return 0;
}

function installPackage(ctx, filePath) {
  const en = ctx.lang === "en";
  const db = ctx.db();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (err) {
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
  const existing = graphRows(ctx, db).find((row) => row.name === manifest.name);
  if (existing) {
    ctx.err(en
      ? `An automation named "${manifest.name}" already exists. Rename or remove it first — this command never overwrites your work.`
      : `"${manifest.name}" 이름의 자동화가 이미 있습니다. 이름을 바꾸거나 지운 뒤 다시 시도하세요 — 이 명령은 기존 작업을 덮어쓰지 않습니다.`);
    return 1;
  }

  // 받는 사람 계정에는 아직 아무것도 채워지지 않았다. 켜진 채로 설치하면
  // 빈 금고·없는 에이전트로 첫 스케줄에 바로 실패한다 — 꺼진 채로 들어온다(D14).
  const checklist = pkgLib.bindingChecklist(parsed);
  const target = manifest.dependencies?.agents?.[0];
  const now = new Date().toISOString();
  const id = `graph-${crypto.randomUUID()}`;
  try {
    db.prepare(
      `INSERT INTO automations
         (id, name, schedule, target_type, target_id, prompt_template, enabled, created_by, created_at, next_run_at, graph_json)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'user', ?, NULL, ?)`,
    ).run(
      id,
      manifest.name,
      manifest.trigger?.schedule || "daily-09:00",
      target?.source === "hub" ? "hub" : "agent",
      target?.slug || "builtin-agentlas-orchestrator",
      manifest.name,
      now,
      JSON.stringify(parsed.graph),
    );
  } catch (err) {
    ctx.err(en ? `Install failed: ${err.message}` : `설치하지 못했습니다: ${err.message}`);
    return 1;
  }

  ctx.out(en
    ? `Installed "${manifest.name}" — switched off until it is bound.`
    : `"${manifest.name}"을(를) 설치했습니다 — 연결이 끝날 때까지 꺼진 상태입니다.`);
  if (checklist.length) {
    ctx.out(en ? "Fill these in the desktop app, then switch it on:" : "데스크탑 앱에서 아래를 채운 뒤 켜세요:");
    for (const item of checklist) {
      if (item.kind === "vault-key") ctx.out(`  · ${en ? "key" : "키"} ${item.key}`);
      else if (item.kind === "agent") ctx.out(`  · ${en ? "agent" : "에이전트"} ${item.slug}${item.source === "hub" ? ctx.ui.dim(en ? " (borrowed from the network — costs credits)" : " (네트워크에서 빌림 — 크레딧 소모)") : ""}`);
      else ctx.out(`  · MCP ${item.serverSlug}`);
    }
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
    ? "Nothing runs until you switch it on. Try a simulation first."
    : "켜기 전에는 아무것도 실행되지 않습니다. 먼저 시뮬레이션으로 돌려보세요."));
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
    return installPackage(ctx, target);
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
  // 목록에 없는 하위 명령을 조용히 list로 처리하면, 오타가 성공처럼 보인다.
  ctx.err(en
    ? `Unknown subcommand "${sub}". Try: list, show, run, export, inspect, install.`
    : `모르는 하위 명령 "${sub}"입니다. list, show, run, export, inspect, install 중에서 고르세요.`);
  return 1;
}

module.exports = { run };
