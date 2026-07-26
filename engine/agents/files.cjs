"use strict";
/*
 * agents/files — 에이전트의 로컬 폴더 해석 + 네이티브 CLI 문맥 파일 생성.
 * 폴더 우선순위: 로컬 임포트 라우트 → 클라우드 설치본(cloud-agent-installs, 복원 마커
 * 존재 시) → userData/agents/<slug>. v1 agentFolder와 동일 규칙 — cd/native가
 * 관찰상 읽기 전용으로 유지돼야 소스 패키지를 재분류하지 않는다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");
const { routesMap } = require("./routes.cjs");

const CLOUD_RESTORE_MARKER_PATH = ".agentlas-cloud-package.json";

function cloudSlug(value) {
  return (String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agentlas-cloud-agent");
}

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function agentSystemPrompt(agent) {
  return agent && agent.systemPrompt ? agent.systemPrompt : `You are ${(agent && agent.name) || "an Agentlas agent"}.`;
}

function agentFolder(agent) {
  const routes = routesMap();
  const r = routes[agent.id];
  if (r && r.path) return r.path; // 로컬 임포트는 원본 폴더
  const cloudRoot = path.join(userDataDir(), "cloud-agent-installs", cloudSlug(agent.slug));
  if (exists(path.join(cloudRoot, CLOUD_RESTORE_MARKER_PATH))) return cloudRoot;
  return path.join(userDataDir(), "agents", agent.slug);
}

function writeIfMissing(file, content) {
  try { fs.lstatSync(file); return false; } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content.endsWith("\n") ? content : content + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function ensureNativeFiles(agent, folder) {
  fs.mkdirSync(folder, { recursive: true });
  const sys = agentSystemPrompt(agent);
  const created = [];
  if (writeIfMissing(path.join(folder, "system-prompt.md"), sys)) created.push("system-prompt.md");
  const header = `# ${agent.name}\n\n${agent.tagline || ""}\n\n${sys}\n`;
  // 네이티브 CLI가 프로젝트 지시로 자동 인식하는 파일들
  if (writeIfMissing(path.join(folder, "CLAUDE.md"), header)) created.push("CLAUDE.md");
  if (writeIfMissing(path.join(folder, "AGENTS.md"), header)) created.push("AGENTS.md");
  if (writeIfMissing(path.join(folder, "GEMINI.md"), header)) created.push("GEMINI.md");
  return created;
}

module.exports = { agentFolder, ensureNativeFiles, agentSystemPrompt, cloudSlug, CLOUD_RESTORE_MARKER_PATH };
