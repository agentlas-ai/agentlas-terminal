"use strict";
/*
 * sessions/apply-fences — 파싱된 펜스 프로토콜을 실제 부작용으로 적용한다.
 * (파싱은 fences.cjs, 적용은 여기 — Desktop client.ts 의 실행 절반에 해당.)
 *
 * 정책 (비협상 불변식과 동일 선상):
 *  - memoryEvents: curate.cjs 의 결정적 게이트가 결정한다(큐레이터는 제안만).
 *    read 권한 턴은 어떤 durable 쓰기도 없다 — 영수증 이벤트만 남는다.
 *  - delegates: 오케스트레이터 동시 상한을 존중한다. 상한 초과는 조용한 큐잉이
 *    아니라 정직한 'delegate-refused' 이벤트다.
 *  - automations: 스케줄 검증 실패는 파서에서 이미 거부됐고, 여기서는 next_run_at
 *    계산 불가/권한 부족/division 재귀를 정직하게 거부한다. Desktop 도 division
 *    챗의 자동화 등록을 막는다(자동화가 자동화를 낳는 재귀 방지, client.ts:3493).
 *  - asks: 세션 이벤트로만 표면화한다. UI 는 REPL 렌더러 소관.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const memoryCurate = require("../memory-cli/curate.cjs");
const automationStore = require("../automation/store.cjs");
const permissions = require("../agentlas-permissions.cjs");
const schedule = require("../automation/schedule.cjs");

/** One 이 가져가는 스코프. 프로젝트 스코프는 프로젝트에 남는다. */
const ONE_SCOPES = new Set(["agent_repo", "user_identity"]);
const ONE_STATE_MAX_BYTES = 64 * 1024;
const ONE_LEDGER_MAX_BYTES = 16 * 1024 * 1024;
const ONE_MAX_CANDIDATES = 64;
const ONE_MAX_CONTENT_CHARS = 4_000;
const ONE_TICKET_CONTENT_CHARS = 600;
const ONE_MAX_EVIDENCE_ITEMS = 8;
const ONE_MAX_EVIDENCE_ITEM_CHARS = 500;
const ONE_MAX_TICKET_BYTES = 16 * 1024;
const ONE_LOCK_STALE_MS = 30_000;
const ONE_LOCK_ATTEMPTS = 50;
const ONE_LOCK_RETRY_MS = 20;
const ONE_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function oneWaitSync(milliseconds) {
  Atomics.wait(ONE_LOCK_WAIT, 0, 0, milliseconds);
}

function oneHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function oneContent(value) {
  return typeof value === "string" ? value.trim().slice(0, ONE_MAX_CONTENT_CHARS) : "";
}

function oneContentKey(value) {
  return oneContent(value).toLowerCase().replace(/\s+/g, " ");
}

function oneBoundedText(value, maxChars) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxChars) : undefined;
}

function oneBoundedRequestContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = {};
  const userIntent = oneBoundedText(value.user_intent, 240);
  const outcome = value.outcome === null ? null : oneBoundedText(value.outcome, 240);
  const cwd = value.cwd_at_request === null ? null : oneBoundedText(value.cwd_at_request, 500);
  const targetProject = value.target_project === null ? null : oneBoundedText(value.target_project, 120);
  const targetPath = value.target_path === null ? null : oneBoundedText(value.target_path, 500);
  const triggerTerms = Array.isArray(value.trigger_terms)
    ? value.trigger_terms.filter((item) => typeof item === "string")
        .map((item) => item.trim().slice(0, 40)).filter(Boolean).slice(0, 12)
    : [];
  if (userIntent) out.user_intent = userIntent;
  if (outcome !== undefined) out.outcome = outcome;
  if (cwd !== undefined) out.cwd_at_request = cwd;
  if (targetProject !== undefined) out.target_project = targetProject;
  if (targetPath !== undefined) out.target_path = targetPath;
  if (triggerTerms.length) out.trigger_terms = [...new Set(triggerTerms)];
  if (typeof value.cross_context === "boolean") out.cross_context = value.cross_context;
  return Object.keys(out).length ? out : undefined;
}

/** Bound untrusted memory-event data before curation's wire JSON is serialized. */
function boundMemoryEvents(events) {
  const bounded = [];
  let count = 0;
  outer:
  for (const raw of (Array.isArray(events) ? events : [])) {
    const candidates = raw && Array.isArray(raw.candidates) ? raw.candidates : [raw];
    for (const candidate of candidates) {
      if (count >= ONE_MAX_CANDIDATES) break outer;
      count += 1;
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const item = {};
      const content = oneContent(candidate.content);
      const memoryKind = oneBoundedText(candidate.memory_kind, 64);
      const suggestedScope = oneBoundedText(candidate.suggested_scope, 64);
      const confidence = oneBoundedText(candidate.confidence, 32);
      const sensitivity = oneBoundedText(candidate.sensitivity, 32);
      const evidenceRefs = Array.isArray(candidate.evidence_refs)
        ? candidate.evidence_refs.filter((value) => typeof value === "string")
            .map((value) => value.trim().slice(0, ONE_MAX_EVIDENCE_ITEM_CHARS))
            .filter(Boolean).slice(0, ONE_MAX_EVIDENCE_ITEMS)
        : [];
      if (content) item.content = content;
      if (memoryKind) item.memory_kind = memoryKind;
      if (suggestedScope) item.suggested_scope = suggestedScope;
      if (confidence) item.confidence = confidence;
      if (sensitivity) item.sensitivity = sensitivity;
      if (evidenceRefs.length) item.evidence_refs = evidenceRefs;
      const requestContext = oneBoundedRequestContext(candidate.request_context);
      if (requestContext) item.request_context = requestContext;
      bounded.push(item);
    }
  }
  return bounded;
}

function oneSafeRegularStat(stat, maxBytes) {
  return Boolean(
    stat && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= maxBytes,
  );
}

function oneSameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino;
}

/** Read a bounded regular file through an fd, refusing link and replacement races. */
function readOneFile(filePath, maxBytes, { allowMissing = false } = {}) {
  let before;
  try {
    before = fs.lstatSync(filePath);
  } catch (error) {
    if (allowMissing && error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!oneSafeRegularStat(before, maxBytes)) throw new Error("One state file is not a bounded regular file");

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (process.platform !== "win32" || !noFollow || !["EINVAL", "ENOTSUP"].includes(error && error.code)) throw error;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY);
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!oneSafeRegularStat(opened, maxBytes) || !oneSameFile(before, opened)) {
      throw new Error("One file changed while opening");
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
    }
    if (total > maxBytes) throw new Error("One file exceeds its safety limit");
    const after = fs.fstatSync(fd);
    if (
      !oneSafeRegularStat(after, maxBytes) || !oneSameFile(opened, after) ||
      after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      total !== after.size
    ) {
      throw new Error("One file changed while reading");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
    } catch {
      throw new Error("One file must contain valid UTF-8");
    }
  } finally {
    fs.closeSync(fd);
  }
}

function oneSafeDirectory(directory) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch { return false; }
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function oneProcessIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !error || error.code !== "ESRCH";
  }
}

function oneLockOwner(lockPath) {
  let raw;
  try { raw = readOneFile(path.join(lockPath, "owner.json"), 512, { allowMissing: true }); } catch { return null; }
  if (raw == null) return null;
  try {
    const owner = JSON.parse(raw);
    if (
      !owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.nonce !== "string" || !/^[a-f0-9]{32}$/.test(owner.nonce)
    ) return null;
    return owner;
  } catch {
    return null;
  }
}

function oneQuarantineLock(lockPath, label) {
  const quarantine = `${lockPath}.${label}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  try { fs.rmSync(quarantine, { recursive: true, force: true }); } catch { /* best effort */ }
  return true;
}

/** Acquire a directory lock; stale takeover proves the recorded owner is gone. */
function acquireOneLedgerLock(lockPath) {
  for (let attempt = 0; attempt < ONE_LOCK_ATTEMPTS; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      created = true;
      const nonce = crypto.randomBytes(16).toString("hex");
      fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
        pid: process.pid,
        nonce,
        createdAt: new Date().toISOString(),
      }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { lockPath, pid: process.pid, nonce };
    } catch (error) {
      if (created) {
        try { oneQuarantineLock(lockPath, "abandoned"); } catch { /* best effort */ }
        return null;
      }
      if (!error || (error.code !== "EEXIST" && error.code !== "ENOENT")) return null;
      let stat;
      try { stat = fs.lstatSync(lockPath); } catch (statError) {
        if (statError && statError.code === "ENOENT") continue;
        return null;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      const owner = oneLockOwner(lockPath);
      if (
        Number.isFinite(stat.mtimeMs) && Date.now() - stat.mtimeMs > ONE_LOCK_STALE_MS &&
        owner && !oneProcessIsAlive(owner.pid)
      ) {
        try {
          oneQuarantineLock(lockPath, "stale");
          continue;
        } catch {
          return null;
        }
      }
      oneWaitSync(ONE_LOCK_RETRY_MS);
    }
  }
  return null;
}

/** Release only this holder's lock; a successor's path is never recursively removed. */
function releaseOneLedgerLock(lock) {
  let stat;
  try { stat = fs.lstatSync(lock.lockPath); } catch { return; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const owner = oneLockOwner(lock.lockPath);
  if (!owner || owner.pid !== lock.pid || owner.nonce !== lock.nonce) return;
  try {
    if (oneQuarantineLock(lock.lockPath, "done")) return;
  } catch { /* retain the lock for stale recovery; never delete an unknown owner */ }
}

function withOneLedgerLock(lockPath, action) {
  const lock = acquireOneLedgerLock(lockPath);
  if (!lock) return null;
  try {
    return action();
  } finally {
    releaseOneLedgerLock(lock);
  }
}

function readExistingOneKeys(raw) {
  const seen = new Set();
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim() || Buffer.byteLength(line, "utf8") > ONE_MAX_TICKET_BYTES) continue;
    try {
      const row = JSON.parse(line);
      const content = row && row.candidate && row.candidate.content;
      const key = oneContentKey(content);
      if (key) seen.add(key);
    } catch { /* preserve unrelated malformed local lines */ }
  }
  return seen;
}

function appendOneLedgerRecord(ledger, record) {
  const encoded = JSON.stringify(record);
  const payload = Buffer.from(encoded + "\n", "utf8");
  const payloadBytes = payload.byteLength;
  if (payloadBytes > ONE_MAX_TICKET_BYTES) return false;
  let before;
  try { before = fs.lstatSync(ledger); } catch { return false; }
  if (!oneSafeRegularStat(before, ONE_LEDGER_MAX_BYTES) || before.size + payloadBytes > ONE_LEDGER_MAX_BYTES) return false;

  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(ledger, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow, 0o600);
  } catch (error) {
    if (process.platform !== "win32" || !noFollow || !["EINVAL", "ENOTSUP"].includes(error && error.code)) return false;
    try { fd = fs.openSync(ledger, fs.constants.O_WRONLY | fs.constants.O_APPEND, 0o600); } catch { return false; }
  }
  try {
    const opened = fs.fstatSync(fd);
    if (
      !oneSafeRegularStat(opened, ONE_LEDGER_MAX_BYTES) || !oneSameFile(before, opened) ||
      opened.size + payloadBytes > ONE_LEDGER_MAX_BYTES
    ) return false;
    let offset = 0;
    while (offset < payloadBytes) {
      const written = fs.writeSync(fd, payload, offset, payloadBytes - offset, null);
      if (!written) return false;
      offset += written;
    }
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd);
    return (
      oneSafeRegularStat(after, ONE_LEDGER_MAX_BYTES) && oneSameFile(opened, after) &&
      after.size === opened.size + payloadBytes
    );
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Agentlas One 서랍(`~/.agentlas/one/.agentlas/memory-tickets.jsonl`)으로 후보를 넘긴다.
 *
 * One 은 프로젝트를 넘나드는 정체성이라 agent_repo/user_identity 만 가져간다.
 * One 이 꺼져 있거나 서랍이 없으면 아무것도 하지 않는다 — 없는 폴더를 만들지 않는다.
 * permission 이 read 이거나 입력/서랍 경계가 안전하지 않으면 아무것도 쓰지 않는다.
 * 실패해도 턴을 죽이지 않는다(펜스 적용 계약과 동일).
 */
function forwardToOne(events, permission = "read") {
  try {
    const normalizedPermission = permissions.normalize(
      permission && typeof permission === "object" ? permission.permission : permission,
    );
    if (normalizedPermission === "read") return 0;
    const root = path.resolve(process.env.AGENTLAS_ONE_DIR || path.join(os.homedir(), ".agentlas", "one"));
    if (!oneSafeDirectory(root)) return 0;
    const stateRaw = readOneFile(path.join(root, "state.json"), ONE_STATE_MAX_BYTES, { allowMissing: true });
    if (stateRaw == null) return 0;
    const state = JSON.parse(stateRaw);
    if (!state || state.on !== true) return 0;
    const stateDir = path.join(root, ".agentlas");
    if (!oneSafeDirectory(stateDir)) return 0;
    const ledger = path.join(root, ".agentlas", "memory-tickets.jsonl");
    let stat;
    try { stat = fs.lstatSync(ledger); } catch { return 0; }
    if (!oneSafeRegularStat(stat, ONE_LEDGER_MAX_BYTES)) return 0;
    const result = withOneLedgerLock(`${ledger}.lock`, () => {
      const ledgerRaw = readOneFile(ledger, ONE_LEDGER_MAX_BYTES);
      if (ledgerRaw == null) return 0;
      const seen = readExistingOneKeys(ledgerRaw);
      let written = 0;
      let candidatesSeen = 0;
      outer:
      for (const raw of (Array.isArray(events) ? events : [])) {
        const candidates = raw && Array.isArray(raw.candidates) ? raw.candidates : [raw];
        for (const candidate of candidates) {
          if (candidatesSeen >= ONE_MAX_CANDIDATES) break outer;
          candidatesSeen += 1;
          if (!candidate || typeof candidate !== "object" || candidate.sensitivity === "secret") continue;
          const scope = String(candidate.suggested_scope || candidate.scope || "");
          if (!ONE_SCOPES.has(scope)) continue;
          const content = oneContent(candidate.content);
          if (!content) continue;
          const ticketContent = content.slice(0, ONE_TICKET_CONTENT_CHARS);
          const key = oneContentKey(ticketContent);
          if (!key || seen.has(key)) continue;
          const evidenceSource = Array.isArray(candidate.evidence)
            ? candidate.evidence
            : Array.isArray(candidate.evidence_refs) ? candidate.evidence_refs : [];
          const evidence = evidenceSource
            .filter((item) => typeof item === "string")
            .map((item) => item.trim().slice(0, ONE_MAX_EVIDENCE_ITEM_CHARS))
            .filter(Boolean)
            .slice(0, ONE_MAX_EVIDENCE_ITEMS);
          const kindValue = candidate.memory_kind || candidate.kind || candidate.type;
          const kind = typeof kindValue === "string" && kindValue.trim()
            ? kindValue.trim().slice(0, 64)
            : "hypothesis";
          const ticket = {
            schemaVersion: "agentlas.one-workspace.v1",
            ticketId: `one-tkt-${oneHash(key)}`,
            agentId: "builtin-agentlas-one",
            turnKey: "",
            source: "terminal-memory-events",
            state: "queued",
            candidate: { type: kind, scope, content: ticketContent, evidence },
            downgraded: false,
            createdAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
          };
          if (!appendOneLedgerRecord(ledger, ticket)) return written;
          seen.add(key);
          written += 1;
        }
      }
      return written;
    });
    return Number.isInteger(result) ? result : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {import('./session.cjs').Session} session 방금 턴을 끝낸 세션
 * @param {object} parsed parseReplyFences 결과
 * @param {{orch?: object}} opts orch 미지정 시 session.orchestrator 사용
 * @returns 적용 영수증 { asks, memory, automations, delegates, refused }
 */
function applyReplyFences(session, parsed, opts = {}) {
  const orch = opts.orch || session.orchestrator || null;
  const record = (ev) => session._record({ at: Date.now(), ...ev });
  const receipts = { asks: 0, memory: null, automations: [], delegates: [], refused: [] };
  const permission = permissions.normalize(session.permission);
  const canWrite = permission !== "read";

  // 파서가 표면화한 오류(잘못된 스케줄 등) — 조용히 삼키지 않는다.
  for (const err of parsed.errors || []) {
    record({ type: "fence-error", text: err });
  }

  /* ── asks → 세션 이벤트 (REPL 렌더러가 표면화) ───────────────────────── */
  for (const ask of parsed.asks || []) {
    record({ type: "ask", payload: ask });
    receipts.asks += 1;
  }

  /* ── memoryEvents → curate 게이트 (제안 ≠ 승인) ─────────────────────── */
  if (Array.isArray(parsed.memoryEvents) && parsed.memoryEvents.length) {
    const memoryEvents = boundMemoryEvents(parsed.memoryEvents);
    // 프로젝트 경계: 명시 초기화된(.agentlas 존재) 폴더만 project 스코프 대상 —
    // 임의 cwd 에 .agentlas 스캐폴딩을 만들지 않는다(session.cjs 프롬프트 증강과 동일 기준).
    let projectPath = null;
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      projectPath = fs.existsSync(path.join(session.cwd, ".agentlas")) ? session.cwd : null;
    } catch { projectPath = null; }
    const ctx = {
      permission,
      projectPath,
      agentId: session.agent.id,
      curatedMemories: [],
    };
    // 게이트 로직을 복제하지 않기 위해 이벤트를 정확한 wire 블록으로 재구성해
    // curateCliReply 에 그대로 통과시킨다(시크릿/스코프/중복/권한 게이트 전부 재사용).
    const heading = memoryCurate.loadArch().eventsHeading;
    const block = `${heading}\n\`\`\`json\n${JSON.stringify(memoryEvents)}\n\`\`\``;
    try {
      memoryCurate.curateCliReply(session.db, block, ctx);
    } catch { /* 게이트 실패가 턴 자체를 죽이면 안 된다 */ }
    receipts.memory = {
      candidates: parsed.memoryEvents.length,
      written: ctx.curatedMemories.length,
      permission,
    };
    // Agentlas One 이 켜져 있으면 에이전트 스코프 후보를 One 서랍에도 티켓으로 넘긴다.
    // 프로젝트 스코프는 여기 남기고 옮기지 않는다 — One 은 프로젝트를 넘나드는 정체성이라
    // agent_repo/user_identity 만 One 의 것이다(기획 2.2 스코프 경계).
    receipts.memory.one = forwardToOne(ctx.curatedMemories, permission);
    // read 권한 턴 = durable 쓰기 0 — 영수증 이벤트만 남는다.
    record({ type: "memory-curated", ...receipts.memory });
  }

  /* ── automations → automation/store.cjs addAutomation ────────────────── */
  for (const a of parsed.automations || []) {
    if (!canWrite) {
      // Desktop automationPermissionRequired(client.ts:3500) 과 동일한 정직 거부.
      const refusal = { type: "automation-refused", name: a.name, reason: "write permission required" };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    if (session.parent || session.chatKind === "division") {
      // division 서브세션(자동화 marker 세션 포함)의 자동화 등록 금지 — 자동화가
      // 자동화를 만드는 재귀 방지. 데스크탑 client.ts:3493(chat.kind !== 'division')과 동형:
      // parent 없는 자동화 실행 세션도 division 챗이므로 반드시 이 가드에 걸려야 한다.
      const refusal = { type: "automation-refused", name: a.name, reason: "division session may not register automations" };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    // 파서가 이미 스케줄을 검증했지만, next_run_at 이 실제로 계산되는지 최종 확인.
    // 시계 없는 행(next_run_at NULL)은 앱 스케줄러가 영영 안 깨운다 — 등록 거부가 정직.
    const next = schedule.nextAutomationRun({ schedule: a.schedule, timezone: a.tz || null });
    if (!next) {
      const refusal = { type: "automation-refused", name: a.name, reason: `schedule "${a.schedule}" has no next run` };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    try {
      const id = automationStore.addAutomation(session.db, {
        name: a.name,
        targetType: "agent",
        targetId: session.agent.id, // 실행 주체 = 이 세션의 에이전트
        cron: a.schedule, // 레거시 미러 토큰(schedule 열) — daemon 이 legacyScheduleSpec 으로 해석
        prompt: a.prompt,
        tz: a.tz || null,
      }, next);
      const receipt = {
        type: "automation-registered",
        id,
        name: a.name,
        schedule: a.schedule,
        nextRunAt: next.toISOString(),
        // steps[] 는 wire 로 받았지만 터미널은 그래프 합성이 없다 — 위장하지 않고 표기.
        ...(a.steps ? { stepsIgnored: a.steps.length } : {}),
      };
      record(receipt);
      receipts.automations.push(receipt);
    } catch (e) {
      const refusal = { type: "automation-refused", name: a.name, reason: (e && e.message) || String(e) };
      record(refusal);
      receipts.refused.push(refusal);
    }
  }

  /* ── delegates → 오케스트레이터로 division 서브세션 스폰 ─────────────── */
  // 상한은 lazy require — session.cjs ↔ orchestrator.cjs 로드 사이클 방지.
  const { maxParallel } = require("./orchestrator.cjs");
  for (const d of parsed.delegates || []) {
    if (!orch || !session.key) {
      const refusal = { type: "delegate-refused", target: d.target, reason: "no orchestrator attached to this session" };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    const brief = (d.brief || "").trim();
    if (!brief) {
      const refusal = { type: "delegate-refused", target: d.target, reason: "empty delegate brief" };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    if (orch.runningCount() >= maxParallel()) {
      // 상한 초과 = 대기가 아니라 정직한 거부(오케스트레이터 정책과 동일).
      const refusal = {
        type: "delegate-refused",
        target: d.target,
        reason: `parallel limit ${maxParallel()} reached (running: ${orch.runningCount()})`,
      };
      record(refusal);
      receipts.refused.push(refusal);
      continue;
    }
    // 부모의 런타임/권한/작업폴더를 물려받는 division 자식. spawnImpl/timeoutConfig
    // 전달은 계약 테스트(오프라인 fake spawn)를 위해 필요하고 프로덕션에선 null 이다.
    const child = orch.spawn({
      agent: session.agent,
      runtime: session.runtime,
      permission,
      cwd: session.cwd,
      parentKey: session.key,
      activate: false,
      title: `delegate: ${d.target}`,
      spawnImpl: session._spawnImpl,
      timeoutConfig: session._timeoutConfig,
    });
    try {
      const promise = orch.sendTo(child.key, brief);
      const receipt = { type: "delegate-spawned", key: child.key, target: d.target, allocation: d.allocation || null };
      record(receipt);
      receipts.delegates.push({ key: child.key, target: d.target, promise });
    } catch (e) {
      // sendTo 의 상한 판정이 최종 권위다(스폰 사이 레이스) — 스폰만 된 유령 세션은 제거.
      orch.remove(child.key);
      const refusal = { type: "delegate-refused", target: d.target, reason: (e && e.message) || String(e) };
      record(refusal);
      receipts.refused.push(refusal);
    }
  }

  return receipts;
}

// forwardToOne 은 One 서랍 전달의 유일한 지점이라 계약 테스트가 직접 잴 수 있게 함께 노출한다.
module.exports = { applyReplyFences, forwardToOne };
