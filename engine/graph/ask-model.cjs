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
const { resolveRuntime } = require("../runtimes/resolve.cjs");

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
 * @returns {Promise<{ok:true,text:string}|{ok:false,reason:string,nextAction:string}>}
 */
async function askModel(ctx, prompt, opts = {}) {
  let runtime;
  try {
    runtime = resolveRuntime({
      db: ctx.db(),
      prefs: ctx.prefs,
      role: "orchestrator",
      ...(opts.runtime ? { explicit: opts.runtime } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      reason: `실행할 AI 런타임을 찾지 못했습니다: ${(err && err.message) || err}`,
      nextAction: "`agentlas doctor`로 런타임 상태를 확인한 뒤 다시 시도해 주세요.",
    };
  }
  if (!runtime || !runtime.kind || !runtime.bin) {
    return {
      ok: false,
      reason: "실행할 AI 런타임이 준비되지 않았습니다.",
      nextAction: "`agentlas doctor`로 런타임 상태를 확인한 뒤 다시 시도해 주세요.",
    };
  }

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
    return {
      ok: false,
      reason: `AI를 부르지 못했습니다: ${(err && err.message) || err}`,
      nextAction: "잠시 뒤 다시 시도하거나 `agentlas doctor`로 상태를 확인해 주세요.",
    };
  }

  const text = String((res && (res.finalText || res.text)) || "");
  if (!text.trim()) {
    return {
      ok: false,
      reason: res && res.error
        ? `AI가 답하지 못했습니다: ${String(res.error).slice(0, 300)}`
        : "AI가 빈 답을 돌려줬습니다.",
      nextAction: "다시 시도해 주세요. 계속되면 `agentlas doctor`로 런타임을 확인해 주세요.",
    };
  }
  return { ok: true, text };
}

module.exports = { askModel };
