"use strict";
/*
 * hub/plugins — Hub 플러그인 매니페스트 조회 + MCP 행 정규화 + 멱등 설치.
 *
 * 배경(v1 주석 승계): 서버는 처음부터 준비돼 있었다 — /api/plugins/<slug>가
 * agentlas.plugin/v1 매니페스트를 주고, 그 라우트 주석이 이 CLI
 * (`agentlas plugin add <slug>`)를 소비자로 지목한다. 그런데 이 명령이 구현된 적이
 * 없어서, 카탈로그 146개가 전부 "존재하지 않는 설치 명령"을 광고하고 있었다.
 * (`agentlas install`은 marketplace.get_manifest{kind:"agent"} 고정이라 플러그인엔 안 먹는다.)
 *
 * 이 파일의 transport 정규화 규칙은 런타임 전멸 사고들의 근본수리다 — 약화 금지:
 *  - 2026-07-23: 레포/홈페이지 HTML URL이 transport:"http" MCP 행으로 등록되어
 *    "절대 연결될 수 없는 MCP 서버"가 생기던 사고.
 *  - codex config.toml: 원격은 URL, stdio는 실행 커맨드. 둘을 섞으면 스키마 위반으로
 *    런타임이 통째로 죽는다(Runtime Doctor가 반복해서 잡던 사고 계열).
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { callHubTool, fetchHub, parseHubJson, webBaseUrl } = require("../cloud/hub-client.cjs");

// 레포/홈페이지 HTML 페이지는 문서지 MCP 연결이 아니다. 이 URL들을 transport:"http"로
// 등록하면 "절대 연결될 수 없는 MCP 서버"가 생긴다(2026-07-23 근본수리 계열).
const PLUGIN_CODE_HOSTING_HTML_RE = /^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\//i;

// 데스크탑 hub-plugin-bridge.ts:38 REPO_PAGE_HOSTS 동형 — 저장소/패키지 HTML 페이지
// 호스트. 데스크탑은 npm/pypi 패키지 페이지도 엔드포인트가 아니라고 본다.
const PLUGIN_REPO_PAGE_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "gitlab.com",
  "www.gitlab.com",
  "bitbucket.org",
  "www.bitbucket.org",
  "npmjs.com",
  "www.npmjs.com",
  "pypi.org",
]);

/**
 * 데스크탑 isLikelyRemoteMcpEndpoint 동형 (electron/mcp-tools/hub-plugin-bridge.ts:61):
 * https 필수, 저장소/패키지 HTML 페이지 호스트는 거부. v1 터미널은 http://도 원격
 * 엔드포인트로 수용했지만 현 데스크탑 모델은 평문 원격 MCP 등록을 허용하지 않는다.
 */
function pluginIsLikelyRemoteMcpEndpoint(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (PLUGIN_REPO_PAGE_HOSTS.has(url.hostname.toLowerCase())) return false;
  return true;
}

/** Hub 플러그인 매니페스트 조회. 404 → null, 스키마 불일치/HTTP 오류 → throw. */
async function fetchPluginManifest(slug, { fetch: fetchImpl } = {}) {
  const resp = await fetchHub(`${webBaseUrl()}/api/plugins/${encodeURIComponent(slug)}`, {
    headers: { accept: "application/json" },
  }, { fetch: fetchImpl });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`plugin lookup failed with HTTP ${resp.status}`);
  const manifest = parseHubJson(resp, "plugin manifest");
  if (!manifest || manifest.schema !== "agentlas.plugin/v1") {
    throw new Error(`Unexpected plugin manifest schema for ${slug}.`);
  }
  return manifest;
}

/**
 * 휴리스틱: 명시적 transport 선언이 없는 레거시 source URL이 진짜 MCP 엔드포인트로 보이는가.
 * 데스크탑 hub-plugin-bridge.ts:94 동형 — https 엔드포인트이면서 경로가 명시적으로
 * MCP(/mcp, /sse)를 가리킬 때만 신뢰한다. v1의 "mcp.* 호스트면 경로 없이 수용" 완화는
 * 데스크탑 모델에 없다(호스트명만으로 엔드포인트를 추정하지 않는다).
 */
function pluginLooksLikeMcpEndpoint(rawUrl) {
  if (!pluginIsLikelyRemoteMcpEndpoint(rawUrl)) return false;
  return /\/(mcp|sse)(?:$|[/?#])/.test(String(rawUrl));
}

/**
 * 매니페스트의 mcp[] 항목을 mcp_servers 행으로 정규화. stdio(command)와 remote(url)를 구분한다.
 * 반환: { row } | { refused: { name, source, reason } } | null(빈 항목).
 *
 * 규칙(근본수리): 레포 URL은 어떤 경우에도 transport:"http" 행으로 쓰이지 않는다.
 *  - transport:"stdio" + command 명시 → stdio 행 (mcp_servers는 command/args_json을 이미 지원).
 *  - transport:"http" + url 명시 → http 행. 단 코드호스팅 HTML 페이지(github.com/…)면 거부.
 *  - 레거시 {name, source}: http(s)면 MCP 엔드포인트로 보일 때만(…/mcp, …/sse, mcp.* 호스트) 수용,
 *    아니면 거부. 비-URL 문자열은 기존대로 stdio 실행 커맨드로 해석.
 */
function pluginMcpRow(slug, entry, index) {
  const name = (typeof entry?.name === "string" && entry.name.trim()) || `${slug}-${index + 1}`;
  const source = typeof entry?.source === "string" ? entry.source.trim() : "";
  const transport = typeof entry?.transport === "string" ? entry.transport.trim().toLowerCase() : "";
  const envKeys = Array.isArray(entry?.envKeys)
    ? entry.envKeys.filter((key) => typeof key === "string")
    : entry?.env && typeof entry.env === "object"
      ? Object.keys(entry.env)
      : [];
  const makeRow = (fields) => ({
    row: {
      id: crypto.randomUUID(),
      catalogId: `hub:${slug}:${name}`,
      name,
      envKeysJson: JSON.stringify(envKeys),
      ...fields,
    },
  });
  const refuse = (reason) => ({ refused: { name, source: source || (typeof entry?.url === "string" ? entry.url : ""), reason } });

  if (transport === "stdio") {
    const command = typeof entry?.command === "string" ? entry.command.trim() : "";
    if (!command) return refuse("stdio row without a launch command");
    const args = Array.isArray(entry?.args) ? entry.args.filter((a) => typeof a === "string") : [];
    return makeRow({ transport: "stdio", command, argsJson: JSON.stringify(args), url: null });
  }
  if (transport === "http" || transport === "sse") {
    const url = typeof entry?.url === "string" && entry.url.trim() ? entry.url.trim() : source;
    if (!/^https?:\/\//i.test(url)) return refuse("http row without a usable endpoint URL");
    if (PLUGIN_CODE_HOSTING_HTML_RE.test(url)) {
      return refuse("URL is a code-hosting HTML page (docs), not an MCP endpoint");
    }
    // 명시 선언이어도 데스크탑과 동일하게 isLikelyRemoteMcpEndpoint를 통과해야 한다
    // (hub-plugin-bridge.ts:90) — https 필수, 저장소/패키지 페이지 호스트 거부.
    if (!pluginIsLikelyRemoteMcpEndpoint(url)) {
      return refuse("URL is not a usable remote MCP endpoint (https required; repo/package pages are docs)");
    }
    return makeRow({ transport: "http", command: null, argsJson: "[]", url });
  }
  if (transport) return refuse(`unsupported transport "${transport}"`);

  // ── 레거시 {name, source} 행 ──
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) {
    if (!pluginLooksLikeMcpEndpoint(source)) {
      return refuse(
        PLUGIN_CODE_HOSTING_HTML_RE.test(source)
          ? "URL is a code-hosting HTML page (docs), not an MCP endpoint"
          : "URL does not look like an MCP endpoint (no /mcp, /sse, or mcp.* host, and no declared transport)",
      );
    }
    return makeRow({ transport: "http", command: null, argsJson: "[]", url: source });
  }
  // 원격은 URL, stdio는 실행 커맨드다. 둘을 섞으면 codex config.toml 스키마 위반으로
  // 런타임이 통째로 죽는다(Runtime Doctor가 반복해서 잡던 사고 계열).
  const argv = source.split(/\s+/).filter(Boolean);
  return makeRow({ transport: "stdio", command: argv[0] ?? null, argsJson: JSON.stringify(argv.slice(1)), url: null });
}

/** 매니페스트 전체를 설치 계획으로 정규화: 등록할 행과, 정직하게 거부한 항목을 분리한다. */
function planPluginMcpInstall(slug, manifest) {
  const entries = Array.isArray(manifest?.mcp) ? manifest.mcp : [];
  const rows = [];
  const refused = [];
  entries.forEach((entry, index) => {
    const normalized = pluginMcpRow(slug, entry, index);
    if (!normalized) return;
    if (normalized.row) rows.push(normalized.row);
    else if (normalized.refused) refused.push(normalized.refused);
  });
  return { rows, refused };
}

/**
 * 정규화된 행들을 로컬 mcp_servers 스키마에 멱등 삽입.
 * { installed, reused, needsApproval } 반환.
 *
 * 데스크탑 hub-plugin-bridge.ts:209-228 동형(자율 경계, 2026-07-23 재설계):
 * stdio(로컬 프로세스 실행 = 원격 메타데이터발 코드 실행)는 절대 자동 활성화하지
 * 않는다 — enabled=0으로 등록하고 승인 필요로 정직하게 표면화한다. 이 테이블은
 * 데스크탑과 공유되므로, 터미널이 enabled=1로 넣으면 데스크탑 런타임 구성이
 * 승인 게이트 없이 그 로컬 프로세스를 실행하게 된다. http/sse 원격 연결만
 * 자동 활성화한다(네트워크 연결일 뿐 로컬 실행이 없다).
 */
function installPluginMcpRows(db, rows) {
  let installed = 0;
  let reused = 0;
  const needsApproval = [];
  for (const row of rows) {
    const stdioNeedsApproval = row.transport === "stdio";
    const existing = db.prepare("SELECT id FROM mcp_servers WHERE catalog_id = ? LIMIT 1").get(row.catalogId);
    if (existing) { reused += 1; continue; } // 멱등: 재설치가 중복 행을 만들지 않는다
    db.prepare(
      `INSERT INTO mcp_servers (id, catalog_id, name, name_en, transport, command, args_json, url, env_keys_json, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.catalogId, row.name, row.name, row.transport,
      row.command, row.argsJson, row.url, row.envKeysJson,
      stdioNeedsApproval ? 0 : 1, new Date().toISOString(),
    );
    installed += 1;
    if (stdioNeedsApproval) needsApproval.push(row.name);
  }
  return { installed, reused, needsApproval };
}

// ── 스킬 번들 설치 (플러그인 = MCP와 별개의 능력 패키지, 오너 결정 2026-08-20) ──
//
// manifest.skills 행이 files[]에 실콘텐츠를 실으면 ~/.agentlas/plugins/<slug>/ 아래에
// 파일로 착지시키고 plugin.json 마커(schema agentlas.local-plugin/v1)를 남긴다.
// 이 규약은 데스크탑 electron/mcp-tools/hub-plugin-bridge.ts(installSkillBundle)와
// Agentlas-OS agentlas_cloud/plugin_discovery.py 스캔이 공유한다 — mcp_servers 등록이
// 아니라 파일시스템이 채널 간 공유 지점이다.

const PLUGIN_SKILL_SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PLUGIN_SKILL_FILE_MAX_BYTES = 512 * 1024;
const PLUGIN_SKILL_MAX_COUNT = 64;
const PLUGIN_SKILL_MAX_FILES_PER_SKILL = 256;
const PLUGIN_SKILL_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
const PLUGIN_MARKER_MAX_BYTES = 128 * 1024;
const PLUGIN_LOCAL_MAX_COUNT = 256;

/** 세 채널이 공유하는 로컬 플러그인 저장소 루트. homeDir 주입은 테스트 격리용. */
function agentlasPluginsDir({ homeDir } = {}) {
  return path.join(homeDir || os.homedir(), ".agentlas", "plugins");
}

/** 스킬 파일 상대 경로 검증 — 절대경로·상위 탈출·널바이트·백슬래시 거부 (데스크탑 동형). */
function pluginSkillSafeRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 260) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || value.endsWith("/")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("~"));
}

/**
 * manifest.skills 를 설치 계획으로 정규화: 실콘텐츠가 실린 스킬과 정직하게 거른 항목 분리.
 * 이름뿐인 레거시 행({name}만)은 refused가 아니라 declaredOnly로 남긴다 — 결함이 아니라
 * 과거 스키마의 정상 모양이다.
 */
function planPluginSkillInstall(slug, manifest) {
  const entries = Array.isArray(manifest?.skills) ? manifest.skills : [];
  const skills = [];
  const declaredOnly = [];
  const refused = [];
  let plannedBytes = 0;
  const seenNames = new Set();
  if (entries.length > PLUGIN_SKILL_MAX_COUNT) {
    refused.push({ name: "(manifest)", reason: `too many skills (maximum ${PLUGIN_SKILL_MAX_COUNT})` });
  }
  for (const entry of entries.slice(0, PLUGIN_SKILL_MAX_COUNT)) {
    const name = typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!name) continue;
    const rawFiles = Array.isArray(entry?.files) ? entry.files : [];
    if (rawFiles.length === 0) {
      declaredOnly.push(name);
      continue;
    }
    if (!PLUGIN_SKILL_SLUG_RE.test(name)) {
      refused.push({ name, reason: "invalid skill name" });
      continue;
    }
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      refused.push({ name, reason: "duplicate skill name" });
      continue;
    }
    seenNames.add(nameKey);
    if (rawFiles.length > PLUGIN_SKILL_MAX_FILES_PER_SKILL) {
      refused.push({ name, reason: `too many files (maximum ${PLUGIN_SKILL_MAX_FILES_PER_SKILL})` });
      continue;
    }
    const files = [];
    const seenPaths = new Set();
    let skillBytes = 0;
    let bad = null;
    for (const file of rawFiles) {
      const filePath = typeof file?.path === "string" ? file.path.trim() : "";
      const content = typeof file?.content === "string" ? file.content : "";
      if (!pluginSkillSafeRelativePath(filePath)) { bad = `unsafe file path "${filePath}"`; break; }
      const pathKey = filePath.toLowerCase();
      if (seenPaths.has(pathKey)) { bad = `duplicate file path "${filePath}"`; break; }
      seenPaths.add(pathKey);
      if (!content.trim()) { bad = `empty content for ${filePath}`; break; }
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > PLUGIN_SKILL_FILE_MAX_BYTES) { bad = `${filePath} exceeds the file size cap`; break; }
      skillBytes += bytes;
      const sha256 = typeof file?.sha256 === "string" && /^[0-9a-f]{64}$/i.test(file.sha256)
        ? file.sha256.toLowerCase()
        : null;
      files.push({ path: filePath, content, sha256 });
    }
    if (bad) { refused.push({ name, reason: bad }); continue; }
    if (plannedBytes + skillBytes > PLUGIN_SKILL_TOTAL_MAX_BYTES) {
      refused.push({ name, reason: `skill payloads exceed the total size cap (${PLUGIN_SKILL_TOTAL_MAX_BYTES} bytes)` });
      continue;
    }
    plannedBytes += skillBytes;
    skills.push({ name, description: typeof entry?.description === "string" ? entry.description : null, files });
  }
  return { skills, declaredOnly, refused };
}

function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing unsafe plugin directory: ${dir}`);
  }
  fs.chmodSync(dir, 0o700);
  const verified = fs.lstatSync(dir);
  if (!verified.isDirectory() || verified.isSymbolicLink() || !sameDirectoryIdentity(stat, verified)) {
    throw new Error(`plugin directory changed during setup: ${dir}`);
  }
  return verified;
}

function sameDirectoryIdentity(left, right) {
  return left
    && right
    && left.isDirectory()
    && right.isDirectory()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino;
}

function privateDirectoryIdentity(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing unsafe plugin directory: ${dir}`);
  }
  return stat;
}

function assertPrivateDirectoryIdentity(dir, expected) {
  const actual = privateDirectoryIdentity(dir);
  if (!sameDirectoryIdentity(expected, actual)) {
    throw new Error(`plugin directory changed during write: ${dir}`);
  }
  return actual;
}

function sameFileInode(left, right) {
  return left
    && right
    && left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino;
}

function existingPluginFile(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink destination: ${target}`);
  if (!stat.isFile()) throw new Error(`refusing non-file destination: ${target}`);
  if (stat.nlink > 1) throw new Error(`refusing hard-linked destination: ${target}`);
  return stat;
}

function writePluginFileAtomic(target, content) {
  const parent = path.dirname(target);
  const parentStat = privateDirectory(parent);
  const expectedTarget = existingPluginFile(target);
  assertPrivateDirectoryIdentity(parent, parentStat);
  const temp = path.join(parent, `.${path.basename(target)}.agentlas-${crypto.randomUUID()}.tmp`);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  let fd = null;
  let tempStat = null;
  let tempPublished = false;
  try {
    assertPrivateDirectoryIdentity(parent, parentStat);
    if (expectedTarget) {
      // Node has no portable rename-no-replace primitive. For an existing file,
      // update only the exact inode observed above, never a pathname successor.
      fd = fs.openSync(target, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = fs.fstatSync(fd);
      if (!sameFileInode(expectedTarget, opened) || opened.nlink !== 1) {
        throw new Error(`plugin destination changed before update: ${target}`);
      }
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, content, 0, "utf8");
      fs.fsyncSync(fd);
      const updated = fs.fstatSync(fd);
      if (!sameFileInode(opened, updated) || updated.nlink !== 1) {
        throw new Error(`plugin destination identity changed during update: ${target}`);
      }
      fs.closeSync(fd);
      fd = null;
      assertPrivateDirectoryIdentity(parent, parentStat);
      const finalStat = fs.lstatSync(target);
      if (!sameFileInode(updated, finalStat) || finalStat.nlink !== 1) {
        throw new Error(`plugin destination changed after update: ${target}`);
      }
      return;
    }

    fd = fs.openSync(temp, flags, 0o600);
    fs.writeFileSync(fd, content, { encoding: "utf8" });
    fs.fsyncSync(fd);
    tempStat = fs.fstatSync(fd);
    if (!tempStat.isFile() || tempStat.nlink !== 1) throw new Error(`unsafe temporary plugin file: ${target}`);
    fs.closeSync(fd);
    fd = null;
    assertPrivateDirectoryIdentity(parent, parentStat);
    // link(2) is atomic and no-replace: unlike rename(2), a successor that
    // appears after the preflight can never be silently clobbered.
    if (existingPluginFile(target)) {
      throw new Error(`plugin destination appeared during write: ${target}`);
    }
    fs.linkSync(temp, target);
    tempPublished = true;
    assertPrivateDirectoryIdentity(parent, parentStat);
    fs.unlinkSync(temp);
    tempPublished = false;
    const finalStat = fs.lstatSync(target);
    if (
      !sameFileInode(tempStat, finalStat)
      || finalStat.nlink !== 1
    ) {
      throw new Error(`plugin file identity changed after write: ${target}`);
    }
    assertPrivateDirectoryIdentity(parent, parentStat);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try {
      if (!tempPublished && sameDirectoryIdentity(parentStat, privateDirectoryIdentity(parent))) {
        fs.unlinkSync(temp);
      }
    } catch (cleanupError) {
      if (cleanupError && cleanupError.code !== "ENOENT") { /* best effort */ }
    }
    throw error;
  }
}

function readPluginDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing unsafe plugin directory: ${dir}`);
  }
  return stat;
}

function sameFileIdentity(left, right) {
  return left
    && right
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink;
}

function readPluginMarker(target) {
  const before = fs.lstatSync(target);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > PLUGIN_MARKER_MAX_BYTES) {
    throw new Error(`unsafe plugin marker: ${target}`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let fd = null;
  try {
    fd = fs.openSync(target, flags);
    const opened = fs.fstatSync(fd);
    if (!sameFileIdentity(before, opened)) throw new Error(`plugin marker changed before read: ${target}`);
    const buffer = Buffer.alloc(PLUGIN_MARKER_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (!count) break;
      bytesRead += count;
    }
    if (bytesRead > PLUGIN_MARKER_MAX_BYTES) throw new Error(`plugin marker exceeds the ${PLUGIN_MARKER_MAX_BYTES}-byte cap`);
    const after = fs.fstatSync(fd);
    if (!sameFileIdentity(opened, after) || bytesRead !== after.size) {
      throw new Error(`plugin marker changed during read: ${target}`);
    }
    const value = buffer.subarray(0, bytesRead).toString("utf8");
    const pathnameAfter = fs.lstatSync(target);
    if (!sameFileIdentity(before, pathnameAfter)) {
      throw new Error(`plugin marker changed after read: ${target}`);
    }
    return value;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function validMarkerText(value, max) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validatePluginMarker(marker, directoryName) {
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  if (marker.schema !== "agentlas.local-plugin/v1") return null;
  if (!validMarkerText(marker.slug, 64) || !PLUGIN_SKILL_SLUG_RE.test(marker.slug)) return null;
  if (String(marker.slug).toLowerCase() !== String(directoryName).toLowerCase()) return null;
  if (!validMarkerText(marker.name, 256)) return null;
  if (!Array.isArray(marker.skills) || marker.skills.length > PLUGIN_SKILL_MAX_COUNT) return null;
  const seenSkills = new Set();
  for (const skill of marker.skills) {
    if (!skill || typeof skill !== "object" || !validMarkerText(skill.name, 64) || !PLUGIN_SKILL_SLUG_RE.test(skill.name)) return null;
    const skillKey = skill.name.toLowerCase();
    if (seenSkills.has(skillKey)) return null;
    seenSkills.add(skillKey);
    if (!Array.isArray(skill.files) || skill.files.length > PLUGIN_SKILL_MAX_FILES_PER_SKILL) return null;
    const seenFiles = new Set();
    for (const file of skill.files) {
      if (!file || typeof file !== "object" || !pluginSkillSafeRelativePath(file.path)) return null;
      const fileKey = file.path.toLowerCase();
      if (seenFiles.has(fileKey)) return null;
      seenFiles.add(fileKey);
      if (!/^[0-9a-f]{64}$/i.test(String(file.sha256 || "")) || typeof file.verified !== "boolean") return null;
    }
  }
  return {
    slug: marker.slug,
    name: marker.name,
    installedAt: validMarkerText(marker.installedAt, 128) ? marker.installedAt : null,
    installedBy: validMarkerText(marker.installedBy, 128) ? marker.installedBy : null,
    skills: marker.skills.map((skill) => String(skill.name)),
  };
}

/**
 * 계획된 스킬들을 ~/.agentlas/plugins/<slug>/skills/<name>/ 에 쓴다.
 *
 * 무결성: 행이 sha256을 선언하면 쓰기 전에 검증하고, 불일치 스킬은 설치하지 않는다.
 * 해시와 콘텐츠가 같은 매니페스트 응답으로 오므로 이 검증은 전송 무결성이지 발행자
 * 서명이 아니다 — 마커의 source.manifestUrl이 출처 기록이다(정직한 한계).
 */
function installPluginSkills(slug, plan, { homeDir, manifestUrl, meta } = {}) {
  if (!PLUGIN_SKILL_SLUG_RE.test(String(slug || ""))) {
    return { dir: "", installed: [], failed: [{ name: String(slug || ""), reason: "invalid plugin slug" }], verified: false };
  }
  const pluginsRoot = agentlasPluginsDir({ homeDir });
  const pluginDir = path.join(pluginsRoot, slug);
  const installed = [];
  const failed = [];
  const markerSkills = [];
  let allDeclared = true;
  let hadFailure = false;
  try {
    // Every directory owned by the installer is private and must be a real
    // directory. In particular, do not follow a pre-created .agentlas/plugins
    // or <slug>/skills symlink into an arbitrary location.
    privateDirectory(path.dirname(pluginsRoot));
    privateDirectory(pluginsRoot);
    privateDirectory(pluginDir);
  } catch (error) {
    return {
      dir: pluginDir,
      installed,
      failed: [{ name: "plugin", reason: String((error && error.message) || error).slice(0, 160) }],
      verified: false,
    };
  }
  const skills = Array.isArray(plan?.skills) ? plan.skills.slice(0, PLUGIN_SKILL_MAX_COUNT) : [];
  if (Array.isArray(plan?.skills) && plan.skills.length > PLUGIN_SKILL_MAX_COUNT) {
    failed.push({ name: "(manifest)", reason: `too many skills (maximum ${PLUGIN_SKILL_MAX_COUNT})` });
    allDeclared = false;
    hadFailure = true;
  }
  let installedBytes = 0;
  const seenSkillNames = new Set();
  for (const skill of skills) {
    const written = [];
    let mismatch = null;
    let skillBytes = 0;
    const seenPaths = new Set();
    const skillName = typeof skill?.name === "string" ? skill.name : "";
    if (!skill || typeof skill !== "object" || !PLUGIN_SKILL_SLUG_RE.test(skillName)) {
      failed.push({ name: String(skill?.name || "skill"), reason: "invalid skill name" });
      allDeclared = false;
      hadFailure = true;
      continue;
    }
    const skillNameKey = skillName.toLowerCase();
    if (seenSkillNames.has(skillNameKey)) {
      failed.push({ name: skillName, reason: "duplicate skill name" });
      allDeclared = false;
      hadFailure = true;
      continue;
    }
    seenSkillNames.add(skillNameKey);
    if (!Array.isArray(skill.files) || skill.files.length > PLUGIN_SKILL_MAX_FILES_PER_SKILL) {
      failed.push({ name: skillName, reason: `too many files (maximum ${PLUGIN_SKILL_MAX_FILES_PER_SKILL})` });
      allDeclared = false;
      hadFailure = true;
      continue;
    }
    for (const file of skill.files) {
      if (!file || typeof file !== "object" || !pluginSkillSafeRelativePath(file.path)) {
        mismatch = `unsafe file path "${String(file?.path || "")}"`;
        break;
      }
      const pathKey = file.path.toLowerCase();
      if (seenPaths.has(pathKey)) {
        mismatch = `duplicate file path "${file.path}"`;
        break;
      }
      seenPaths.add(pathKey);
      if (typeof file.content !== "string" || !file.content.trim()) {
        mismatch = `empty content for ${file.path}`;
        break;
      }
      const bytes = Buffer.byteLength(file.content, "utf8");
      if (bytes > PLUGIN_SKILL_FILE_MAX_BYTES) {
        mismatch = `${file.path} exceeds the file size cap`;
        break;
      }
      skillBytes += bytes;
      const actual = crypto.createHash("sha256").update(file.content, "utf8").digest("hex");
      if (file.sha256 && file.sha256 !== actual) { mismatch = `sha256 mismatch for ${file.path}`; break; }
      if (!file.sha256) allDeclared = false;
      written.push({ path: file.path, sha256: actual, verified: Boolean(file.sha256) });
    }
    if (mismatch) {
      failed.push({ name: skillName, reason: mismatch });
      hadFailure = true;
      continue;
    }
    if (installedBytes + skillBytes > PLUGIN_SKILL_TOTAL_MAX_BYTES) {
      failed.push({ name: skillName, reason: `skill payloads exceed the total size cap (${PLUGIN_SKILL_TOTAL_MAX_BYTES} bytes)` });
      allDeclared = false;
      hadFailure = true;
      continue;
    }
    try {
      const skillDir = path.join(pluginDir, "skills", skillName);
      privateDirectory(path.join(pluginDir, "skills"));
      privateDirectory(skillDir);
      for (const file of skill.files) {
        const parts = file.path.split("/");
        let parent = skillDir;
        for (const part of parts.slice(0, -1)) {
          parent = path.join(parent, part);
          privateDirectory(parent);
        }
        writePluginFileAtomic(path.join(parent, parts[parts.length - 1]), file.content);
      }
      installedBytes += skillBytes;
      installed.push(skillName);
      markerSkills.push({ name: skillName, files: written });
    } catch (e) {
      failed.push({ name: skillName, reason: String((e && e.message) || e).slice(0, 160) });
      hadFailure = true;
    }
  }
  const contentVerified = installed.length > 0 && allDeclared && !hadFailure;
  let markerWritten = false;
  if (installed.length > 0) {
    // 마커는 마지막에 쓴다 — 마커가 있으면 스킬 파일도 있다는 뜻이어야 한다.
    const marker = {
      schema: "agentlas.local-plugin/v1",
      slug,
      name: (meta && meta.name) || slug,
      family: (meta && meta.family) || null,
      version: (meta && meta.version) || null,
      installedAt: new Date().toISOString(),
      installedBy: "agentlas-terminal",
      source: { manifestUrl: manifestUrl || null, contentVerification: contentVerified ? "manifest-sha256" : "none" },
      skills: markerSkills,
    };
    try {
      writePluginFileAtomic(path.join(pluginDir, "plugin.json"), `${JSON.stringify(marker, null, 2)}\n`);
      markerWritten = true;
    } catch (e) {
      failed.push({ name: "plugin.json", reason: String((e && e.message) || e).slice(0, 160) });
      hadFailure = true;
    }
  }
  return { dir: pluginDir, installed, failed, verified: contentVerified && markerWritten && !hadFailure };
}

/** ~/.agentlas/plugins/<slug>/plugin.json 마커들을 읽는다 — list의 설치 여부 표시용. */
function listInstalledLocalPlugins({ homeDir } = {}) {
  const root = agentlasPluginsDir({ homeDir });
  let names;
  try {
    const rootStat = readPluginDirectory(root);
    names = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.isSymbolicLink())
      .map((d) => d.name)
      .filter((name) => !name.startsWith("."))
      .slice(0, PLUGIN_LOCAL_MAX_COUNT);
    const rootAfter = readPluginDirectory(root);
    if (rootAfter.dev !== rootStat.dev || rootAfter.ino !== rootStat.ino) return [];
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const pluginDir = path.join(root, name);
      const pluginBefore = readPluginDirectory(pluginDir);
      const marker = JSON.parse(readPluginMarker(path.join(pluginDir, "plugin.json")));
      const pluginAfter = readPluginDirectory(pluginDir);
      if (pluginAfter.dev !== pluginBefore.dev || pluginAfter.ino !== pluginBefore.ino) continue;
      const valid = validatePluginMarker(marker, name);
      if (!valid) continue;
      out.push({ ...valid, dir: pluginDir });
    } catch {
      // 마커 없는 디렉터리와 unsafe/corrupt markers는 설치 상태로 광고하지 않는다.
    }
  }
  return out;
}

/** Hub 플러그인 카탈로그 목록 (marketplace.list_plugins). 실패는 그대로 throw — 폴백 카탈로그 금지. */
async function listHubPlugins({ callTool } = {}) {
  const call = callTool || callHubTool;
  const result = await call("marketplace.list_plugins", {});
  return (result && (result.plugins || result.results)) || [];
}

module.exports = {
  PLUGIN_CODE_HOSTING_HTML_RE,
  PLUGIN_REPO_PAGE_HOSTS,
  fetchPluginManifest,
  pluginIsLikelyRemoteMcpEndpoint,
  pluginLooksLikeMcpEndpoint,
  pluginMcpRow,
  planPluginMcpInstall,
  installPluginMcpRows,
  listHubPlugins,
  agentlasPluginsDir,
  pluginSkillSafeRelativePath,
  planPluginSkillInstall,
  installPluginSkills,
  listInstalledLocalPlugins,
};
