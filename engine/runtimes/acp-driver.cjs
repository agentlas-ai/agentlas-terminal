"use strict";
/*
 * runtimes/acp-driver — kimi · grok · cursor 를 위한 ACP 드라이버 (PRD 2026-08-15 T-2).
 *
 * 세 번째 손코딩이 아니다. Desktop 이 만든 공용 ACP 러너(electron/runtime/acp.js)를 벤더 코어에서
 * 그대로 로드해 쓴다 — 데스크탑·터미널이 같은 파일 하나로 같은 런타임을 같은 품질로 돈다.
 * (터미널이 손으로 미러링해 온 native-host 4종과 달리 드리프트가 구조적으로 없다.)
 *
 * 벤더 코어에 acp.js 가 없으면(옛 코어) — 종전 그대로 "드라이버 없음"으로 정직하게 거부한다.
 * 조용히 다른 런타임으로 넘어가지 않는다.
 */
const { loadCoreAcpRuntime } = require("../core/desktop-core.cjs");

const ACP_KINDS = new Set(["kimi", "grok", "cursor"]);

/** 이 머신에서 ACP 드라이버를 쓸 수 있는가. { ok, reason?, module? } */
function acpDriverAvailability() {
  const loaded = loadCoreAcpRuntime();
  if (!loaded) return { ok: false, reason: "desktop core not available (run `agentlas doctor`)" };
  if (loaded.error) return { ok: false, reason: loaded.error.message };
  if (!loaded.module || typeof loaded.module.createAcpRunner !== "function") {
    return { ok: false, reason: "desktop core exposes no createAcpRunner" };
  }
  return { ok: true, module: loaded.module };
}

function acpSpecFor(kind, mod) {
  const spec = mod.ACP_AGENTS && mod.ACP_AGENTS[kind];
  return spec || null;
}

/**
 * native-host 계약으로 ACP 턴을 돈다.
 * req = { kind, bin, prompt, systemPrompt, cwd, permission, ui, env, signal, model, locale }
 * 반환: { text, session, usage, error, errorKind, errorSource }
 */
async function runAcpTurn(req) {
  const { kind, bin, ui } = req;
  const avail = acpDriverAvailability();
  if (!avail.ok) {
    return { text: "", session: req.session || {}, error: `runtime '${kind}' has no ACP driver here: ${avail.reason}`, errorKind: "unsupported", errorSource: "marker" };
  }
  const mod = avail.module;
  const spec = acpSpecFor(kind, mod);
  if (!spec) {
    return { text: "", session: req.session || {}, error: `runtime '${kind}' is not an ACP agent in this core`, errorKind: "unsupported", errorSource: "marker" };
  }
  const runner = mod.createAcpRunner(spec);
  const locale = req.locale === "ko" ? "ko" : "en";
  let streaming = false;
  let lastText = "";
  const events = {
    onPartial: (full) => {
      const text = String(full || "");
      if (!streaming) { ui.streamStart(); streaming = true; }
      const delta = text.startsWith(lastText) ? text.slice(lastText.length) : text;
      lastText = text;
      if (delta) ui.streamDelta(delta);
    },
    onStatus: (status) => ui.status(status),
    onTool: (name, args, result, id, isError) => {
      ui.tool(name, args || "");
      if (result) ui.toolResult(result, !isError);
    },
    onThinking: (phase) => { if (phase === "start") ui.status(locale === "ko" ? "생각 중..." : "thinking..."); },
    onNotice: (notice) => { if (notice && notice.message) ui.status(notice.message); },
  };
  try {
    const result = await runner({
      systemPrompt: req.systemPrompt || "",
      history: [],
      userPrompt: req.prompt || "",
      backendLabel: spec.label,
      locale,
      permission: req.permission,
      runtimeSource: bin,
      cwd: req.cwd,
      env: req.env || process.env,
      signal: req.signal,
      ...(req.model ? { model: req.model } : {}),
    }, events);
    if (streaming) ui.streamEnd();
    const session = { ...(req.session || {}), ...(result.sessionId ? { acpSessionId: result.sessionId } : {}) };
    if (result.failure) {
      return { text: result.text || "", session, usage: null, error: result.failure.message, errorKind: result.failure.kind, errorSource: result.failure.source };
    }
    return { text: result.text || "", session, usage: null, error: null };
  } catch (e) {
    if (streaming) ui.streamEnd();
    const message = e && e.message ? e.message : String(e);
    return { text: "", session: req.session || {}, usage: null, error: message, errorKind: /abort/i.test(message) ? "cancelled" : "exit", errorSource: "marker" };
  }
}

module.exports = { ACP_KINDS, acpDriverAvailability, acpSpecFor, runAcpTurn };
