"use strict";

/*
 * experience/runtime — 실행 시점 Experience 해석 + 실행 종료 후 운영 경험 적립.
 *
 * v1 모놀리스(engine/agentlas.cjs, legacy-v1-engine-snapshot)에서 이식:
 *   parseRunExperienceArgs · exactAgentBaseForExecution ·
 *   resolveRuntimeExperienceCli · finalizeExperienceExecutionCli
 * 복원 계약 모듈(agentlas-experience-exchange/-intake, agentlas-desktop-loadout)은
 * 소비만 한다 — 재구현 금지.
 *
 * 불변식(v1 그대로, 완화 금지):
 *  - builtin 에이전트/제네릭(no-agent) 턴은 Experience 증거를 만들지 않는다.
 *  - exact base 식별이 안 되면 null — 추정 폴백 금지.
 *  - 데스크탑 로드아웃 권위와 로컬 해석이 어긋나면 조용히 로컬을 쓰지 않고
 *    "desktop-loadout-runtime-resolution-mismatch"로 정직하게 skip한다.
 *  - 적립 실패는 stderr 한 줄로 노출하고 null 반환(성공 위장 금지).
 */

const crypto = require("node:crypto");
const { userDataDir } = require("../core/paths.cjs");
const { tableExists } = require("../core/db.cjs");
const { agentFolder } = require("../agents/files.cjs");
const { routesMap } = require("../agents/routes.cjs");
const terminalExperienceExchange = require("../agentlas-experience-exchange.cjs");
const terminalExperienceIntake = require("../agentlas-experience-intake.cjs");
const desktopOntologyLoadout = require("../agentlas-desktop-loadout.cjs");

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// v1 prefsLang 대응. v2 prefs 키(language)와 v1 키(lang)를 모두 읽는다 —
// locale 기본값 결정용이며, 명령이 준 input.lang이 항상 우선한다.
function prefsLang() {
  try {
    const prefs = require("../agentlas-config.cjs").loadPrefs(userDataDir());
    return prefs.lang || prefs.language || "en";
  } catch {
    return "en";
  }
}

function parseRunExperienceArgs(args) {
  const prompt = [];
  const experience = { taskSignatures: [], declaredTaskClasses: [], environmentTags: [], experiencePackReleaseIds: [] };
  let passthrough = false;
  const addList = (target, value) => {
    for (const item of String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean)) {
      if (!target.includes(item)) target.push(item);
    }
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index]);
    if (passthrough) { prompt.push(token); continue; }
    if (token === "--") { passthrough = true; continue; }
    const take = () => index + 1 < args.length ? String(args[++index]) : "";
    if (token === "--experience-base-release") experience.baseAgentReleaseId = take();
    else if (token.startsWith("--experience-base-release=")) experience.baseAgentReleaseId = token.slice(26);
    else if (token === "--experience-pack-release") addList(experience.experiencePackReleaseIds, take());
    else if (token.startsWith("--experience-pack-release=")) addList(experience.experiencePackReleaseIds, token.slice(26));
    else if (token === "--experience-agent-definition") experience.agentDefinitionId = take();
    else if (token.startsWith("--experience-agent-definition=")) experience.agentDefinitionId = token.slice(30);
    else if (token === "--experience-task-signature") addList(experience.taskSignatures, take());
    else if (token.startsWith("--experience-task-signature=")) addList(experience.taskSignatures, token.slice(28));
    else if (token === "--experience-task-class") addList(experience.declaredTaskClasses, take());
    else if (token.startsWith("--experience-task-class=")) addList(experience.declaredTaskClasses, token.slice(24));
    else if (token === "--experience-environment") addList(experience.environmentTags, take());
    else if (token.startsWith("--experience-environment=")) addList(experience.environmentTags, token.slice(25));
    else if (token === "--experience-desktop-loadout") experience.desktopLoadout = true;
    else if (
      token === "--experience-loadout" || token === "--experience-loadout-file" ||
      token.startsWith("--experience-loadout=") || token.startsWith("--experience-loadout-file=")
    ) {
      throw new Error("Custom Experience loadout paths are no longer supported; use --experience-desktop-loadout.");
    }
    else if (token === "--no-experience") experience.disabled = true;
    else prompt.push(token);
  }
  return { prompt: prompt.join(" "), experience };
}

/**
 * 실행 대상 에이전트의 exact base(AgentDefinition/AgentRelease) 식별.
 * 우선순위: 명시적 런타임 바인딩 → 설치된 Hub 바인딩 → exact 로컬 packageHash.
 * 어느 것도 증명되지 않으면 null(추정 금지) — Experience 증거 발행이 막힌다.
 */
function exactAgentBaseForExecution(db, agent, runtimeExperience = null) {
  if (!agent || agent.builtin) return null;
  const portableId = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
  let binding = null;
  try {
    if (tableExists(db, "installed_agent_hub_bindings")) {
      binding = db.prepare(
        "SELECT agent_definition_id,agent_release_id FROM installed_agent_hub_bindings WHERE installed_agent_id=?",
      ).get(agent.id) || null;
    }
  } catch { binding = null; }
  const route = routesMap()[agent.id] || {};
  const markerResult = terminalExperienceExchange.readExactLocalBaseMarker(agentFolder(agent), agent.slug);
  const marker = markerResult.marker;
  const rawHash = String(marker?.packageHash || route.packageHash || route.definitionHash || "").replace(/^sha256:/i, "").toLowerCase();
  const packageHash = /^[a-f0-9]{64}$/.test(rawHash) ? `sha256:${rawHash}` : null;
  const explicitDefinition = String(runtimeExperience?.agentDefinitionId || "");
  const explicitRelease = String(runtimeExperience?.baseAgentReleaseId || "");
  if (portableId.test(explicitDefinition) && portableId.test(explicitRelease)) {
    return { agentDefinitionId: explicitDefinition, agentReleaseId: explicitRelease, packageHash, authority: "explicit-runtime-binding" };
  }
  if (binding && portableId.test(String(binding.agent_definition_id)) && portableId.test(String(binding.agent_release_id))) {
    return { agentDefinitionId: binding.agent_definition_id, agentReleaseId: binding.agent_release_id, packageHash, authority: "installed-hub-binding" };
  }
  if (!packageHash) return null;
  // 해시 파생식은 v1과 바이트 단위로 동일해야 한다(로컬 정의/릴리스 id 안정성 계약).
  const definitionDigest = sha(`terminal-local-definition\0${agent.id}\0${agent.slug}`);
  const releaseDigest = sha(`terminal-local-release\0${definitionDigest}\0${packageHash}`);
  return {
    agentDefinitionId: `local-agent-definition:${definitionDigest.slice(0, 32)}`,
    agentReleaseId: `local-agent-release:${releaseDigest.slice(0, 32)}`,
    packageHash,
    authority: "exact-local-package-hash",
  };
}

function resolveRuntimeExperienceCli(agent, prompt, requested, cwd, overrides = {}) {
  const prepared = desktopOntologyLoadout.prepareDesktopLoadoutRequest({
    db: overrides.db,
    agent,
    userDataDir: overrides.userDataDir || userDataDir(),
    requested: requested || {},
    now: overrides.now,
  });
  if (prepared.mode === "skip") {
    return { disabled: true, observableReason: prepared.reason, resolution: "skipped" };
  }
  const resolved = terminalExperienceExchange.resolveRuntimeExperienceForAgent({
    userDataDir: overrides.userDataDir || userDataDir(),
    cwd,
    prompt,
    requested: prepared.requested || requested || {},
    declaredTaskClasses: requested && requested.declaredTaskClasses,
    agent,
    agentRoot: agent ? (overrides.agentRoot || agentFolder(agent)) : null,
    ...(overrides.platform ? { platform: overrides.platform } : {}),
    ...(overrides.arch ? { arch: overrides.arch } : {}),
    ...(overrides.runtime ? { runtime: overrides.runtime } : {}),
  });
  if (prepared.mode !== "resolved") return resolved;
  const authority = prepared.authority;
  const tasteRuntime = {
    tasteRuntimeOverlay: authority.tasteRuntimeOverlay || null,
    loadoutAuthority: "desktop-terminal-exact-loadout",
    projectionRevision: authority.projectionRevision,
    loadoutRevision: authority.loadoutRevision,
  };
  if (!authority.experiencePackReleaseId) {
    return {
      disabled: true,
      resolution: "desktop-loadout-taste-only",
      ...tasteRuntime,
    };
  }
  if (resolved.disabled === true) return { ...resolved, ...tasteRuntime };
  if (
    resolved.agentDefinitionId !== authority.agentDefinitionId ||
    resolved.baseAgentReleaseId !== authority.baseAgentReleaseId ||
    !Array.isArray(resolved.experiencePackReleaseIds) ||
    resolved.experiencePackReleaseIds.length !== 1 ||
    resolved.experiencePackReleaseIds[0] !== authority.experiencePackReleaseId
  ) {
    return {
      disabled: true,
      observableReason: "desktop-loadout-runtime-resolution-mismatch",
      resolution: "skipped",
      ...tasteRuntime,
    };
  }
  return {
    ...resolved,
    ...tasteRuntime,
  };
}

/**
 * 실행 종료 후 운영 경험 적립(run-receipt + 후보 번들). 실패는 stderr 한 줄 +
 * null — 적립이 실행 성공/실패 판정을 바꾸지 않는다.
 */
function finalizeExperienceExecutionCli(db, input) {
  if (input.permission === "read") return null;
  if (!input.agentId) return null;
  let agent;
  try { agent = db.prepare("SELECT * FROM installed_agents WHERE id=?").get(input.agentId); }
  catch { return null; }
  if (!agent) return null;
  const exactBase = exactAgentBaseForExecution(db, agent, input.runtimeExperience);
  if (!exactBase) return null;
  const runtime = input.runtime || {};
  const provider = runtime.mode === "cli" ? runtime.kind : runtime.backend;
  const modelId = input.model || runtime.model || provider;
  const usage = input.usage || {};
  try {
    return terminalExperienceIntake.finalizeAgentExecution({
      db,
      userDataDir: userDataDir(),
      cwd: input.cwd || input.projectPath || process.cwd(),
      agent,
      exactBase,
      environment: { runtime: provider || "terminal", os: process.platform, arch: process.arch },
      model: { provider: provider || "terminal-runtime", modelId: modelId || "terminal-runtime" },
      mcp: (input.mcpServers || []).flatMap((server) => {
        const catalogId = server.catalog_id || server.catalogId;
        // 검토된 런타임 allowlist는 "승인" 증거일 뿐, 이 턴의 자식 프로세스가
        // MCP initialize/tool call을 완료했다는 증거가 아니다. exact 런타임
        // 신호 없이 connected로 부풀리지 않는다.
        return catalogId ? [{ catalogId, status: "approved" }] : [];
      }),
      outcome: input.outcome,
      metrics: {
        promptTokens: usage.input_tokens || usage.prompt_tokens || 0,
        completionTokens: usage.output_tokens || usage.completion_tokens || 0,
        totalTokens: usage.total_tokens || 0,
        durationMs: input.durationMs || usage.duration_ms || 0,
        retryCount: 0,
      },
      curatedMemories: input.curatedMemories || [],
      taskHint: input.taskHint,
      taskSignatures: input.runtimeExperience?.taskSignatures || [],
      experiencePackReleaseId: input.runtimeExperience?.experiencePackReleaseIds?.[0] || null,
      locale: input.lang || prefsLang(),
      runId: input.runId,
      createdAt: input.createdAt,
    });
  } catch (error) {
    process.stderr.write(`▸ local Experience intake skipped · ${String((error && error.message) || error).slice(0, 180)}\n`);
    return null;
  }
}

module.exports = {
  parseRunExperienceArgs,
  exactAgentBaseForExecution,
  resolveRuntimeExperienceCli,
  finalizeExperienceExecutionCli,
};
