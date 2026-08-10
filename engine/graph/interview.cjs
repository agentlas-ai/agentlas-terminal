"use strict";
const { layoutGraph, needsLayout } = require("./layout.cjs");
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

// 갈림길이 쓸 수 있는 판단 방법. **커널이 실제로 실행하는 것과 같아야 한다.**
// 예전엔 "neq"가 있었는데 커널은 "ne"만 실행했다 — 제품이 자기가 못 읽는 자동화를 저장했다.
const CONDITION_OPS = ["truthy", "falsy", "eq", "ne", "gt", "lt", "contains"];

// ── 도구 결합 ──────────────────────────────────────────────────────────────
// 데스크탑 shared/graph-tool-binding.ts 와 **같은 명부**여야 한다. 어긋나면 터미널에서
// 만든 그래프가 데스크탑에서 켜지지 않는다(요구가 다르게 읽히므로).
const PROVIDER_CATALOG = [
  { id: "google_calendar", label: "Google 캘린더", group: "google", capabilities: ["calendar.events.list", "calendar.events.create"] },
  { id: "google_sheets", label: "Google 스프레드시트", group: "google", capabilities: ["sheets.rows.read", "sheets.rows.append"] },
  { id: "gmail", label: "Gmail", group: "google", capabilities: ["mail.messages.list", "mail.messages.send"] },
  { id: "outlook_calendar", label: "Outlook 캘린더", group: "microsoft", capabilities: ["calendar.events.list", "calendar.events.create"] },
  { id: "outlook_mail", label: "Outlook 메일", group: "microsoft", capabilities: ["mail.messages.list", "mail.messages.send"] },
  { id: "apple_calendar", label: "Apple 캘린더", group: "apple", capabilities: ["calendar.events.list", "calendar.events.create"] },
  { id: "slack", label: "Slack", group: "slack", capabilities: ["chat.messages.post", "chat.messages.list"] },
  { id: "notion", label: "Notion", group: "notion", capabilities: ["docs.pages.read", "docs.pages.create", "docs.database.query"] },
  { id: "github", label: "GitHub", group: "github", capabilities: ["code.issues.list", "code.issues.create", "code.repo.read"] },
  { id: "linear", label: "Linear", group: "atlassian", capabilities: ["tasks.issues.list", "tasks.issues.create"] },
  { id: "local_files", label: "이 컴퓨터의 파일", group: "local", capabilities: ["files.read", "files.write"] },
  { id: "web_search", label: "웹 검색", group: "other", capabilities: ["web.search"] },
];
const CAPABILITIES = [...new Set(PROVIDER_CATALOG.flatMap((p) => p.capabilities))].sort();
const findProvider = (id) => (id ? PROVIDER_CATALOG.find((p) => p.id === id) || null : null);
const providersFor = (capability) => PROVIDER_CATALOG.filter((p) => p.capabilities.includes(capability));

const CAPABILITY_LABEL = {
  "calendar.events.list": "캘린더 일정 읽기", "calendar.events.create": "캘린더에 일정 넣기",
  "sheets.rows.read": "스프레드시트 읽기", "sheets.rows.append": "스프레드시트에 추가",
  "mail.messages.list": "메일 읽기", "mail.messages.send": "메일 보내기",
  "chat.messages.post": "채팅에 올리기", "chat.messages.list": "채팅 읽기",
  "docs.pages.read": "문서 읽기", "docs.pages.create": "문서 만들기",
  "docs.database.query": "문서 데이터베이스 조회",
  "code.issues.list": "이슈 읽기", "code.issues.create": "이슈 만들기", "code.repo.read": "코드 읽기",
  "tasks.issues.list": "할 일 읽기", "tasks.issues.create": "할 일 만들기",
  "files.read": "이 컴퓨터 파일 읽기", "files.write": "이 컴퓨터에 파일 쓰기",
  "web.search": "웹 검색",
};
const CAPABILITY_CHOICES = CAPABILITIES.map((id) => CAPABILITY_LABEL[id] || id);

const OPS = new Set(CONDITION_OPS);
const VALUE_OPS = new Set(["contains", "eq", "ne", "gt", "lt"]);
const VAR_RE = /^[A-Za-z_][\w-]*$/;

function startInterview(request, { knownGraphs = [], selfId = null } = {}) {
  // knownGraphs: 이 사람이 이미 가진 저장된 자동화들(id·name). runGraph 단계가 이 중에서만
  //   고르게 하려고 인터뷰 프롬프트와 검증에 함께 흐른다(데스크탑과 같은 규칙).
  return { request: String(request || "").trim(), answers: [], asked: [], round: 0, attempts: [], knownGraphs, selfId };
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
  "with examples when a choice is not obvious. Write every question, choice, name, goal, label,",
  "and note in the PRODUCT LANGUAGE stated at the end of this prompt — even when the person",
  "writes in another language. The person chose the product language in settings; drifting to",
  "the input language makes the product look broken. (Their own words quoted back are fine.)",
  "",
  "Return ONLY compact JSON, one of these two shapes:",
  '  {"ask":[{"id":"<stable-id>","question":"...","why":"...","choices":["...","..."]}]}',
  `  {"blueprint":{"schema":"${BLUEPRINT_SCHEMA}","name":"...","goal":"...","trigger":{...},"steps":[...],"branches":[...],"checks":[...]}}`,
  "",
  'trigger is either {"kind":"cron","schedule":"daily-08:00"} (24h, or a 5-field cron string)',
  'or {"kind":"input","label":"<what to ask the person>","varName":"<one word, a-z>"}.',
  "",
  'steps[] entries: {"title":"...","instruction":"...","effect":"read"|"mutation",',
  '  "produces":"<one word>","consumes":["<one word>"],"role":"<kind of worker>"}.',
  "  · instruction is what the agent is told. Write it so it can act with no further questions.",
  "  · role: what KIND of worker this step needs, in the person's language",
  '    ("한국어 마케팅 글쓰기", "web game coding", "data analysis"). Add it to every',
  "    agent/action step. Write the role, NEVER an agent name or id — the product searches",
  "    the real catalog and fills the slot itself. A name you invent does not exist and the",
  "    graph dies at run time. Steps that need the same kind of worker get the same role text.",
  "    Alongside role, add roleEn: the same role faithfully translated to English. The catalog",
  "    is English — searching with a non-English role buries the right worker (measured: the",
  "    same query ranked its target 1st in English and 144th in Korean).",
  "  · kind:\"code\" when the step is an EXACT computation or data-shaping that a chat model would",
  "    get quietly wrong: number math, currency/percent, parsing HTML/CSV/JSON, spreadsheet cells,",
  "    date arithmetic, calling a data library (e.g. yfinance). For those, add kind:\"code\", a short",
  "    codeLang (\"python\" default, or \"js\"), and code:\"<the script>\". The script gets the upstream",
  "    values as `vars` (a dict/object) and must set `result` to what the next step reads.",
  "    Read consumes[] the same way. YOU write the code — the person only describes what they want.",
  "    If the script imports anything outside the Python standard library, declare the pip names in",
  '    packages:["yfinance"] on that step — the product installs them before the run. Prefer the',
  "    standard library when it can do the job; an undeclared import dies on the user's machine.",
  "  · kind:\"runGraph\" when the person wants an automation they ALREADY have to run as one",
  "    step of this one (\"then run my weekly report\"). Add graphRef:\"<id>\" chosen from the",
  "    list of saved automations at the end of this prompt — never invent an id, and never use",
  "    the name (names change, ids do not). If nothing in that list matches, do not guess:",
  "    write the work as ordinary steps instead.",
  "  · kind:\"agent\" (the default, omit it) for judgement, writing, summarizing, deciding — anything",
  "    where being approximately right is fine. Split a step: fetch+compute in a code step, then",
  "    judge/write in an agent step. Do not put exact math inside an agent instruction.",
  "  · a step that reads {{x}} must list x in consumes, and some earlier step (or the input trigger)",
  '    must declare produces:"x".',
  '  · effect:"mutation" for anything that leaves the machine or changes a file.',
  '  · approval:"auto" ONLY when the person explicitly said the step may go out without',
  '    their review ("검토 없이", "바로 올려", "no review needed"). Never lower it yourself,',
  '    never infer it from convenience. Omit the field otherwise — outward steps stay locked.',
  '  · uses: [{"capability":"<from the list below>","provider":"<id>"|null}] — the outside',
  '    services this step needs. Pick the capability from the closed list; if the person named a',
  '    service, put its id in provider, otherwise leave provider null and it will be asked later.',
  '    A step that only writes text needs no `uses` at all.',
  '  · Never invent a capability or provider id. If what they want is not in the list, say so',
  '    in the step instruction and leave `uses` out rather than inventing one.',
  '  · Do NOT ask whether an account is already connected, and do not mention API keys, tokens,',
  '    logins, or authentication. The product checks connections itself and asks separately.',
  '    Ask only WHICH service, and only when it genuinely changes what gets built.',
  "",
  'branches[] entries (optional): {"afterStep":<0-based>,"var":"<one word>",',
  '  "op":"contains|truthy|falsy|eq|ne|gt|lt","value":"...",',
  '  "yesStep":<index>,"noStep":<index>,',
  '  "repeatStep":<index>,"repeatOn":"yes"|"no","maxRepeats":<1-20>}.',
  "  · repeatStep goes BACK to an earlier step. It REQUIRES repeatOn and maxRepeats.",
  "",
  "checks[] (REQUIRED whenever a branch repeats, and whenever a step that changes things",
  "  outside sends out a value an earlier step computed — an unattended run must not ship",
  "  an empty or invented result):",
  '  {"afterStep":<0-based>,"subject":"<a value some step produces>",',
  '   "criteria":"<one-line summary of what passing means>","produces":"<one word>",',
  '   "items":[{"text":"<atomic, checkable>","kind":"must"|"mustNot"}]}',
  "  · A check is a SEPARATE step that judges the result against the criteria and produces",
  '    "pass" or "fail". A repeat must branch on that verdict — never on words inside the',
  "    result itself. A step that grades its own output is not a check.",
  "  · So: to repeat until good enough, add a check after the step, then branch on",
  '    {"var":"<the check\'s produces>","op":"eq","value":"fail","repeatOn":"yes",...}.',
  "  · YOU propose the checklist (items): 2-5 \"must\" items (what must exist in the result)",
  "    plus 1-3 \"mustNot\" items (common failure modes for THIS task: invented numbers,",
  "    placeholder text, copying the input verbatim, missing the asked comparison...).",
  "    Write items that are atomic and checkable — 'The CSV has a numeric price column',",
  "    not 'The data looks good'. Vague items produce noisy judging.",
  "    The person will see and can edit every item before saving — propose, don't ask.",
  "  · A factual item (\"the price matches the real value\") cannot be judged from the result",
  "    alone — the judge would guess. Split it: add a read step BEFORE the check that re-fetches",
  "    the fact (kind:\"code\" or a read step with uses) into its own produces, then set the",
  "    check's evidence:\"<that name>\". The check then compares result against evidence.",
  "    Only ask when the goal itself is too vague to know what the result even is.",
  "  · repeatOn says which side loops. Write the condition the way the person said it and",
  "    put the loop on the side they meant — do not flip either one to make it fit.",
  "",
  "Ask at most 3 questions per turn. Never repeat a question id you already asked.",
  "",
  `capability must be one of: ${CAPABILITIES.join(", ")}`,
  `provider must be one of: ${PROVIDER_CATALOG.map((p) => p.id).join(", ")}`,
].join("\n");

function buildInterviewPrompt(state, locale = "ko") {
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
  // ★부를 수 있는 자동화 목록을 그 순간 실물로 싣는다(데스크탑과 같은 규칙). 이것이 없으면
  //   모델은 id를 지어내고, 그 그래프는 실행 때 죽는다.
  if (state.knownGraphs && state.knownGraphs.length) {
    lines.push("", "Saved automations you may call with kind:\"runGraph\" (use the id exactly):", ...state.knownGraphs.slice(0, 40).map((g) => `  ${g.id} — ${g.name}`));
  }
  // ★산출 언어는 입력 언어가 아니라 **제품 설정**이 정한다(데스크탑과 같은 규칙).
  lines.push("", `PRODUCT LANGUAGE: ${locale === "ko" ? "Korean" : "English"}. Every user-facing string you emit is in this language.`);
  // ★지난 시도가 왜 지어지지 못했는지를 모델 앞에 놓는다. 데스크탑과 같은 규율이다 —
  //   없으면 같은 실수를 그대로 반복한다.
  //   (패리티 게이트가 잡았다: 처음엔 이 블록이 `asked` 안에 들어가, 질문을 한 적 없는
  //    첫 시도에서는 실패 사유가 아예 안 실렸다.)
  const attempts = state.attempts || [];
  if (attempts.length) {
    lines.push(
      "",
      "Your previous blueprint could NOT be built. Fix exactly these problems and return a",
      "corrected blueprint. EVERY fix below is ADDITIVE: add the missing top-level checks[] entry",
      "(each problem message gives you the exact entry to add). Keep EVERY step, the trigger, and",
      "every produces/consumes exactly as they are — never delete, merge, or shrink a step to make",
      "a problem disappear: that removes what the person asked for and just triggers a different",
      "error. More steps and more checks is the right direction, never fewer. Do not repeat the",
      "same mistake, and do not ask the person — these are format problems on your side,",
      "not missing information:",
    );
    for (const a of attempts) for (const problem of a.problems) lines.push(`  · ${problem}`);
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
    question: "정해진 시각에 스스로 돌까요, 값을 넣을 때만 돌까요?",
    why: "두 방식은 서로 다른 자동화입니다. 임의로 정하면 원하지 않는 때에 돌게 됩니다.",
    choices: ["정해진 시각에 스스로", "값을 넣을 때만"],
  };
}

/**
 * ★출력값 검증 check를 **코드가 채운다**(데스크탑 graph-blueprint.ts autofillOutputChecks와 동일).
 * 바깥으로 나가는 단계가 소비하는 '앞에서 만든 값'에 check가 없으면, 검증기가 아는 그대로
 * 표준 check를 넣어 **완전한 그래프를 완성**한다. 모델에 되물어 진동시키지 않고, 단계를 깎거나
 * 캔버스로 떠넘기지도 않는다. 사람은 저장 확인 화면에서 항목을 보고 고칠 수 있다.
 */
function autofillOutputChecks(bp) {
  if (!bp || !Array.isArray(bp.steps)) return bp;
  const checks = Array.isArray(bp.checks) ? [...bp.checks] : [];
  const checked = new Set(checks.map((c) => (c.subject || "").trim()).filter(Boolean));
  bp.steps.forEach((step, index) => {
    if (step.effect !== "mutation") return;
    for (const value of Array.isArray(step.consumes) ? step.consumes : []) {
      const name = String(value == null ? "" : value).trim();
      if (!name || checked.has(name)) continue;
      const madeAt = bp.steps.findIndex((s, i) => i < index && (s.produces || "").trim() === name);
      if (madeAt < 0) continue;
      checks.push({
        afterStep: madeAt,
        subject: name,
        criteria: `${name}이(가) 비어있지 않고 요청대로 채워졌다`,
        produces: `${name}_ok`,
        items: [
          { text: `${name}이(가) 실제 내용으로 채워졌다`, kind: "must" },
          { text: "빈 값·자리표시자·지어낸 값이 아니다", kind: "mustNot" },
        ],
      });
      checked.add(name);
    }
  });
  return { ...bp, checks };
}

/** 청사진이 그래프로 지어질 수 있는지. 모자란 곳은 기본값이 아니라 질문으로 돌려준다. */
function validateBlueprint(bp, ctx = {}) {
  const problems = [];
  const push = (reason, ask = null) => problems.push({ reason, ask });
  if (!bp || typeof bp !== "object") { push("만들 내용을 읽지 못했습니다."); return problems; }
  if (!String(bp.name || "").trim()) {
    push("이름이 없습니다.", { id: "name", question: "이 자동화를 뭐라고 부를까요?", why: "목록에서 이 이름으로 찾게 됩니다." });
  }
  if (!String(bp.goal || "").trim()) {
    push("무엇을 위한 자동화인지가 없습니다.", {
      id: "goal", question: "이 자동화로 무엇을 얻고 싶으신가요? 한 문장이면 됩니다.",
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
        why: "시각을 대신 정하면, 보지 않는 시간에 조용히 돌게 됩니다.",
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
      id: "steps", question: "무슨 일을 해야 하나요? 순서대로 적어 주세요.",
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
        why: "지시가 비면 에이전트가 되물어 오고, 자동화는 아무것도 하지 못합니다.",
      });
    }
    if (step.effect !== "read" && step.effect !== "mutation") {
      push(`${at}가 바깥을 바꾸는지 정해지지 않았습니다.`, {
        id: `step-${index}-effect`,
        question: `"${step.title || at}"은(는) 바깥으로 나가는 일(글 게시, 메일 발송, 파일 저장, 결제)을 하나요?`,
        why: "바깥을 바꾸는 단계는 실행 전에 확인받도록 잠가 둡니다.",
        choices: ["아니요, 만들기만 합니다", "네, 바깥으로 나갑니다"],
      });
    }
    // ★부를 자동화는 실재해야 한다(데스크탑 shared/graph-blueprint.ts와 같은 규칙). 이름이
    //   아니라 id로 가리키는 이유도 같다 — 이름은 바뀌고 지어낸 id는 실행에서 죽는다.
    //   목록을 모르는 호출부에서는 형식만 본다(ctx.knownGraphs 없으면 건너뜀).
    if (step.kind === "runGraph") {
      const ref = String(step.graphRef || "").trim();
      if (!ref) {
        push(`${at}가 어느 자동화를 부를지 정하지 않았습니다.`);
      } else if (ctx.selfId && ref === ctx.selfId) {
        push(`${at}가 자기 자신을 부릅니다 — 끝나지 않습니다.`);
      } else if (ctx.knownGraphs && ctx.knownGraphs.length && !ctx.knownGraphs.some((g) => g.id === ref)) {
        push(`${at}가 부르려는 자동화("${ref}")가 없습니다. 저장된 자동화 중에서 골라야 합니다.`);
      }
    }
    // ★코드 스텝은 스크립트가 있어야 한다. 없으면 "코드로 하겠다"고 해 놓고 빈 채로 저장돼
    //   실행에서 CODE_NODE_EMPTY로 죽는다(데스크탑과 같은 규칙, 저작 시점에 막는다).
    if (step.kind === "code") {
      if (!String(step.code || "").trim()) {
        push(`${at}는 코드로 실행한다고 했는데 스크립트가 비어 있습니다.`, {
          id: `step-${index}-code`,
          question: `"${step.title || at}" 단계에서 무엇을 계산·가공하나요? (AI가 스크립트를 채웁니다)`,
          why: "코드 단계는 스크립트가 없으면 실행되지 않습니다.",
        });
      }
      if (step.codeLang && step.codeLang !== "python" && step.codeLang !== "js") {
        push(`${at}의 코드 언어 "${step.codeLang}"을(를) 이 제품이 모릅니다(python 또는 js).`);
      }
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

    for (const use of step.uses || []) {
      if (!use || typeof use !== "object") { push(`${at}의 도구 선언을 읽지 못했습니다.`); continue; }
      if (!CAPABILITIES.includes(use.capability)) {
        push(`${at}가 이 제품이 모르는 도구("${use.capability}")를 쓰려고 합니다.`, {
          id: `step-${index}-capability`,
          question: `"${step.title || at}" 단계는 어떤 서비스를 씁니까?`,
          why: "이 제품이 다룰 수 있는 것으로 골라야 실제로 연결할 수 있습니다.",
          choices: CAPABILITY_CHOICES,
        });
        continue;
      }
      if (use.provider && !findProvider(use.provider)) {
        push(`${at}가 이 제품이 모르는 서비스("${use.provider}")를 가리킵니다.`, {
          id: `step-${index}-provider`,
          question: `"${step.title || at}" 단계는 어느 서비스를 씁니까?`,
          why: "서비스가 정해져야 어느 계정을 연결할지 알 수 있습니다.",
          choices: providersFor(use.capability).map((p) => p.label),
        });
      }
    }
    if (step.produces) {
      if (!VAR_RE.test(step.produces)) push(`${at}의 결과 이름 "${step.produces}"은(는) 쓸 수 없습니다.`);
      else produced.add(step.produces);
    }
  });


  // 검증 단계
  const checkVerdicts = new Set();
  for (const check of bp.checks || []) {
    const at = `${(check.afterStep ?? 0) + 1}번째 단계 뒤의 검증`;
    if (!steps[check.afterStep]) { push(`${at}가 없는 단계를 가리킵니다.`); continue; }
    if (!check.subject || !produced.has(check.subject)) {
      push(`${at}가 볼 "${check.subject}" 값을 아무도 만들지 않습니다.`);
    }
    const checkItems = Array.isArray(check.items)
      ? check.items.filter((item) => item && typeof item.text === "string" && item.text.trim())
      : [];
    for (const item of Array.isArray(check.items) ? check.items : []) {
      if (!item || typeof item.text !== "string" || !item.text.trim()) {
        push(`${at}의 채점표 항목 하나가 비어 있습니다.`);
      }
    }
    if (checkItems.length === 0 && !String(check.criteria || "").trim()) {
      push(`${at}의 통과 기준이 없습니다.`, {
        id: `check-${check.afterStep}-criteria`,
        question: `"${(steps[check.afterStep] && steps[check.afterStep].title) || at}" 결과가 어떤 상태여야 통과인가요?`,
        why: "기준이 없으면 무엇을 보고 판정할지 정할 수 없습니다.",
      });
    }
    if (check.evidence && !produced.has(check.evidence)) {
      push(`${at}가 근거로 삼는 "${check.evidence}" 값을 아무도 만들지 않습니다.`, {
        id: `check-${check.afterStep}-evidence`,
        question: `검증 근거 "${check.evidence}"은(는) 어느 단계가 가져오나요?`,
        why: "근거 없는 사실 확인은 판정자가 지어내게 됩니다 — 재조회 단계가 먼저 필요합니다.",
      });
    }
    const name = String(check.produces || "").trim() || `check${check.afterStep + 1}_verdict`;
    produced.add(name);
    checkVerdicts.add(name);
  }

  /*
   * ★계산한 값이 그대로 **바깥으로 나가면** 검증이 있어야 한다(데스크탑과 같은 규칙).
   * 실사용 실측(2026-08-06, 주간 매출 요약): 증감률이 전부 null인데 아무도 안 보고
   * 요약 엑셀로 저장될 뻔했다 — 검증을 "반복이 있을 때만" 요구했기 때문이다.
   */
  {
    const checkedSubjects = new Set(
      (bp.checks || []).map((check) => (check.subject || "").trim()).filter(Boolean),
    );
    steps.forEach((step, index) => {
      if (step.effect !== "mutation") return;
      const consumes = Array.isArray(step.consumes) ? step.consumes : [];
      for (const value of consumes) {
        const name = String(value == null ? "" : value).trim();
        if (!name || checkedSubjects.has(name)) continue;
        const madeAt = steps.findIndex((s, i) => i < index && (s.produces || "").trim() === name);
        if (madeAt < 0) continue;
        push(
          `"${step.title || `${index + 1}번째 단계`}"는 바깥으로 나가는데, 그 앞에서 만든 `
          + `"${name}" 값이 쓸 만한지 확인하는 단계가 없습니다. 단계는 하나도 지우지 말고, `
          + `top-level checks[]에 이 항목을 그대로 추가하세요: `
          + `{"afterStep":${madeAt},"subject":"${name}","criteria":"${name}이(가) 비어있지 않고 요청대로 채워졌다",`
          + `"produces":"${name}_ok","items":[{"text":"${name}이(가) 실제 내용으로 채워졌다","kind":"must"},`
          + `{"text":"빈 값·자리표시자·지어낸 값이 아니다","kind":"mustNot"}]}`,
        );
      }
    });
  }

  // 반복이 있는데 검증이 없으면 "마음에 들 때까지"를 글자 찾기로 흉내 내게 된다(실측).
  for (const branch of bp.branches || []) {
    if (branch.repeatStep === undefined) continue;
    if (!checkVerdicts.has(branch.var)) {
      push(`${(branch.afterStep ?? 0) + 1}번째 단계 뒤의 반복이 검증 결과가 아니라 "${branch.var}"의 내용을 보고 돌지 말지 정합니다.`, {
        id: `branch-${branch.afterStep}-needs-check`,
        question: `"${(steps[branch.repeatStep] && steps[branch.repeatStep].title) || "앞 단계"}"를 다시 할지 말지, 무엇을 보고 정할까요? 통과 기준을 한 문장으로 적어 주세요.`,
        why: "만든 단계가 자기 결과에 붙인 글자를 보고 정하면, 자기가 자기를 채점하는 셈이 됩니다.",
      });
    }
  }

  for (const branch of bp.branches || []) {
    const at = `${(branch.afterStep ?? 0) + 1}번째 단계 뒤의 갈림길`;
    if (!steps[branch.afterStep]) { push(`${at}가 없는 단계를 가리킵니다.`); continue; }
    if (!OPS.has(branch.op)) { push(`${at}의 판단 방법을 알 수 없습니다.`); continue; }
    if (!branch.var || !produced.has(branch.var)) push(`${at}가 보는 "${branch.var}" 값을 아무도 만들지 않습니다.`);
    if (VALUE_OPS.has(branch.op) && (branch.value === undefined || branch.value === null || branch.value === "")) {
      push(`${at}가 무엇과 비교하는지 정해져 있지 않습니다.`, {
        id: `branch-${branch.afterStep}-value`,
        question: `${at}에서, 어떤 경우에 "예"로 갈까요?`,
        why: "비교할 것이 없으면 갈림길이 판단하지 못하고 거기서 멈춥니다.",
      });
    }
    // 앞 단계로 가는 연결은 이름이 무엇이든 **반복**이다. 상한이 없으면 커널이 실행을 거절한다.
    for (const pair of [["yesStep", branch.yesStep], ["noStep", branch.noStep]]) {
      const target = pair[1];
      if (typeof target !== "number") continue;
      if (target <= branch.afterStep && branch.repeatStep === undefined) {
        push(`${at}의 "${pair[0] === "yesStep" ? "예" : "아니오"}" 쪽이 앞 단계로 되돌아가는데 반복 횟수가 없습니다.`, {
          id: `branch-${branch.afterStep}-repeats`,
          question: `${at}에서 되돌아가는 반복, 최대 몇 번까지 할까요?`,
          why: "사람이 보지 않는 사이에 도는 자동화라, 멈출 지점이 없으면 실행하지 않습니다.",
          choices: ["2번", "3번", "5번"],
        });
      }
    }
    if (branch.repeatStep !== undefined) {
      if (branch.repeatOn !== "yes" && branch.repeatOn !== "no") {
        // 막기만 하면 인터뷰가 막다른 길이 된다. 방향은 사람이 말해야 하는 것이다(실측 3/3 뒤집힘).
        const back = (steps[branch.repeatStep] && steps[branch.repeatStep].title) || "앞 단계";
        const rule = branchLabel(branch);
        push(`${at}가 어느 쪽으로 갈 때 되돌아가는지 정해지지 않았습니다.`, {
          id: `branch-${branch.afterStep}-direction`,
          question: `"${rule}" — 어느 쪽일 때 "${back}"부터 다시 할까요?`,
          why: "이 방향이 뒤집히면 원하는 것과 정반대로 도는 자동화가 됩니다.",
          choices: ["그렇다면 다시", "아니라면 다시"],
        });
      }
      if (!steps[branch.repeatStep]) push(`${at}의 되돌아갈 단계가 없습니다.`);
      if (branch.repeatStep > branch.afterStep) push(`${at}는 뒤쪽 단계로 되돌아갈 수 없습니다.`);
      if (branch.repeatOn === "yes" ? branch.noStep === branch.repeatStep : branch.yesStep === branch.repeatStep) {
        push(`${at}의 양쪽이 모두 같은 단계로 갑니다 — 갈림길이 아무것도 가르지 않습니다.`);
      }
      const cap = branch.maxRepeats;
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1 || cap > MAX_REPEATS) {
        push(`${at}의 반복 횟수가 정해져 있지 않습니다.`, {
          id: `branch-${branch.afterStep}-repeats`,
          question: `${at}에서 되돌아가는 반복, 최대 몇 번까지 할까요?`,
          why: "사람이 보지 않는 사이에 도는 자동화라, 멈출 지점이 없으면 실행하지 않습니다.",
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


/**
 * 갈림길이 실제로 어떻게 갈라지는지 사람 말로. 저장 전에 이걸로 확인을 받는다.
 * 실측: 만들어진 갈림길 3개가 전부 방향이 거꾸로였는데 그림을 안 보면 알 수 없었다.
 */
function describeBranches(bp, locale) {
  const ko = locale !== "en";
  const lines = [];
  const title = (index) => (typeof index === "number" && bp.steps[index] ? bp.steps[index].title : (ko ? "끝" : "the end"));
  for (const branch of bp.branches || []) {
    const rule = branchLabel(branch, locale);
    const repeatText = branch.repeatStep !== undefined
      ? (ko ? `"${title(branch.repeatStep)}"부터 다시 (최대 ${branch.maxRepeats}번)` : `back to "${title(branch.repeatStep)}" (up to ${branch.maxRepeats}x)`)
      : null;
    const yes = repeatText && branch.repeatOn === "yes"
      ? repeatText
      : branch.yesStep !== undefined ? title(branch.yesStep) : title(branch.afterStep + 1);
    const no = repeatText && branch.repeatOn !== "yes"
      ? repeatText
      : branch.noStep !== undefined ? title(branch.noStep) : title(branch.afterStep + 1);
    const quote = (text) => (String(text).charAt(0) === '"' ? String(text) : `"${text}"`);
    lines.push(ko
      ? `${rule} → 그렇다면 ${quote(yes || "끝")}, 아니라면 ${quote(no)}`
      : `${rule} → yes: ${quote(yes || "the end")}, no: ${quote(no)}`);
  }
  return lines;
}

/*
 * ★언어를 받는다(데스크탑 shared/graph-blueprint.ts 미러). 예전에는 무조건 한국어라
 * 영어로 만든 그래프에도 `verdict이(가) "fail"인가?`가 박혔고, 그 라벨이 공개
 * 설명문에 실려 Hub 발행이 통째로 거절됐다("descriptionEn contains Hangul").
 */
function branchLabel(branch, locale = "ko") {
  const shown = typeof branch.value === "string" ? `"${branch.value}"` : String(branch.value ?? "");
  if (locale === "en") {
    switch (branch.op) {
      case "contains": return `Does ${branch.var} contain ${shown}?`;
      case "truthy": return `Does ${branch.var} have a value?`;
      case "falsy": return `Is ${branch.var} empty?`;
      case "eq": return `Is ${branch.var} ${shown}?`;
      case "ne": return `Is ${branch.var} not ${shown}?`;
      case "gt": return `Is ${branch.var} greater than ${shown}?`;
      case "lt": return `Is ${branch.var} less than ${shown}?`;
      default: return `Check ${branch.var}`;
    }
  }
  switch (branch.op) {
    case "contains": return `${branch.var}에 ${shown}이(가) 있나?`;
    case "truthy": return `${branch.var}에 값이 있나?`;
    case "falsy": return `${branch.var}이(가) 비었나?`;
    case "eq": return `${branch.var}이(가) ${shown}인가?`;
    case "ne": return `${branch.var}이(가) ${shown}이 아닌가?`;
    case "gt": return `${branch.var}이(가) ${shown}보다 큰가?`;
    case "lt": return `${branch.var}이(가) ${shown}보다 작은가?`;
    default: return `${branch.var} 확인`;
  }
}

/**
 * 실행 시점을 사람 말로. `0 8 * * 1-5`나 `daily-08:00`은 저장 형식이지 사람이 읽을 말이 아니다.
 * 데스크탑 shared/graph-blueprint.ts 의 humanSchedule 과 같은 규칙이어야 한다.
 */
function humanSchedule(schedule, locale) {
  const ko = locale !== "en";
  const raw = String(schedule == null ? "" : schedule).trim();
  if (!raw || raw === "manual") return ko ? "값을 넣을 때만" : "only when you start it";
  const daily = /^daily-(\d{2}):(\d{2})$/.exec(raw);
  if (daily) return ko ? `매일 ${hhmm(daily[1], daily[2], "ko")}` : `every day at ${daily[1]}:${daily[2]}`;
  const parts = raw.split(/\s+/);
  if (parts.length === 5) {
    const min = parts[0], hour = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && mon === "*") {
      const at = hhmm(String(hour).padStart(2, "0"), String(min).padStart(2, "0"), ko ? "ko" : "en");
      const when = dowPhrase(dow, dom, ko ? "ko" : "en");
      return ko ? `${when} ${at}` : `${when} at ${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
  }
  return raw;
}

function hhmm(hour, minute, locale) {
  if (locale !== "ko") return `${hour}:${minute}`;
  const h = Number(hour);
  const period = h < 12 ? "오전" : "오후";
  const shown = h % 12 === 0 ? 12 : h % 12;
  return minute === "00" ? `${period} ${shown}시` : `${period} ${shown}시 ${Number(minute)}분`;
}

const DOW_KO = { "0": "일", "1": "월", "2": "화", "3": "수", "4": "목", "5": "금", "6": "토", "7": "일" };

function dowPhrase(dow, dom, locale) {
  const ko = locale === "ko";
  if (dow === "*" && dom === "*") return ko ? "매일" : "every day";
  if (dow === "1-5") return ko ? "평일(월~금)" : "every weekday";
  if (dow === "0,6" || dow === "6,0") return ko ? "주말" : "every weekend";
  if (/^\d$/.test(dow)) return ko ? `매주 ${DOW_KO[dow]}요일` : `every week on day ${dow}`;
  if (dow === "*" && /^\d+$/.test(dom)) return ko ? `매월 ${Number(dom)}일` : `on day ${dom} of each month`;
  if (/^[\d,]+$/.test(dow)) {
    const days = dow.split(",").map((d) => DOW_KO[d] || d).join("·");
    return ko ? `매주 ${days}요일` : `on ${dow}`;
  }
  return ko ? "정해진 때" : "on schedule";
}

function scheduleLabel(schedule) {
  return humanSchedule(schedule, "ko");
}

/** 청사진 → 그래프. **노드 id와 연결은 전부 여기서 만든다.** */
/** 길이를 넘으면 마지막 온전한 낱말까지만 — 데스크탑 clipAtWord와 같은 규칙. */
function clipAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

function buildGraphFromBlueprint(bp, locale = "ko", ctx = {}) {
  const problems = validateBlueprint(bp, ctx);
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
    const isCode = step.kind === "code";
    // 다른 자동화를 한 단계로 부른다(데스크탑 커넥터 C46 subgraph). 캔버스엔 있는데
    //   말로는 못 만들던 구멍 — 데스크탑 스케줄러가 이 노드를 재귀 실행한다.
    const isSub = step.kind === "runGraph";
    nodes.push({
      id: stepId(index),
      // 코드 스텝은 code 노드로, subgraph 는 subgraph 노드로(데스크탑 shared/graph-blueprint.ts와 같은 규칙).
      type: isSub ? "subgraph" : isCode ? "code" : (step.effect === "mutation" ? "action" : "agent"),
      label: step.title,
      position: { x: column(index + 1), y: 0 },
      config: {
        ...(isSub
          ? { graphRef: step.graphRef || "", note: step.instruction }
          : isCode
          ? {
            code: step.code || "", codeLang: step.codeLang === "js" ? "js" : "python", note: step.instruction,
            ...(Array.isArray(step.packages) && step.packages.length
              ? { packages: step.packages.map((v) => String(v).trim()).filter(Boolean) }
              : {}),
          }
          : { prompt: step.instruction }),
        effect: step.effect,
        // 기본은 잠김. 사람이 명시로 "검토 없이"라고 했을 때만 auto(데스크탑과 같은 규칙).
        ...(step.effect === "mutation"
          ? { approval: step.approval === "auto" ? "auto" : "ask" }
          : {}),
        // ★역할은 저장돼야 한다 — 묻기만 하고 버리면 편성이 채울 슬롯 자체가 없다
        //   (데스크탑 shared/graph-blueprint.ts와 같은 자리, 같은 규칙).
        ...(typeof step.role === "string" && step.role.trim() ? { role: step.role.trim() } : {}),
        ...(typeof step.roleEn === "string" && step.roleEn.trim() ? { roleEn: step.roleEn.trim() } : {}),
        ...(step.produces ? { produces: step.produces } : {}),
        ...(step.consumes && step.consumes.length ? { consumes: step.consumes[0] } : {}),
        ...(step.uses && step.uses.length
          ? { needs: step.uses.map((use) => ({
              capability: use.capability,
              provider: use.provider && findProvider(use.provider) ? use.provider : null,
              required: true,
            })) }
          : {}),
      },
    });
  });

  const branchAt = new Map();
  for (const branch of bp.branches || []) branchAt.set(branch.afterStep, branch);
  // ★한 단계 뒤에 검증 여럿(데스크탑 shared/graph-blueprint.ts와 같은 규칙).
  const checkAt = new Map();
  for (const check of bp.checks || []) {
    const list = checkAt.get(check.afterStep) || [];
    list.push(check);
    checkAt.set(check.afterStep, list);
  }
  const checkId = (i, ordinal = 0) =>
    ordinal === 0 ? `verify${i + 1}` : `verify${i + 1}-${ordinal + 1}`;
  let seq = 0;
  const link = (source, target, handle, maxIterations) => {
    edges.push({
      id: `e${seq += 1}`, source, target,
      ...(handle ? { sourceHandle: handle } : {}),
      ...(typeof maxIterations === "number" ? { maxIterations } : {}),
    });
  };
  link("start", stepId(0));
  for (const [afterStep, list] of checkAt) {
    if (!bp.steps[afterStep]) continue;
    list.forEach((check, ordinal) => {
      const firstItem = Array.isArray(check.items)
        ? check.items.find((item) => item && typeof item.text === "string" && item.text.trim())
        : null;
      // ★접두어는 제품 언어를 따르고, 자를 때 낱말을 쪼개지 않는다(데스크탑과 같은 규칙).
      const rawLabel = String((check.criteria || "").trim() || (firstItem && firstItem.text)
        || (locale === "en" ? "Checklist" : "채점표")).trim();
      const label = clipAtWord(rawLabel, 40);
      const itemRows = Array.isArray(check.items)
        ? check.items
          .filter((item) => item && typeof item.text === "string" && item.text.trim())
          .map((item) => ({ text: item.text.trim(), kind: item.kind === "mustNot" ? "mustNot" : "must" }))
        : [];
      nodes.push({
        id: checkId(afterStep, ordinal), type: "eval",
        label: `${locale === "en" ? "Check" : "검증"}: ${label}`,
        position: { x: column(afterStep + 1) + 70 + ordinal * 60, y: 0 },
        config: {
          subject: check.subject,
          ...(String(check.criteria || "").trim() ? { criteria: check.criteria } : {}),
          ...(itemRows.length ? { items: itemRows } : {}),
          ...(typeof check.evidence === "string" && check.evidence.trim() ? { evidence: check.evidence.trim() } : {}),
          produces: String(check.produces || "").trim()
            || (ordinal === 0 ? `check${afterStep + 1}_verdict` : `check${afterStep + 1}_${ordinal + 1}_verdict`),
        },
      });
    });
  }
  bp.steps.forEach((_step, index) => {
    const checkList = checkAt.get(index) || [];
    const branch = branchAt.get(index);
    const afterStepId = checkList.length ? checkId(index, checkList.length - 1) : stepId(index);
    checkList.forEach((_check, ordinal) => {
      link(ordinal === 0 ? stepId(index) : checkId(index, ordinal - 1), checkId(index, ordinal));
    });
    if (!branch) {
      if (bp.steps[index + 1]) link(afterStepId, stepId(index + 1));
      return;
    }
    const branchId = `check${index + 1}`;
    nodes.push({
      id: branchId, type: "condition", label: branchLabel(branch, locale),
      position: { x: column(index + 1) + 140, y: 0 },
      config: { var: branch.var, op: branch.op, ...(branch.value !== undefined ? { value: branch.value } : {}) },
    });
    link(afterStepId, branchId);
    // 되돌아가는 쪽은 선언(repeatOn)대로 잇는다 — 거짓 쪽으로 고정하면 사람이 말한
    // 방향과 반대인 자동화가 만들어진다(실측 3/3).
    const repeatSide = branch.repeatStep !== undefined ? branch.repeatOn : undefined;
    if (repeatSide === "yes") link(branchId, stepId(branch.repeatStep), "true", branch.maxRepeats);
    else if (branch.yesStep !== undefined && bp.steps[branch.yesStep]) link(branchId, stepId(branch.yesStep), "true");
    else if (bp.steps[index + 1]) link(branchId, stepId(index + 1), "true");
    if (repeatSide === "no") link(branchId, stepId(branch.repeatStep), "false", branch.maxRepeats);
    else if (branch.noStep !== undefined && bp.steps[branch.noStep]) link(branchId, stepId(branch.noStep), "false");
    else if (repeatSide === "yes" && bp.steps[index + 1]) link(branchId, stepId(index + 1), "false");
    // ★빠져나가는 쪽이 비어 있으면 끝나는 자리를 만들어 준다 (데스크탑 shared/graph-blueprint.ts와 같은 규칙).
    //   "마음에 들 때까지 다시 써"를 마지막 단계에 걸면 되돌아가는 쪽만 이어지고 빠져나가는 쪽이 빈다.
    //   그러면 커널은 NO_MATCHING_EDGE로 멈춘다 — **드디어 통과한 순간에**. 실패하는 동안은 잘 돌다가
    //   성공하자마자 죽는 가장 나쁜 타이밍이고, 말로 만든 사람은 뭘 빠뜨렸는지 알 수도 없다.
    const exitSide = repeatSide === "yes" ? "false" : repeatSide === "no" ? "true" : null;
    if (exitSide && !edges.some((e) => e.source === branchId && e.sourceHandle === exitSide)) {
      const doneId = `${branchId}-done`;
      const produced = bp.steps[branch.repeatStep !== undefined ? branch.repeatStep : index]
        && bp.steps[branch.repeatStep !== undefined ? branch.repeatStep : index].produces;
      nodes.push({
        id: doneId,
        type: "output",
        position: { x: 0, y: 0 },
        label: "끝",
        config: { effect: "read", text: produced ? `{{${produced}}}` : "완료했습니다." },
      });
      link(branchId, doneId, exitSide);
    }
  });

  // ★겹치지 않게 배치한 뒤 돌려준다(데스크탑 shared/graph-blueprint.ts와 같은 규칙·같은 상수).
  const built = { version: 1, nodes, edges };
  const laidOut = needsLayout(built) ? layoutGraph(built) : nodes;
  return {
    ok: true,
    graph: { version: 1, nodes: laidOut, edges },
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

/**
 * ★런타임이 JSON 대신 **사람에게 하는 말**을 돌려줬을 수 있다.
 *
 * 실측 2026-08-06: 모델이 `You've hit your weekly limit · resets Aug 8 at 6pm (Asia/Seoul)`을
 * 돌려줬는데, 제품은 그 문장을 삼키고 "만들 내용을 읽지 못했습니다 / 한 문장으로 다시
 * 적어 주세요"라고 말했다. 사람은 자기 문장이 틀린 줄 알고 몇 번이고 다시 쓴다 —
 * 아무리 잘 써도 안 된다. 무엇이 막혔는지 아는 쪽은 제품인데, 그것을 지우고 있었다.
 *
 * 짧고 JSON이 아니면 잘린 청사진이 아니라 **고지문**이다. 그대로 보여준다.
 */
const RUNTIME_NOTICE_MAX = 240;
const unreadable = (rawText) => {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  const looksLikeNotice = text.length > 0 && text.length <= RUNTIME_NOTICE_MAX && !text.includes("{");
  if (looksLikeNotice) {
    return {
      ok: false, code: "INTERVIEW_MODEL_UNAVAILABLE",
      reason: `AI가 만들지 못했습니다 — ${text}`,
      nextAction: "다른 모델을 연결하거나, 안내에 적힌 시각 이후에 다시 시도해 주세요.",
      // 재시도로 해결되지 않는다 — 형식 문제가 아니다.
      terminal: true,
    };
  }
  return {
    ok: false, code: "INTERVIEW_OUTPUT_UNREADABLE",
    reason: "만들 내용을 읽지 못했습니다.",
    nextAction: "자동으로 돌릴 일을 한 문장으로 다시 적어 주세요.",
  };
};

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
/**
 * 다시 만든 청사진이 앞 시도보다 작아졌는가. 데스크탑과 같은 계약.
 * 프롬프트로 "지우지 마라"고 부탁하는 것만으로는 안 된다 — 검증 오류는 그 단계를
 * 지우면 사라지고, 지워진 청사진은 검증을 통과한다.
 */
function weakenedAgainstLastAttempt(blueprint, state) {
  const attempts = (state && state.attempts) || [];
  const last = attempts[attempts.length - 1];
  if (!last) return null;
  const steps = Array.isArray(blueprint.steps) ? blueprint.steps.length : 0;
  const complainedAboutSize = (last.problems || []).some((p) => p.includes("단계가") && p.includes("개입니다"));
  if (typeof last.stepCount === "number" && steps < last.stepCount && !complainedAboutSize) {
    return `앞서 만든 것에는 단계가 ${last.stepCount}개였는데 이번에는 ${steps}개입니다.`
      + " 문제를 그 단계를 지워서 고치면, 부탁하신 일이 사라진 채로 만들어집니다.";
  }
  const trigger = blueprint.trigger && blueprint.trigger.kind;
  if (last.triggerKind && trigger && trigger !== last.triggerKind) {
    return `시작 방식이 "${last.triggerKind}"에서 "${trigger}"로 바뀌었습니다.`
      + " 언제 시작할지는 말씀하신 대로 두어야 합니다.";
  }
  return null;
}

function parseInterviewTurn(text, state) {
  const raw = firstJsonObject(text);
  if (!raw) return unreadable(text);
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return unreadable(text); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable(text);

  if (Array.isArray(parsed.ask) && parsed.ask.length > 0) {
    const questions = normalizeQuestions(parsed.ask, state);
    if (!questions.length) {
      return {
        ok: false, code: "INTERVIEW_REPEATED_QUESTIONS",
        reason: "이미 답하신 것만 다시 물으려 했습니다.",
        nextAction: "다시 시도하거나, 만들 것을 조금 더 구체적으로 적어 주세요.",
      };
    }
    return { ok: true, turn: { kind: "ask", questions } };
  }

  const blueprint = parsed.blueprint;
  if (!blueprint || typeof blueprint !== "object") return unreadable(text);
  // ★출력값 검증 check는 코드가 채운다 — 부탁받은 완전한 그래프를 완성한다(깎지도 떠넘기지도 않음).
  const normalized = autofillOutputChecks({ ...blueprint, schema: BLUEPRINT_SCHEMA });
  const problems = validateBlueprint(normalized);
  if (problems.length === 0) {
    // 검증은 통과했다. 그런데 **앞 시도보다 작아졌으면** 문제를 지워서 고친 것이다 —
    // 지워진 청사진은 검증을 통과하고, 사람이 부탁한 일이 사라진 채로 만들어진다.
    const weakened = weakenedAgainstLastAttempt(normalized, state);
    if (weakened) return { ok: true, turn: { kind: "retry", problems: [weakened] } };
    return { ok: true, turn: { kind: "blueprint", blueprint: normalized } };
  }
  const questions = normalizeQuestions(problems.map((p) => p.ask).filter(Boolean), state);
  if (questions.length) return { ok: true, turn: { kind: "ask", questions } };
  // 물어서 채울 수 없는 문제 — 사람이 답을 안 준 게 아니라 **모델이 형식을 틀린** 것이다.
  // 그걸 "구체적으로 적어 주세요"로 떠넘기면 막다른 길이 된다: 무엇이 틀렸는지 사람은
  // 모르고, 우리는 안다. 무엇이 틀렸는지 돌려주고 스스로 고치게 한다.
  return {
    ok: true,
    turn: {
      kind: "retry",
      problems: problems.map((p) => p.reason),
      stepCount: Array.isArray(normalized.steps) ? normalized.steps.length : 0,
      triggerKind: normalized.trigger && normalized.trigger.kind,
    },
  };
}

/** 모델이 스스로 고쳐 볼 기회의 상한. 데스크탑과 같은 값.
 *  2→4: 출력검증 문제는 사람에게 못 묻고 모델 단독 교정만 가능한데, 이제 메시지가 정확한
 *  checks[] 항목을 그대로 주므로(추가만 하면 됨) 몇 번 더 주면 대개 수렴한다. */
const MAX_SELF_CORRECTIONS = 4;

module.exports = {
  BLUEPRINT_SCHEMA, MAX_QUESTIONS_PER_TURN, MAX_INTERVIEW_ROUNDS, MAX_REPEATS,
  startInterview, recordAnswers, buildInterviewPrompt, parseInterviewTurn, humanSchedule,
  MAX_SELF_CORRECTIONS, weakenedAgainstLastAttempt,
  validateBlueprint, autofillOutputChecks, buildGraphFromBlueprint, branchLabel, describeBranches,
};
