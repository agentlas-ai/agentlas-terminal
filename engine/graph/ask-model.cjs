"use strict";
/*
 * 인터뷰 한 턴을 모델에게 묻는 최소 경로.
 *
 * 세션·영속·메모리 티켓 없이 **한 번 묻고 최종 텍스트만** 받는다. 인터뷰는 사람이 화면 앞에
 * 앉아 기다리는 대화라, 채팅 세션의 부수효과(대화 저장·메모리 방출·펜스 처리)가 끼어들면
 * 사용자가 요청하지 않은 기록이 남는다.
 *
 * 실패를 삼키지 않는다. 모델이 안 돌면 그 사실과 다음 행동을 그대로 돌려준다 —
 * 조용히 빈 문자열을 주면 파서가 "읽지 못했습니다"로 바꿔 원인이 사라진다.
 */
const nativeHost = require("../agentlas-native-host.cjs");
// ★resolveRuntime(resolve.cjs)이 아니라 resolveRuntimeForAgent를 쓴다.
// resolveRuntime은 `role`을 **아예 읽지 않아서**, 사용자가 모델 역할에 gemini를 지정해 둬도
// active_runtime(codex)으로 흘렀다(실측: 인터뷰가 사용자가 고르지 않은 런타임에서 돌았고,
// 그쪽 사용 한도가 소진돼 있었다). 사용자가 정한 역할 사다리를 따르는 쪽이 정본이다.
const { resolveRuntimeForAgent } = require("../runtimes/overrides.cjs");
const { listAvailableCliRuntimes } = require("../runtimes/detect.cjs");

/**
 * native-host가 부르는 이벤트 싱크 — 인터뷰 중에는 화면에 아무것도 흘리지 않는다.
 *
 * ★메서드를 손으로 골라 적으면 안 된다. native-host가 부르는 이름이 하나라도 빠지면
 * 턴 중간에 TypeError로 죽는다(실측: streamStart 누락으로 프로세스가 통째로 죽었다).
 * 실제 EventSink의 표면을 그대로 덮어써서, 저쪽이 늘어나도 여기가 따라간다.
 */
function quietSink() {
  const { EventSink } = require("../sessions/sink.cjs");
  const sink = new EventSink(() => {}, () => {});
  const quiet = Object.create(Object.getPrototypeOf(sink));
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(sink))) {
    if (name === "constructor") continue;
    quiet[name] = () => {};
  }
  // native-host가 색/번역 헬퍼도 만진다.
  quiet.c = new Proxy({}, { get: () => (text) => String(text ?? "") });
  quiet.t = (_key, fallback) => String(fallback ?? "");
  quiet.replaceTasks = () => {};
  return quiet;
}

/**
 * 인터뷰 한 턴을 묻는다.
 *
 * 사용자가 정한 역할(orchestrator)을 **먼저** 쓴다. 그게 실패하면 조용히 포기하지 않고
 * 이 컴퓨터에 있는 다른 런타임으로 이어서 물어보되, **어느 것이 답했는지 말한다** —
 * 조용히 다른 모델로 바꾸면 사용자는 자기가 고른 모델이 돈 줄 안다.
 * 전부 실패하면 각각의 사유를 그대로 돌려준다(하나로 뭉뚱그리면 원인이 사라진다).
 *
 * @returns {Promise<{ok:true,text:string,runtime:string,fellBackFrom?:string}
 *                  |{ok:false,reason:string,nextAction:string}>}
 */
async function askModel(ctx, prompt, opts = {}) {
  const db = ctx.db();
  let primary = null;
  try {
    primary = resolveRuntimeForAgent({
      db,
      prefs: ctx.prefs,
      role: "orchestrator",
      ...(opts.runtime ? { explicit: opts.runtime } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    });
  } catch (err) {
    primary = null;
    var primaryError = (err && err.message) || String(err);
  }

  // 시도 순서: 사용자가 정한 것 먼저, 그다음 이 컴퓨터에 있는 나머지.
  const candidates = [];
  if (primary && primary.kind && primary.bin) candidates.push(primary);
  if (!opts.runtime) {
    // listAvailableCliRuntimes()는 문자열이 아니라 {kind, bin, path} 객체를 돌려준다.
    // 문자열로 읽으면 후보가 하나도 안 쌓여 폴백이 통째로 죽는다(실측).
    for (const found of listAvailableCliRuntimes()) {
      if (!found || !found.kind || !found.path) continue;
      if (candidates.some((c) => c.kind === found.kind)) continue;
      candidates.push({ kind: found.kind, bin: found.path });
    }
  }
  if (!candidates.length) {
    return {
      ok: false,
      reason: primaryError
        ? `실행할 AI 런타임을 찾지 못했습니다: ${primaryError}`
        : "이 컴퓨터에서 쓸 수 있는 AI 런타임이 없습니다.",
      nextAction: "`agentlas doctor`로 런타임 상태를 확인한 뒤 다시 시도해 주세요.",
    };
  }

  const failures = [];
  for (const runtime of candidates) {
    let res;
    try {
      res = await nativeHost.runNativeTurn({
        kind: runtime.kind,
        bin: runtime.bin,
        ui: quietSink(),
        cwd: opts.cwd || process.cwd(),
        prompt,
        // 읽기 권한 — 인터뷰는 사람에게 묻고 형식을 만드는 일이라 파일을 바꿀 이유가 없다.
        permission: "read",
        session: {},
        model: runtime.model,
        effort: runtime.effort,
        mcpServers: [],
        mcpAllowlistMode: "exact",
      });
    } catch (err) {
      failures.push(`${runtime.kind}: ${(err && err.message) || err}`);
      continue;
    }
    const text = String((res && (res.finalText || res.text)) || "");
    /*
     * ★런타임이 "답"이 아니라 **거절 고지문**을 돌려줬을 수 있다.
     *
     * 실측 2026-08-06: claude-code가 `You've hit your weekly limit · resets Aug 8 at 6pm`을
     * 돌려줬는데, 빈 답이 아니라는 이유로 성공으로 세어졌다. 그래서 **멀쩡히 살아 있는
     * codex로 넘어가지 않고** 인터뷰가 통째로 죽었다 — 폴백 장치는 있는데 이 경우에만
     * 안 걸린 셈이다. 한 줄짜리 고지문은 산출물이 아니다. 실패로 세고 다음 런타임을 쓴다.
     */
    const notice = runtimeRefusal(text);
    if (notice) {
      failures.push(`${runtime.kind}: ${notice}`);
      continue;
    }
    if (text.trim()) {
      const out = { ok: true, text, runtime: runtime.kind };
      if (candidates[0] !== runtime) out.fellBackFrom = candidates[0].kind;
      return out;
    }
    failures.push(res && res.error
      ? `${runtime.kind}: ${String(res.error).replace(/\s+/g, " ").slice(0, 200)}`
      : `${runtime.kind}: 빈 답`);
  }

  return {
    ok: false,
    reason: `AI가 답하지 못했습니다.\n  ${failures.join("\n  ")}`,
    nextAction: "`agentlas doctor`로 런타임 상태를 확인하거나, 로그인이 필요한 런타임에 다시 로그인해 주세요.",
  };
}

/**
 * 한 줄짜리 거절 고지문인가 — 한도 소진·로그인 필요·요금 문제 같은 것.
 * 산출물(JSON·본문)은 길거나 구조가 있다. 짧고 구조가 없고 거절 단어가 있으면 고지문이다.
 */
const REFUSAL_WORDS = /\b(limit|quota|rate.?limit|usage|credits?|billing|sign in|log in|unauthorized|forbidden|expired|subscription)\b/i;
function runtimeRefusal(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 240) return null;
  if (t.includes("{") || t.includes("\n\n")) return null;
  return REFUSAL_WORDS.test(t) ? t : null;
}

module.exports = { askModel };
