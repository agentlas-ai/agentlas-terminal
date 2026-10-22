"use strict";
/*
 * agentlas-api-agent: BYOK(Anthropic/OpenAI/Google) + Ollama 위에서 도는 agentlas 자체 에이전트 루프.
 * openclaw가 pi-agent-core로 하는 일을 CJS로: SSE 스트리밍 + provider별 tool-use 프로토콜 + 로컬 툴 실행.
 * byok.ts(electron)의 SSE 패턴을 이식했다. 외부 SDK 의존성 없음 (Node 20 fetch/ReadableStream).
 *
 *   anthropic / openai / ollama → 스트리밍 + 툴 루프 (read/write/full 권한 게이트)
 *   google                      → 스트리밍 채팅 (툴은 후속 — 우아하게 chat-only)
 *
 * Only `ollama` is a Terminal session lane (runtimes/kinds.cjs API_EXECUTABLE_KINDS; sessions/session.cjs). The
 * anthropic/openai/google branches are reached by contract tests only; BYOK, Agentlas serving, LM Studio and MLX run
 * through Desktop's local-tool-loop, which Terminal receives with the vendored core, not through this file.
 */
const crypto = require("node:crypto");
const tools = require("./agentlas-tools.cjs");
const { normalizeProviderUsage, createUsageSum } = require("./usage-normalizer.cjs");
const { redactToolContent } = require("./tool-result-redaction.cjs");

/*
 * Host-loop rules shared with Desktop local-tool-loop.ts (native-harness audit 31, A4 H2):
 *  - the round cap is a backstop against runaways, not a measure of the work (Desktop MAX_TOOL_LOOP_TURNS = 200).
 *    At 12, ordinary read-edit-check work hit it and the last intermediate text was saved as the answer;
 *  - a run that reaches the cap without an answer is a typed failure (local_tool_loop_stuck), never a reply;
 *  - real stalls are caught by repeated completed outcomes (Desktop automation-progress-guard: the same outcome
 *    4 times in a row, or the same observation 5 times), cleared by a successful new change.
 */
const MAX_ITERS = 200;
const NO_PROGRESS_IDENTICAL_STREAK = 4;
const NO_PROGRESS_SAME_OBSERVATION = 5;
const NO_PROGRESS_CODE = "automation_no_progress_loop";
const IDLE_MS = Number(process.env.AGENTLAS_IDLE_TIMEOUT_MS) || 180000;

// 스트림이 IDLE_MS 동안 한 바이트도 안 오면 중단(provider가 SSE를 열고 멈추는 hang 방지).
// 부모 signal(사용자 Ctrl-C)과 결합한다. timer는 unref이라 프로세스 종료를 막지 않는다.
function idleAbort(parentSignal, ms) {
  const ctrl = new AbortController();
  let timer = null;
  const onParent = () => ctrl.abort();
  if (parentSignal) {
    if (parentSignal.aborted) ctrl.abort();
    else parentSignal.addEventListener("abort", onParent, { once: true });
  }
  const bump = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), ms);
    if (timer.unref) timer.unref();
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    if (parentSignal && parentSignal.removeEventListener) parentSignal.removeEventListener("abort", onParent);
  };
  bump();
  return { signal: ctrl.signal, bump, clear };
}

async function* iterSse(resp, idle) {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (idle) idle.bump();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** Completed tool outcomes only (a request alone never proves progress). note() returns a failure when stalled. */
function createToolLoopProgress() {
  let lastExact = null;
  let streak = 0;
  const observations = new Map();
  const successfulChanges = new Set();
  const stalled = (rule) => ({
    error: "Execution stopped because the same tool outcomes kept repeating. Review the last work history before continuing.",
    errorKind: "refused", errorSource: "marker", errorCode: NO_PROGRESS_CODE, noProgressRule: rule,
  });
  return {
    note(name, args, out) {
      const tool = tools.BY_NAME[name];
      const observation = !tool || tool.minPerm === "read";
      const requestKey = digest(`${name} ${stableJson(args || {})}`);
      const outcomeKey = digest(`${requestKey} ${out && out.ok ? "result" : "error"} ${String((out && out.content) || "")}`);
      if (!observation && out && out.ok && !successfulChanges.has(outcomeKey)) {
        successfulChanges.add(outcomeKey);
        observations.clear();
        lastExact = null;
        streak = 0;
        return null;
      }
      streak = lastExact === outcomeKey ? streak + 1 : 1;
      lastExact = outcomeKey;
      if (streak >= NO_PROGRESS_IDENTICAL_STREAK) return stalled("identical_streak");
      if (observation) {
        const count = (observations.get(outcomeKey) || 0) + 1;
        observations.set(outcomeKey, count);
        if (count >= NO_PROGRESS_SAME_OBSERVATION) return stalled("same_observation");
      }
      return null;
    },
  };
}

function toolLoopStuck(model, rounds) {
  return {
    error: `The local model (${model || "model"}) kept calling tools for ${rounds} turns without reaching an answer. This run is not accepted as a result.`,
    errorKind: "exit", errorSource: "marker", errorCode: "local_tool_loop_stuck",
  };
}

function sseData(line) {
  if (!line.startsWith("data:")) return null;
  const p = line.slice(5).trim();
  return p === "[DONE]" ? "[DONE]" : p;
}

// ── Anthropic ────────────────────────────────────────────
async function streamAnthropic({ apiKey, model, system, messages, permission, ui, signal }) {
  const body = {
    model,
    max_tokens: 8192,
    stream: true,
    system,
    messages,
  };
  const toolDefs = tools.anthropicTools(permission);
  if (toolDefs.length) body.tools = toolDefs;

  const idle = idleAbort(signal, IDLE_MS);
  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: idle.signal,
      body: JSON.stringify(body),
    });
  } catch (error) {
    idle.clear();
    throw error;
  }
  if (!resp.ok) {
    idle.clear();
    throw new Error(`Anthropic ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  }

  const blocks = {}; // index → {type, text, name, id, inputJson}
  let stopReason = null;
  let messageStopped = false;
  let rawUsage = null; // message_start + message_delta usage merged, normalized once after the stream
  try {
    for await (const line of iterSse(resp, idle)) {
      const data = sseData(line);
      if (!data || data === "[DONE]") continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === "message_stop") {
        messageStopped = true;
      } else if (ev.type === "content_block_start") {
        const cb = ev.content_block || {};
        blocks[ev.index] = { type: cb.type, text: "", name: cb.name, id: cb.id, inputJson: "" };
        if (cb.type === "tool_use") ui.tool(cb.name, "");
        else ui.streamStart();
      } else if (ev.type === "content_block_delta") {
        const b = blocks[ev.index] || (blocks[ev.index] = { type: "text", text: "", inputJson: "" });
        if (ev.delta.type === "text_delta") {
          b.text += ev.delta.text;
          ui.streamDelta(ev.delta.text);
        } else if (ev.delta.type === "input_json_delta") {
          b.inputJson += ev.delta.partial_json || "";
        }
      } else if (ev.type === "content_block_stop") {
        const b = blocks[ev.index];
        if (b && b.type === "tool_use") {
          const arg = safeArg(b.inputJson);
          if (arg) ui.info(ui.c.dim("  " + arg));
        }
        // 텍스트 블록 stop에서는 streamEnd를 호출하지 않는다 — 메모리 가드 중간 flush 방지(턴 끝에서만 flush).
      } else if (ev.type === "message_start") {
        const u = ev.message && ev.message.usage;
        if (u && typeof u === "object") rawUsage = { ...(rawUsage || {}), ...u };
      } else if (ev.type === "message_delta") {
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        // message_delta usage is cumulative for the fields it carries; absent fields keep message_start's value.
        if (ev.usage && typeof ev.usage === "object") {
          const defined = Object.fromEntries(Object.entries(ev.usage).filter(([, v]) => v !== undefined && v !== null));
          rawUsage = { ...(rawUsage || {}), ...defined };
        }
      }
    }
  } finally {
    // 본문 스트림이 중간에 끊겨도 Renderer의 열린 스트림 상태와 취소 리스너를 남기지 않는다.
    ui.streamEnd();
    idle.clear();
  }

  // 어셈블
  const ordered = Object.keys(blocks)
    .sort((a, b) => a - b)
    .map((k) => blocks[k]);
  const assistantContent = [];
  const toolUses = [];
  let text = "";
  for (const b of ordered) {
    if (b.type === "text" && b.text) {
      assistantContent.push({ type: "text", text: b.text });
      text += b.text;
    } else if (b.type === "tool_use") {
      let input = {};
      try {
        input = JSON.parse(b.inputJson || "{}");
      } catch {
        input = {};
      }
      assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input });
      toolUses.push({ id: b.id, name: b.name, input });
    }
  }
  const usage = rawUsage ? normalizeProviderUsage("anthropic", rawUsage) : null;
  return { text, assistantContent, toolUses, stopReason, usage,
    terminal: messageStopped && ["end_turn", "max_tokens", "stop_sequence", "tool_use"].includes(stopReason) };
}

async function runAnthropicLoop(req) {
  const { ctx, ui } = req;
  const messages = req.messages.slice();
  let finalText = "";
  let ownerControlTerminal = "uncertain";
  let reachedEnd = false;
  let toolRounds = 0;
  const progress = createToolLoopProgress();
  const usageSum = createUsageSum();
  for (let i = 0; i < MAX_ITERS; i++) {
    if (req.signal && req.signal.aborted) { reachedEnd = true; break; }
    const r = await streamAnthropic({
      apiKey: req.apiKey,
      model: req.model,
      system: req.system,
      messages,
      permission: ctx.permission,
      ui,
      signal: req.signal,
    });
    finalText = r.text || finalText;
    if (r.usage) usageSum.add(r.usage);
    if (!r.terminal || (r.toolUses.length && r.stopReason !== "tool_use")) { reachedEnd = true; break; }
    if (!r.toolUses.length) { ownerControlTerminal = "completed"; reachedEnd = true; break; }
    toolRounds += 1;
    messages.push({ role: "assistant", content: r.assistantContent });
    const results = [];
    for (const tu of r.toolUses) {
      const out = await tools.runToolAsync(tu.name, tu.input, ctx);
      const safe = redactToolContent(out.content);
      ui.toolResult(safe.content, out.ok, { redaction: safe.redaction });
      if (out.terminalUncertain) return { text: finalText, ownerControlTerminal: "uncertain" };
      const stalled = progress.note(tu.name, tu.input, out);
      if (stalled) { const spent = usageSum.total(); if (spent) ui.cost(spent); return { text: finalText, ownerControlTerminal: "uncertain", ...stalled }; }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: safe.content, is_error: !out.ok });
    }
    messages.push({ role: "user", content: results });
  }
  const spent = usageSum.total();
  if (spent) ui.cost(spent);
  if (!reachedEnd) return { text: finalText, ownerControlTerminal: "uncertain", ...toolLoopStuck(req.model, toolRounds) };
  return { text: finalText, ownerControlTerminal };
}

// ── OpenAI ───────────────────────────────────────────────
async function streamOpenAI({ apiKey, model, messages, permission, ui, signal, baseUrl }) {
  const body = { model, stream: true, stream_options: { include_usage: true }, messages };
  const toolDefs = tools.openaiTools(permission);
  if (toolDefs.length) body.tools = toolDefs;

  const idle = idleAbort(signal, IDLE_MS);
  let resp;
  try {
    resp = await fetch(`${baseUrl || "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      signal: idle.signal,
      body: JSON.stringify(body),
    });
  } catch (error) {
    idle.clear();
    throw error;
  }
  if (!resp.ok) {
    idle.clear();
    throw new Error(`OpenAI ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  }

  let text = "";
  let started = false;
  const toolCalls = {}; // index → {id, name, args}
  let finish = null;
  let usage = null;
  try {
    for await (const line of iterSse(resp, idle)) {
      const data = sseData(line);
      if (!data || data === "[DONE]") continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.usage) usage = normalizeProviderUsage("openai-chat", ev.usage);
      const choice = ev.choices && ev.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (delta.content) {
        if (!started) {
          ui.streamStart();
          started = true;
        }
        text += delta.content;
        ui.streamDelta(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolCalls[idx] || (toolCalls[idx] = { id: "", name: "", args: "" });
          if (tc.id) cur.id = tc.id;
          if (tc.function && tc.function.name) {
            if (!cur.name) ui.tool(tc.function.name, "");
            cur.name = tc.function.name;
          }
          if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  } finally {
    if (started) ui.streamEnd();
    idle.clear();
  }

  const calls = Object.keys(toolCalls)
    .sort((a, b) => a - b)
    .map((k) => toolCalls[k])
    .filter((c) => c.name);
  return { text, toolCalls: calls, finish, usage };
}

async function runOpenAILoop(req) {
  const { ctx, ui } = req;
  const messages = req.messages.slice();
  // OpenAI는 system을 messages[0]로.
  if (!messages.length || messages[0].role !== "system") messages.unshift({ role: "system", content: req.system });
  let finalText = "";
  let ownerControlTerminal = "uncertain";
  let reachedEnd = false;
  let toolRounds = 0;
  const progress = createToolLoopProgress();
  const usageSum = createUsageSum();
  for (let i = 0; i < MAX_ITERS; i++) {
    if (req.signal && req.signal.aborted) { reachedEnd = true; break; }
    const r = await streamOpenAI({
      apiKey: req.apiKey,
      model: req.model,
      messages,
      permission: ctx.permission,
      ui,
      signal: req.signal,
      baseUrl: req.baseUrl,
    });
    finalText = r.text || finalText;
    if (r.usage) usageSum.add(r.usage);
    if (!["stop", "length", "tool_calls", "function_call"].includes(r.finish)
      || (r.toolCalls.length && !["tool_calls", "function_call"].includes(r.finish))) { reachedEnd = true; break; }
    if (!r.toolCalls.length) { ownerControlTerminal = "completed"; reachedEnd = true; break; }
    toolRounds += 1;
    messages.push({
      role: "assistant",
      content: r.text || null,
      tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
    });
    for (const c of r.toolCalls) {
      let args = {};
      try {
        args = JSON.parse(c.args || "{}");
      } catch {
        args = {};
      }
      const arg = safeArgObj(args);
      if (arg) ui.info(ui.c.dim("  " + arg));
      const out = await tools.runToolAsync(c.name, args, ctx);
      const safe = redactToolContent(out.content);
      ui.toolResult(safe.content, out.ok, { redaction: safe.redaction });
      if (out.terminalUncertain) return { text: finalText, ownerControlTerminal: "uncertain" };
      const stalled = progress.note(c.name, args, out);
      if (stalled) { const spent = usageSum.total(); if (spent) ui.cost(spent); return { text: finalText, ownerControlTerminal: "uncertain", ...stalled }; }
      messages.push({ role: "tool", tool_call_id: c.id, content: safe.content });
    }
  }
  const spent = usageSum.total();
  if (spent) ui.cost(spent);
  if (!reachedEnd) return { text: finalText, ownerControlTerminal: "uncertain", ...toolLoopStuck(req.model, toolRounds) };
  return { text: finalText, ownerControlTerminal };
}

// ── Ollama (openai 스타일 tools, /api/chat) ──────────────
async function runOllamaLoop(req) {
  const { ctx, ui } = req;
  const host = (req.ctx.env && req.ctx.env.OLLAMA_HOST) || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const messages = req.messages.slice();
  if (!messages.length || messages[0].role !== "system") messages.unshift({ role: "system", content: req.system });
  const toolDefs = tools.openaiTools(ctx.permission);
  let finalText = "";
  let ownerControlTerminal = "uncertain";
  let reachedEnd = false;
  let toolRounds = 0;
  const progress = createToolLoopProgress();
  const usageSum = createUsageSum();
  const finish = (extra) => { const spent = usageSum.total(); if (spent) ui.cost(spent); return { ...extra }; };
  for (let i = 0; i < MAX_ITERS; i++) {
    if (req.signal && req.signal.aborted) { reachedEnd = true; break; }
    const idle = idleAbort(req.signal, IDLE_MS);
    let resp;
    try {
      resp = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: idle.signal,
        body: JSON.stringify({ model: req.model, stream: true, messages, tools: toolDefs.length ? toolDefs : undefined }),
      });
    } catch (e) {
      idle.clear();
      throw new Error(`Ollama connection failed (${host}) — is 'ollama serve' running? ${e.message}`);
    }
    if (!resp.ok) {
      idle.clear();
      const body = (await resp.text().catch(() => "")).slice(0, 200);
      /*
       * ★"model 'x' not found" 는 낼 수는 있는데 푸는 길이 없는 오류였다 — 사용자는
       * 이 컴퓨터에 무엇이 받아져 있는지 모른다. 서버가 살아 있으면 실제 목록을 붙인다.
       */
      if (/not found/i.test(body)) {
        const hint = await require("./runtimes/ollama.cjs")
          .describeMissingModel(req.model, { env: ctx.env })
          .catch(() => null);
        if (hint) throw new Error(hint);
      }
      throw new Error(`Ollama ${resp.status}: ${body}`);
    }
    let text = "";
    let started = false;
    let toolCalls = [];
    let done = false;
    let doneEvent = null;
    try {
      for await (const line of iterSse(resp, idle)) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.done === true) { done = true; doneEvent = ev; }
        const msg = ev.message || {};
        if (msg.content) {
          if (!started) {
            ui.streamStart();
            started = true;
          }
          text += msg.content;
          ui.streamDelta(msg.content);
        }
        if (Array.isArray(msg.tool_calls)) toolCalls = toolCalls.concat(msg.tool_calls);
      }
    } finally {
      if (started) ui.streamEnd();
      idle.clear();
    }
    finalText = text || finalText;
    // The final `done` event carries prompt_eval_count / eval_count; a done without them is an unknown call.
    if (doneEvent) usageSum.add(normalizeProviderUsage("ollama", doneEvent));
    if (!done) { reachedEnd = true; break; }
    if (!toolCalls.length) { ownerControlTerminal = "completed"; reachedEnd = true; break; }
    toolRounds += 1;
    messages.push({ role: "assistant", content: text, tool_calls: toolCalls });
    for (const c of toolCalls) {
      const fn = c.function || {};
      const args = typeof fn.arguments === "string" ? safeParse(fn.arguments) : fn.arguments || {};
      ui.tool(fn.name || "tool", safeArgObj(args));
      const out = await tools.runToolAsync(fn.name, args, ctx);
      const safe = redactToolContent(out.content);
      ui.toolResult(safe.content, out.ok, { redaction: safe.redaction });
      if (out.terminalUncertain) return finish({ text: finalText, ownerControlTerminal: "uncertain" });
      const stalled = progress.note(fn.name, args, out);
      if (stalled) return finish({ text: finalText, ownerControlTerminal: "uncertain", ...stalled });
      // Ollama tool 결과는 tool_call_id가 없으므로 tool_name으로 상관관계를 보존 (병렬 호출 시 중요)
      messages.push({ role: "tool", tool_name: fn.name, content: safe.content });
    }
  }
  if (!reachedEnd) return finish({ text: finalText, ownerControlTerminal: "uncertain", ...toolLoopStuck(req.model, toolRounds) });
  return finish({ text: finalText, ownerControlTerminal });
}

// ── Google (chat-only 스트리밍) ──────────────────────────
async function runGoogleChat(req) {
  const { ui } = req;
  const contents = [];
  for (const m of req.messages) {
    if (m.role === "user") contents.push({ role: "user", parts: [{ text: textOf(m.content) }] });
    else if (m.role === "assistant") contents.push({ role: "model", parts: [{ text: textOf(m.content) }] });
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(req.apiKey)}`;
  const idle = idleAbort(req.signal, IDLE_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: idle.signal,
      body: JSON.stringify({ systemInstruction: { parts: [{ text: req.system }] }, contents }),
    });
  } catch (error) {
    idle.clear();
    throw error;
  }
  if (!resp.ok) {
    idle.clear();
    throw new Error(`Google ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 300)}`);
  }
  let text = "";
  let ownerControlTerminal = "uncertain";
  let started = false;
  try {
    for await (const line of iterSse(resp, idle)) {
      const data = sseData(line);
      if (!data || data === "[DONE]") continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (["STOP", "MAX_TOKENS"].includes(ev.candidates?.[0]?.finishReason)) ownerControlTerminal = "completed";
      const t = ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts && ev.candidates[0].content.parts[0] && ev.candidates[0].content.parts[0].text;
      if (t) {
        if (!started) {
          ui.streamStart();
          started = true;
        }
        text += t;
        ui.streamDelta(t);
      }
    }
  } finally {
    if (started) ui.streamEnd();
    idle.clear();
  }
  return { text, ownerControlTerminal };
}

// ── 엔트리 ───────────────────────────────────────────────
// req = { backend, model, apiKey, system, messages([{role,content}]), ctx({cwd,permission}), ui, signal }
async function runApiTurn(req) {
  switch (req.backend) {
    case "anthropic":
      return runAnthropicLoop(req);
    case "openai":
      return runOpenAILoop(req);
    case "upstage":
      return runOpenAILoop({ ...req, baseUrl: "https://api.upstage.ai/v1" });
    case "ollama":
      return runOllamaLoop(req);
    case "google":
      return runGoogleChat(req);
    default:
      throw new Error(`unsupported backend: ${req.backend}`);
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
function safeArg(json) {
  return safeArgObj(safeParse(json || "{}"));
}
function safeArgObj(o) {
  if (!o || typeof o !== "object") return "";
  return o.file_path || o.path || o.command || o.pattern || o.query || "";
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return "";
}

module.exports = { runApiTurn, runOllamaLoop, MAX_ITERS };
