"use strict";
/*
 * automation/schedule — cron/프리셋 파싱 + 다음 실행 시각 계산 (순수 모듈, DB 없음).
 *
 * v1 engine/agentlas-parity.cjs 의 검증된 파서를 그대로 포팅했다 — 알고리즘 재작성 금지.
 * 미니 cron (5필드: 분 시 일 월 요일). 앱 스케줄러(croner)는 next_run_at IS NULL 을
 * "시계 없음"으로 취급하므로 CLI가 직접 next_run_at 을 채워야 한다.
 *
 * 타임존: Intl.DateTimeFormat 으로 UTC 순간을 해당 존 로컬 파트로 투영하며 1분씩
 * 전진 탐색한다. 이 방식은 DST 를 자연스럽게 흡수한다 — 봄에 사라지는 시각(예:
 * America/New_York 02:30, DST 시작일)은 그날 매치가 없어 다음 날로 넘어가고,
 * 가을에 두 번 오는 시각은 첫 번째(UTC 기준 이른 쪽)만 잡는다.
 */

function cronField(expr, min, max) {
  const set = new Set();
  for (const part of String(expr).split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      const range = m[1].split("-").map(Number);
      lo = range[0];
      hi = range.length > 1 ? range[1] : m[2] ? max : range[0];
    }
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const zonedFormatterCache = new Map();
const zonedCalendarFormatterCache = new Map();

function zonedDateParts(date, timezone) {
  if (!timezone) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      day: date.getDate(),
      month: date.getMonth() + 1,
      weekday: date.getDay(),
    };
  }
  let formatter = zonedFormatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      minute: "2-digit",
      hour: "2-digit",
      day: "2-digit",
      month: "2-digit",
      weekday: "short",
    });
    zonedFormatterCache.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

function zonedCalendarParts(date, timezone) {
  let formatter = zonedCalendarFormatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    zonedCalendarFormatterCache.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function calendarDayNumber(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function zonedCalendarTime(parts, timezone) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let candidate = new Date(desired);
  for (let i = 0; i < 4; i++) {
    const actual = zonedCalendarParts(candidate, timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const corrected = desired - (actualAsUtc - candidate.getTime());
    if (corrected === candidate.getTime()) return candidate;
    candidate = new Date(corrected);
  }
  return candidate;
}

function nextLocalDayStart(date, timezone) {
  if (!timezone) {
    const next = new Date(date.getTime());
    next.setHours(0, 0, 0, 0);
    next.setDate(next.getDate() + 1);
    return next;
  }

  const current = zonedCalendarParts(date, timezone);
  const nextDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const target = {
    year: nextDay.getUTCFullYear(),
    month: nextDay.getUTCMonth() + 1,
    day: nextDay.getUTCDate(),
    hour: 0,
    minute: 0,
  };
  const targetDay = calendarDayNumber(target);
  let candidate = zonedCalendarTime(target, timezone);

  // Midnight can be skipped by a timezone transition. Accept the first instant
  // that has reached the next local calendar day (or a later, non-existent day).
  for (let i = 0; i < 48; i++) {
    if (candidate.getTime() > date.getTime()) {
      const actual = zonedCalendarParts(candidate, timezone);
      if (calendarDayNumber(actual) >= targetDay) return candidate;
    }
    candidate = new Date(candidate.getTime() + 60 * 60 * 1000);
  }
  return null;
}

function nextCronRun(cron, from = new Date(), timezone = null) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minS, hourS, domS, monS, dowS] = parts;
  const mins = cronField(minS, 0, 59);
  const hours = cronField(hourS, 0, 23);
  const doms = cronField(domS, 1, 31);
  const mons = cronField(monS, 1, 12);
  const dows = cronField(dowS, 0, 7);
  if (!mins || !hours || !doms || !mons || !dows) return null;
  if (dows.has(7)) dows.add(0); // cron 관례: 7 = 일요일 별칭
  try {
    if (timezone) zonedDateParts(from, timezone); // 잘못된 IANA 존이면 여기서 throw → null
  } catch {
    return null;
  }
  const fromMs = from.getTime();
  if (!Number.isFinite(fromMs)) return null;
  const t = new Date(fromMs);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const searchUntil = fromMs + 8 * 366 * 24 * 60 * 60 * 1000;
  while (t.getTime() <= searchUntil) {
    const local = zonedDateParts(t, timezone);
    const domOk = doms.has(local.day);
    const dowOk = dows.has(local.weekday);
    // 표준 cron: dom/dow 둘 다 제한이면 OR, 아니면 AND
    const domRestricted = domS !== "*";
    const dowRestricted = dowS !== "*";
    const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
    const monthOk = mons.has(local.month);
    if (monthOk && dayOk && hours.has(local.hour) && mins.has(local.minute)) return t;
    if (!monthOk || !dayOk) {
      const dayStart = nextLocalDayStart(t, timezone);
      if (dayStart && dayStart.getTime() > t.getTime()) {
        t.setTime(dayStart.getTime());
        continue;
      }
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

/**
 * IANA 타임존으로 해석 가능한지만 본다(빈 값 = 로컬존이므로 유효).
 * nextCronRun 은 cron 파싱 실패와 잘못된 존을 똑같이 null 로 접어버리므로,
 * 호출부가 "어느 필드가 틀렸는지"를 구분하려면 이 검사가 따로 필요하다.
 */
function isValidTimezone(timezone) {
  if (!timezone) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(timezone) });
    return true;
  } catch {
    return false;
  }
}

function localTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** 레거시 미러 토큰(hourly / every-15m / daily-9:30 / weekday- / weekly- / monthly- / cron:) → spec. */
function legacyScheduleSpec(raw, timezone) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (value.startsWith("cron:")) {
    const expr = value.slice(5).trim();
    return expr ? { kind: "cron", expr, tz: timezone } : null;
  }
  if (value.split(/\s+/).length === 5) return { kind: "cron", expr: value, tz: timezone };
  if (value === "hourly") return { kind: "interval", everyMs: 60 * 60 * 1000, anchor: "lastRun" };
  const every = value.match(/^every-(\d+)(m|h)$/);
  if (every) {
    const amount = Number(every[1]);
    if (amount > 0) return { kind: "interval", everyMs: amount * (every[2] === "h" ? 3600000 : 60000), anchor: "lastRun" };
  }
  let match = value.match(/^daily-(\d{1,2}):(\d{2})$/);
  if (match) return { kind: "cron", expr: `${Number(match[2])} ${Number(match[1])} * * *`, tz: timezone };
  match = value.match(/^weekday-(\d{1,2}):(\d{2})$/);
  if (match) return { kind: "cron", expr: `${Number(match[2])} ${Number(match[1])} * * 1-5`, tz: timezone };
  match = value.match(/^weekly-(sun|mon|tue|wed|thu|fri|sat)-(\d{1,2}):(\d{2})$/i);
  if (match) {
    const dow = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[match[1].toLowerCase()];
    return { kind: "cron", expr: `${Number(match[3])} ${Number(match[2])} * * ${dow}`, tz: timezone };
  }
  match = value.match(/^monthly-(\d{1,2})-(\d{1,2}):(\d{2})$/);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 31) {
    return { kind: "cron", expr: `${Number(match[3])} ${Number(match[2])} ${Number(match[1])} * *`, tz: timezone };
  }
  return null;
}

/**
 * Desktop schedule_json + 레거시 미러 토큰 패리티(IANA 타임존 포함).
 * row: { schedule, schedule_json?, timezone? }
 */
function nextAutomationRun(row, from = new Date()) {
  const timezone = row.timezone || localTimezone();
  let spec = null;
  if (row.schedule_json && String(row.schedule_json).trim()) {
    try {
      const parsed = JSON.parse(row.schedule_json);
      if (parsed && typeof parsed.kind === "string") spec = parsed;
    } catch { /* fall through to legacy schedule */ }
  }
  if (!spec) spec = legacyScheduleSpec(row.schedule, timezone);
  if (!spec) {
    // Desktop computeNextRun 은 해석 불가한 레거시 스케줄을 24시간 폴백으로 보존한다.
    // 더 중요하게: due 행을 같은 시각에 그대로 두면 무한 재발화한다 — 반드시 전진.
    return row.schedule ? new Date(from.getTime() + 24 * 3600 * 1000) : null;
  }
  if (spec.kind === "cron") return nextCronRun(spec.expr, from, spec.tz || timezone);
  if (spec.kind === "interval") {
    const every = Number(spec.everyMs);
    if (!Number.isFinite(every) || every <= 0) return null;
    return spec.anchor === "wallclock"
      ? new Date(Math.ceil((from.getTime() + 1) / every) * every)
      : new Date(from.getTime() + every);
  }
  if (spec.kind === "once") {
    const at = new Date(spec.atIso);
    return at.getTime() > from.getTime() ? at : null;
  }
  return null;
}

module.exports = {
  cronField,
  zonedDateParts,
  nextCronRun,
  isValidTimezone,
  localTimezone,
  legacyScheduleSpec,
  nextAutomationRun,
};
