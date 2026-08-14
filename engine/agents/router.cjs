"use strict";

/*
 * Model-judged routing for the explicit `route` capability.
 *
 * Ordinary `agentlas run` is project-first and does not call this module. This
 * surface intentionally contains no regex intent gates, keyword dictionaries,
 * phrase lists, lexical scores, deterministic specialist routes, or default
 * agent substitution. The connected model may select an exact installed agent;
 * otherwise the result remains unresolved.
 */
const crypto = require("node:crypto");
const { listRoutableAgents } = require("./registry.cjs");
const { sharedRuntimeKind } = require("../runtimes/resolve.cjs");

const UNRESOLVED_LABEL = "unresolved";

function ensureJudgeRunner(db, runtime) {
  let judgment;
  try {
    judgment = require("../agentlas-judgment.cjs");
  } catch {
    return null;
  }
  if (judgment.hasJudgmentRunner()) return judgment;

  const capture = require("../workforce/capture.cjs");
  let resolved = runtime || null;
  if (!resolved && db) {
    try {
      const active = require("../runtimes/detect.cjs").activeRuntimeRow(db);
      const activeKind = sharedRuntimeKind(active);
      if (active && capture.RUNTIME_BIN[activeKind]) {
        resolved = { kind: activeKind, model: active.model || null };
      } else if (active && active.kind === "byok" && active.backend) {
        resolved = { kind: "byok", backend: active.backend, model: active.model || null };
      } else if (active && active.kind === "ollama") {
        resolved = { kind: "ollama", model: active.model || null };
      }
    } catch {
      resolved = null;
    }
  }

  if (resolved && capture.RUNTIME_BIN[resolved.kind]) {
    judgment.setJudgmentRunner(async ({ system, prompt, signal }) => {
      try {
        return await capture.captureRuntime(resolved.kind, system, prompt, {
          cwd: capture.projectCwd(),
          permission: "read",
          model: resolved.model || undefined,
          signal,
        });
      } catch (error) {
        /*
         * ★사유를 ""로 지우지 않는다 — 여기서 지우면 판정 서비스는 "no connected model
         * reached a valid judgment"라는 거짓 문장만 남긴다(모델은 닿았고, 한도라고
         * 말했다). 러너 계약은 문자열이므로 예외를 그대로 올려 judgeLabels가 사유를
         * 싣게 한다.
         */
        throw error;
      }
    });
    return judgment;
  }

  if (resolved && (resolved.kind === "byok" || resolved.kind === "ollama")) {
    const backend = resolved.kind === "ollama" ? "ollama" : resolved.backend;
    if (backend) {
      judgment.setJudgmentRunner(async ({ system, prompt, signal }) => {
        const baseFetch = globalThis.fetch;
        const fetchImpl = typeof baseFetch === "function" && signal
          ? (url, init) => baseFetch(url, { ...(init || {}), signal })
          : baseFetch;
        try {
          return await capture.runApi(backend, resolved.model || null, system, prompt, { fetch: fetchImpl });
        } catch {
          return "";
        }
      });
      return judgment;
    }
  }
  return judgment;
}

function unresolvedChoice(lang, reason, noModelReason = null) {
  return {
    agent: null,
    unresolved: true,
    routeSource: "unresolved",
    noModel: Boolean(noModelReason),
    noModelReason,
    reason: reason || (lang === "ko"
      ? "요청을 맡을 에이전트를 확정하지 못했습니다"
      : "No agent was confirmed for this request"),
  };
}

function autoRouteNote(choice, lang) {
  if (!choice || choice.unresolved || !choice.agent) {
    return lang === "ko"
      ? `에이전트를 확정하지 않았습니다. ${choice?.reason || "현재 판단 근거가 충분하지 않습니다."}`
      : `No agent was confirmed. ${choice?.reason || "There is not enough evidence to decide."}`;
  }
  const name = lang === "ko" ? choice.agent.name : choice.agent.nameEn || choice.agent.name;
  return lang === "ko"
    ? `사용 에이전트: ${name}. 이유: ${choice.reason}.`
    : `Selected agent: ${name}. Reason: ${choice.reason}.`;
}

async function resolveAutoRoute(db, task, opts = {}) {
  const lang = opts.lang === "ko" ? "ko" : "en";
  const finish = (choice) => ({ ...choice, note: autoRouteNote(choice, lang) });
  const input = String(task || "").trim();
  if (!input) {
    return finish(unresolvedChoice(lang,
      lang === "ko" ? "판단할 요청이 없습니다" : "There is no request to judge"));
  }

  const candidates = listRoutableAgents(db);
  if (!candidates.length) {
    return finish(unresolvedChoice(lang,
      lang === "ko" ? "실행 가능한 설치 에이전트가 없습니다" : "No installed agent is available"));
  }
  const judgment = ensureJudgeRunner(db, opts.runtime || null);
  if (!judgment || !judgment.hasJudgmentRunner()) {
    return finish(unresolvedChoice(lang,
      lang === "ko"
        ? "연결된 모델이 없어 요청을 맡을 에이전트를 판단하지 못했습니다"
        : "No connected model is available to judge the request",
      "no_runtime"));
  }

  const byLabel = new Map(candidates.map((agent) => [agent.slug, agent]));
  const labels = [...byLabel.keys(), UNRESOLVED_LABEL];
  const roster = candidates.map((agent) => {
    const name = [...new Set([agent.name, agent.nameEn].filter(Boolean))].join(" / ");
    const tagline = [...new Set([agent.tagline, agent.taglineEn].filter(Boolean))].join(" / ");
    return `- ${agent.slug}: ${name}${tagline ? ` — ${tagline}` : ""}`;
  });
  const verdict = await judgment.judgeLabels({
    kind: `terminal-model-route:${crypto.createHash("sha256").update(labels.join("\n")).digest("hex").slice(0, 12)}`,
    question: "Which exact installed agent should handle this request?",
    labels,
    input,
    guidance: [
      "Judge the full request by meaning and the declared agent descriptions.",
      "Do not infer fit from a shared word alone.",
      `Choose “${UNRESOLVED_LABEL}” when no agent clearly fits or the evidence is insufficient.`,
      "Installed agents:",
      ...roster,
    ].join("\n"),
    multi: false,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs || 40000,
  });

  if (verdict.source !== "llm" || !verdict.labels.length) {
    return finish(unresolvedChoice(lang,
      lang === "ko"
        ? "연결된 모델이 유효한 판단을 반환하지 않았습니다"
        : "The connected model did not return a valid judgment",
      "model_unavailable"));
  }
  const picked = verdict.labels[0];
  if (picked === UNRESOLVED_LABEL) {
    return finish(unresolvedChoice(lang, verdict.reason));
  }
  const agent = byLabel.get(picked);
  if (!agent) {
    return finish(unresolvedChoice(lang,
      lang === "ko"
        ? "판단 결과가 현재 설치된 에이전트와 일치하지 않습니다"
        : "The judgment does not match an installed agent"));
  }
  const choice = {
    agent,
    unresolved: false,
    routeSource: "llm",
    reason: verdict.reason || (lang === "ko"
      ? "연결된 모델이 전체 요청과 에이전트 설명을 비교했습니다"
      : "The connected model compared the full request with the agent descriptions"),
  };
  return finish(choice);
}

module.exports = {
  UNRESOLVED_LABEL,
  resolveAutoRoute,
  ensureJudgeRunner,
  autoRouteNote,
};
