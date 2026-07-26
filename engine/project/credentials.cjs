"use strict";
/*
 * project/credentials — 프로젝트 로컬 자격증명 스토어 (v1 monolith 3957–4182 포팅).
 *
 * 계약:
 *  - 값(비밀)은 절대 .agentlas/local-credentials.map.json 이나 soul memory에 기록하지
 *    않는다. 여기엔 env 이름·상대 경로·owner·stale-check 메모만 남는다.
 *  - signing/, credentials/ 폴더와 .env* 는 ensureAgentlasCredentialIgnoreCli 가
 *    프로젝트 .gitignore에 별도 블록으로 등록한다 (README만 예외로 커밋 허용).
 */
const fs = require("node:fs");
const path = require("node:path");
const { loadArch } = require("../core/db.cjs");
const { runCwd } = require("./paths.cjs");

function localCredentialConfigCli(arch) {
  return {
    mapFile: arch.localCredentialsMapFile || "local-credentials.map.json",
    envExampleFile: arch.projectEnvExampleFile || ".env.example",
    signingDir: arch.projectSigningDir || "signing",
    credentialsDir: arch.projectCredentialsDir || "credentials",
    readmeFile: arch.projectCredentialsReadmeFile || "README.md",
  };
}
function projectEnvIdCli(projectPath) {
  const raw = path.basename(projectPath || runCwd() || "project") || "project";
  return raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "PROJECT";
}
function projectScopedGlobalEnvKeyCli(projectPath, key) {
  return `AGENTLAS_PROJECT_${projectEnvIdCli(projectPath)}_${key}`;
}
function projectScopedEnvValuesCli(values, projectPath) {
  const prefix = `AGENTLAS_PROJECT_${projectEnvIdCli(projectPath)}_`;
  const result = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (!key.startsWith(prefix)) continue;
    const actualKey = key.slice(prefix.length);
    if (/^[A-Z][A-Z0-9_]*$/.test(actualKey)) result[actualKey] = value;
  }
  return result;
}
function localCredentialsMapSkeletonCli(projectPath, projectName, cfg) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    kind: "agentlas-local-credential-store",
    projectName,
    projectRoot: projectPath,
    createdAt: now,
    updatedAt: now,
    envFiles: [".env", ".env.local"],
    secretDirs: [cfg.signingDir, cfg.credentialsDir],
    entries: [],
  };
}
const CREDENTIAL_INDEX_SECTION_CLI = "## Local Credential Index (read first)";
function credentialIndexSectionContentCli(arch) {
  const cfg = localCredentialConfigCli(arch || loadArch());
  const mapFile = (arch && arch.localCredentialsMapFile) || "local-credentials.map.json";
  return `${CREDENTIAL_INDEX_SECTION_CLI}

- For deploy, release, store, billing, auth, API, or cloud work, read
  .agentlas/${mapFile} before saying a credential is missing.
- Real values may live in .env, .env.local, ${cfg.signingDir}/,
  ${cfg.credentialsDir}/, local keychain/vault, or project-scoped global env
  keys like AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME>.
- Keep this memory value-free: record env names, local relative paths, owner,
  stale-check notes, and validation commands only.

| Need | Look here first | Memory record |
|------|-----------------|---------------|
| Scalar env key | .env or .env.local | env name only |
| Store/signing file | ${cfg.signingDir}/ | relative path only |
| App/provider config | ${cfg.credentialsDir}/ | relative path only |
| Shared local env | AGENTLAS_PROJECT_<PROJECT>_<ENV_NAME> | project-scoped env name |
`;
}
function projectSoulTemplateCli(projectName, arch) {
  return `# Project Soul Memory: ${projectName}

Durable memory for this project folder, maintained by Agentlas.

${credentialIndexSectionContentCli(arch)}

## Project Purpose

## Current State

## Decisions

## Risks

## Auto-curated memory
`;
}
function ensureSoulCredentialIndexCli(projectPath, projectName, arch) {
  const memoryDir = (arch && arch.memoryDir) || ".agentlas";
  const soulFile = (arch && arch.soulFile) || "project-soul-memory.md";
  const dir = path.join(projectPath, memoryDir);
  const soul = path.join(dir, soulFile);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(soul)) {
    fs.writeFileSync(soul, projectSoulTemplateCli(projectName, arch), "utf8");
    return soul;
  }
  let content = "";
  try { content = fs.readFileSync(soul, "utf8"); } catch { content = ""; }
  if (!content.includes(CREDENTIAL_INDEX_SECTION_CLI)) {
    const section = credentialIndexSectionContentCli(arch);
    const marker = "\n## Project Purpose";
    const next = content.includes(marker)
      ? content.replace(marker, `\n${section}\n## Project Purpose`)
      : `${content.trimEnd()}\n\n${section}\n`;
    fs.writeFileSync(soul, next.endsWith("\n") ? next : next + "\n", "utf8");
  }
  return soul;
}
function envExampleContentCli(cfg) {
  return `# Agentlas local project environment.
# Copy this file to .env and fill real values only on this machine.

# File-path style for tools that expect a local JSON credential file.
SUPPLY_JSON_KEY=${cfg.signingDir}/google-play.json

# Inline JSON style for tools that support reading a credential directly from env.
GOOGLE_PLAY_SERVICE_ACCOUNT_JSON=
`;
}
function signingReadmeContentCli(cfg) {
  return `# ${cfg.signingDir}/

Put release signing material here when this project needs local deploy or store
automation. This folder is ignored by git except for this README.

Examples:

- Google Play release JSON used by SUPPLY_JSON_KEY
- Apple signing certificates or provisioning profiles
- Notarization or release upload keys

Do not commit files from this folder.
`;
}
function credentialsReadmeContentCli(cfg) {
  return `# ${cfg.credentialsDir}/

Put app or service configuration files here when this project needs local runtime
access. This folder is ignored by git except for this README.

Examples:

- Android google-services.json
- iOS GoogleService-Info.plist
- provider config files used only by this local project

Do not commit files from this folder.
`;
}
function ensureAgentlasCredentialIgnoreCli(projectPath, cfg) {
  const gitignorePath = path.join(projectPath, ".gitignore");
  const marker = "# Agentlas local credentials";
  const block = `${marker}
.env
.env.local
.env.*.local
._*
${cfg.signingDir}/*
!${cfg.signingDir}/
!${cfg.signingDir}/${cfg.readmeFile}
${cfg.credentialsDir}/*
!${cfg.credentialsDir}/
!${cfg.credentialsDir}/${cfg.readmeFile}
`;
  let existing = "";
  try { existing = fs.readFileSync(gitignorePath, "utf8"); } catch { existing = ""; }
  if (existing.includes(marker)) {
    if (!/^\._\*$/m.test(existing)) fs.writeFileSync(gitignorePath, `${existing.trimEnd()}\n._*\n`, "utf8");
    return;
  }
  const next = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}` : block;
  fs.writeFileSync(gitignorePath, next.endsWith("\n") ? next : next + "\n", "utf8");
}
function ensureLocalCredentialStoreCli(projectPath, projectName, arch) {
  const cfg = localCredentialConfigCli(arch || loadArch());
  const dir = path.join(projectPath, (arch && arch.memoryDir) || ".agentlas");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(projectPath, cfg.signingDir), { recursive: true });
  fs.mkdirSync(path.join(projectPath, cfg.credentialsDir), { recursive: true });
  const envExample = path.join(projectPath, cfg.envExampleFile);
  if (!fs.existsSync(envExample)) fs.writeFileSync(envExample, envExampleContentCli(cfg), "utf8");
  const signingReadme = path.join(projectPath, cfg.signingDir, cfg.readmeFile);
  if (!fs.existsSync(signingReadme)) fs.writeFileSync(signingReadme, signingReadmeContentCli(cfg), "utf8");
  const credentialsReadme = path.join(projectPath, cfg.credentialsDir, cfg.readmeFile);
  if (!fs.existsSync(credentialsReadme)) fs.writeFileSync(credentialsReadme, credentialsReadmeContentCli(cfg), "utf8");
  const mapPath = path.join(dir, cfg.mapFile);
  if (!fs.existsSync(mapPath)) {
    fs.writeFileSync(mapPath, JSON.stringify(localCredentialsMapSkeletonCli(projectPath, projectName, cfg), null, 2) + "\n", "utf8");
  }
  ensureAgentlasCredentialIgnoreCli(projectPath, cfg);
  return { cfg, mapPath };
}
function readJsonObjectCli(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function upsertLocalCredentialMapCli(projectPath, projectName, arch, entry) {
  const { cfg, mapPath } = ensureLocalCredentialStoreCli(projectPath, projectName, arch || loadArch());
  const data = readJsonObjectCli(mapPath, localCredentialsMapSkeletonCli(projectPath, projectName, cfg));
  const now = new Date().toISOString();
  data.updatedAt = now;
  if (!Array.isArray(data.entries)) data.entries = [];
  const id = entry.id || `${entry.provider || "credential"}:${(entry.env || []).join(",") || (entry.localFiles || []).join(",")}`;
  const clean = {
    id,
    provider: entry.provider || "unknown",
    env: Array.isArray(entry.env) ? [...new Set(entry.env.filter(Boolean))] : [],
    localFiles: Array.isArray(entry.localFiles) ? [...new Set(entry.localFiles.filter(Boolean))] : [],
    owner: entry.owner || "project",
    valueMaterialized: Boolean(entry.valueMaterialized),
    storage: Array.isArray(entry.storage) ? [...new Set(entry.storage.filter(Boolean))] : [],
    requiredFor: Array.isArray(entry.requiredFor) ? [...new Set(entry.requiredFor.filter(Boolean))] : [],
    lastVerified: entry.lastVerified || null,
    staleCheck: entry.staleCheck || null,
    updatedAt: now,
  };
  const idx = data.entries.findIndex((row) => row && row.id === id);
  if (idx >= 0) data.entries[idx] = { ...data.entries[idx], ...clean };
  else data.entries.push(clean);
  fs.writeFileSync(mapPath, JSON.stringify(data, null, 2) + "\n", "utf8");
}
// v1은 fail()로 즉시 종료했다 — v2 규칙은 throw → 명령이 ctx.err + return 1 로 변환.
function safeCredentialDestRelCli(destRel) {
  const rel = path.normalize(String(destRel || "")).replace(/\\/g, "/");
  if (!rel || path.isAbsolute(rel) || rel === "." || rel.startsWith("../") || rel.includes("\0")) {
    throw new Error("credential destination must be a relative path inside the project");
  }
  return rel;
}

module.exports = {
  CREDENTIAL_INDEX_SECTION_CLI,
  localCredentialConfigCli,
  projectEnvIdCli,
  projectScopedGlobalEnvKeyCli,
  projectScopedEnvValuesCli,
  localCredentialsMapSkeletonCli,
  credentialIndexSectionContentCli,
  projectSoulTemplateCli,
  ensureSoulCredentialIndexCli,
  envExampleContentCli,
  signingReadmeContentCli,
  credentialsReadmeContentCli,
  ensureAgentlasCredentialIgnoreCli,
  ensureLocalCredentialStoreCli,
  readJsonObjectCli,
  upsertLocalCredentialMapCli,
  safeCredentialDestRelCli,
};
