"use strict";
/*
 * 그래프 인터뷰(터미널) — 데스크탑 shared/graph-blueprint.ts + electron/workflow/graph-interview.ts
 * 와 **같은 계약**이어야 한다. 어긋나면 표면마다 다른 그래프가 만들어진다.
 *
 * 설계의 핵심 한 줄: **모델은 청사진만 말하고, 그래프는 코드가 짓는다.**
 * 모델이 노드 id와 연결을 직접 쓰면, 실사용에서 사람이 겪은 결함이 그대로 재발한다
 * (참/거짓 미선언 연결 → 두 갈래 동시 실행 · 고아 노드 · 상한 없는 반복 ·
 *  아무도 만들지 않는 값 참조).
 *
 * 두 번째 규칙: **모르면 지어내지 말고 묻는다.** 특히 실행 시각과 "바깥으로 나가는가"는
 * 절대 기본값을 쓰지 않는다 — 자동화는 사람이 없는 동안 돌기 때문이다.
 */

const BLUEPRINT_SCHEMA = "agentlas.graph-blueprint.v1";
const MAX_QUESTIONS_PER_TURN = 3;
const MAX_INTERVIEW_ROUNDS = 6;
const MAX_STEPS = 20;
const MAX_REPEATS = 20;

const OPS = new Set(["contains", "truthy", "falsy", "eq", "neq", "gt", "lt"]);
const VALUE_OPS = new Set(["contains", "eq", "neq", "gt", "lt"]);
const VAR_RE = /^[A-Za-z_][\w-]*$/;

function startInterview(request) {
  return { request: String(request || "").trim(), answers: [], asked: [], round: 0 };
}

function recordAnswers(state, answers) {
  return {
    ...state,
    answers: [...state.answers, ...answers],
    asked: [...new Set([...state.asked, ...answers.map((a) => a.questionId)])],
    round: state.round + 1,
  };
}

const RULES = [
  "You are building an automation for someone who is not a developer. You will be asked to either",
  "ASK questions or produce a BLUEPRINT. Never produce raw graph JSON, node ids, or edges.",
  "",
  "Ask rather than assume. These must come from the person, never from you:",
  "  · when it runs (a time, or 'whenever I give it a value') — never invent a time;",
  "  · whether a step goes OUTSIDE (posting, emailing, saving a file, paying) — never downgrade to read;",
  "  · what exactly each step should do, in enough detail that an agent can act without asking back;",
  "  · how many times a repeat may run.",
  "Ask about what you genuinely cannot decide. Do not ask about things you can name yourself",
  "(a sensible automation name, a variable name, the order of obvious steps).",
  "",
  "If the person says they do not know, or asks you to decide (\"you pick\", \"알아서 해줘\",",
  "\"상관없어\", \"아무거나\"), DECIDE IT YOURSELF and move on. Never ask the same thing a third time.",
  "Deferring to you is not permission — it means take the most conservative option:",
  "  · goes outside? → read. Nothing leaves the machine unless they said yes in their own words.",
  "  · repeat limit? → 2, the smallest useful bound.",
  "  · run time? → there is no safe time to pick, so offer to make it input-triggered instead",
  "    (it then runs only when they start it) and build that if they still do not choose.",
  "Say what you decided for them in the goal sentence, so they can see it and change it.",
  "",
  "If an answer does not actually answer your question, do not repeat the question as-is —",
  "offer concrete choices instead. Never ask more than you need: prefer building with a sensible",
  "default over a fourth round of questions about the same thing.",
  "",
  "Write questions the way a helpful shop assistant would: short, concrete, one thing at a time,",
  "with examples when a choice is not obvious. Write them in the same language the person used.",
  "",
  "Return ONLY compact JSON, one of these two shapes:",
  '  {"ask":[{"id":"<stable-id>","question":"...","why":"...","choices":["...","..."]}]}',
  `  {"blueprint":{"schema":"${BLUEPRINT_SCHEMA}","name":"...","goal":"...","trigger":{...},"steps":[...],"branches":[...]}}`,
  "",
  'trigger is either {"kind":"cron","schedule":"daily-08:00"} (24h, or a 5-field cron string)',
  'or {"kind":"input","label":"<what to ask the person>","varName":"<one word, a-z>"}.',
  "",
  'steps[] entries: {"title":"...","instruction":"...","effect":"read"|"mutation",',
  '  "produces":"<one word>","consumes":["<one word>"]}.',
  "  · instruction is what the agent is told. Write it so it can act with no further questions.",
  "  · a step that reads {{x}} must list x in consumes, and some earlier step (or the input trigger)",
  '    must declare produces:"x".',
  '  · effect:"mutation" for anything that leaves the machine or changes a file.',
  "",
  'branches[] entries (optional): {"afterStep":<0-based>,"var":"<one word>",',
  '  "op":"contains|truthy|falsy|eq|neq|gt|lt","value":"...",',
  '  "yesStep":<index>,"noStep":<index>,"repeatStep":<index>,"maxRepeats":<1-20>}.',
  "  · repeatStep goes BACK to an earlier step and REQUIRES maxRepeats.",
  "",
  "Ask at most 3 questions per turn. Never repeat a question id you already asked.",
].join("\n");

function buildInterviewPrompt(state) {
  const known = state.answers.length
    ? state.answers.map((a) => `Q(${a.questionId}): ${a.question}\nA: ${a.answer}`).join("\n\n")
    : "(nothing yet)";
  const lines = [
    RULES,
    "",
    `What the person asked for:\n${state.request}`,
    "",
    `What they have already told you:\n${known}`,
  ];
  if (state.asked.length) {
    lines.push("", `Question ids already asked (do not repeat): ${state.asked.join(", ")}`);
  }
  if (state.round >= MAX_INTERVIEW_ROUNDS - 1) {
    lines.push(
      "",
      "This is the last round. Ask only what makes the automation impossible to build without it;",
      "otherwise return the blueprint.",
    );
  }
  return lines.join("\n");
}

function triggerQuestion() {
  return {
    id: "trigger",
    question: "이 자동화는 정해진 시각에 저절로 돌까요, 아니면 값을 넣을 때마다 돌까요?",
    why: "둘은 완전히 다른 자동화입니다. 제가 임의로 정하면 원하지 않는 때에 돌게 됩니다.",
    choices: ["정해진 시각에 저절로", "내가 값을 넣을 때마다"],
  };
}

/** 청사진이 그래프로 지어질 수 있는지. 모자란 곳은 기본값이 아니라 질문으로 돌려준다. */
function validateBlueprint(bp) {
  const problems = [];
  const push = (reason, ask = null) => problems.push({ reason, ask });
  if (!bp || typeof bp !== "object") { push("만들 내용을 읽지 못했습니다."); return problems; }
  if (!String(bp.name || "").trim()) {
    push("이름이 없습니다.", { id: "name", question: "이 자동화를 뭐라고 부를까요?", why: "목록에서 이 이름으로 찾게 됩니다." });
  }
  if (!String(bp.goal || "").trim()) {
    push("무엇을 위한 자동화인지가 없습니다.", {
      id: "goal", question: "이 자동화로 무엇을 얻고 싶으신가요? 한 문장으로 말씀해 주세요.",
      why: "나중에 목록에서 보고 무엇이었는지 알아보려면 필요합니다.",
    });
  }
  const trigger = bp.trigger;
  if (!trigger || typeof trigger !== "object") {
    push("언제 시작하는지가 없습니다.", triggerQuestion());
  } else if (trigger.kind === "cron") {
    if (!String(trigger.schedule || "").trim()) {
      push("실행 시각이 없습니다.", {
        id: "schedule", question: "몇 시에 돌릴까요?",
        why: "시각을 제가 정하면, 사용자가 원하지 않는 시각에 조용히 돌게 됩니다.",
        choices: ["매일 아침 8시", "매일 저녁 9시", "평일 아침 9시", "매주 월요일 아침 9시"],
      });
    }
  } else if (trigger.kind === "input") {
    if (!String(trigger.label || "").trim()) {
      push("무엇을 입력받는지가 없습니다.", {
        id: "input-label", question: "시작할 때 무엇을 입력받을까요? (예: 만들 프로젝트의 주제)",
        why: "입력창에 이 문구가 그대로 보입니다.",
      });
    }
    if (!VAR_RE.test(String(trigger.varName || ""))) push("입력값의 이름이 올바르지 않습니다.");
  } else {
    push("언제 시작하는지를 알 수 없습니다.", triggerQuestion());
  }

  const steps = Array.isArray(bp.steps) ? bp.steps : [];
  if (steps.length === 0) {
    push("할 일이 하나도 없습니다.", {
      id: "steps", question: "이 자동화가 무슨 일을 해야 하나요? 순서대로 말씀해 주세요.",
      why: "단계가 없으면 만들 수 있는 것이 없습니다.",
    });
  }
  if (steps.length > MAX_STEPS) push(`단계가 ${steps.length}개입니다. 한 번에 만들 수 있는 것은 ${MAX_STEPS}개까지입니다.`);

  const produced = new Set();
  if (trigger && trigger.kind === "input" && trigger.varName) produced.add(trigger.varName);
  steps.forEach((step, index) => {
    const at = `${index + 1}번째 단계`;
    if (!step || typeof step !== "object") { push(`${at}를 읽지 못했습니다.`); return; }
    if (!String(step.title || "").trim()) push(`${at}에 이름이 없습니다.`);
    if (!String(step.instruction || "").trim()) {
      push(`${at}가 무엇을 할지 적혀 있지 않습니다.`, {
        id: `step-${index}-instruction`,
        question: `"${step.title || at}" 단계에서 정확히 무엇을 해야 하나요?`,
        why: "지시가 비면 에이전트가 되물어 오고, 자동화는 아무것도 못 합니다.",
      });
    }
    if (step.effect !== "read" && step.effect !== "mutation") {
      push(`${at}가 바깥을 바꾸는지 정해지지 않았습니다.`, {
        id: `step-${index}-effect`,
        question: `"${step.title || at}" 단계는 바깥으로 나가는 일(글 게시·메일 발송·파일 저장·결제 등)을 하나요?`,
        why: "바깥을 바꾸는 단계는 실행 전에 확인을 받도록 잠가 둡니다.",
        choices: ["아니요, 글을 만들기만 합니다", "네, 바깥으로 나갑니다"],
      });
    }
    for (const name of step.consumes || []) {
      if (!produced.has(name)) {
        push(`${at}가 쓰는 "${name}" 값을 아무도 만들지 않습니다.`, {
          id: `step-${index}-consumes-${name}`,
          question: `"${step.title || at}" 단계가 쓰는 "${name}"은(는) 어디서 오나요?`,
          why: "만들어 주는 단계가 없으면 그 자리가 빈 채로 실행됩니다.",
        });
      }
    }
    if (step.produces) {
      if (!VAR_RE.test(step.produces)) push(`${at}의 결과 이름 "${step.produces}"은(는) 쓸 수 없습니다.`);
      else produced.add(step.produces);
    }
  });

  for (const branch of bp.branches || []) {
    const at = `${(branch.afterStep ?? 0) + 1}번째 단계 뒤의 갈림길`;
    if (!steps[branch.afterStep]) { push(`${at}가 없는 단계를 가리킵니다.`); continue; }
    if (!OPS.has(branch.op)) { push(`${at}의 판단 방법을 알 수 없습니다.`); continue; }
    if (!branch.var || !produced.has(branch.var)) push(`${at}가 보는 "${branch.var}" 값을 아무도 만들지 않습니다.`);
    if (VALUE_OPS.has(branch.op) && (branch.value === undefined || branch.value === null || branch.value === "")) {
      push(`${at}가 무엇과 비교하는지 정해져 있지 않습니다.`, {
        id: `branch-${branch.afterStep}-value`,
        question: `${at}에서, 어떤 경우에 "예"로 갈까요?`,
        why: "비교할 것이 없으면 갈림길이 판단을 못 하고 거기서 멈춥니다.",
      });
    }
    if (branch.repeatStep !== undefined) {
      if (!steps[branch.repeatStep]) push(`${at}의 되돌아갈 단계가 없습니다.`);
      if (branch.repeatStep > branch.afterStep) push(`${at}는 뒤쪽 단계로 되돌아갈 수 없습니다.`);
      const cap = branch.maxRepeats;
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1 || cap > MAX_REPEATS) {
        push(`${at}의 반복 횟수가 정해져 있지 않습니다.`, {
          id: `branch-${branch.afterStep}-repeats`,
          question: `${at}에서 되돌아가는 반복은 최대 몇 번까지 할까요?`,
          why: "사람이 보지 않는 동안 도는 자동화라, 멈출 지점이 없으면 실행하지 않습니다.",
          choices: ["2번", "3번", "5번"],
        });
      }
    }
    if (branch.yesStep === undefined && branch.noStep === undefined && branch.repeatStep === undefined) {
      push(`${at} 뒤에 아무것도 이어져 있지 않습니다.`);
    }
  }
  return problems;
}

function branchLabel(branch) {
  const shown = typeof branch.value === "string" ? `"${branch.value}"` : String(branch.value ?? "");
  switch (branch.op) {
    case "contains": return `${branch.var}에 ${shown}이(가) 있나?`;
    case "truthy": return `${branch.var}에 값이 있나?`;
    case "falsy": return `${branch.var}이(가) 비었나?`;
    case "eq": return `${branch.var}이(가) ${shown}인가?`;
    case "neq": return `${branch.var}이(가) ${shown}이 아닌가?`;
    case "gt": return `${branch.var}이(가) ${shown}보다 큰가?`;
    case "lt": return `${branch.var}이(가) ${shown}보다 작은가?`;
    default: return `${branch.var} 확인`;
  }
}

function scheduleLabel(schedule) {
  const daily = /^daily-(\d{2}):(\d{2})$/.exec(String(schedule || ""));
  return daily ? `매일 ${daily[1]}:${daily[2]}` : String(schedule || "");
}

/** 청사진 → 그래프. **노드 id와 연결은 전부 여기서 만든다.** */
function buildGraphFromBlueprint(bp) {
  const problems = validateBlueprint(bp);
  if (problems.length) return { ok: false, problems };

  const nodes = [];
  const edges = [];
  const column = (i) => i * 280;
  const trigger = bp.trigger;
  nodes.push({
    id: "start", type: "trigger",
    label: trigger.kind === "cron" ? scheduleLabel(trigger.schedule) : trigger.label,
    position: { x: 0, y: 0 },
    config: trigger.kind === "cron"
      ? { schedule: trigger.schedule }
      : { kind: "input", promptLabel: trigger.label, produces: trigger.varName },
  });
  const stepId = (i) => `step${i + 1}`;
  bp.steps.forEach((step, index) => {
    nodes.push({
      id: stepId(index),
      type: step.effect === "mutation" ? "action" : "agent",
      label: step.title,
      position: { x: column(index + 1), y: 0 },
      config: {
        prompt: step.instruction,
        effect: step.effect,
        ...(step.effect === "mutation" ? { approval: "ask" } : {}),
        ...(step.produces ? { produces: step.produces } : {}),
        ...(step.consumes && step.consumes.length ? { consumes: step.consumes[0] } : {}),
      },
    });
  });

  const branchAt = new Map();
  for (const branch of bp.branches || []) branchAt.set(branch.afterStep, branch);
  let seq = 0;
  const link = (source, target, handle, maxIterations) => {
    edges.push({
      id: `e${seq += 1}`, source, target,
      ...(handle ? { sourceHandle: handle } : {}),
      ...(typeof maxIterations === "number" ? { maxIterations } : {}),
    });
  };
  link("start", stepId(0));
  bp.steps.forEach((_step, index) => {
    const branch = branchAt.get(index);
    if (!branch) {
      if (bp.steps[index + 1]) link(stepId(index), stepId(index + 1));
      return;
    }
    const branchId = `check${index + 1}`;
    nodes.push({
      id: branchId, type: "condition", label: branchLabel(branch),
      position: { x: column(index + 1) + 140, y: 0 },
      config: { var: branch.var, op: branch.op, ...(branch.value !== undefined ? { value: branch.value } : {}) },
    });
    link(stepId(index), branchId);
    if (branch.yesStep !== undefined && bp.steps[branch.yesStep]) link(branchId, stepId(branch.yesStep), "true");
    else if (bp.steps[index + 1]) link(branchId, stepId(index + 1), "true");
    if (branch.repeatStep !== undefined) link(branchId, stepId(branch.repeatStep), "false", branch.maxRepeats);
    else if (branch.noStep !== undefined && bp.steps[branch.noStep]) link(branchId, stepId(branch.noStep), "false");
  });

  return {
    ok: true,
    graph: { version: 1, nodes, edges },
    scheduleHuman: trigger.kind === "cron" ? trigger.schedule : "manual",
    triggerType: trigger.kind === "cron" ? "schedule" : "manual",
  };
}

function firstJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) return body.slice(start, i + 1); }
  }
  return null;
}

const unreadable = () => ({
  ok: false, code: "INTERVIEW_OUTPUT_UNREADABLE",
  reason: "만들 내용을 읽지 못했습니다.",
  nextAction: "무엇을 자동으로 하고 싶은지 한 문장으로 다시 말씀해 주세요.",
});

function normalizeQuestions(candidates, state) {
  const seen = new Set(state.asked);
  const out = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const question = typeof candidate.question === "string" ? candidate.question.trim() : "";
    if (!question) continue;
    const id = String(candidate.id && String(candidate.id).trim() ? candidate.id : question).slice(0, 80);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      question: question.slice(0, 300),
      why: (typeof candidate.why === "string" ? candidate.why.trim() : "").slice(0, 300),
      ...(Array.isArray(candidate.choices)
        ? { choices: candidate.choices.filter((c) => typeof c === "string").slice(0, 6) }
        : {}),
    });
    if (out.length >= MAX_QUESTIONS_PER_TURN) break;
  }
  return out;
}

/**
 * 모델 출력을 읽는다.
 * ★핵심: 모델이 blueprint를 냈더라도 **검증을 통과하지 못하면 질문으로 되돌린다.**
 */
function parseInterviewTurn(text, state) {
  const raw = firstJsonObject(text);
  if (!raw) return unreadable();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return unreadable(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable();

  if (Array.isArray(parsed.ask) && parsed.ask.length > 0) {
    const questions = normalizeQuestions(parsed.ask, state);
    if (!questions.length) {
      return {
        ok: false, code: "INTERVIEW_REPEATED_QUESTIONS",
        reason: "이미 답하신 것만 다시 물으려 했습니다.",
        nextAction: "다시 시도하거나, 만들고 싶은 것을 조금 더 구체적으로 말씀해 주세요.",
      };
    }
    return { ok: true, turn: { kind: "ask", questions } };
  }

  const blueprint = parsed.blueprint;
  if (!blueprint || typeof blueprint !== "object") return unreadable();
  const normalized = { ...blueprint, schema: BLUEPRINT_SCHEMA };
  const problems = validateBlueprint(normalized);
  if (problems.length === 0) return { ok: true, turn: { kind: "blueprint", blueprint: normalized } };
  const questions = normalizeQuestions(problems.map((p) => p.ask).filter(Boolean), state);
  if (questions.length) return { ok: true, turn: { kind: "ask", questions } };
  return {
    ok: false, code: "INTERVIEW_BLUEPRINT_INVALID",
    reason: problems.map((p) => p.reason).slice(0, 4).join(" "),
    nextAction: "만들고 싶은 것을 조금 더 구체적으로 말씀해 주시면 다시 시도합니다.",
  };
}

module.exports = {
  BLUEPRINT_SCHEMA, MAX_QUESTIONS_PER_TURN, MAX_INTERVIEW_ROUNDS, MAX_REPEATS,
  startInterview, recordAnswers, buildInterviewPrompt, parseInterviewTurn,
  validateBlueprint, buildGraphFromBlueprint, branchLabel,
};
