"use strict";
/*
 * sessions/fences — 에이전트 응답 속 숨은 펜스 프로토콜 파서 (Desktop runner 패리티).
 *
 * Desktop electron/mcp/client.ts 가 매 응답에서 파싱하는 4개 제어 블록의
 * WIRE FORMAT 을 그대로 복제한다 (파싱만; 적용은 apply-fences.cjs):
 *
 *  1. `## Memory Events` + ```json 펜스  — electron/memory/events.ts
 *     → engine/memory-cli/curate.cjs parseMemoryEventsCli 를 소비(재구현 금지).
 *  2. `## Delegate` + ```json 펜스       — electron/mcp/delegate.ts parseDelegations
 *     허용 형태: [{target,brief,allocation}] 배열 또는 {delegations:[...], synthesis}.
 *  3. `## Automation` + ```json 펜스     — electron/automation-emitter.ts parseAutomations
 *     [{name,prompt,agent?,hubAgent?,schedule: 문자열|{preset,time,tz,dow,day}|{cron,tz}, steps?}]
 *     단, Desktop 은 잘못된 스케줄을 daily-09:00 으로 폴백하지만 터미널은
 *     "스케줄을 추측하지 않는다" — 검증 실패는 errors 로 정직하게 거부한다.
 *  4. <<agentlas-ask>>{json}<</agentlas-ask>> — renderer/lib/ask-question.ts extractQuestions
 *     (여는/닫는 토큰이 다르다: 닫는 쪽은 <</agentlas-ask>>. 닫는 토큰이 없으면
 *      스트리밍 중일 수 있으므로 본문에 그대로 둔다.)
 *
 * 모든 블록은 cleanText(영속/표시용)에서 제거된다 — 사용자는 제어 블록을 보지 않는다.
 */

const memoryCurate = require("../memory-cli/curate.cjs");
const workloadRouting = require("../agentlas-workload-routing.cjs");
const schedule = require("../automation/schedule.cjs");

// Desktop electron/mcp/delegate.ts:13
const DELEGATE_HEADING = "## Delegate";
// Desktop electron/automation-emitter.ts:11
const AUTOMATION_HEADING = "## Automation";
// Desktop electron/confirm/index.ts:15-16 · renderer/lib/ask-question.ts:21-22
const ASK_OPEN = "<<agentlas-ask>>";
const ASK_CLOSE = "<</agentlas-ask>>";

// Fence payloads are model-authored input. Keep parsing and downstream
// side-effect loops bounded; oversized entries are refused, not truncated.
const MAX_FENCE_JSON_BYTES = 256 * 1024;
const MAX_DELEGATIONS = 64;
const MAX_AUTOMATIONS = 64;
const MAX_ASKS = 32;
const MAX_STEPS = 32;
const MAX_DELEGATE_ENTRY_BYTES = 16 * 1024;
const MAX_AUTOMATION_ENTRY_BYTES = 32 * 1024;
const MAX_STEPS_BYTES = 64 * 1024;
const MAX_TARGET_BYTES = 256;
const MAX_BRIEF_BYTES = 8 * 1024;
const MAX_NAME_BYTES = 256;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_AGENT_BYTES = 256;
const MAX_SCHEDULE_BYTES = 512;
const MAX_ASK_BODY_BYTES = 64 * 1024;

function utf8Bytes(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function boundedString(value, maxBytes) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return utf8Bytes(trimmed) <= maxBytes ? trimmed : null;
}

function jsonBytes(value) {
  try { return utf8Bytes(JSON.stringify(value)); } catch { return Infinity; }
}

/* ── ## Delegate (delegate.ts parseDelegations 포팅) ─────────────────────── */

function parseDelegateBlock(text) {
  const idx = text.lastIndexOf(DELEGATE_HEADING);
  if (idx < 0) return { delegations: [], synthesisAllocation: null, cleanedText: text.trim(), errors: [] };

  const after = text.slice(idx + DELEGATE_HEADING.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  let delegations = [];
  let synthesisAllocation = null;
  const errors = [];
  if (fence) {
    const jsonText = fence[1].trim();
    if (utf8Bytes(jsonText) > MAX_FENCE_JSON_BYTES) {
      errors.push("Delegate JSON exceeds " + MAX_FENCE_JSON_BYTES + " bytes");
    } else try {
      const data = JSON.parse(jsonText);
      const rawDelegations = Array.isArray(data)
        ? data
        : data && typeof data === "object" && Array.isArray(data.delegations)
          ? data.delegations
          : [];
      if (rawDelegations.length > MAX_DELEGATIONS) {
        errors.push("Delegate block exceeds maximum of " + MAX_DELEGATIONS + " entries");
      } else {
        if (!Array.isArray(data) && data && typeof data === "object" && data.synthesis) {
          synthesisAllocation = workloadRouting.normalizeAllocation(data.synthesis, "synthesize");
        }
        delegations = rawDelegations
          .map((d, index) => {
            if (!d || typeof d !== "object" || Array.isArray(d)) return null;
            if (jsonBytes(d) > MAX_DELEGATE_ENTRY_BYTES) {
              errors.push("Delegate entry " + (index + 1) + " exceeds " + MAX_DELEGATE_ENTRY_BYTES + " bytes");
              return null;
            }
            const target = boundedString(d.target, MAX_TARGET_BYTES);
            const brief = boundedString(d.brief, MAX_BRIEF_BYTES);
            if (target === null || brief === null) {
              errors.push("Delegate entry " + (index + 1) + " contains an oversized string");
              return null;
            }
            // Desktop 계약: target 만 필수. allocation 은 정규화 실패 시 null 로 남고
            // (레거시 텍스트 위임과 동일) 실행 측이 현재 모델 폴백 영수증을 남긴다.
            return target
              ? { target, brief, allocation: workloadRouting.normalizeAllocation(d.allocation, "delegate") }
              : null;
          })
          .filter(Boolean);
      }
    } catch {
      delegations = [];
      errors.push("Delegate JSON parse failed");
    }
  } else {
    errors.push("Delegate heading present but no JSON fence found");
  }

  let cut = text.length;
  if (fence && fence.index != null) {
    cut = idx + DELEGATE_HEADING.length + fence.index + fence[0].length;
  } else {
    cut = idx; // 펜스 없으면 dangling heading 도 제거 (Desktop 과 동일)
  }
  const cleanedText = (text.slice(0, idx) + text.slice(cut)).trim();
  return { delegations, synthesisAllocation, cleanedText, errors };
}

/* ── ## Automation (automation-emitter.ts parseAutomations 포팅, 정직 거부판) ── */

const DOW_TOKEN = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PRESETS = new Set(["daily", "weekday", "weekly", "monthly", "hourly"]);

// Desktop presetToLegacyToken(automation-emitter.ts:165) 과 동일한 미러 토큰.
function presetToLegacyToken(preset, time, o) {
  switch (preset) {
    case "hourly":
      return "hourly";
    case "daily":
      return `daily-${time}`;
    case "weekday":
      return `weekday-${time}`;
    case "weekly": {
      let dow = 1; // Desktop 기본값: 월요일 (스케줄 추측이 아니라 유효 프리셋 내 기본값)
      if (typeof o.dow === "number") dow = o.dow;
      else if (typeof o.dow === "string") {
        const i = DOW_TOKEN.indexOf(o.dow.toLowerCase());
        if (i >= 0) dow = i;
      }
      return `weekly-${DOW_TOKEN[dow] || "mon"}-${time}`;
    }
    case "monthly":
      return `monthly-${o.day && o.day >= 1 ? o.day : 1}-${time}`;
    default:
      return `daily-${time}`;
  }
}

/*
 * 방출 스케줄 → 레거시 미러 토큰 + tz. Desktop resolveSchedule 과 wire 형태는
 * 동일하지만 실패 정책이 다르다: Desktop 은 daily-09:00 폴백, 터미널은 null 반환
 * (정직 거부 — 사용자가 시키지 않은 시각에 자동화를 돌리는 것이 침묵 폴백보다 나쁘다).
 * 최종 검증은 engine/automation/schedule.cjs 로 한다.
 */
function resolveScheduleHonest(emitted, errors) {
  // 레거시 문자열 형식 ("daily-09:00", "cron:* * * * *", 5필드 cron …)
  if (typeof emitted === "string") {
    const token = emitted.trim();
    if (!token) {
      errors.push("Automation schedule string was empty");
      return null;
    }
    const spec = schedule.legacyScheduleSpec(token, null);
    if (!spec || (spec.kind === "cron" && !schedule.nextCronRun(spec.expr, new Date(), spec.tz))) {
      errors.push(`Unrecognized legacy schedule rejected: "${token}"`);
      return null;
    }
    return { token, tz: "" };
  }
  if (!emitted || typeof emitted !== "object") {
    errors.push("Automation schedule missing — refusing to guess one");
    return null;
  }

  const tz = typeof emitted.tz === "string" && emitted.tz.trim() ? emitted.tz.trim() : "";

  if (typeof emitted.cron === "string" && emitted.cron.trim()) {
    const cron = emitted.cron.trim();
    // nextCronRun 이 문법 + IANA tz 를 함께 검증한다 (croner validateCron 의 터미널 대응물).
    if (!schedule.nextCronRun(cron, new Date(), tz || null)) {
      errors.push(`Invalid cron expression rejected: "${cron}"`);
      return null;
    }
    return { token: `cron:${cron}`, tz };
  }

  const preset = typeof emitted.preset === "string" ? emitted.preset.trim().toLowerCase() : "";
  if (!PRESETS.has(preset)) {
    errors.push(`Unknown schedule preset rejected: "${preset || "(none)"}"`);
    return null;
  }
  // hourly 는 시각이 필요 없다. 그 외 프리셋은 HH:MM 필수 — 시각을 추측하지 않는다.
  let time = "09:00";
  if (preset !== "hourly") {
    time = typeof emitted.time === "string" && /^\d{1,2}:\d{2}$/.test(emitted.time) ? emitted.time : "";
    if (!time) {
      errors.push(`Schedule preset "${preset}" missing valid "time" (HH:MM) — refusing to guess`);
      return null;
    }
  }
  const token = presetToLegacyToken(preset, time, emitted);
  const spec = schedule.legacyScheduleSpec(token, tz || null);
  if (!spec || (spec.kind === "cron" && !schedule.nextCronRun(spec.expr, new Date(), spec.tz))) {
    // daily-99:99 같은 범위 밖 시각이 여기서 걸린다.
    errors.push(`Could not compile schedule preset "${preset}" time "${time}"`);
    return null;
  }
  return { token, tz };
}

function parseAutomationBlock(text) {
  const idx = text.lastIndexOf(AUTOMATION_HEADING);
  if (idx < 0) return { automations: [], cleanedText: text.trim(), errors: [] };

  const after = text.slice(idx + AUTOMATION_HEADING.length);
  const fence = after.match(/```(?:json)?\s*([\s\S]*?)```/);
  const errors = [];
  let automations = [];

  if (fence) {
    const jsonText = fence[1].trim();
    if (utf8Bytes(jsonText) > MAX_FENCE_JSON_BYTES) {
      errors.push("Automation JSON exceeds " + MAX_FENCE_JSON_BYTES + " bytes");
    } else try {
      const raw = JSON.parse(jsonText);
      // Desktop automation-emitter accepts both the legacy array and the
      // current session-edit object (name + full graph). Normalize the latter
      // to one entry before applying the same bounded validation below.
      const data = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object"
          ? [raw]
          : null;
      if (data) {
        if (data.length > MAX_AUTOMATIONS) {
          errors.push("Automation block exceeds maximum of " + MAX_AUTOMATIONS + " entries");
        } else {
          automations = data
          .map((d, index) => {
            if (!d || typeof d !== "object") {
              errors.push("Automation entry was not an object");
              return null;
            }
            if (jsonBytes(d) > MAX_AUTOMATION_ENTRY_BYTES) {
              errors.push("Automation entry " + (index + 1) + " exceeds " + MAX_AUTOMATION_ENTRY_BYTES + " bytes");
              return null;
            }
            const name = boundedString(d.name, MAX_NAME_BYTES);
            const prompt = boundedString(d.prompt, MAX_PROMPT_BYTES);
            const agent = boundedString(d.agent, MAX_AGENT_BYTES);
            const hubAgent = boundedString(d.hubAgent, MAX_AGENT_BYTES);
            if (name === null || prompt === null || agent === null || hubAgent === null) {
              errors.push("Automation entry " + (index + 1) + " contains an oversized string");
              return null;
            }
            if (!name || !prompt) {
              errors.push(`Automation "${name || "(unnamed)"}" missing name/prompt`);
              return null;
            }
            if (typeof d.schedule === "string" && utf8Bytes(d.schedule.trim()) > MAX_SCHEDULE_BYTES) {
              errors.push("Automation " + name + " schedule exceeds " + MAX_SCHEDULE_BYTES + " bytes");
              return null;
            }
            if (d.schedule && typeof d.schedule === "object" && jsonBytes(d.schedule) > MAX_SCHEDULE_BYTES) {
              errors.push("Automation " + name + " schedule exceeds " + MAX_SCHEDULE_BYTES + " bytes");
              return null;
            }
            const resolved = resolveScheduleHonest(d.schedule, errors);
            if (!resolved) return null; // 정직 거부 — 스케줄 추측 금지
            // steps[] 는 wire 패리티로 보존만 한다. Desktop 은 stepsToGraph 로
            // 그래프를 합성하지만 터미널 데몬은 prompt_template 단일 실행이다 —
            // 그래프 합성을 위장하지 않는다(비합성은 apply 쪽 영수증에 표기).
            if (Array.isArray(d.steps) && d.steps.length > MAX_STEPS) {
              errors.push("Automation " + name + " exceeds maximum of " + MAX_STEPS + " steps");
              return null;
            }
            if (Array.isArray(d.steps) && jsonBytes(d.steps) > MAX_STEPS_BYTES) {
              errors.push("Automation " + name + " steps exceed " + MAX_STEPS_BYTES + " bytes");
              return null;
            }
            const steps = Array.isArray(d.steps) && d.steps.length
              ? d.steps.filter((s) => !!s && typeof s === "object")
              : undefined;
            return {
              name,
              schedule: resolved.token,
              prompt,
              ...(agent ? { agent } : {}),
              ...(hubAgent ? { hubAgent } : {}),
              tz: resolved.tz,
              ...(steps ? { steps } : {}),
            };
          })
          .filter(Boolean);
        }
      } else {
        errors.push("Automation block was neither a JSON array nor a JSON object");
      }
    } catch (err) {
      errors.push(`Automation JSON parse failed: ${(err && err.message) || String(err)}`);
    }
  } else {
    errors.push("Automation heading present but no JSON fence found");
  }

  let cut = text.length;
  if (fence && fence.index != null) {
    cut = idx + AUTOMATION_HEADING.length + fence.index + fence[0].length;
  } else {
    cut = idx;
  }
  const cleanedText = (text.slice(0, idx) + text.slice(cut)).trim();
  return { automations, cleanedText, errors };
}

/* ── <<agentlas-ask>> (renderer/lib/ask-question.ts extractQuestions 포팅) ── */

function tryParseAsk(body) {
  if (utf8Bytes(body) > MAX_ASK_BODY_BYTES) return null;
  // body 가 ```json 펜스로 감싸진 경우도 허용 (Desktop confirm/index.ts:77-80 동일)
  const stripped = body
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  let o;
  try {
    o = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const question = typeof o.question === "string" ? o.question.trim() : "";
  if (!question) return null;
  const optionsRaw = Array.isArray(o.options) ? o.options : [];
  const options = [];
  for (const opt of optionsRaw) {
    if (!opt || typeof opt !== "object") continue;
    const label = typeof opt.label === "string" ? opt.label.trim() : "";
    if (!label) continue;
    const description = typeof opt.description === "string" ? opt.description.trim() : "";
    options.push({
      label: label.slice(0, 200),
      ...(description ? { description: description.slice(0, 1000) } : {}),
    });
    if (options.length >= 8) break; // Desktop confirm/index.ts:99 상한
  }
  if (options.length < 2) return null; // Desktop 계약: 선택지 2개 미만은 유효 질문 아님
  return {
    question: question.slice(0, 4000),
    ...(typeof o.header === "string" && o.header.trim() ? { header: o.header.trim().slice(0, 200) } : {}),
    multiSelect: o.multiSelect === true,
    options,
  };
}

function extractAsks(text) {
  if (!text.includes(ASK_OPEN)) return { text, asks: [] };
  const asks = [];
  let remaining = text;
  let buf = "";
  for (;;) {
    const open = remaining.indexOf(ASK_OPEN);
    if (open < 0) {
      buf += remaining;
      break;
    }
    buf += remaining.slice(0, open);
    const afterOpen = remaining.slice(open + ASK_OPEN.length);
    const close = afterOpen.indexOf(ASK_CLOSE);
    if (close < 0) {
      // 닫는 토큰이 아직 없다 — 스트리밍 중 미완성일 수 있으니 본문에 그대로 둔다.
      buf += remaining.slice(open);
      break;
    }
    const parsed = tryParseAsk(afterOpen.slice(0, close).trim());
    if (parsed && asks.length < MAX_ASKS) asks.push(parsed);
    // 파싱 실패해도 닫힌 펜스는 본문에서 제거 — malformed JSON raw 를 사용자에게 노출하지 않는다.
    remaining = afterOpen.slice(close + ASK_CLOSE.length);
  }
  return { text: buf, asks };
}

/* ── 통합 진입점 ─────────────────────────────────────────────────────────── */

/**
 * @returns {{
 *   cleanText: string,           // 4개 펜스가 모두 제거된 표시/영속용 텍스트
 *   memoryEvents: object[],      // parseMemoryEventsCli 원시 이벤트(게이트 전)
 *   delegates: Array<{target,brief,allocation}>,
 *   synthesisAllocation: object|null,
 *   automations: Array<{name,schedule,prompt,agent?,hubAgent?,tz,steps?}>,
 *   asks: Array<{question,header?,multiSelect,options}>,
 *   errors: string[]             // 자동화 검증 실패 등 — 조용히 드롭하지 않고 표면화
 * }}
 */
function parseReplyFences(text) {
  const raw = String(text || "");
  const errors = [];

  // 1. Memory Events — 큐레이트 모듈의 파서를 소비(포맷 정본은 그쪽).
  const mem = memoryCurate.parseMemoryEventsCli(raw);
  let working = mem.cleaned;

  // 2. Delegate
  const del = parseDelegateBlock(working);
  working = del.cleanedText;
  errors.push(...(del.errors || []));

  // 3. Automation
  const auto = parseAutomationBlock(working);
  working = auto.cleanedText;
  errors.push(...auto.errors);

  // 4. Ask
  const ask = extractAsks(working);
  working = ask.text;

  return {
    cleanText: working.trim(),
    memoryEvents: mem.events,
    delegates: del.delegations,
    synthesisAllocation: del.synthesisAllocation,
    automations: auto.automations,
    asks: ask.asks,
    errors,
  };
}

module.exports = {
  DELEGATE_HEADING,
  AUTOMATION_HEADING,
  ASK_OPEN,
  ASK_CLOSE,
  parseReplyFences,
  // 테스트/재사용용 개별 파서
  parseDelegateBlock,
  parseAutomationBlock,
  extractAsks,
};
