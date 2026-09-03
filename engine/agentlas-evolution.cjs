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
const { runWriteTransaction } = require("./agentlas-sqlite-policy.cjs");

function sha256(content) {
  return createHash("sha256").update(String(content), "utf8").digest("hex");
}

const ABSENT_TARGET_HASH = sha256("agentlas:absent-agent-asset:v1");
const MAX_EVOLUTION_CONTENT_BYTES = 512 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
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

function terminalSafe(value, maxLength = 300) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizedListLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 200)) : 50;
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
      .all(normalizedListLimit(limit));
  } catch {
    rows = [];
  }
  const pending = [];
  const applied = [];
  const autoApplied = [];
  for (const row of rows) {
    const source = parseSource(row.source_json);
    const entry = { row, source };
    if (row.status === "candidate") pending.push(entry);
    else {
      applied.push(entry);
      if (source._autoApplied === true) autoApplied.push(entry);
    }
  }
  return { pending, applied, autoApplied };
}

function agentById(db, id) {
  try {
    return db.prepare("SELECT * FROM installed_agents WHERE id = ?").get(id) || null;
  } catch {
    return null;
  }
}

function evolutionSameDirectoryIdentity(left, right) {
  return Boolean(
    left && right && left.isDirectory() && right.isDirectory() &&
    !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino,
  );
}

function evolutionDirectoryAnchor(target, label, containedBy = null) {
  if (typeof target !== "string" || !path.isAbsolute(target) || /[\u0000\r\n]/.test(target)) {
    throw new Error(`${label} must be an absolute directory`);
  }
  const requested = path.resolve(target);
  let stat;
  try { stat = fs.lstatSync(requested); }
  catch (error) { throw new Error(`${label} is not an existing directory: ${error.message || error}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real non-symbolic-link directory`);
  }
  let realpath;
  try { realpath = fs.realpathSync.native(requested); }
  catch (error) { throw new Error(`${label} could not be canonicalized: ${error.message || error}`); }
  if (containedBy && !(
    realpath === containedBy.realpath || realpath.startsWith(`${containedBy.realpath}${path.sep}`)
  )) {
    throw new Error(`${label} escapes its managed parent`);
  }
  let canonical;
  try { canonical = fs.lstatSync(realpath); }
  catch (error) { throw new Error(`${label} could not be rechecked: ${error.message || error}`); }
  if (!evolutionSameDirectoryIdentity(stat, canonical)) {
    throw new Error(`${label} changed during canonicalization`);
  }
  return { path: requested, realpath, dev: stat.dev, ino: stat.ino, stat };
}

function evolutionAssertDirectoryAnchor(anchor, label, containedBy = null) {
  const current = evolutionDirectoryAnchor(anchor.path, label, containedBy);
  if (!evolutionSameDirectoryIdentity(anchor.stat || anchor, current.stat || current) || current.realpath !== anchor.realpath) {
    throw new Error(`${label} changed during evolution`);
  }
  return current;
}

function evolutionSameFileIdentity(left, right) {
  return Boolean(
    left && right && left.isFile() && right.isFile() &&
    !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.dev === right.dev && left.ino === right.ino,
  );
}

function evolutionFileIdentity(file, { allowMissing = false, allowHardLinks = false } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (allowMissing && error && error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Evolution target must be a regular non-symbolic-link file");
  }
  if (!allowHardLinks && stat.nlink !== 1) throw new Error("Evolution target must not be hard-linked");
  return stat;
}

function targetFilePath(agentFolder, agent, targetPath) {
  const rawDir = agentFolder(agent);
  if (typeof rawDir !== "string" || !path.isAbsolute(rawDir) || /[\u0000\r\n]/.test(rawDir)) {
    throw new Error("Evolution agent folder must be an absolute safe path");
  }
  const dir = path.resolve(String(rawDir || ""));
  const parent = evolutionDirectoryAnchor(path.dirname(dir), "Evolution agent parent");
  const directory = evolutionDirectoryAnchor(dir, "Evolution agent folder", parent);
  evolutionAssertDirectoryAnchor(parent, "Evolution agent parent");
  evolutionAssertDirectoryAnchor(directory, "Evolution agent folder", parent);
  const safe = path.resolve(directory.realpath, targetPath);
  if (
    safe !== path.join(directory.realpath, targetPath) ||
    !(safe === directory.realpath || safe.startsWith(`${directory.realpath}${path.sep}`)) ||
    path.dirname(safe) !== directory.realpath
  ) {
    throw new Error("Evolution target escapes the agent folder");
  }
  return { file: safe, parent, directory };
}

function currentTargetHash(file) {
  let fd;
  try {
    const before = evolutionFileIdentity(file, { allowMissing: true });
    if (!before) return { exists: false, content: "", hash: ABSENT_TARGET_HASH, stat: null };
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!evolutionSameFileIdentity(before, opened) || opened.nlink !== 1) {
      throw new Error("Evolution target changed while opening");
    }
    const content = fs.readFileSync(fd, "utf8");
    const after = fs.fstatSync(fd);
    if (!evolutionSameFileIdentity(before, after) || after.nlink !== 1 || after.size !== Buffer.byteLength(content, "utf8")) {
      throw new Error("Evolution target changed while reading");
    }
    return { exists: true, content, hash: sha256(content), stat: after };
  } catch (error) {
    if (error && error.code === "ENOENT") return { exists: false, content: "", hash: ABSENT_TARGET_HASH, stat: null };
    throw error;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* preserve read failure */ }
  }
}

function evolutionAssertTarget(file, expected) {
  const current = evolutionFileIdentity(file, { allowMissing: true });
  if (expected ? !evolutionSameFileIdentity(expected, current) : current) {
    throw new Error("Evolution target changed before publication");
  }
  return current;
}

function evolutionRemoveOwnedFile(file, expected, anchors) {
  evolutionAssertDirectoryAnchor(anchors.parent, "Evolution agent parent");
  evolutionAssertDirectoryAnchor(anchors.directory, "Evolution agent folder", anchors.parent);
  const current = evolutionFileIdentity(file);
  if (!evolutionSameFileIdentity(expected, current) || current.nlink !== 1) {
    throw new Error("Evolution target changed before cleanup");
  }
  fs.unlinkSync(file);
  evolutionAssertDirectoryAnchor(anchors.parent, "Evolution agent parent");
  evolutionAssertDirectoryAnchor(anchors.directory, "Evolution agent folder", anchors.parent);
}

function evolutionRemoveOwnedTemp(file, expected) {
  if (!expected) return;
  try {
    const current = evolutionFileIdentity(file, { allowMissing: true });
    if (current && evolutionSameFileIdentity(expected, current) && current.nlink === 1) fs.unlinkSync(file);
  } catch { /* leave unknown successors as recovery artifacts */ }
}

function evolutionRestoreBackup(backup, file, expected, anchors) {
  if (!backup || !expected) return false;
  try {
    const current = evolutionFileIdentity(file, { allowMissing: true });
    if (current) return false;
    const saved = evolutionFileIdentity(backup);
    if (!evolutionSameFileIdentity(expected, saved) || saved.nlink !== 1) return false;
    fs.linkSync(backup, file);
    const restored = evolutionFileIdentity(file, { allowHardLinks: true });
    if (!evolutionSameFileIdentity(expected, restored) || restored.nlink < 2) return false;
    fs.unlinkSync(backup);
    return true;
  } catch { return false; }
}

function writeTargetAtomic(file, content, anchors, expected = null) {
  if (!anchors || !anchors.directory || !anchors.parent) throw new Error("Evolution target has no directory anchor");
  evolutionAssertDirectoryAnchor(anchors.parent, "Evolution agent parent");
  evolutionAssertDirectoryAnchor(anchors.directory, "Evolution agent folder", anchors.parent);
  const current = evolutionAssertTarget(file, expected);
  let mode = current ? current.mode & 0o777 : 0o600;
  const temp = path.join(anchors.directory.realpath, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let tempStat = null;
  let backup = null;
  let published = false;
  let fd;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      mode,
    );
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error("Evolution temporary target is unsafe");
    // Keep the descriptor identity as soon as the exclusive create succeeds;
    // a later write/fsync failure may still need to remove exactly this temp.
    tempStat = opened;
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(written) || written <= 0) throw new Error("Evolution temporary target write stalled");
      offset += written;
    }
    try { fs.fchmodSync(fd, mode); }
    catch (error) {
      if (process.platform !== "win32") throw error;
      /* Windows/ACL-only host: the descriptor mode is best effort. */
    }
    fs.fsyncSync(fd);
    const written = fs.fstatSync(fd);
    if (!evolutionSameFileIdentity(opened, written) || written.nlink !== 1 || written.size !== bytes.length) {
      throw new Error("Evolution temporary target changed while writing");
    }
    tempStat = written;
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* preserve original */ }
    evolutionRemoveOwnedTemp(temp, tempStat);
    throw error;
  }
  if (fd !== undefined) {
    try { fs.closeSync(fd); } catch (error) {
      evolutionRemoveOwnedTemp(temp, tempStat);
      throw error;
    }
  }
  try {
    evolutionAssertDirectoryAnchor(anchors.parent, "Evolution agent parent");
    evolutionAssertDirectoryAnchor(anchors.directory, "Evolution agent folder", anchors.parent);
    evolutionAssertTarget(file, expected);
    if (current) {
      backup = `${file}.previous-${process.pid}-${randomUUID()}`;
      fs.renameSync(file, backup);
      const moved = evolutionFileIdentity(backup);
      if (!evolutionSameFileIdentity(current, moved) || moved.nlink !== 1) {
        evolutionRestoreBackup(backup, file, current, anchors);
        throw new Error("Evolution target changed before publication");
      }
      evolutionAssertDirectoryAnchor(anchors.parent, "Evolution agent parent");
      evolutionAssertDirectoryAnchor(anchors.directory, "Evolution agent folder", anchors.parent);
      if (evolutionFileIdentity(file, { allowMissing: true })) {
        throw new Error("Evolution target successor appeared during publication");
      }
    }
    evolutionAssertDirectoryAnchor(anchors.parent, "Evolution agent parent");
    evolutionAssertDirectoryAnchor(anchors.directory, "Evolution agent folder", anchors.parent);
    if (evolutionFileIdentity(file, { allowMissing: true })) {
      throw new Error("Evolution target successor appeared during publication");
    }
    fs.linkSync(temp, file);
    // Keep ownership through every post-link check.  If any later check fails,
    // the catch block may remove this exact inode before restoring the backup;
    // a boolean tied only to the temporary link would leave a half-published
    // target behind after the temp name is unlinked.
    published = true;
    const linkedTarget = evolutionFileIdentity(file, { allowHardLinks: true });
    const linkedTemp = evolutionFileIdentity(temp, { allowHardLinks: true });
    if (!evolutionSameFileIdentity(tempStat, linkedTarget) || !evolutionSameFileIdentity(tempStat, linkedTemp) || linkedTarget.nlink < 2 || linkedTemp.nlink < 2) {
      throw new Error("Evolution target identity changed after publication");
    }
    evolutionAssertDirectoryAnchor(anchors.parent, "Evolution agent parent");
    evolutionAssertDirectoryAnchor(anchors.directory, "Evolution agent folder", anchors.parent);
    fs.unlinkSync(temp);
    const installed = evolutionFileIdentity(file);
    if (!evolutionSameFileIdentity(tempStat, installed) || installed.nlink !== 1) {
      throw new Error("Evolution target identity changed after publication");
    }
    // Finish mode verification through an O_NOFOLLOW descriptor.  A pathname
    // chmod here could follow a target symlink installed by a concurrent
    // writer after the identity check and mutate an outside file.
    let finalFd;
    try {
      finalFd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const openedFinal = fs.fstatSync(finalFd);
      if (!evolutionSameFileIdentity(tempStat, openedFinal) || openedFinal.nlink !== 1) {
        throw new Error("Evolution target identity changed after publication");
      }
      try { fs.fchmodSync(finalFd, mode); }
      catch (chmodError) {
        if (process.platform !== "win32") throw chmodError;
        /* Windows/ACL-only host: the final mode is best effort. */
      }
      const final = fs.fstatSync(finalFd);
      if (!evolutionSameFileIdentity(tempStat, final) || final.nlink !== 1 ||
          (process.platform !== "win32" && (final.mode & 0o777) !== mode)) {
        throw new Error("Evolution target identity changed after publication");
      }
    } finally {
      if (finalFd !== undefined) try { fs.closeSync(finalFd); } catch { /* preserve final verification */ }
    }
    if (backup) {
      const old = evolutionFileIdentity(backup, { allowMissing: true });
      if (old && evolutionSameFileIdentity(current, old) && old.nlink === 1) fs.unlinkSync(backup);
      backup = null;
    }
    published = false;
  } catch (error) {
    if (published) {
      try {
        const target = evolutionFileIdentity(file, { allowMissing: true, allowHardLinks: true });
        if (target && evolutionSameFileIdentity(tempStat, target)) fs.unlinkSync(file);
      } catch { /* leave unknown successor untouched */ }
    }
    evolutionRemoveOwnedTemp(temp, tempStat);
    if (backup) evolutionRestoreBackup(backup, file, current, anchors);
    throw error;
  }
}

function restoreTargetAfterFailure(file, before, expectedCurrentHash, anchors) {
  const current = currentTargetHash(file);
  if (current.hash !== expectedCurrentHash) {
    throw new Error("Evolution persistence failed and the target changed again before rollback; manual repair is required");
  }
  if (before.exists) writeTargetAtomic(file, before.content, anchors, current.stat);
  else evolutionRemoveOwnedFile(file, current.stat, anchors);
}

function printCard(out, entry, index) {
  const { row, source } = entry;
  const card = source.humanCard && typeof source.humanCard === "object" ? source.humanCard : null;
  const tier = source.riskTier === "high" ? "high" : "low";
  const application = row.status === "candidate" ? "승인 전" : source._autoApplied === true ? "자동 반영" : "승인 후 반영";
  out(`  [${index}] ${terminalSafe(row.id)}  (${tier} · ${terminalSafe(row.status)} · ${application} · ${terminalSafe(row.agent_id)})`);
  if (card) {
    out(`      배운 것 : ${terminalSafe(card.learned)}`);
    out(`      바뀐 것 : ${terminalSafe(card.change)}`);
    out(`      안전장치: ${terminalSafe(card.reversible)}`);
  } else {
    out(`      ${terminalSafe(row.summary)}`);
  }
}

function cmdList(db, out) {
  const { pending, applied } = listGrowthProposals(db);
  out("== agent growth proposals ==");
  out("");
  out(`대기(승인 필요) ${pending.length}건:`);
  if (!pending.length) out("  (없음)");
  pending.forEach((entry, i) => printCard(out, entry, i + 1));
  out("");
  out(`성장 반영 완료 ${applied.length}건 (필요할 때 되돌릴 수 있는 안전장치):`);
  if (!applied.length) out("  (없음)");
  applied.forEach((entry, i) => printCard(out, entry, i + 1));
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

function validateProposalPayload(row, fail) {
  if (!SHA256_RE.test(String(row.before_hash)) || !SHA256_RE.test(String(row.after_hash))) {
    fail("Evolution proposal contains an invalid content hash");
    return false;
  }
  if (typeof row.before_content !== "string" || typeof row.after_content !== "string") {
    fail("Evolution proposal content is invalid");
    return false;
  }
  if (
    Buffer.byteLength(row.before_content, "utf8") > MAX_EVOLUTION_CONTENT_BYTES ||
    Buffer.byteLength(row.after_content, "utf8") > MAX_EVOLUTION_CONTENT_BYTES
  ) {
    fail("Evolution proposal exceeds the portable 512 KiB content limit");
    return false;
  }
  if (sha256(row.after_content) !== row.after_hash) {
    fail("Evolution proposal after-content does not match its approved hash");
    return false;
  }
  if (
    (row.before_hash === ABSENT_TARGET_HASH && row.before_content !== "") ||
    (row.before_hash !== ABSENT_TARGET_HASH && sha256(row.before_content) !== row.before_hash)
  ) {
    fail("Evolution proposal before-content does not match its approved baseline hash");
    return false;
  }
  return true;
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
  const inserted = db.prepare(
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
  if (inserted.changes !== 1) throw new Error(`Evolution ${action} receipt already exists; proposal state is inconsistent`);
}

function cmdApply(db, id, out, fail, agentFolder) {
  const row = loadProposal(db, id, fail);
  if (!row) return;
  if (!validateProposalPayload(row, fail)) return;
  if (row.status !== "candidate") {
    return fail(`Only a pending candidate can be applied; ${id} is '${row.status}'.`);
  }
  const agent = agentById(db, row.agent_id);
  if (!agent) return fail(`Agent not found for proposal: ${row.agent_id}`);
  let target;
  let before;
  try {
    target = targetFilePath(agentFolder, agent, row.target_path);
    before = currentTargetHash(target.file);
  } catch (error) {
    return fail(error && error.message ? error.message : String(error));
  }
  const { file } = target;
  if (before.hash !== row.before_hash) {
    return fail("Agent prompt changed after this proposal was created; review it in the desktop app and re-propose.");
  }
  const now = new Date().toISOString();
  let wroteTarget = false;
  try {
    runWriteTransaction(db, () => {
      const locked = db.prepare("SELECT status FROM agent_evolution_proposals WHERE id=?").get(row.id);
      if (!locked || locked.status !== "candidate") throw new Error("Evolution proposal changed before apply; reload and review it again");
      if (currentTargetHash(file).hash !== row.before_hash) throw new Error("Agent prompt changed before apply; reload and review it again");
      writeTargetAtomic(file, row.after_content, target, before.stat);
      wroteTarget = true;
      if (currentTargetHash(file).hash !== row.after_hash) throw new Error("Applied content did not match the approved hash");
      db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?").run(row.after_content, row.agent_id);
      insertReceipt(db, row, "apply", row.before_hash, row.after_hash, now);
      const changed = db.prepare(
        `UPDATE agent_evolution_proposals
           SET status = 'applied', applied_at = COALESCE(applied_at, ?),
               last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'candidate'`,
      ).run(now, now, row.id).changes;
      if (changed !== 1) throw new Error("Evolution proposal changed before apply; no receipt was committed");
    });
  } catch (error) {
    if (wroteTarget) {
      try { restoreTargetAfterFailure(file, before, sha256(row.after_content), target); }
      catch (rollbackError) { return fail(`${error.message}. ${rollbackError.message}`); }
    }
    return fail(`${error.message}; the original target was restored.`);
  }
  out(`applied ${id} → ${row.target_path} (agent ${row.agent_id}). Revert with: agentlas evolve revert ${id}`);
}

function cmdRevert(db, id, out, fail, agentFolder) {
  const row = loadProposal(db, id, fail);
  if (!row) return;
  if (!validateProposalPayload(row, fail)) return;
  if (row.status !== "applied" && row.status !== "measured") {
    return fail(`Only an applied proposal can be reverted; ${id} is '${row.status}'.`);
  }
  const applyReceipt = db
    .prepare("SELECT 1 FROM agent_evolution_receipts WHERE proposal_id = ? AND action = 'apply' LIMIT 1")
    .get(row.id);
  if (!applyReceipt) return fail("Revert requires the verified apply receipt.");
  const agent = agentById(db, row.agent_id);
  if (!agent) return fail(`Agent not found for proposal: ${row.agent_id}`);
  let target;
  let before;
  try {
    target = targetFilePath(agentFolder, agent, row.target_path);
    before = currentTargetHash(target.file);
  } catch (error) {
    return fail(error && error.message ? error.message : String(error));
  }
  const { file } = target;
  if (before.hash !== row.after_hash) {
    return fail("Agent prompt changed after this proposal was applied; revert blocked to avoid clobbering newer edits.");
  }
  const now = new Date().toISOString();
  let wroteTarget = false;
  try {
    runWriteTransaction(db, () => {
      const locked = db.prepare("SELECT status FROM agent_evolution_proposals WHERE id=?").get(row.id);
      if (!locked || !["applied", "measured"].includes(locked.status)) throw new Error("Evolution proposal changed before revert; reload it first");
      if (currentTargetHash(file).hash !== row.after_hash) throw new Error("Agent prompt changed before revert; reload it first");
      // A proposal may have created the prompt asset from an absent baseline.
      // Restoring that baseline means removing the created file, not writing an
      // empty file (whose sha256 can never equal ABSENT_TARGET_HASH).
      if (row.before_hash === ABSENT_TARGET_HASH) evolutionRemoveOwnedFile(file, before.stat, target);
      else writeTargetAtomic(file, row.before_content, target, before.stat);
      wroteTarget = true;
      if (currentTargetHash(file).hash !== row.before_hash) throw new Error("Reverted content did not match the original hash");
      db.prepare("UPDATE installed_agents SET system_prompt = ? WHERE id = ?").run(row.before_content, row.agent_id);
      insertReceipt(db, row, "rollback", row.after_hash, row.before_hash, now);
      const changed = db.prepare(
        `UPDATE agent_evolution_proposals
           SET status = 'rolled_back', rolled_back_at = COALESCE(rolled_back_at, ?),
               last_error = NULL, updated_at = ?
         WHERE id = ? AND status IN ('applied','measured')`,
      ).run(now, now, row.id).changes;
      if (changed !== 1) throw new Error("Evolution proposal changed before revert; no receipt was committed");
    });
  } catch (error) {
    if (wroteTarget) {
      try { restoreTargetAfterFailure(file, before, row.before_hash, target); }
      catch (rollbackError) { return fail(`${error.message}. ${rollbackError.message}`); }
    }
    return fail(`${error.message}; the applied target was restored.`);
  }
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
    if (args.length !== 1) return fail("usage: agentlas evolve [list | apply <id> | revert <id>]");
    out("usage: agentlas evolve [list | apply <id> | revert <id>]");
    out("  list          — review pending (approval-needed) and auto-applied agent growth proposals");
    out("  apply <id>    — approve and apply a pending proposal to the agent prompt");
    out("  revert <id>   — roll back an applied proposal");
    return;
  }
  if (sub === "list" || sub === "ls") {
    if (args.length > 1) return fail("usage: agentlas evolve list");
    return cmdList(db, out);
  }
  if (sub === "apply") {
    if (args.length !== 2 || !args[1]) return fail("usage: agentlas evolve apply <id>");
    return cmdApply(db, args[1], out, fail, agentFolder);
  }
  if (sub === "revert" || sub === "rollback") {
    if (args.length !== 2 || !args[1]) return fail("usage: agentlas evolve revert <id>");
    return cmdRevert(db, args[1], out, fail, agentFolder);
  }
  return fail(`Unknown evolve subcommand: ${sub} (list|apply|revert)`);
}

module.exports = { cmdEvolve, countPendingGrowthProposals, listGrowthProposals };
