"use strict";
/*
 * agents/files — 에이전트의 로컬 폴더 해석 + 네이티브 CLI 문맥 파일 생성.
 * 폴더 우선순위: 로컬 임포트 라우트 → 클라우드 설치본(cloud-agent-installs, 복원 마커
 * 존재 시) → userData/agents/<slug>. v1 agentFolder와 동일 규칙 — cd/native가
 * 관찰상 읽기 전용으로 유지돼야 소스 패키지를 재분류하지 않는다.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { userDataDir } = require("../core/paths.cjs");
const { routesMap } = require("./routes.cjs");

const CLOUD_RESTORE_MARKER_PATH = ".agentlas-cloud-package.json";
const NATIVE_CONTEXT_MAX_CHARS = 256 * 1024;

function cloudSlug(value) {
  return (String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agentlas-cloud-agent");
}

function agentSystemPrompt(agent) {
  const value = agent && agent.systemPrompt ? agent.systemPrompt : `You are ${(agent && agent.name) || "an Agentlas agent"}.`;
  const text = String(value);
  if (text.length > NATIVE_CONTEXT_MAX_CHARS) throw new Error("agent system prompt exceeds the native context file limit");
  return text;
}

function safeExternalAgentPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000\r\n]/.test(value)) return null;
  const resolved = path.resolve(value);
  const unsafe = new Set([path.parse(resolved).root, path.resolve(os.homedir()), path.resolve(userDataDir())]);
  if (unsafe.has(resolved)) return null;
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    const canonical = fs.realpathSync(resolved);
    if (unsafe.has(canonical)) return null;
    return canonical;
  } catch (error) {
    // Preserve a safe missing local route for read-only `agentlas cd` output.
    // The write boundary below refuses to recreate it.
    return error && error.code === "ENOENT" ? resolved : null;
  }
}

function isRegularNoFollow(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function agentFolder(agent) {
  const routes = routesMap();
  const r = routes[agent.id];
  const localPath = safeExternalAgentPath(r && r.path);
  if (localPath) return localPath; // 로컬 임포트는 원본 폴더
  const cloudRoot = path.join(userDataDir(), "cloud-agent-installs", cloudSlug(agent.slug));
  if (safeExternalAgentPath(cloudRoot) && isRegularNoFollow(path.join(cloudRoot, CLOUD_RESTORE_MARKER_PATH))) return cloudRoot;
  return path.join(userDataDir(), "agents", cloudSlug(agent.slug));
}

function writeIfMissing(file, content) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`native context target must be a regular non-symbolic-link file: ${file}`);
    return false;
  } catch (error) {
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

function assertNativeFolder(folder) {
  if (typeof folder !== "string" || !path.isAbsolute(folder) || /[\u0000\r\n]/.test(folder)) {
    throw new Error("native context folder must be an absolute safe path");
  }
  const resolved = path.resolve(folder);
  const data = path.resolve(userDataDir());
  const internalRoots = [path.join(data, "agents"), path.join(data, "cloud-agent-installs")];
  const internal = internalRoots.some((root) => resolved.startsWith(root + path.sep));
  const unsafe = new Set([path.parse(resolved).root, path.resolve(os.homedir()), data]);
  if (unsafe.has(resolved)) throw new Error("refusing to write native context files to a broad user/system directory");
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("native context folder must be a real directory");
    const canonical = fs.realpathSync(resolved);
    if (unsafe.has(canonical)) throw new Error("refusing to write native context files to a broad user/system directory");
    return canonical;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    if (!internal) throw new Error("refusing to recreate a missing imported agent source folder");
    fs.mkdirSync(resolved, { recursive: true });
    const created = fs.lstatSync(resolved);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("native context folder changed type during creation");
  }
  return resolved;
}

function ensureNativeFiles(agent, folder) {
  folder = assertNativeFolder(folder);
  const sys = agentSystemPrompt(agent);
  const created = [];
  if (writeIfMissing(path.join(folder, "system-prompt.md"), sys)) created.push("system-prompt.md");
  const name = String(agent.name || agent.slug || "Agentlas agent").replace(/[\u0000\r\n]/g, " ").slice(0, 500);
  const tagline = String(agent.tagline || "").replace(/[\u0000\r]/g, " ").slice(0, 2_000);
  const header = `# ${name}\n\n${tagline}\n\n${sys}\n`;
  // 네이티브 CLI가 프로젝트 지시로 자동 인식하는 파일들
  if (writeIfMissing(path.join(folder, "CLAUDE.md"), header)) created.push("CLAUDE.md");
  if (writeIfMissing(path.join(folder, "AGENTS.md"), header)) created.push("AGENTS.md");
  if (writeIfMissing(path.join(folder, "GEMINI.md"), header)) created.push("GEMINI.md");
  return created;
}

module.exports = {
  agentFolder,
  ensureNativeFiles,
  agentSystemPrompt,
  cloudSlug,
  safeExternalAgentPath,
  assertNativeFolder,
  CLOUD_RESTORE_MARKER_PATH,
};
