"use strict";

// `agentlas evolve [list|apply <id>|revert <id>]` — Phase 2 / 2+ (terminal 표면).
//
// 데스크탑 트리거가 만든 "성장 제안"을 공유 agentlas.sqlite에서 읽어 검토·적용·되돌린다.
// hep/터미널 세션은 UI가 없으므로 이 명령이 4표면 발화 UX의 터미널 창구다.
//   list  — 대기 중(고위험 candidate) + 자동적용(저위험) 제안을 사람이 읽는 3줄로.
//   apply <id>  — 고위험 candidate를 명시 승인해 프롬프트에 적용(런타임 authority=system_prompt + 파일).
//   revert <id> — 적용된 제안을 되돌린다.
//
// 적용/되돌리기 게이트는 도구 무관한 "타깃 파일 내용 해시(before_hash/after_hash)"로만 판정한다
// (데스크탑이 생성 시 저장한 sha256). 그래서 데스크탑이 자동적용한 저위험 제안도 터미널에서
// 안전하게 되돌릴 수 있다. 어떤 실패도 폴백 없이 상태로 노출한다.

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

function sha256(content) {
  return createHash("sha256").update(String(content), "utf8").digest("hex");
}

const ABSENT_TARGET_HASH = sha256("agentlas:absent-agent-asset:v1");
const RULE_TARGETS = new Set([
  "system-prompt.md",
  "soul.md",
  "agent.md",
  "claude.md",
  "agents.md",
  "gemini.md",
  "persona.md",
  "prompt.md",
]);

function parseSource(json) {
  try {
    const parsed = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 대기 중(사람 결정 필요) 고위험 성장 제안 개수 — 터미널 홈 배너용. */
function countPendingGrowthProposals(db) {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_evolution_proposals
          WHERE json_extract(source_json, '$._growth') = 1 AND status = 'candidate'`,
      )
      .get();
    return Number(row && row.n ? row.n : 0);
  } catch {
    return 0;
  }
}

function listGrowthProposals(db, limit = 50) {
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT * FROM agent_evolution_proposals
          WHERE json_extract(source_json, '$._growth') = 1
            AND status IN ('candidate','applied','measured')
          ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
          LIMIT ?`,
      )
      .all(limit);
  } catch {
    rows = [];
  }
  const pending = [];
  const autoApplied = [];
  for (const row of rows) {
    const source = parseSource(row.source_json);
    const entry = { row, source };
    if (row.status === "candidate") pending.push(entry);
    else if (source._autoApplied === true) autoApplied.push(entry);
  }
  return { pending, autoApplied };
}

function agentById(db, id) {
  try {
    return db.prepare("SELECT * FROM installed_agents WHERE id = ?").get(id) || null;
  } catch {
    return null;
  }
}

function targetFilePath(agentFolder, agent, targetPath) {
  const dir = agentFolder(agent);
  const safe = path.resolve(dir, targetPath);
  if (safe !== path.join(dir, targetPath) && !safe.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error("Evolution target escapes the agent folder");
  }
  return safe;
}

function currentTargetHash(file) {
  try {
    const content = fs.readFileSync(file, "utf8");
    return { exists: true, content, hash: sha256(content) };
  } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, content: "", hash: ABSENT_TARGET_HASH };
    throw error;
  }
}

function printCard(out, entry, index) {
  const { row, source } = entry;
  const card = source.humanCard && typeof source.humanCard === "object" ? source.humanCard : null;
  const tier = source.riskTier === "high" ? "high" : "low";
  out(`  [${index}] ${row.id}  (${tier} · ${row.status} · ${row.agent_id})`);
  if (card) {
    out(`      배운 것 : ${card.learned}`);
    out(`      바뀌는 것: ${card.change}`);
    out(`      되돌리기 : ${card.reversible}`);
  } else {
    out(`      ${row.summary}`);
  }
}

function cmdList(db, out) {
  const { pending, autoApplied } = listGrowthProposals(db);
  out("== agent growth proposals ==");
  out("");
  out(`대기(승인 필요) ${pending.length}건:`);
  if (!pending.length) out("  (없음)");
  pending.forEach((entry, i) => printCard(out, entry, i + 1));
  out("");
  out(`자동 적용됨(저위험) ${autoApplied.length}건:`);
  if (!autoApplied.length) out("  (없음)");
  autoApplied.forEach((entry, i) => printCard(out, entry, i + 1));
  out("");
  out("적용:  agentlas evolve apply <id>   ·   되돌리기: agentlas evolve revert <id>");
}

function loadProposal(db, id, fail) {
  const row = db.prepare("SELECT * FROM agent_evolution_proposals WHERE id = ?").get(id);
  if (!row) return fail(`Proposal not found: ${id}`);
  if (row.proposal_type !== "rule") {
    return fail(`Terminal evolve applies rule (prompt) proposals only; ${id} is '${row.proposal_type}'. Use the desktop app.`);
  }
  if (!RULE_TARGETS.has(String(row.target_path).toLowerCase())) {
    return fail(`Unsupported evolution target: ${row.target_path}`);
  }
  return row;
}

// 터미널이 부트스트랩한 DB는 v45라 진화 영수증 테이블이 없을 수 있다(데스크탑 v51+ 마이그레이션이
// 추가). 앱과 동일한 스키마로 idempotent 생성 — 앱이 이미 만들었으면 no-op.
function ensureReceiptTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_evolution_receipts (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_path TEXT NOT NULL,
      version_before INTEGER NOT NULL,
      version_after INTEGER NOT NULL,
      target_hash_before TEXT NOT NULL,
      target_hash_after TEXT NOT NULL,
      package_hash_before TEXT NOT NULL,
      package_hash_after TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(proposal_id, action)
    );
  `);
}

function insertReceipt(db, row, action, hashBefore, hashAfter, now) {
  ensureReceiptTable(db);
  db.prepare(
    `INSERT INTO agent_evolution_receipts (
       id, proposal_id, agent_id, action, target_path,
       version_before, version_after, target_hash_before, target_hash_after,
       package_hash_before, package_hash_after, created_at
     ) VALUES (?, ?, ?, ?, ?, 1, 2, ?, ?, ?, ?, ?)
     ON CONFLICT(proposal_id, action) DO NOTHING`,
  ).run(
    `evo_receipt_${randomUUID()}`,
    row.id,
    row.agent_id,
    action,
    row.target_path,
    hashBefore,
    hashAfter,
    hashBefore,
    hashAfter,
    now,
  );
}

function cmdApply(db, id, out, fail, agentFolder) {
  const row = loadProposal(db, id, fail);
  if (!row) return;
  if (row.status !== "candidate") {
    return fail(`Only a pending candidate can be applied; ${id} is '${row.status}'.`);
  }
  const agent = agentById(db, row.agent_id);
  if (!agent) return fail(`Agent not found for proposal: ${row.agent_id}`);
  const file = targetFilePath(agentFolder, agent, row.target_path);
  const current = currentTargetHash(file);
  if (current.hash !== row.before_hash) {
    return fail("Agent prompt changed after this proposal was created; review it in the desktop app and re-propose.");
  }
  const now = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, row.after_content, "utf8");
  const verify = sha256(fs.readFileSync(file, "utf8"));
  if (verify !== row.after_hash) {
    // 원상복구 후 실패 노출(폴백 금지).
    fs.writeFileSync(file, row.before_content, "utf8");
    return fail("Applied content did not match the approved hash; restored the original.");
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?").run(row.after_content, row.agent_id);
    insertReceipt(db, row, "apply", row.before_hash, row.after_hash, now);
    db.prepare(
      `UPDATE agent_evolution_proposals
         SET status = 'applied', applied_at = COALESCE(applied_at, ?),
             last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'candidate'`,
    ).run(now, now, row.id);
  });
  tx();
  out(`applied ${id} → ${row.target_path} (agent ${row.agent_id}). Revert with: agentlas evolve revert ${id}`);
}

function cmdRevert(db, id, out, fail, agentFolder) {
  const row = loadProposal(db, id, fail);
  if (!row) return;
  if (row.status !== "applied" && row.status !== "measured") {
    return fail(`Only an applied proposal can be reverted; ${id} is '${row.status}'.`);
  }
  const applyReceipt = db
    .prepare("SELECT 1 FROM agent_evolution_receipts WHERE proposal_id = ? AND action = 'apply' LIMIT 1")
    .get(row.id);
  if (!applyReceipt) return fail("Revert requires the verified apply receipt.");
  const agent = agentById(db, row.agent_id);
  if (!agent) return fail(`Agent not found for proposal: ${row.agent_id}`);
  const file = targetFilePath(agentFolder, agent, row.target_path);
  const current = currentTargetHash(file);
  if (current.hash !== row.after_hash) {
    return fail("Agent prompt changed after this proposal was applied; revert blocked to avoid clobbering newer edits.");
  }
  const now = new Date().toISOString();
  fs.writeFileSync(file, row.before_content, "utf8");
  const verify = sha256(fs.readFileSync(file, "utf8"));
  if (verify !== row.before_hash) {
    fs.writeFileSync(file, row.after_content, "utf8");
    return fail("Reverted content did not match the original hash; restored the applied version.");
  }
  const tx = db.transaction(() => {
    db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?").run(row.before_content, row.agent_id);
    insertReceipt(db, row, "rollback", row.after_hash, row.before_hash, now);
    db.prepare(
      `UPDATE agent_evolution_proposals
         SET status = 'rolled_back', rolled_back_at = COALESCE(rolled_back_at, ?),
             last_error = NULL, updated_at = ?
       WHERE id = ? AND status IN ('applied','measured')`,
    ).run(now, now, row.id);
  });
  tx();
  out(`reverted ${id} → restored ${row.target_path} (agent ${row.agent_id}).`);
}

/**
 * cmdEvolve — `agentlas evolve <sub> ...`.
 * @param {{db:any,args:string[],out:(s:string)=>void,fail:(s:string)=>void,agentFolder:(a:any)=>string}} ctx
 */
function cmdEvolve(ctx) {
  const { db, out, fail, agentFolder } = ctx;
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  const sub = args[0] || "list";
  if (sub === "help" || sub === "--help" || sub === "-h") {
    out("usage: agentlas evolve [list | apply <id> | revert <id>]");
    out("  list          — review pending (approval-needed) and auto-applied agent growth proposals");
    out("  apply <id>    — approve and apply a pending proposal to the agent prompt");
    out("  revert <id>   — roll back an applied proposal");
    return;
  }
  if (sub === "list" || sub === "ls") return cmdList(db, out);
  if (sub === "apply") {
    if (!args[1]) return fail("usage: agentlas evolve apply <id>");
    return cmdApply(db, args[1], out, fail, agentFolder);
  }
  if (sub === "revert" || sub === "rollback") {
    if (!args[1]) return fail("usage: agentlas evolve revert <id>");
    return cmdRevert(db, args[1], out, fail, agentFolder);
  }
  return fail(`Unknown evolve subcommand: ${sub} (list|apply|revert)`);
}

module.exports = { cmdEvolve, countPendingGrowthProposals, listGrowthProposals };
