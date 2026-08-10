"use strict";
/*
 * storm/deps — storm/swarm 하네스의 의존성 주머니(D bag) 조립 + 로컬 런타임 인벤토리.
 *
 * v1에서는 모놀리스(engine/agentlas.cjs)의 lazy 팩토리 parity()가 이 D를 만들었다
 * (legacy-v1-engine-snapshot, 10727–10758행). v2에서는 각 멤버를 모듈 경계에 맞게
 * 다시 배선한다:
 *
 *   captureRuntime / runApi / buildChildEnvCli / projectCwd / runCwd
 *                       → engine/workforce/capture.cjs (검증된 헤드리스 캡처 단일 경로 —
 *                         storm/swarm 워커용 제2의 스폰 경로를 만들지 않는다)
 *   resolveRuntime      → engine/workforce/deps.cjs resolveWorkforceRuntime
 *                         (v1 사다리 그대로: 명시 override > prefs 저장 CLI >
 *                          공유 DB active_runtime(byok/ollama 포함) > PATH 탐지.
 *                          아무것도 없으면 code="no_runtime" 정직 정지 — 폴백 금지)
 *   listAvailableRuntimes → 여기서 v1 모놀리스 9245–9275행을 포팅 (아래)
 *   modelRoutingReceiptPath → v1과 동일한 userData 하위 JSONL
 *
 * 불변식(오너 결정): 인벤토리는 이 호스트에 실제 설치·연결된 런타임만 광고한다.
 * Terminal/plugin이 스케줄할 수 없는 런타임을 시늉하지 않는다.
 */
const path = require("node:path");

const { userDataDir } = require("../core/paths.cjs");
const routing = require("../agentlas-workload-routing.cjs");
const capture = require("../workforce/capture.cjs");
const { resolveWorkforceRuntime } = require("../workforce/deps.cjs");

// v1 모놀리스 listAvailableRuntimes 포팅 (legacy-v1-engine-snapshot 9245–9275행).
// 상위(부모 AI) 워크로드 할당자를 위한 "실행 가능한 런타임 인벤토리"를 만든다.
function listAvailableRuntimes(db, fallbackRuntime = null) {
  const active = fallbackRuntime || resolveWorkforceRuntime(db);
  const candidates = [];
  const add = (runtime) => {
    if (!runtime) return;
    const key = runtime.mode === "cli" ? `cli:${runtime.kind}` : `api:${runtime.backend}:${runtime.model || ""}`;
    if (candidates.some((item) => item.key === key)) return;
    const discovered = routing.defaultAvailableModels(runtime);
    const availableModels = [...discovered];
    if (runtime.model && !availableModels.some((model) => model.id === runtime.model)) {
      availableModels.push({
        id: runtime.model,
        tier: runtime.modelTier || runtime.tier || null,
        capabilities: runtime.capabilities || [],
        contextWindow: runtime.contextWindow || null,
        efforts: runtime.efforts || [],
        description: runtime.modelDescription || "host-selected current model",
      });
    }
    candidates.push({ ...runtime, key, availableModels });
  };
  add(active);
  for (const kind of Object.keys(capture.RUNTIME_BIN)) {
    if (!capture.which(capture.RUNTIME_BIN[kind])) continue;
    add({ mode: "cli", kind });
  }
  return candidates
    .filter((runtime) => runtime.availableModels.length)
    .map(({ key, ...runtime }, index) => ({ ...runtime, runtimeId: `runtime-${index + 1}` }));
}

// v1 D.modelRoutingReceiptPath와 동일한 경로. workload-routing의 defaultReceiptPath
// (~/.agentlas/…)가 아니라 userData 하위를 쓰는 것이 Terminal의 v1 계약이다.
function modelRoutingReceiptPath() {
  return path.join(userDataDir(), "model-routing-receipts.jsonl");
}

/**
 * D bag 조립. ctx = { lang?, out? } (엔진 ctx의 부분집합).
 * 모든 멤버는 v1 parity() 팩토리와 같은 계약 형태를 유지한다 —
 * storm/swarm 모듈은 이 D만 사용하고 자체 스폰/자체 상태를 갖지 않는다.
 */
function buildStormDeps(ctx = {}) {
  return {
    prefsLang: () => ctx.lang || "en",
    // Phase 1-2: 주입 Ui 관통 (자체 생성 방지)
    uiInstance: ctx.uiInstance || null,
    out: typeof ctx.out === "function" ? ctx.out : (s) => process.stdout.write(`${s}\n`),
    resolveRuntime: resolveWorkforceRuntime,
    listAvailableRuntimes,
    captureRuntime: capture.captureRuntime,
    runApi: capture.runApi,
    buildChildEnvCli: capture.buildChildEnv,
    projectCwd: capture.projectCwd,
    runCwd: capture.runCwd,
    modelRoutingReceiptPath,
  };
}

module.exports = { listAvailableRuntimes, modelRoutingReceiptPath, buildStormDeps };
