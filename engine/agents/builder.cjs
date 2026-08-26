"use strict";
/*
 * agents/builder — 터미널 소유 로컬 에이전트 빌더 (독립).
 *
 * 배경(2026-08-06 오너 원칙): 데스크탑/플러그인은 산출물·설정을 공유할 뿐 선행
 * 전제가 아니다. 그런데 `agentlas build "<req>"`는 Hephaestus 네이티브
 * 패스스루라 "Open Claude Code or Codex with the plugin, then /hep-build"라는
 * 스텁만 냈다 — 플러그인 강제. 터미널은 자체 런타임(claude-code/codex/gemini)이
 * 있으므로 빌더를 로컬로 돌린다.
 *
 * 계약: 빌더 에이전트를 멱등 시드(installed_agents)하고, `run`과 같은 실행
 * 인프라(Orchestrator 세션)로 돌린다. 산출물은 `import`가 읽는 로컬 폴더 형식
 * (AGENTS.md=시스템 프롬프트, manifest.md=이름/태그라인). 빌더가 마지막 줄에
 * `BUILT: <folder>`를 찍으면 그 폴더를 자동 import 한다. 실패해도 폴더는 남아
 * `agentlas import <folder>`로 언제든 설치할 수 있다.
 */
const crypto = require("node:crypto");
const { runWriteTransaction } = require("../agentlas-sqlite-policy.cjs");
const { columnExists } = require("../core/db.cjs");

const BUILDER_SLUG = "agentlas-builder";
const BUILDER_ID = "builtin-agentlas-builder";

const BUILDER_SYSTEM_PROMPT = [
  "You are the Agentlas local agent builder, running inside the Agentlas terminal.",
  "Your job: turn the user's request into an installable Agentlas agent, entirely on this machine — no external plugin, no desktop app.",
  "",
  "Produce a folder the terminal can import. In the current working directory create a folder named after the agent (kebab-case slug), containing exactly:",
  "  - AGENTS.md — the agent's full system prompt / soul: who it is, what it does, how it behaves, its guardrails. Write it as the instructions the agent itself will run under. Be specific and production-ready, not a description of the agent.",
  "  - manifest.md — first line `# <Agent Name>`, second line a one-sentence tagline.",
  "  - README.md — a short human-facing summary of what the agent does and how to use it.",
  "  - agentlas.json — `{ \"schemaVersion\": \"1.0\", \"name\": \"<Agent Name>\", \"slug\": \"<kebab-case-slug>\", \"entry\": \"AGENTS.md\", \"skills\": [] }`. Do NOT invent an agentId; the identity is minted once by the packaging path and must never be typed by hand.",
  "",
  "If the agent needs reusable procedures, add them as `.claude/skills/<skill-name>/SKILL.md`.",
  "A skill's name IS its folder name: the frontmatter `name:` must equal the folder exactly, and `agentlas.json` skills[] must list exactly those folder names. Never write a placeholder like `{{SKILL_ID_1}}` — leave the list empty instead.",
  "",
  "Rules:",
  "  - Decide the agent's scope from the request; if the request is thin, choose sensible, specific defaults and state them in README.md rather than asking endless questions.",
  "  - Do not invent credentials, API keys, or secrets. If the agent needs an env var, name it in README.md as something the user provides later.",
  "  - Keep everything inside the new folder. Do not modify files outside it.",
  "  - When finished, print exactly one final line: `BUILT: <relative-folder-path>` so the terminal can install it.",
].join("\n");

/** 빌더 에이전트를 멱등 보장한다(installed_agents). 반환: 에이전트 행 형태. */
function ensureBuilderAgent(db) {
  const now = new Date().toISOString();
  const hasVisibility = columnExists(db, "installed_agents", "visibility");
  runWriteTransaction(db, () => {
    const existing = db.prepare("SELECT id FROM installed_agents WHERE id=? OR slug=?").get(BUILDER_ID, BUILDER_SLUG);
    if (existing) {
      db.prepare("UPDATE installed_agents SET system_prompt=?, name=?, name_en=?, tagline=?, tagline_en=? WHERE id=?")
        .run(BUILDER_SYSTEM_PROMPT, "Agent Builder", "Agent Builder", "Builds Agentlas agents locally", "Builds Agentlas agents locally", existing.id);
      return;
    }
    if (hasVisibility) {
      db.prepare(
        "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role, visibility) " +
        "VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,1,?,?)",
      ).run(BUILDER_ID, BUILDER_SLUG, "Agent Builder", "Agent Builder", "Builds Agentlas agents locally", "Builds Agentlas agents locally", BUILDER_SYSTEM_PROMPT, now, "blue", "orchestrator", "visible");
    } else {
      db.prepare(
        "INSERT INTO installed_agents (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json, env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role) " +
        "VALUES (?,?,?,?,?,?,?,'[]','[]',NULL,'A',?,?,1,?)",
      ).run(BUILDER_ID, BUILDER_SLUG, "Agent Builder", "Agent Builder", "Builds Agentlas agents locally", "Builds Agentlas agents locally", BUILDER_SYSTEM_PROMPT, now, "blue", "orchestrator");
    }
  });
  return {
    id: BUILDER_ID,
    slug: BUILDER_SLUG,
    name: "Agent Builder",
    nameEn: "Agent Builder",
    systemPrompt: BUILDER_SYSTEM_PROMPT,
    builtin: true,
    role: "orchestrator",
  };
}

/** 빌더 산출물 마지막 줄에서 `BUILT: <folder>`를 뽑는다. */
function parseBuiltFolder(finalText) {
  const lines = String(finalText || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^BUILT:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

module.exports = { ensureBuilderAgent, parseBuiltFolder, BUILDER_SLUG, BUILDER_ID, BUILDER_SYSTEM_PROMPT };
