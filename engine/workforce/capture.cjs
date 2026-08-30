"use strict";
/*
 * workforce/capture — 헤드리스 러너 2종: CLI 캡처(captureRuntime) + BYOK 원샷(runApi),
 * 그리고 워크포스 워커의 자식 env 빌더(buildChildEnv).
 *
 * v1 모놀리스(engine/agentlas.cjs, legacy-v1-engine-snapshot)의 captureRuntime /
 * runApi / buildChildEnvCli 를 계약 그대로 포팅했다. 계약 자체는
 * test/capture-runtime-guard.cjs 가 고정한다 — 아래 속성을 약화시키면 안 된다:
 *
 *  - idle/total 타임아웃 + SIGTERM→SIGKILL 승격 + kill-grace 강제 해제
 *    (child가 close를 영영 안 줘도 캡처 슬롯은 반드시 풀린다)
 *  - 출력 상한(AGENTLAS_CAPTURE_MAX_OUTPUT_BYTES, 64KB..32MB) 초과 즉시 중단 —
 *    무한 출력 버퍼링 금지
 *  - AbortSignal 전파(운영자 취소)
 *  - no-authority 캡처: 프롬프트를 argv로만 전달(stdin 에코 없음), MCP는
 *    정확-공백 격리(claudeMcpIsolationArgs/geminiMcpIsolationArgs), 툴 전면 차단
 *  - 자식 env는 native-host.runtimeEnvForKind 로 신원 격리(CODEX_HOME 등),
 *    프로젝트 .env가 보호 키(타임아웃/캡처 상한 포함)를 덮지 못한다
 */
const fs = require("node:fs");
const { detectRuntimeRefusal } = require("../runtime-refusal.cjs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { dbPath, userDataDir } = require("../core/paths.cjs");
const { runCwd, projectCwd } = require("../project/paths.cjs");

// 캡처 드라이버가 검증된 런타임만. 정본(runtimes/kinds.cjs)의 RUNTIME_BIN에는 kimi/grok/cursor도
// 있지만 buildArgs/텍스트 추출 계약이 없으므로 캡처 검증 파생본만 쓴다 — 새 kind 를
// 정본에 추가해도 capture:true 를 명시하기 전엔 여기 조용히 들어오지 않는다.
const { CAPTURE_RUNTIME_BIN: RUNTIME_BIN } = require("../runtimes/kinds.cjs");
const { readKeychainPassword } = require("../core/keychain-read.cjs");

const SERVICE = "com.agentlas.desktop";

// v1 which 포팅: PATH + 알려진 설치 위치. detect.whichSync(spawn `which`)와 달리
// 캡처 경로는 프로세스 spawn 없이 결정론적으로 실행 파일을 찾는다.
function which(cmd) {
  const paths = (process.env.PATH || "").split(path.delimiter);
  const exts = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  const extra = [
    path.join(os.homedir(), ".claude/local"),
    path.join(os.homedir(), ".codex/bin"),
    path.join(os.homedir(), ".gemini/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of [...paths, ...extra]) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function finiteTimeoutMs(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const CAPTURE_OUTPUT_DEFAULT_BYTES = 4 * 1024 * 1024;
function captureOutputLimit(env = process.env) {
  return finiteTimeoutMs(env.AGENTLAS_CAPTURE_MAX_OUTPUT_BYTES, CAPTURE_OUTPUT_DEFAULT_BYTES, 64 * 1024, 32 * 1024 * 1024);
}
function directCaptureOutputLimit(value) {
  return finiteTimeoutMs(value, CAPTURE_OUTPUT_DEFAULT_BYTES, 128, 32 * 1024 * 1024);
}

// ── 캡처 인자 빌드 (v1 buildArgs 포팅) ──────────────────────────────────
// 보안 매핑은 native-host/permissions가 단일 정본이다. 여기서는 조립만 한다.
function buildArgs(kind, systemPrompt, prompt, permission, runtimeOptions = {}) {
  const native = require("../agentlas-native-host.cjs");
  const level = require("../agentlas-permissions.cjs").normalize(permission);
  const model = runtimeOptions.model ? String(runtimeOptions.model) : null;
  const effort = runtimeOptions.effort ? String(runtimeOptions.effort) : null;
  const noAuthority = runtimeOptions.authorityMode === "no-authority";
  // read-only 권한: 워크포스가 tool:file-read 능력만 부여했을 때. plan 모드(쓰기 불가)에
  // 정확-도구 allowlist를 겹쳐 읽기 3종으로 고정한다. 이것이 "증명 가능한 경계"의 실체다 —
  // 예전에는 이 모드가 없어서 도구를 주면 곧바로 acceptEdits(쓰기)+기본 도구 전체가 됐고,
  // 그래서 권한 부여 자체를 항상 거부할 수밖에 없었다(2026-07-27 코드 감사 불가의 근본).
  const readOnlyAuthority = runtimeOptions.authorityMode === "read-only";
  const readOnlyTools = Array.isArray(runtimeOptions.allowedNativeTools) && runtimeOptions.allowedNativeTools.length
    ? [...new Set(runtimeOptions.allowedNativeTools.map((t) => String(t)))].sort()
    : [];
  if (readOnlyAuthority && !readOnlyTools.length) {
    throw new Error("read-only capture requires an explicit native tool allowlist");
  }
  // read-only 분기를 가진 런타임은 claude-code뿐이다. 다른 kind로 들어오면 아래에서
  // 일반 권한 분기로 떨어져 조용히 쓰기/셸까지 열린다 — 권한 승격이므로 정직 정지.
  // (역할별 모델 배정으로 워커가 codex/gemini에서 돌 수 있게 되며 실재 경로가 됐다.)
  if (readOnlyAuthority && kind !== "claude-code") {
    throw new Error(`read-only capture is not provable on ${kind}`);
  }
  if (kind === "claude-code") {
    if (readOnlyAuthority) {
      const thinkingRo = effort === "max" || effort === "xhigh" ? "Ultrathink. " : effort === "high" ? "Think hard. " : effort === "medium" ? "Think. " : "";
      const claudeEffortRo = effort === "minimal" ? "low" : effort === "xhigh" ? "max" : effort;
      return [
        "-p", thinkingRo + prompt,
        "--append-system-prompt", systemPrompt,
        ...(model ? ["--model", model] : []),
        ...(claudeEffortRo && claudeEffortRo !== "none" ? ["--effort", claudeEffortRo] : []),
        // 도구를 쓰는 워커는 최종 답까지 stdout에 한 글자도 내지 않는다 — 무도구
        // 워커에는 없던 문제다. 유휴 타이머는 그 침묵을 "죽었다"로 읽고 10분에
        // 처형한다(2026-07-27 라이브 실측 AGENTLAS_CAPTURE_IDLE_TIMEOUT). 이벤트
        // 스트림으로 받아 도구 호출마다 진행 신호가 흐르게 하면 유휴 판정이 비로소
        // 진짜 정지 신호가 된다. 최종 텍스트는 capturedRuntimeAgentText가 result
        // 이벤트에서 뽑는다(이미 이 프로토콜을 파싱한다). 부분 토큰 델타는 켜지
        // 않는다 — 진행 신호는 도구 호출 단위로 충분하고 출력량이 폭증한다.
        "--output-format", "stream-json",
        "--verbose",
        // plan 모드는 쓰기/실행을 거부한다. allowedTools로 읽기 3종만 남긴다.
        "--permission-mode", "plan",
        "--allowedTools", readOnlyTools.join(","),
        "--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,Bash,BashOutput,KillShell,WebFetch,WebSearch,Task",
        ...native.claudeMcpIsolationArgs(),
      ];
    }
    const perm = native.claudePermissionArgs(noAuthority ? "read" : level);
    // 백그라운드/캡처 경로에는 검토된 MCP 서버 목록이 없다. full 권한은 툴 권한이지
    // MCP 동의가 아니므로 이 경로는 항상 정확-공백 MCP 격리를 유지한다.
    const mcp = native.claudeMcpIsolationArgs();
    const thinking = effort === "max" || effort === "xhigh" ? "Ultrathink. " : effort === "high" ? "Think hard. " : effort === "medium" ? "Think. " : "";
    const claudeEffort = effort === "minimal" ? "low" : effort === "xhigh" ? "max" : effort;
    const effortArgs = claudeEffort && claudeEffort !== "none" ? ["--effort", claudeEffort] : [];
    return [
      "-p", thinking + prompt,
      "--append-system-prompt", systemPrompt,
      ...(model ? ["--model", model] : []),
      ...effortArgs,
      // 이 분기도 read-only 분기와 같은 이유로 이벤트 스트림이 필요하다. 위 주석은
      // 침묵 문제를 "도구를 쓰는 워커"의 것으로 한정했지만, 그건 도구 유무가 아니라
      // "최종 답 전에는 stdout에 아무것도 없다"는 성질이고 이 분기도 똑같다.
      // effort가 높으면 "Ultrathink."가 앞에 붙어 사고만 10분을 넘길 수 있고,
      // 유휴 타이머는 그 침묵을 죽음으로 읽는다 — 2026-07-28 라이브에서 무도구
      // 워커 3개가 전부 600초 유휴로 처형됐다. 진행 신호가 흐르는 채널로 재야
      // 유휴 판정이 실제 정지를 뜻한다. 최종 텍스트는
      // capturedRuntimeAgentText가 result 이벤트에서 그대로 뽑는다.
      "--output-format", "stream-json",
      "--verbose",
      ...perm,
      ...(noAuthority ? ["--tools", ""] : []),
      ...mcp,
    ];
  }
  if (kind === "codex") {
    const perm = native.codexPermissionArgs(noAuthority ? "read" : level);
    const mcp = [];
    const modelArgs = model ? ["-m", model] : [];
    const effortArgs = effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
    const noAuthorityArgs = noAuthority ? [
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--disable", "apps",
      "--disable", "browser_use",
      "--disable", "computer_use",
      "--disable", "image_generation",
      "--disable", "workspace_dependencies",
      "--disable", "goals",
      "--disable", "memories",
      "--disable", "plugins",
      "--disable", "hooks",
      "--disable", "multi_agent",
      "--disable", "tool_suggest",
      "--json",
    ] : [];
    return ["exec", "--skip-git-repo-check", ...noAuthorityArgs, ...modelArgs, ...effortArgs, ...perm, ...mcp, `[SYSTEM]\n${systemPrompt}\n\n${prompt}`];
  }
  if (kind === "gemini") {
    const perm = native.geminiPermissionArgs(noAuthority ? "read" : level);
    if (noAuthority && !runtimeOptions.noToolsPolicyPath) {
      // Gemini는 툴 공백을 증명할 명시적 deny-all 정책 파일 없이는 no-authority 실행 금지.
      throw new Error("Gemini no-authority capture requires an explicit deny-all policy");
    }
    const noAuthorityArgs = noAuthority
      ? ["--admin-policy", String(runtimeOptions.noToolsPolicyPath)]
      : [];
    // full 권한이어도 사용자의 전역 Gemini MCP 정의(자격증명 env 동반)를 상속하지 않는다.
    const mcp = native.geminiMcpIsolationArgs();
    return ["--prompt", `[SYSTEM]\n${systemPrompt}\n\n${prompt}`, ...(model ? ["-m", model] : []), ...perm, ...noAuthorityArgs, ...mcp];
  }
  if (kind === "agy") {
    return native.agyArgs({
      prompt,
      systemPrompt,
      permission: noAuthority ? "read" : level,
      model,
    });
  }
  return [prompt];
}

// codex --json 이벤트 스트림에서 최종 에이전트 텍스트만 추출.
function codexCaptureAgentText(jsonl) {
  const completed = [];
  const latest = new Map();
  for (const line of String(jsonl || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event?.item;
    if (!item || item.type !== "agent_message" || typeof item.text !== "string") continue;
    if (event.type === "item.completed") completed.push(item.text);
    else if (event.type === "item.started" || event.type === "item.updated") latest.set(String(item.id || latest.size), item.text);
  }
  if (completed.length) return completed.join("");
  return [...latest.values()].join("");
}

function nonNegativeTokenCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function usageFromObject(value, inputKeys, outputKeys, inputAdditiveKeys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const firstCount = (keys) => {
    for (const key of keys) {
      const count = nonNegativeTokenCount(value[key]);
      if (count != null) return count;
    }
    return null;
  };
  let inputTokens = firstCount(inputKeys);
  const outputTokens = firstCount(outputKeys);
  if (inputTokens != null) {
    for (const key of inputAdditiveKeys) {
      const count = nonNegativeTokenCount(value[key]);
      if (count != null) inputTokens += count;
    }
  }
  // Do not manufacture a zero for providers that expose only one side.
  return inputTokens == null || outputTokens == null
    ? null
    : { inputTokens, outputTokens };
}

function capturedRuntimeUsage(kind, raw) {
  const events = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  const genericUsage = (value) =>
    usageFromObject(
      value,
      ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "promptTokenCount"],
      ["outputTokens", "output_tokens", "completionTokens", "completion_tokens", "candidatesTokenCount"],
    );
  for (const event of [...events].reverse()) {
    if (kind === "claude-code") {
      const claudeUsage = usageFromObject(
        event?.usage,
        ["input_tokens"],
        ["output_tokens"],
        ["cache_creation_input_tokens", "cache_read_input_tokens"],
      );
      if (claudeUsage) return claudeUsage;
      const modelUsage = event?.modelUsage;
      if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
        let inputTokens = 0;
        let outputTokens = 0;
        let observed = false;
        for (const row of Object.values(modelUsage)) {
          const usage = genericUsage(row);
          if (!usage) continue;
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          observed = true;
        }
        if (observed) return { inputTokens, outputTokens };
      }
    }
    const direct =
      genericUsage(event?.usage) ||
      genericUsage(event?.step_update?.usage) ||
      genericUsage(event?.usageMetadata) ||
      genericUsage(event?.stats);
    if (direct) return direct;
    if (kind === "gemini") {
      const models = event?.stats?.models;
      if (models && typeof models === "object" && !Array.isArray(models)) {
        let inputTokens = 0;
        let outputTokens = 0;
        let observed = false;
        for (const row of Object.values(models)) {
          const usage = genericUsage(row);
          if (!usage) continue;
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          observed = true;
        }
        if (observed) return { inputTokens, outputTokens };
      }
    }
  }
  return null;
}


/**
 * ★캡처된 스트림에서 **실패 표식**을 걷는다 — 종료코드만 보면 exit 0 거절이 산출물이 된다.
 *
 * 실측(2026-08-06): claude 한도는 rate_limit_event(status:rejected)·result(is_error:true)를
 * 보내고, codex 한도는 표식 없이 거절문을 agent_message로 싣고 turn.completed로 끝난다.
 * 이 파일은 이벤트 종류 목록에 rate_limit_event를 적어 두고도 한 번도 읽지 않았다 —
 * 거절문이 그대로 워커 핸드오프가 되어 종합(synthesis)에 섞였다.
 */
function capturedRuntimeFailure(kind, raw, text) {
  const events = raw.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (kind === "claude-code") {
      if (event.type === "result" && event.is_error) {
        return { message: typeof event.result === "string" ? event.result : "claude error", source: "marker" };
      }
      if (event.type === "rate_limit_event" && event.rate_limit_info && event.rate_limit_info.status === "rejected") {
        return { message: "claude rate limit rejected", source: "marker" };
      }
    }
    if (kind === "codex" && (event.type === "turn.failed" || event.type === "error")) {
      const msg = (event.error && (event.error.message || event.error)) || "codex error";
      return { message: String(msg), source: "marker" };
    }
    if (kind === "gemini") {
      if (event.type === "error") {
        const msg = (event.error && (event.error.message || event.error)) || "gemini error";
        return { message: String(msg), source: "marker" };
      }
      if (event.type === "result" && event.status && event.status !== "success") {
        return { message: `gemini ${event.status}`, source: "marker" };
      }
    }
    if (kind === "agy" && event.event === "result") {
      const status = String(event.result?.status || "").toLowerCase();
      if (status && !["success", "completed", "done"].includes(status)) {
        return { message: `agy ${status}`, source: "marker" };
      }
    }
  }
  // 표식이 전혀 없는 케이스(codex 한도) — 휴리스틱 최후 그물, 출처 표기.
  const refusal = detectRuntimeRefusal(text);
  return refusal ? { message: refusal.message, source: "heuristic" } : null;
}

function capturedRuntimeAgentText(kind, raw) {
  const text = String(raw || "");
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 네이티브 CLI는 캡처 모드에서 보통 평문을 준다. 한 줄이라도 JSON이 아니면
      // 추측하지 말고 전체 결과를 보존한다.
      return text.trim();
    }
  }
  if (!events.length) return "";

  if (kind === "claude-code") {
    const isProtocol = events.some((event) =>
      ["system", "stream_event", "result", "rate_limit_event"].includes(event?.type),
    );
    if (!isProtocol) return text.trim();
    const final = [...events].reverse().find(
      (event) => event?.type === "result" && typeof event.result === "string",
    );
    if (final) return final.result;
    return events.map((event) => {
      const delta = event?.type === "stream_event" ? event.event?.delta : null;
      return delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
    }).join("");
  }

  if (kind === "gemini") {
    const isProtocol = events.some((event) =>
      ["init", "message", "tool_use", "tool_result", "result", "error"].includes(event?.type),
    );
    if (!isProtocol) return text.trim();
    const assistant = events
      .filter((event) => event?.type === "message" && event.role === "assistant")
      .map((event) => typeof event.content === "string" ? event.content : "")
      .join("");
    if (assistant) return assistant;
    const final = [...events].reverse().find((event) =>
      event?.type === "result" &&
      (typeof event.result === "string" || typeof event.response === "string"),
    );
    return final ? String(final.result ?? final.response) : "";
  }

  if (kind === "agy") {
    const isProtocol = events.some((event) =>
      event?.event === "step_update" || event?.event === "result",
    );
    if (!isProtocol) return text.trim();
    const final = [...events].reverse().find((event) =>
      event?.event === "result" && typeof event.result?.response === "string",
    );
    if (final) return final.result.response;
    return events
      .filter((event) => event?.event === "step_update" && event.step_update?.step_type === "agent_response")
      .map((event) => typeof event.step_update?.text_delta === "string" ? event.step_update.text_delta : "")
      .join("");
  }

  return text.trim();
}

/**
 * 네이티브 CLI 헤드리스 1턴 캡처 — 최종 텍스트를 resolve한다.
 * opts: { cwd, env, permission, model, effort, authorityMode, noToolsPolicyPath,
 *         envelope, timeoutConfig, outputLimitBytes, signal, spawn(테스트 주입) }
 * envelope=true면 { text, usage }를 반환한다. usage는 양쪽 토큰을 실제로 관측한
 * 경우만 채우고, 불완전한 provider 이벤트를 0으로 위조하지 않는다.
 */
function captureRuntime(kind, systemPrompt, prompt, opts) {
  opts = opts || {};
  const cwd = opts.cwd || runCwd();
  const nativeHost = require("../agentlas-native-host.cjs");
  const timeout = opts.timeoutConfig
    ? nativeHost.directNativeTimeoutConfig(opts.timeoutConfig)
    : nativeHost.nativeTimeoutConfig(opts.env || process.env);
  const outputLimit = opts.outputLimitBytes == null
    ? captureOutputLimit(opts.env || process.env)
    : directCaptureOutputLimit(opts.outputLimitBytes);
  return new Promise((resolve, reject) => {
    // 계약 테스트용 실행 파일 주입(가짜 CLI가 픽스처를 cat) — 프로덕션 경로에선 없음.
    const bin = opts.binOverride || which(RUNTIME_BIN[kind]) || RUNTIME_BIN[kind];
    let child;
    let launchCleanup = () => {};
    try {
      const spawnImpl = opts.spawn || spawn;
      const env = nativeHost.runtimeEnvForKind(kind, opts.env || process.env, {
        permission: opts.permission,
        mcpServers: [],
        mcpAllowlistMode: kind === "gemini" ? "exact" : undefined,
      });
      const groupedChild = process.platform !== "win32" && spawnImpl === spawn;
      const runtimeOptions = {
        model: opts.model,
        effort: opts.effort,
        authorityMode: opts.authorityMode,
        noToolsPolicyPath: opts.noToolsPolicyPath,
        allowedNativeTools: opts.allowedNativeTools,
      };
      let childArgs = buildArgs(kind, systemPrompt, prompt, opts.permission, runtimeOptions);
      if (kind === "agy") {
        const prepared = nativeHost.prepareAgyLaunch({
          prompt,
          systemPrompt,
          permission: opts.authorityMode === "no-authority" ? "read" : opts.permission,
          model: opts.model,
        }, {
          platform: opts.platform,
          promptLimit: opts.agyPromptLimit,
        });
        childArgs = prepared.args;
        launchCleanup = prepared.cleanup;
      }
      child = spawnImpl(bin, childArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        detached: groupedChild,
        windowsHide: true,
      });
      child.__agentlasGroupedChild = groupedChild;
    } catch (error) {
      launchCleanup();
      reject(error);
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let capturedBytes = 0;
    let settled = false;
    let terminationError = null;
    let idleTimer = null;
    let totalTimer = null;
    let killTimer = null;
    let forceTimer = null;
    let onStdout = () => {};
    let onStderr = () => {};
    let onError = () => {};
    let onClose = () => {};
    let onAbort = () => {};

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      idleTimer = totalTimer = killTimer = forceTimer = null;
    };
    const cleanup = () => {
      clearTimers();
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (opts.signal) opts.signal.removeEventListener?.("abort", onAbort);
      launchCleanup();
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const requestStop = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      idleTimer = totalTimer = null;
      nativeHost.terminateNativeChild(child, "SIGTERM");
      if (settled) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        nativeHost.terminateNativeChild(child, "SIGKILL");
        if (settled) return;
        // child가 close를 영영 안 줘도 캡처 슬롯을 강제로 해제한다 (v1 계약).
        forceTimer = setTimeout(() => finishReject(terminationError), Math.max(250, Math.min(1_000, timeout.killGraceMs)));
      }, timeout.killGraceMs);
    };
    const timeoutError = (phase, ms) => {
      const error = new Error(
        phase === "idle"
          ? `${kind} capture idle timeout: ${ms}ms 동안 출력이 없습니다.`
          : `${kind} capture total timeout: 전체 실행 시간이 ${ms}ms를 초과했습니다.`,
      );
      error.code = `AGENTLAS_CAPTURE_${phase.toUpperCase()}_TIMEOUT`;
      return error;
    };
    const armIdle = () => {
      if (settled || terminationError) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => requestStop(timeoutError("idle", timeout.idleMs)), timeout.idleMs);
    };
    const append = (target, chunk) => {
      armIdle();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, outputLimit - capturedBytes);
      if (remaining > 0) {
        const kept = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
        target.push(kept);
        capturedBytes += kept.length;
      }
      if (bytes.length > remaining) {
        const error = new Error(`${kind} capture output limit: ${outputLimit} bytes를 초과했습니다.`);
        error.code = "AGENTLAS_CAPTURE_OUTPUT_LIMIT";
        requestStop(error);
      }
    };

    onStdout = (chunk) => append(stdoutChunks, chunk);
    onStderr = (chunk) => append(stderrChunks, chunk);
    onError = (error) => finishReject(terminationError || error);
    onClose = (code) => {
      if (terminationError) {
        finishReject(terminationError);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code && code !== 0) {
        // stderr가 경고문뿐이면 진짜 원인이 stdout(JSON 오류 응답 등)에 있을 수 있다 —
        // 2026-07-27 실측: 워커 exit 1이 설정 경고 2줄만 남기고 원인 불명이 됐다.
        // 두 스트림의 꼬리를 모두 싣는다.
        const stdoutTail = stdout.trim().slice(-400);
        finishReject(new Error(
          `${kind} exited ${code}: ${stderr.slice(-500)}${stdoutTail ? `\n--- stdout tail ---\n${stdoutTail}` : ""}`,
        ));
        return;
      }
      const raw = stdout.trim() || stderr.trim();
      let text;
      if (kind === "codex" && opts.authorityMode === "no-authority") {
        text = codexCaptureAgentText(raw);
      } else if (kind === "claude-code" || kind === "gemini" || kind === "agy") {
        text = capturedRuntimeAgentText(kind, raw);
      } else {
        text = raw;
      }
      // ★거절 고지문은 산출물이 아니다 — 성공으로 돌려주면 워커 핸드오프가 오염된다.
      const failure = capturedRuntimeFailure(kind, raw, text);
      if (failure) {
        finishReject(new Error(`${kind} runtime refused (${failure.source}): ${failure.message}`));
        return;
      }
      finishResolve(opts.envelope
        ? { text, usage: capturedRuntimeUsage(kind, raw) }
        : text);
    };
    onAbort = () => {
      const reason = opts.signal && opts.signal.reason;
      const error = reason instanceof Error ? reason : new Error(`${kind} capture aborted`);
      if (!error.code) error.code = "ABORT_ERR";
      requestStop(error);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
    armIdle();
    totalTimer = setTimeout(() => requestStop(timeoutError("total", timeout.totalMs)), timeout.totalMs);
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ── API 러너 (BYOK / Ollama) — 비스트리밍, 최종 텍스트/usage 반환 (v1 runApi 포팅) ──
// engine/agentlas-api-agent.cjs 는 스트리밍+툴 루프(대화형)용이다. 워크포스 워커는
// zero-tools 원샷이 계약이므로 v1의 비스트리밍 원샷 경로를 그대로 쓴다.
const DEFAULT_API_MODEL = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
  ollama: "llama3.1",
  upstage: "solar-pro2",
  custom: "deepseek-chat",
  glm: "glm-4.6",
  kimi: "kimi-k2-0711-preview",
  deepseek: "deepseek-chat",
};
const ANTHROPIC_COMPAT_API = {
  glm: { label: "GLM", baseUrl: "https://api.z.ai/api/anthropic" },
  kimi: { label: "Kimi", baseUrl: "https://api.moonshot.ai/anthropic" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/anthropic" },
};
const DEFAULT_CUSTOM_API_BASE_URL = "https://api.openai.com/v1";

async function apiKey(backend) {
  // ★거부가 아니라 **정지**가 실제 실패 모양이다. 예전에는 `.catch(() => null)` 하나로
  //   "접근 거부는 키 없음" 이라 적어 두었는데, 화면 없는 호스트에서 keytar 는 거부하지 않고
  //   영영 돌아오지 않는다(이벤트 루프째로). core/keychain-read 가 상한을 실제로 걸 수 있는
  //   자식 프로세스에서 읽고, 못 읽으면 여기 계약대로 "키 없음"을 돌려준다.
  return readKeychainPassword(SERVICE, "byok:" + backend);
}

// Custom BYOK 키가 전송될 origin 재검증: 공개 주소는 HTTPS만, HTTP는 localhost/LAN만.
function normalizeCustomApiBaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return DEFAULT_CUSTOM_API_BASE_URL;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Custom API base URL is invalid.");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const isPrivateLan =
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (isLoopback || isPrivateLan))) {
    throw new Error("Custom API base URL must use HTTPS or HTTP on localhost/LAN.");
  }
  return value.replace(/\/+$/, "");
}

/** Desktop과 공유하는 SQLite meta에서 Custom OpenAI base URL을 읽는다(읽기 전용). */
function readCustomApiBaseUrl() {
  const p = dbPath();
  if (!fs.existsSync(p)) return DEFAULT_CUSTOM_API_BASE_URL;
  let db = null;
  let raw = "";
  try {
    try {
      const Database = require("better-sqlite3");
      db = new Database(p, { readonly: true, fileMustExist: true });
    } catch {
      const { DatabaseSync } = require("node:sqlite");
      db = new DatabaseSync(p, { readOnly: true });
    }
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'custom_base_url'").get();
      raw = row && row.value ? row.value : "";
    } catch {
      // 구버전 DB에 meta 테이블/키가 없으면 Desktop과 동일하게 OpenAI 기본 URL.
      raw = "";
    }
  } catch (e) {
    throw new Error(`Could not read the Custom API base URL from the shared database: ${(e && e.message) || e}`);
  } finally {
    try { if (db && typeof db.close === "function") db.close(); } catch { /* ignore close failure */ }
  }
  return normalizeCustomApiBaseUrl(raw);
}

/**
 * BYOK/Ollama 한 턴. 재사용 경로이므로 절대 process.exit하지 않고 오류를 throw해
 * 호출자의 catch/finally가 부분 실패를 처리하게 한다.
 * options는 회귀 테스트의 fetch/키 주입용이며 상용 호출자는 사용하지 않는다.
 */
async function runApi(backend, model, system, prompt, options) {
  options = options || {};
  const finish = (text, usage) => options.envelope
    ? { text: String(text || ""), usage: usage || null }
    : String(text || "");
  model = model || DEFAULT_API_MODEL[backend];
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable in this runtime (run through the app runtime).");
  const request = (url, init) => fetchImpl(
    url,
    options.signal ? { ...init, signal: options.signal } : init,
  );
  if (backend === "ollama") {
    const resp = await request("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status} — run 'ollama serve' and check the model`);
    const j = await resp.json();
    return finish(
      (j.message && j.message.content) || "",
      usageFromObject(j, ["prompt_eval_count"], ["eval_count"]),
    );
  }
  const supported = backend === "anthropic" || backend === "openai" || backend === "google" ||
    backend === "upstage" || backend === "custom" || !!ANTHROPIC_COMPAT_API[backend];
  if (!supported) throw new Error("Unsupported backend: " + backend);
  const key = Object.prototype.hasOwnProperty.call(options, "apiKey") ? options.apiKey : await apiKey(backend);
  if (!key) throw new Error(`${backend} API key is missing. Register it in App settings → BYOK.`);

  const anthropicCompat = ANTHROPIC_COMPAT_API[backend];
  if (backend === "anthropic" || anthropicCompat) {
    const label = anthropicCompat ? anthropicCompat.label : "Anthropic";
    const base = anthropicCompat ? anthropicCompat.baseUrl : "https://api.anthropic.com";
    const authHeaders = anthropicCompat
      ? { "x-api-key": key, authorization: "Bearer " + key }
      : { "x-api-key": key };
    // Prompt caching: 진짜 Anthropic만 cache_control을 존중한다. 크고 안정된
    // system 프리픽스를 캐시 경계로 표시하면 적중 시 입력이 ~90% 싸게 과금되고,
    // 모델별 최소치(~1024 토큰) 미만이면 서버가 조용히 무시하므로 무해하다.
    // 호환 엔드포인트(GLM/Kimi/DeepSeek)는 문자열 형태를 유지한다 — 서버측
    // 자동 캐시가 있고 추가 필드를 거부할 수 있다(데스크탑 byok.ts와 동일 계약).
    const systemField = backend === "anthropic"
      ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
      : system;
    const resp = await request(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, system: systemField, messages: [{ role: "user", content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`${label} ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    return finish(
      (j.content && j.content[0] && j.content[0].text) || "",
      usageFromObject(j.usage, ["input_tokens"], ["output_tokens"]),
    );
  }
  if (backend === "openai" || backend === "upstage" || backend === "custom") {
    const base = backend === "upstage"
      ? "https://api.upstage.ai/v1"
      : backend === "custom"
        ? normalizeCustomApiBaseUrl(Object.prototype.hasOwnProperty.call(options, "customBaseUrl")
          ? options.customBaseUrl
          : readCustomApiBaseUrl())
        : "https://api.openai.com/v1";
    const label = backend === "custom" ? "Custom API" : backend === "upstage" ? "Upstage" : "OpenAI";
    const resp = await request(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    });
    if (!resp.ok) throw new Error(`${label} ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    return finish(
      (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "",
      usageFromObject(j.usage, ["prompt_tokens"], ["completion_tokens"]),
    );
  }
  if (backend === "google") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const resp = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] }),
    });
    if (!resp.ok) throw new Error(`Google ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    const j = await resp.json();
    const c = j.candidates && j.candidates[0];
    return finish(
      (c && c.content && c.content.parts && c.content.parts[0] && c.content.parts[0].text) || "",
      usageFromObject(j.usageMetadata, ["promptTokenCount"], ["candidatesTokenCount"]),
    );
  }
  throw new Error("Unsupported backend: " + backend);
}

// ── 자식 env 빌더 (v1 buildChildEnvCli 포팅) ───────────────────────────
function parseDotEnv(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}
function readDotEnvFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 512 * 1024) return {};
    return parseDotEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}
function readDotEnvDir(dir) {
  return { ...readDotEnvFile(path.join(dir, ".env")), ...readDotEnvFile(path.join(dir, ".env.local")) };
}
function projectEnvId(projectPath) {
  const raw = path.basename(projectPath || runCwd() || "project") || "project";
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "PROJECT";
}
function projectScopedEnvValues(values, projectPath) {
  const prefix = `AGENTLAS_PROJECT_${projectEnvId(projectPath)}_`;
  const result = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!key.startsWith(prefix)) continue;
    const actualKey = key.slice(prefix.length);
    if (/^[A-Z][A-Z0-9_]*$/.test(actualKey)) result[actualKey] = value;
  }
  return result;
}

// 프로젝트/에이전트 dotenv는 일반 API 키 우선순위를 유지하되, 호스트 CLI의 신원·설치·
// 플러그인 탐색 루트는 바꾸지 못한다. Windows env도 대소문자 무관 비교(v1 계약).
const PROTECTED_CHILD_ENV_KEYS_CLI = new Set([
  "HOME", "PATH", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SAFE_MODE",
  "AGENTLAS_CODEX_HOME", "AGENTLAS_USER_DATA_DIR",
  "CLAUDE_CODE_SIMPLE", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR",
  "GEMINI_CLI_HOME", "GEMINI_CLI_SYSTEM_SETTINGS_PATH", "GEMINI_CLI_USER_SETTINGS",
  "GEMINI_CLI_TRUSTED_FOLDERS_PATH", "GEMINI_CLI_TRUST_WORKSPACE", "GEMINI_CLI_EXTENSION_REGISTRY_URI",
  "HEPHAESTUS_RUNTIME_ROOT", "HEPHAESTUS_RUNTIME_BASE", "HEPHAESTUS_PYTHON", "HEPHAESTUS_AUTO_UPDATE",
  "HEPHAESTUS_UPDATE_CHECK", "NPM_CONFIG_PREFIX", "NODE_OPTIONS", "NODE_PATH",
  "PYTHONHOME", "PYTHONPATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "AGENTLAS_HUB_CONNECT_TIMEOUT_MS", "AGENTLAS_HUB_IDLE_TIMEOUT_MS", "AGENTLAS_HUB_TOTAL_TIMEOUT_MS",
  "AGENTLAS_NATIVE_IDLE_TIMEOUT_MS", "AGENTLAS_NATIVE_TOTAL_TIMEOUT_MS", "AGENTLAS_NATIVE_KILL_GRACE_MS",
  "AGENTLAS_CAPTURE_MAX_OUTPUT_BYTES",
]);
// 네트워크 무결성 키 — TLS 검증·프록시·CA·엔드포인트·세션. 비신뢰 출처(클론 레포의
// 프로젝트/에이전트 dotenv)로 주입되면 MITM/SSRF/세션 하이재킹. 사용자 본인의 전역
// credentials.env와 호스트 셸 env는 신뢰하므로 허용.
const UNTRUSTED_PROTECTED_ENV_KEYS_CLI = new Set([
  "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "OPENSSL_CONF", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "GRPC_PROXY", "NPM_CONFIG_PROXY",
  "AGENTLAS_SESSION", "AGENTLAS_MCP_BASE_URL", "AGENTLAS_WEB_BASE_URL", "AGENTLAS_API_BASE_URL",
  "AGENTLAS_HUB_BASE_URL", "AGENTLAS_CLOUD_BASE_URL", "OLLAMA_HOST",
  // 모델 제공사 엔드포인트/게이트웨이 — Agentlas 자체 base URL과 같은 부류인데 빠져
  // 있었다. 2026-07-27 실측: 클론 레포의 .env 한 줄이 자식 CLI의 ANTHROPIC_BASE_URL과
  // AUTH_TOKEN을 갈아치워, 모든 워커 프롬프트가 공격자 서버로 나가고 그 서버가 쓴
  // 답변이 핸드오프·합성으로 흘러든다. 키 자체(*_API_KEY)는 프로젝트별 BYOK 기능이라
  // 계속 허용한다 — 막는 것은 "데이터가 어디로 가는가"뿐이다.
  "ANTHROPIC_BASE_URL", "ANTHROPIC_API_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK",
  "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_ORGANIZATION", "AZURE_OPENAI_ENDPOINT",
  "OPENAI_PROXY", "CODEX_BASE_URL", "CODEX_API_URL",
  "GOOGLE_GEMINI_BASE_URL", "GOOGLE_VERTEX_BASE_URL", "GEMINI_API_BASE_URL",
  "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS",
]);
function isProtectedChildEnvKeyCli(key, trusted) {
  const k = String(key || "").trim().toUpperCase();
  if (PROTECTED_CHILD_ENV_KEYS_CLI.has(k)) return true; // 호스트 신원/플러그인 루트 — 모든 출처 차단
  if (!trusted && UNTRUSTED_PROTECTED_ENV_KEYS_CLI.has(k)) return true; // 네트워크 무결성 — 비신뢰 출처만 차단
  return false;
}
function mergeChildEnvValues(target, values, overwrite, trusted) {
  const injected = [];
  for (const [key, value] of Object.entries(values || {})) {
    if (!value || isProtectedChildEnvKeyCli(key, trusted)) continue;
    if (!overwrite && target[key]) continue;
    target[key] = value;
    injected.push(key);
  }
  return injected;
}

/**
 * 워크포스 자식 env 빌더 (v1 buildChildEnvCli의 v2 포팅).
 * v1의 멀티모달 카탈로그/키체인 볼트/에이전트 폴더 dotenv 소스는 그 서브시스템이
 * 아직 v2로 이식되지 않아 여기 없다 — 워크포스 경로는 ctx.agentId를 절대 넘기지
 * 않으므로(no-authority 원샷) 계약상 영향이 없고, 필요해지면 그 모듈 포팅과 함께
 * 여기에 소스를 추가한다(조용한 근사 금지).
 */
async function buildChildEnv(db, ctx) {
  const env = { ...process.env };
  const apply = (values, overwrite, trusted) => {
    mergeChildEnvValues(env, values, overwrite, trusted);
  };
  const globalCredentials = {
    ...readDotEnvFile(path.join(userDataDir(), "credentials.env")),
    ...readDotEnvFile(path.join(os.homedir(), ".agentlas", "credentials.env")),
  };
  apply(globalCredentials, false, true); // 사용자 본인의 전역 자격 — 신뢰
  if (ctx && ctx.projectPath) apply(projectScopedEnvValues(globalCredentials, ctx.projectPath), true, true);
  if (ctx && ctx.cwd) apply(readDotEnvDir(ctx.cwd), true, false); // 프로젝트 dotenv — 비신뢰
  if (ctx && ctx.projectPath && ctx.projectPath !== ctx.cwd) apply(readDotEnvDir(ctx.projectPath), true, false);
  return env;
}

module.exports = {
  RUNTIME_BIN,
  which,
  runCwd,
  projectCwd,
  buildArgs,
  codexCaptureAgentText,
  capturedRuntimeAgentText,
  capturedRuntimeUsage,
  captureOutputLimit,
  directCaptureOutputLimit,
  captureRuntime,
  apiKey,
  normalizeCustomApiBaseUrl,
  readCustomApiBaseUrl,
  runApi,
  buildChildEnv,
  isProtectedChildEnvKeyCli,
  parseDotEnv,
  mergeChildEnvValues,
  readDotEnvFile,
  readDotEnvDir,
  projectScopedEnvValues,
};
