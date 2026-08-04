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
