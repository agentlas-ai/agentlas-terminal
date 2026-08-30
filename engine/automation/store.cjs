"use strict";
/*
 * automation/store — automations 테이블 DB 표면 (목록/추가/토글/삭제 + 리스 + 실행 기록).
 *
 * 스키마 소유권: 정본은 데스크탑 앱. 이 모듈은 base 열(id, name, schedule,
 * target_type, target_id, prompt_template, enabled, created_at, next_run_at,
 * last_run_at)만 전제하고, 그 뒤에 추가된 열(timezone, trigger_type, tool_mode,
 * hub_mode, run_count, claimed_at, lease_owner, …)은 columnExists 로 방어한다.
 *
 * 리스 계약(절대 약화 금지): claimed_at TTL 15분 — 앱 store/automations.ts 의
 * LEASE_TTL_MS 와 동일. Desktop 스케줄러와 터미널 데몬이 같은 SQLite 를 보므로,
 * 리스를 잡지 못한 쪽은 절대 실행하지 않는다(중복 실행 = codex 자동화 전멸급 사고).
 * 리스 열이 없는 구형 DB에서는 배타성을 증명할 수 없으므로 fail-closed(실행 거부).
 */
const crypto = require("node:crypto");
const os = require("node:os");
const { columnExists, tableExists, runWriteTransaction } = require("../core/db.cjs");
const { nextAutomationRun } = require("./schedule.cjs");

const LEASE_TTL_MS = 15 * 60 * 1000; // 앱 store/automations.ts LEASE_TTL_MS와 동일
const LEASE_OWNER = `cli:${os.hostname()}:${process.pid}`;

function leaseSupported(db) {
  return columnExists(db, "automations", "claimed_at") && columnExists(db, "automations", "lease_owner");
}

function listAutomations(db) {
  if (!tableExists(db, "automations")) return [];
  return db.prepare("SELECT * FROM automations ORDER BY created_at DESC").all();
}

function getAutomationByPrefix(db, idPrefix) {
  if (!tableExists(db, "automations")) return null;
  const prefix = String(idPrefix || "").trim();
  if (!prefix) return null;
  const exact = db.prepare("SELECT * FROM automations WHERE id = ?").get(prefix);
  if (exact) return exact;
  // LIKE를 쓰면 사용자가 입력한 %/_가 와일드카드가 되어 전혀 다른 행을 고른다.
  // 두 행 이상이면 임의의 첫 행을 mutation 대상으로 삼지 않고 전체 ID를 요구한다.
  const matches = db.prepare(
    "SELECT * FROM automations WHERE substr(id, 1, length(?)) = ? ORDER BY id LIMIT 2",
  ).all(prefix, prefix);
  if (matches.length > 1) throw new Error(`automation id prefix is ambiguous: ${prefix}`);
  return matches[0] || null;
}

function resultChanges(result) {
  return Number(result && (result.changes ?? result.rowsAffected) || 0);
}

function validLease(lease) {
  return Boolean(
    lease && typeof lease.owner === "string" && lease.owner &&
    typeof lease.claimedAt === "string" && lease.claimedAt,
  );
}

/**
 * Build the fencing predicate for a post-claim write. When a legacy caller has
 * no lease token, only an actually-unclaimed row may be updated; an active
 * successor lease is never touched. The daemon always supplies the exact
 * owner+claimed_at pair returned by claimAutomationLease().
 */
function leaseFence(db, id, lease = null, row = null) {
  const parts = ["id = ?"];
  const params = [id];
  if (!leaseSupported(db)) return { sql: parts.join(" AND "), params };
  if (validLease(lease)) {
    parts.push("lease_owner = ?", "claimed_at = ?");
    params.push(lease.owner, lease.claimedAt);
  } else if (row && row.lease_owner == null && row.claimed_at == null) {
    parts.push("lease_owner IS NULL", "claimed_at IS NULL");
  } else {
    parts.push("0");
  }
  return { sql: parts.join(" AND "), params };
}

/**
 * 자동화 추가. spec: { name, targetType, targetId, cron, prompt, tz?, disabled? }
 * next_run_at 은 호출자가 검증한 nextCronRun 결과(Date)를 받는다.
 * @returns {string} 새 automation id
 */
function addAutomation(db, spec, next) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const cols = ["id", "name", "schedule", "target_type", "target_id", "prompt_template", "enabled", "created_at", "next_run_at"];
  const vals = [
    id,
    spec.name,
    spec.cron,
    spec.targetType,
    spec.targetId,
    spec.prompt,
    spec.disabled ? 0 : 1,
    now,
    next ? next.toISOString() : null,
  ];
  // 데스크탑이 나중에 추가한 열 — 있으면 v1과 동일한 값으로 채운다.
  const optional = {
    created_by: "cli",
    timezone: spec.tz || null,
    trigger_type: "schedule",
    tool_mode: "auto",
    hub_mode: "hub-allowed",
    run_count: 0,
  };
  for (const [col, v] of Object.entries(optional)) {
    if (columnExists(db, "automations", col)) {
      cols.push(col);
      vals.push(v);
    }
  }
  db.prepare(`INSERT INTO automations (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...vals);
  return id;
}

/** on: next_run_at 재계산 후 활성화. off: 비활성화(스케줄 보존). */
function setEnabled(db, row, enabled) {
  return setEnabledChecked(db, row, enabled).next;
}

function setEnabledChecked(db, row, enabled) {
  if (enabled) {
    const next = nextAutomationRun(row) || null;
    const result = db.prepare("UPDATE automations SET enabled=1, next_run_at=? WHERE id=?").run(next ? next.toISOString() : null, row.id);
    return { changed: resultChanges(result) > 0, next };
  }
  const result = db.prepare("UPDATE automations SET enabled=0 WHERE id=?").run(row.id);
  return { changed: resultChanges(result) > 0, next: null };
}

function removeAutomation(db, id) {
  return resultChanges(db.prepare("DELETE FROM automations WHERE id=?").run(id)) > 0;
}

/**
 * 리스 획득 — 앱 스케줄러와 같은 SQLite 리스(claimed_at TTL 15분)로 중복 실행 방지.
 * 원자적 조건부 UPDATE 하나로 판정한다(SELECT 후 UPDATE 금지 — 레이스).
 * @returns {boolean} true = 이 프로세스가 배타 실행권을 가짐
 */
function claimAutomation(db, id, now = new Date(), owner = LEASE_OWNER) {
  return Boolean(claimAutomationLease(db, id, now, owner));
}

/** Claim and return the exact owner+claimed_at fence used by this run. */
function claimAutomationLease(db, id, now = new Date(), owner = LEASE_OWNER) {
  // 리스 열이 없으면 배타성을 증명할 수 없다 — 중복 실행 위험을 감수하지 않고 거부.
  if (!leaseSupported(db)) return null;
  const cutoff = new Date(now.getTime() - LEASE_TTL_MS).toISOString();
  const claimedAt = now.toISOString();
  const result = db
    .prepare(
      "UPDATE automations SET claimed_at = ?, lease_owner = ? WHERE id = ? AND enabled = 1 AND (claimed_at IS NULL OR claimed_at < ?)",
    )
    .run(claimedAt, owner, id, cutoff);
  return resultChanges(result) > 0 ? { owner, claimedAt } : null;
}

/**
 * 이 프로세스가 아직 들고 있는 리스의 claimed_at 을 현재로 민다.
 *
 * claimAutomation 은 한 번만 부르고 갱신이 없었다. 데스크탑 스케줄러는 60초마다
 * 갱신하므로, TTL(15분)을 넘긴 CLI 실행은 프로세스가 멀쩡히 살아 있는데도
 * 회수 대상이 된다 — 에이전트 세션에서 15분은 평범하고, 그러면 같은 자동화가
 * 두 실행기에서 겹쳐 돈다. 소유자가 나일 때만 갱신하므로, 이미 남에게 넘어간
 * 리스를 되빼앗지는 않는다.
 */
function renewAutomationLease(db, id, now = new Date(), owner = LEASE_OWNER) {
  if (arguments.length >= 5) return Boolean(renewAutomationLeaseToken(db, id, now, { owner, claimedAt: arguments[4] }));
  if (!leaseSupported(db)) return false;
  // false means definitive ownership loss. SQLite busy/I/O errors must throw
  // so the caller can retry instead of killing a valid run as if a peer had
  // taken the lease (Desktop renewAutomationRunLease contract).
  const result = db
    .prepare("UPDATE automations SET claimed_at = ? WHERE id = ? AND lease_owner = ? AND claimed_at IS NOT NULL")
    .run(now.toISOString(), id, owner);
  return resultChanges(result) > 0;
}

/** Renew an exact fence and return its new claimed_at value. */
function renewAutomationLeaseToken(db, id, now = new Date(), lease) {
  if (!leaseSupported(db) || !validLease(lease)) return null;
  const claimedAt = now.toISOString();
  const result = db
    .prepare("UPDATE automations SET claimed_at = ? WHERE id = ? AND lease_owner = ? AND claimed_at = ?")
    .run(claimedAt, id, lease.owner, lease.claimedAt);
  return resultChanges(result) > 0 ? { owner: lease.owner, claimedAt } : null;
}

function releaseAutomation(db, id, owner = LEASE_OWNER, claimedAt = null) {
  try {
    if (owner && typeof owner === "object") {
      claimedAt = owner.claimedAt || null;
      owner = owner.owner || LEASE_OWNER;
    }
    const token = typeof claimedAt === "string" && claimedAt ? " AND claimed_at = ?" : "";
    const result = db
      .prepare(`UPDATE automations SET claimed_at = NULL, lease_owner = NULL WHERE id = ? AND lease_owner = ?${token}`)
      .run(...(token ? [id, owner, claimedAt] : [id, owner]));
    return resultChanges(result) > 0;
  } catch { return false; }
}

/**
 * 실행 기록 — run_history(v1/Desktop 스케줄러 패리티) + automation_runs(있으면) 양쪽.
 * best-effort: 기록 실패가 자동화 실행 자체를 죽이면 안 된다.
 */
function recordRun(db, automationId, status, error, scheduledFor, lease) {
  if (!leaseSupported(db) || !validLease(lease)) return { ok: false, leaseLost: true, recorded: false };
  const nowIso = new Date().toISOString();
  try {
    return runWriteTransaction(db, () => {
      const fence = leaseFence(db, automationId, lease);
      let recorded = false;
      if (tableExists(db, "run_history")) {
        const result = db.prepare(
          `INSERT INTO run_history (id, automation_id, scheduled_for, ran_at, status, skipped_count, error)
             SELECT ?,?,?,?,?,0,? FROM automations WHERE ${fence.sql}`,
        ).run(crypto.randomUUID(), automationId, scheduledFor || null, nowIso, status, error || null, ...fence.params);
        recorded = recorded || resultChanges(result) > 0;
      }
      if (tableExists(db, "automation_runs")) {
        const result = db.prepare(
          `INSERT INTO automation_runs (id, automation_id, started_at, status, node_states_json)
             SELECT ?,?,?,?,NULL FROM automations WHERE ${fence.sql}`,
        ).run(crypto.randomUUID(), automationId, nowIso, status, ...fence.params);
        recorded = recorded || resultChanges(result) > 0;
      }
      const stillOwned = db.prepare(`SELECT 1 FROM automations WHERE ${fence.sql}`).get(...fence.params);
      return { ok: Boolean(stillOwned), leaseLost: !stillOwned, recorded };
    });
  } catch (error) {
    return { ok: false, leaseLost: false, recorded: false, error: String((error && error.message) || error) };
  }
}

function listRuns(db, limit = 15) {
  if (!tableExists(db, "run_history")) return [];
  return db.prepare(
    `SELECT h.ran_at, h.status, h.error, a.name FROM run_history h
       LEFT JOIN automations a ON a.id = h.automation_id
       ORDER BY h.ran_at DESC LIMIT ?`,
  ).all(Math.max(1, limit));
}

/**
 * 다음 회차가 없어 자동화를 끝낼 때만 쓰는 단방향(끄기 전용) write.
 *
 * advanceAfterRun 은 실행 시작 시점의 row 스냅샷을 들고 있는데, 그 사이 사용자가
 * 다른 터미널이나 Desktop 토글로 `automation off` 를 할 수 있다(에이전트 실행은
 * 수 분~수십 분). 스냅샷의 enabled 를 되쓰면 그 끄기가 조용히 되돌아가고
 * ("Disabled: … morning" 을 보고 exit 0 인데도) 다음 예정 시각에 또 발화한다.
 * 그래서 enabled 는 "켜기"로는 절대 쓰지 않고, 종료 조건일 때만 0 으로 내린다.
 */
function disableExhausted(db, id, lease = null, row = null) {
  const fence = leaseFence(db, id, lease, row);
  return resultChanges(db.prepare(`UPDATE automations SET enabled = 0 WHERE ${fence.sql}`).run(...fence.params)) > 0;
}

/**
 * 실행 후 스케줄 북키핑 — v1 runAutomationOnce 의 성공/실패 분기와 동일:
 *  - 성공: run_count 증가. 실패: last_run_at 만 갱신(성공 카운트 오염 금지).
 *  - advanceSchedule(데몬 경로)일 때만 next_run_at 전진; 다음 시각이 없으면 비활성화.
 *  - run-now(advanceSchedule=false)는 스케줄을 건드리지 않는다(앱 advanceSchedule=false와 동일).
 *
 * enabled 는 여기서 스냅샷 값으로 되쓰지 않는다 — disableExhausted 주석 참조.
 * (같은 이유로 성공/실패 두 분기 모두 같은 규칙을 따라야 한다: 한쪽만 고치면
 *  실패로 끝난 실행이 여전히 끈 자동화를 부활시킨다.)
 */
function advanceAfterRun(db, row, { ok, advanceSchedule, ranAt = new Date(), lease = null } = {}) {
  const hasRunCount = columnExists(db, "automations", "run_count");
  const shouldAdvance = !!advanceSchedule && (row.trigger_type || "schedule") === "schedule";
  const advance = shouldAdvance ? nextAutomationRun(row, ranAt) : null;
  try {
    return runWriteTransaction(db, () => {
      const fence = leaseFence(db, row.id, lease, row);
      let result;
      if (ok) {
        if (shouldAdvance) {
          const sql = hasRunCount
            ? "UPDATE automations SET last_run_at = ?, run_count = run_count + 1, next_run_at = ?"
            : "UPDATE automations SET last_run_at = ?, next_run_at = ?";
          result = db.prepare(`${sql} WHERE ${fence.sql}`).run(
            ranAt.toISOString(), advance ? advance.toISOString() : null, ...fence.params,
          );
        } else if (hasRunCount) {
          result = db.prepare(`UPDATE automations SET last_run_at = ?, run_count = run_count + 1 WHERE ${fence.sql}`)
            .run(ranAt.toISOString(), ...fence.params);
        } else {
          result = db.prepare(`UPDATE automations SET last_run_at = ? WHERE ${fence.sql}`).run(ranAt.toISOString(), ...fence.params);
        }
      } else if (shouldAdvance) {
        result = db.prepare(`UPDATE automations SET last_run_at = ?, next_run_at = ? WHERE ${fence.sql}`)
          .run(ranAt.toISOString(), advance ? advance.toISOString() : null, ...fence.params);
      } else {
        result = db.prepare(`UPDATE automations SET last_run_at = ? WHERE ${fence.sql}`).run(ranAt.toISOString(), ...fence.params);
      }
      if (resultChanges(result) === 0) return { advance, maxRunsReached: false, updated: false, leaseLost: true };

      let maxRunsReached = false;
      if (shouldAdvance && !advance) {
        if (!disableExhausted(db, row.id, lease, row)) {
          return { advance, maxRunsReached: false, updated: false, leaseLost: true };
        }
        maxRunsReached = true;
      }
      // max_runs 도달 시 비활성화 (앱과 동일한 종료 조건).
      if (ok && row.max_runs && (row.run_count || 0) + 1 >= row.max_runs) {
        if (!disableExhausted(db, row.id, lease, row)) {
          return { advance, maxRunsReached: false, updated: false, leaseLost: true };
        }
        maxRunsReached = true;
      }
      return { advance, maxRunsReached, updated: true, leaseLost: false };
    });
  } catch (error) {
    return {
      advance,
      maxRunsReached: false,
      updated: false,
      leaseLost: false,
      error: String((error && error.message) || error),
    };
  }
}

/**
 * 이 실행기가 실행할 수 없는 계열의 SQL 술어 — daemon.runnerSkip 게이트와 짝이다.
 * (hub 타깃 / tool_mode browser·computer-use = Desktop 몫.)
 * IFNULL 필수: SQLite 3치 논리에서 NULL 열이 있으면 NOT (…) 이 NULL 이 되어
 * 멀쩡한 행까지 조용히 사라진다.
 */
function runnerUnsupportedSql(db) {
  const parts = ["IFNULL(target_type,'') = 'hub'"];
  if (columnExists(db, "automations", "tool_mode")) {
    parts.push("IFNULL(tool_mode,'') IN ('browser','computer-use')");
  }
  return `(${parts.join(" OR ")})`;
}

/**
 * 데몬 폴링: 활성 + 스케줄 트리거 + next_run_at 도래분. trigger_type 열은 방어적.
 *
 * opts.runnable=true (데몬 실행 창): 이 실행기가 실행할 수 없는 행을 셀렉션에서 뺀다.
 * 이유(굶주림 근본): 미지원 행(Desktop 몫)과 남이 리스를 쥔 행은 스킵돼도 next_run_at
 * 이 전진하지 않는다 — 시간순 LIMIT n 창의 머리에 영구히 남아 뒤의 실행 가능한
 * 자동화를 전부 굶긴다(데몬은 멀쩡해 보이고 아무것도 안 돈다). 실행 못 할 행은
 * 애초에 창에 담지 않는 것이 유일한 근본 수리다 — 그 행의 회차는 그대로 보존된다.
 * opts.runnable=false: 그 미지원 행만(고지용). 미지정: 예전 그대로 전체.
 */
function dueAutomations(db, nowIso = new Date().toISOString(), limit = 5, opts = {}) {
  if (!tableExists(db, "automations")) return [];
  const where = ["enabled = 1"];
  const params = [];
  if (columnExists(db, "automations", "trigger_type")) where.push("trigger_type = 'schedule'");
  where.push("next_run_at IS NOT NULL", "next_run_at <= ?");
  params.push(nowIso);
  if (opts.runnable === true) {
    where.push(`NOT ${runnerUnsupportedSql(db)}`);
    if (leaseSupported(db)) {
      // 남이 유효 리스를 쥔 행은 claimAutomation 이 반드시 실패한다 — 같은 굶주림 경로.
      where.push("(claimed_at IS NULL OR claimed_at < ?)");
      params.push(new Date(Date.parse(nowIso) - LEASE_TTL_MS).toISOString());
    }
  } else if (opts.runnable === false) {
    where.push(runnerUnsupportedSql(db));
  }
  params.push(limit);
  return db.prepare(
    `SELECT * FROM automations WHERE ${where.join(" AND ")} ORDER BY next_run_at ASC LIMIT ?`,
  ).all(...params);
}

module.exports = {
  LEASE_TTL_MS,
  LEASE_OWNER,
  leaseSupported,
  listAutomations,
  getAutomationByPrefix,
  addAutomation,
  setEnabled,
  setEnabledChecked,
  removeAutomation,
  claimAutomation,
  claimAutomationLease,
  renewAutomationLease,
  renewAutomationLeaseToken,
  releaseAutomation,
  recordRun,
  listRuns,
  advanceAfterRun,
  dueAutomations,
  runnerUnsupportedSql,
};
