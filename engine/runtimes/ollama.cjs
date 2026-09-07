"use strict";
/*
 * runtimes/ollama — 로컬 Ollama 서버의 **실물** 인벤토리.
 *
 * ★왜 생겼나 (2026-09-07 실측). `agentlas --runtime ollama` 는 resolve 에서
 *   `{kind:"ollama", backend:"ollama"}` 만 만들고 **모델을 정하지 않았다**
 *   (runtimes/resolve.cjs apiRuntime — model 은 공유 DB active_runtime 행에만 있다).
 *   그래서 실행부 세 곳이 각자 `runtime.model || "llama3.1"` 로 이름을 지어냈고,
 *   그 모델이 없는 기계에서는 전부 이렇게 죽었다:
 *
 *     Ollama 404: {"error":"model 'llama3.1' not found"}
 *
 *   실측한 기계에는 qwen3:30b-a3b 와 gpt-oss:20b 가 **둘 다 받아져 있었고 둘 다
 *   도구 호출까지 정상 동작했다.** 즉 능력 문제가 아니라 이름을 지어낸 문제였다.
 *   "이 컴퓨터에 뭐가 있는지"는 추측할 값이 아니라 물어보면 답해 주는 값이다.
 *
 * 규칙:
 *  - 기본값 상수를 두지 않는다. 모델 이름은 언제나 서버가 말한 목록에서만 나온다.
 *  - 못 정했으면 **조용히 아무 모델이나 고르지 않고** 왜 못 정했는지와 푸는 길
 *    (ollama serve / ollama pull)을 함께 던진다.
 *
 * 쌍둥이: agentlas_desktop/electron/runtime/ollama.ts 의 probeOllama (같은 두 엔드포인트).
 */

/** 기본 로컬 호스트. env OLLAMA_HOST 로 재정의 가능(원격 Ollama 포함). */
function ollamaHost(env) {
  const source = env && typeof env === "object" ? env : process.env;
  const raw = String(source.OLLAMA_HOST || "").trim();
  if (!raw) return "http://127.0.0.1:11434";
  const trimmed = raw.replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

async function getJson(url, timeoutMs, fetchImpl) {
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await doFetch(url, { signal: ctrl.signal });
    if (!resp || !resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 로컬 Ollama 서버 감지. 서버가 안 떠 있으면 null.
 * @returns {Promise<{host:string, version:string, models:string[]}|null>}
 */
async function probeOllama(opts) {
  const options = opts || {};
  const host = ollamaHost(options.env);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2000;
  const tags = await getJson(`${host}/api/tags`, timeoutMs, options.fetch);
  if (!tags) return null;
  const models = Array.isArray(tags.models)
    ? tags.models.map((m) => (m && typeof m.name === "string" ? m.name : "")).filter(Boolean)
    : [];
  const version = await getJson(`${host}/api/version`, timeoutMs, options.fetch);
  return { host, version: (version && version.version) || "unknown", models };
}

/**
 * 사용자가 적은 모델 이름을 설치된 태그에 맞춘다.
 * ollama 는 `qwen3` 를 `qwen3:latest` 로 저장하므로 정확일치만 보면 멀쩡한 이름이 빗나간다.
 */
function matchInstalledModel(preferred, models) {
  const want = String(preferred || "").trim();
  if (!want) return null;
  if (models.includes(want)) return want;
  const latest = `${want}:latest`;
  if (models.includes(latest)) return latest;
  const base = want.split(":")[0].toLowerCase();
  return models.find((name) => name.split(":")[0].toLowerCase() === base) || null;
}

function ollamaError(code, lines) {
  const error = new Error(lines.filter(Boolean).join("\n"));
  error.code = code;
  return error;
}

/**
 * 이번 실행에 쓸 Ollama 모델 이름을 정한다.
 *
 * 사용자가(또는 공유 DB active_runtime 이) 이름을 정했으면 **그대로 존중한다** —
 * 없는 모델이면 서버가 그 이름을 그대로 짚어 404 로 말해 주고, 그 문구는
 * describeMissingModel 이 설치 목록으로 보강한다. 여기서 몰래 다른 모델로
 * 바꿔치기하면 사용자가 고른 것과 실제로 돈 것이 갈린다.
 *
 * 이름이 없을 때만 서버에 물어 **실재하는** 모델을 고른다. 예전 기본값
 * `"llama3.1"` 은 지어낸 이름이었고, 그 모델이 없는 기계에서는 실행이 통째로 죽었다.
 *
 * @param {string|null|undefined} preferred 사용자가/공유 DB가 정한 모델(없을 수 있다)
 * @returns {Promise<{model:string, host:string, models:string[]|null, requested:string|null}>}
 */
async function resolveOllamaModel(preferred, opts) {
  const options = opts || {};
  const host = ollamaHost(options.env);
  const requested = String(preferred || "").trim() || null;
  if (requested) return { model: requested, host, models: null, requested };

  const probe = await probeOllama(options);
  if (!probe) {
    throw ollamaError("ollama_unreachable", [
      `No Ollama model is selected and the Ollama server is not answering at ${host}.`,
      "",
      "Start it, then rerun:",
      "  ollama serve",
      "",
      "Using a different host? Set OLLAMA_HOST (e.g. OLLAMA_HOST=127.0.0.1:11434).",
    ]);
  }
  if (!probe.models.length) {
    throw ollamaError("ollama_no_models", [
      `Ollama is running at ${probe.host} but has no models pulled.`,
      "",
      "Pull one, then rerun:",
      "  ollama pull qwen3",
    ]);
  }
  return { model: probe.models[0], host: probe.host, models: probe.models, requested: null };
}

/**
 * "model 'x' not found" 를 사람이 풀 수 있는 문장으로 바꾼다.
 * 서버가 살아 있으면 실제 설치 목록을 붙인다 — 없으면 원문을 그대로 둔다.
 */
async function describeMissingModel(model, opts) {
  const probe = await probeOllama(opts);
  if (!probe || !probe.models.length) return null;
  const matched = matchInstalledModel(model, probe.models);
  return [
    `Ollama model '${model}' is not on this machine.`,
    `Installed: ${probe.models.join(", ")}`,
    "",
    matched
      ? `Did you mean '${matched}'?`
      : `Pull it, or select one that is already here:\n  ollama pull ${model}`,
  ].join("\n");
}

module.exports = {
  ollamaHost,
  probeOllama,
  matchInstalledModel,
  resolveOllamaModel,
  describeMissingModel,
};
