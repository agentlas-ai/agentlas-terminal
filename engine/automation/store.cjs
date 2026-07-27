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
const { columnExists, tableExists } = require("../core/db.cjs");
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
  return db.prepare("SELECT * FROM automations WHERE id LIKE ?").get(String(idPrefix) + "%") || null;
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
  if (enabled) {
    const next = nextAutomationRun(row) || null;
    db.prepare("UPDATE automations SET enabled=1, next_run_at=? WHERE id=?").run(next ? next.toISOString() : null, row.id);
    return next;
  }
  db.prepare("UPDATE automations SET enabled=0 WHERE id=?").run(row.id);
  return null;
}

function removeAutomation(db, id) {
  db.prepare("DELETE FROM automations WHERE id=?").run(id);
}

/**
 * 리스 획득 — 앱 스케줄러와 같은 SQLite 리스(claimed_at TTL 15분)로 중복 실행 방지.
 * 원자적 조건부 UPDATE 하나로 판정한다(SELECT 후 UPDATE 금지 — 레이스).
 * @returns {boolean} true = 이 프로세스가 배타 실행권을 가짐
 */
function claimAutomation(db, id, now = new Date(), owner = LEASE_OWNER) {
  // 리스 열이 없으면 배타성을 증명할 수 없다 — 중복 실행 위험을 감수하지 않고 거부.
  if (!leaseSupported(db)) return false;
  const cutoff = new Date(now.getTime() - LEASE_TTL_MS).toISOString();
  const result = db
    .prepare(
      "UPDATE automations SET claimed_at = ?, lease_owner = ? WHERE id = ? AND enabled = 1 AND (claimed_at IS NULL OR claimed_at < ?)",
    )
    .run(now.toISOString(), owner, id, cutoff);
  return (result.changes ?? result.rowsAffected ?? 0) > 0;
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
  if (!leaseSupported(db)) return false;
  try {
    const result = db
      .prepare("UPDATE automations SET claimed_at = ? WHERE id = ? AND lease_owner = ?")
      .run(now.toISOString(), id, owner);
    return (result.changes ?? result.rowsAffected ?? 0) > 0;
  } catch {
    return false;
  }
}

function releaseAutomation(db, id) {
  try {
    db.prepare("UPDATE automations SET claimed_at = NULL, lease_owner = NULL WHERE id = ?").run(id);
  } catch { /* best-effort */ }
}

/**
 * 실행 기록 — run_history(v1/Desktop 스케줄러 패리티) + automation_runs(있으면) 양쪽.
 * best-effort: 기록 실패가 자동화 실행 자체를 죽이면 안 된다.
 */
function recordRun(db, automationId, status, error, scheduledFor) {
  const nowIso = new Date().toISOString();
  try {
    if (tableExists(db, "run_history")) {
      db.prepare(
        "INSERT INTO run_history (id, automation_id, scheduled_for, ran_at, status, skipped_count, error) VALUES (?,?,?,?,?,0,?)",
      ).run(crypto.randomUUID(), automationId, scheduledFor || null, nowIso, status, error || null);
    }
  } catch { /* best-effort */ }
  try {
    if (tableExists(db, "automation_runs")) {
      db.prepare(
        "INSERT INTO automation_runs (id, automation_id, started_at, status, node_states_json) VALUES (?,?,?,?,NULL)",
      ).run(crypto.randomUUID(), automationId, nowIso, status);
    }
  } catch { /* best-effort */ }
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
 * 실행 후 스케줄 북키핑 — v1 runAutomationOnce 의 성공/실패 분기와 동일:
 *  - 성공: run_count 증가. 실패: last_run_at 만 갱신(성공 카운트 오염 금지).
 *  - advanceSchedule(데몬 경로)일 때만 next_run_at 전진; 다음 시각이 없으면 비활성화.
 *  - run-now(advanceSchedule=false)는 스케줄을 건드리지 않는다(앱 advanceSchedule=false와 동일).
 */
function advanceAfterRun(db, row, { ok, advanceSchedule, ranAt = new Date() } = {}) {
  const hasRunCount = columnExists(db, "automations", "run_count");
  const shouldAdvance = !!advanceSchedule && (row.trigger_type || "schedule") === "schedule";
  const advance = shouldAdvance ? nextAutomationRun(row, ranAt) : null;
  if (ok) {
    if (shouldAdvance) {
      if (hasRunCount) {
        db.prepare(
          "UPDATE automations SET last_run_at = ?, run_count = run_count + 1, next_run_at = ?, enabled = ? WHERE id = ?",
        ).run(ranAt.toISOString(), advance ? advance.toISOString() : null, advance ? row.enabled : 0, row.id);
      } else {
        db.prepare("UPDATE automations SET last_run_at = ?, next_run_at = ?, enabled = ? WHERE id = ?")
          .run(ranAt.toISOString(), advance ? advance.toISOString() : null, advance ? row.enabled : 0, row.id);
      }
    } else if (hasRunCount) {
      db.prepare("UPDATE automations SET last_run_at = ?, run_count = run_count + 1 WHERE id = ?")
        .run(ranAt.toISOString(), row.id);
    } else {
      db.prepare("UPDATE automations SET last_run_at = ? WHERE id = ?").run(ranAt.toISOString(), row.id);
    }
    // max_runs 도달 시 비활성화 (앱과 동일한 종료 조건).
    if (row.max_runs && (row.run_count || 0) + 1 >= row.max_runs) {
      db.prepare("UPDATE automations SET enabled = 0 WHERE id = ?").run(row.id);
      return { advance, maxRunsReached: true };
    }
  } else if (shouldAdvance) {
    db.prepare("UPDATE automations SET last_run_at = ?, next_run_at = ?, enabled = ? WHERE id = ?")
      .run(ranAt.toISOString(), advance ? advance.toISOString() : null, advance ? row.enabled : 0, row.id);
  } else {
    db.prepare("UPDATE automations SET last_run_at = ? WHERE id = ?").run(ranAt.toISOString(), row.id);
  }
  return { advance, maxRunsReached: false };
}

/** 데몬 폴링: 활성 + 스케줄 트리거 + next_run_at 도래분. trigger_type 열은 방어적. */
function dueAutomations(db, nowIso = new Date().toISOString(), limit = 5) {
  if (!tableExists(db, "automations")) return [];
  const triggerFilter = columnExists(db, "automations", "trigger_type") ? "AND trigger_type = 'schedule'" : "";
  return db.prepare(
    `SELECT * FROM automations WHERE enabled = 1 ${triggerFilter} AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?`,
  ).all(nowIso, limit);
}

module.exports = {
  LEASE_TTL_MS,
  LEASE_OWNER,
  leaseSupported,
  listAutomations,
  getAutomationByPrefix,
  addAutomation,
  setEnabled,
  removeAutomation,
  claimAutomation,
  renewAutomationLease,
  releaseAutomation,
  recordRun,
  listRuns,
  advanceAfterRun,
  dueAutomations,
};
