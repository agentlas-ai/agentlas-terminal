"use strict";
/*
 * cloud-assets/package — 폴더 스캔 → 패키지 번들 → (dry-run이 아니면) CAS 등록.
 *
 * v1 monolith "Agentlas Cloud packaging" 절의 충실 이식. 핵심 계약(약화 금지):
 *  - 패키징/보안 리뷰는 전부 로컬에서 돈다. Agent Cloud에는 패키지 데이터·해시·
 *    로컬 리뷰 증적만 올라간다 (플랫폼 LLM 호출 없음).
 *  - 시크릿 발견 = blocker = 등록 fetch 0회. (agentlas-secret-patterns 공유 모듈 +
 *    이 파일의 구조적 credential 검사 + 파일명 차단 목록의 3중 게이트)
 *  - 파일 읽기는 no-follow + 전/후 fstat 대조 — 스캔 중 바꿔치기(symlink swap,
 *    append)는 전부 blocker다. TOCTOU로 패키지에 외부 파일이 새는 것을 막는다.
 *  - .agentlas 로컬 상태(경험 계보 experience-relations.jsonl 계열, CAS 마커,
 *    cloud-asset-state)는 절대 업로드되지 않고 베이스 패키지 해시도 흔들지 않는다.
 *  - 등록은 관측한 베이스 리비전(If-Match) 또는 명시적 새 생성(If-None-Match: "*")
 *    으로만 — 조용한 덮어쓰기 금지 (cas.cjs).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  CLOUD_MAX_TOTAL_BYTES,
  CLOUD_MAX_FILE_BYTES,
  CLOUD_MAX_FILES,
  CLOUD_PACKAGE_HASH_V1,
  CLOUD_PACKAGE_HASH_V2,
  CLOUD_RESTORE_MARKER_PATH,
  cloudSlug,
  sha,
  cloudCodePointPathOrder,
  cloudIsLocalExperienceLineagePath,
  cloudPortablePathKey,
  cloudPortableRelativePath,
  cloudPortablePathConflict,
  cloudPackageHashVersion,
  cloudHashPackage,
  normalizeCloudAssetDescriptor,
} = require("../hub/install.cjs");
const { SECRET_PATTERNS } = require("../agentlas-secret-patterns.cjs");
const { userDataDir } = require("../core/paths.cjs");
const state = require("./state.cjs");
const { cargoSearchAgents } = require("./cargo.cjs");
const cas = require("./cas.cjs");

const CLOUD_TEXT_EXTS = new Set([".cfg", ".cjs", ".conf", ".config", ".css", ".csv", ".env", ".html", ".ini", ".js", ".json", ".jsonl", ".md", ".mjs", ".properties", ".ps1", ".psd1", ".psm1", ".py", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"]);
const CLOUD_AGENT_FILES = new Set(["AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "README.md", "agent.md", "manifest.md", "system-prompt.md"]);
const CLOUD_SKIP_DIRS = new Set([".git", ".next", ".studio-runtime", ".turbo", "build", "coverage", "dist", "node_modules", "out", "release"]);
const CLOUD_BLOCKED_FILE_RE = [/^\.env(?:\..*)?$/i, /^id_rsa(?:\.pub)?$/i, /^credentials(?:\..*)?$/i, /^secrets?(?:\..*)?$/i, /^cloud-asset-state\.v1\.json$/i, /(?:^|[._-])service-account(?:[._-]|$)/i, /\.(?:key|pem|p12|pfx|mobileprovision)$/i];
const CLOUD_ROUTING_CARD_PATH = ".agentlas/routing-card.json";
const CLOUD_ROUTING_CARD_CAPABILITY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const CLOUD_ROUTING_CARD_STATUSES = new Set(["draft", "searchable", "candidate", "routing_ready", "trusted"]);
const CLOUD_SECRET_RE = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i, "private key material"],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{20,}\b/, "OpenAI-style API key"],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/, "GitHub token"],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/, "GitLab token"],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  ["npm-token", /\bnpm_[A-Za-z0-9]{30,}\b/, "npm access token"],
  ["stripe-secret", /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/, "Stripe secret key"],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, "Slack token"],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  ["generic-secret", /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{8,}['"]/i, "hard-coded credential"],
];

// ── 텍스트/credential 디코딩 ──

function cloudDecodeUtf16CredentialText(bytes) {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)).toString("utf16le");
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)));
    body.swap16();
    return body.toString("utf16le");
  }
  // BOM 없는 UTF-16 휴리스틱 — 짝수/홀수 바이트 NUL 비율로 엔디언 추정.
  const sampleLength = Math.min(bytes.length - (bytes.length % 2), 4096);
  if (sampleLength < 8) return null;
  let oddNuls = 0;
  let evenNuls = 0;
  for (let index = 0; index < sampleLength; index += 2) {
    if (bytes[index] === 0) evenNuls++;
    if (bytes[index + 1] === 0) oddNuls++;
  }
  const pairs = sampleLength / 2;
  const fullLength = bytes.length - (bytes.length % 2);
  if (oddNuls / pairs > 0.3) return bytes.subarray(0, fullLength).toString("utf16le");
  if (evenNuls / pairs > 0.3) {
    const body = Buffer.from(bytes.subarray(0, fullLength));
    body.swap16();
    return body.toString("utf16le");
  }
  return null;
}

function cloudDecodeTextAsset(bytes) {
  const utf16 = cloudDecodeUtf16CredentialText(bytes);
  if (utf16 !== null) return { ok: true, text: utf16 };
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

/** 값이 진짜 credential처럼 보이는가 — 플레이스홀더(${KEY}, changeme 등)는 통과시킨다. */
function cloudCredentialValueLooksReal(rawValue) {
  let value = String(rawValue || "").trim().replace(/^['"]|['"]$/g, "").trim();
  try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  if (value.length < 8) return false;
  if (/^(?:\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|\{\{[^}]+\}\}|<[^>]+>)$/i.test(value)) return false;
  if (/^(?:process\.env\.|os\.environ|env\(|secret\(|vault:)/i.test(value)) return false;
  const compact = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (/^(?:your|example|sample|dummy|placeholder|configure|configureonthismachine|changeme|replaceme|replacewith|redacted|masked|notareal|none|null|undefined|x+|star+)(?:api)?(?:key|secret|token|password)?(?:here)?$/.test(compact)) return false;
  if (/^(?:\*+|x+|_+|-+)$/.test(value)) return false;
  return true;
}

function cloudTextContainsStructuredCredential(text) {
  const assignment = /(?:^|\n)\s*["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password|passwd|pwd)["']?\s*[:=]\s*([^\r\n#;]+)/gi;
  for (const match of text.matchAll(assignment)) {
    if (cloudCredentialValueLooksReal(match[1])) return true;
  }
  const urlCredential = /\bhttps?:\/\/[^/\s:@]+:([^@\s/]{8,})@/gi;
  for (const match of text.matchAll(urlCredential)) {
    if (cloudCredentialValueLooksReal(match[1])) return true;
  }
  const queryCredential = /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|token|password)=([^&#\s]+)/gi;
  for (const match of text.matchAll(queryCredential)) {
    if (cloudCredentialValueLooksReal(match[1])) return true;
  }
  return false;
}

function cloudAddSecretFindingsFromBytes(bytes, relativePath, addFinding) {
  const candidates = new Set([bytes.toString("utf8")]);
  const utf16 = cloudDecodeUtf16CredentialText(bytes);
  if (utf16) candidates.add(utf16);
  for (const text of candidates) {
    for (const [id, re, label] of CLOUD_SECRET_RE) {
      if (re.test(text)) addFinding(id, "blocker", "secret", `Possible ${label} found in package content.`, relativePath, "Remove the value and require users to configure their own key.");
    }
    if (cloudTextContainsStructuredCredential(text)) {
      addFinding("generic-unquoted-secret", "blocker", "secret", "Possible unquoted or URL-embedded credential found in package content.", relativePath, "Replace the value with an environment/BYOK placeholder.");
    }
    // 공유 시크릿 패턴(agentlas-secret-patterns)도 같은 게이트에 태운다.
    // 단, 할당형(password: …, authorization: …) 매치는 값이 진짜처럼 보일 때만
    // blocker로 승격한다 — "password: configure_on_this_machine" 같은 플레이스홀더를
    // 오탐으로 막으면 패키징 게이트 자체가 불신받는다(content_guard 오탐 사고 계열).
    let sharedPatternHit = false;
    for (const re of SECRET_PATTERNS) {
      // 패턴에 g 플래그가 없으므로 전역 사본으로 모든 매치를 훑는다 — 첫 매치가
      // 플레이스홀더라고 같은 파일의 두 번째 진짜 키를 놓치면 안 된다.
      const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      for (const match of text.matchAll(globalRe)) {
        const matched = String(match[0] || "");
        const assignmentSplit = matched.match(/^[^:=]{0,40}[:=]\s*(.+)$/s);
        if (assignmentSplit && !cloudCredentialValueLooksReal(assignmentSplit[1])) continue;
        addFinding("shared-secret-pattern", "blocker", "secret", "Possible live credential (shared secret-pattern match) found in package content.", relativePath, "Remove the value and require users to configure their own key.");
        sharedPatternHit = true;
        break;
      }
      if (sharedPatternHit) break;
    }
  }
}

// ── 스냅샷 읽기 도우미 ──

function cloudPackageSnapshot(files) {
  return new Map(files.map((file) => [file.path, file]));
}

function cloudReadSnapshotText(snapshot, relativePath) {
  const file = snapshot.get(relativePath);
  return file ? Buffer.from(file.contentBase64, "base64").toString("utf8") : "";
}

function cloudReadSnapshotJson(snapshot, relativePath) {
  try {
    const parsed = JSON.parse(cloudReadSnapshotText(snapshot, relativePath));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function cloudReadPackageJson(snapshot) {
  return {
    agentlas: cloudReadSnapshotJson(snapshot, "agentlas.json"),
    manifest: cloudReadSnapshotJson(snapshot, "manifest.json"),
    agentCard: cloudReadSnapshotJson(snapshot, ".agentlas/agent-card.json"),
    routingCard: cloudReadSnapshotJson(snapshot, ".agentlas/routing-card.json"),
  };
}

function stringFirst(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function cloudReadFirst(snapshot, names, maxChars) {
  for (const name of names) {
    const text = cloudReadSnapshotText(snapshot, name);
    if (text) return text.slice(0, maxChars);
  }
  return "";
}

function cloudReadName(snapshot, fallbackName) {
  const manifest = cloudReadPackageJson(snapshot);
  const explicit = stringFirst(
    manifest.agentlas?.displayName,
    manifest.agentlas?.name,
    manifest.manifest?.name,
    manifest.agentCard?.name,
    manifest.routingCard?.name,
  );
  if (explicit) return explicit.replace(/\s+/g, " ").trim().slice(0, 80);
  const text = cloudReadFirst(snapshot, ["agent.md", "AGENT.md", "README.md", "CLAUDE.md", "AGENTS.md"], 2000);
  const heading = text.match(/^#\s+(.+)$/m);
  return (heading ? heading[1] : fallbackName).replace(/\s+/g, " ").trim().slice(0, 80);
}

function cloudReadTagline(snapshot) {
  const manifest = cloudReadPackageJson(snapshot);
  const explicit = stringFirst(
    manifest.agentlas?.summary,
    manifest.agentlas?.description,
    manifest.manifest?.description,
    manifest.agentCard?.summary,
    manifest.routingCard?.summary,
  );
  if (explicit) return explicit.replace(/\s+/g, " ").trim().slice(0, 160);
  const text = cloudReadFirst(snapshot, ["README.md", "agent.md", "AGENT.md"], 3000);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#") && !t.startsWith(">")) return t.slice(0, 160);
  }
  return "Portable Agentlas cloud agent package.";
}

/*
 * 공개 Hub 발행 이중 언어 메타데이터 게이트 — 데스크탑 package.ts:435-449 동형.
 * 데스크탑은 게이트 전에 연결된 모델로 자동 번역을 시도하지만(package.ts:428-434),
 * v2 터미널은 로컬 런타임 리뷰 계층이 아직 미배선이라(--llm-review 정직 정지와
 * 동일 계열) 번역 없이 게이트만 적용한다 — 조용한 무검증 발행보다 정직한 차단.
 */
function cloudCleanLocalizedField(value, max) {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max).trim()
    : "";
}

function cloudNormalizeLocalizedListing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const localized = {
    titleEn: cloudCleanLocalizedField(value.titleEn, 96),
    titleKo: cloudCleanLocalizedField(value.titleKo, 96),
    descriptionEn: cloudCleanLocalizedField(value.descriptionEn, 640),
    descriptionKo: cloudCleanLocalizedField(value.descriptionKo, 640),
  };
  return Object.values(localized).some(Boolean) ? localized : undefined;
}

function cloudReadLocalizedListing(snapshot) {
  const manifest = cloudReadPackageJson(snapshot);
  for (const source of [manifest.agentCard, manifest.agentlas, manifest.manifest, manifest.routingCard]) {
    const nested = cloudNormalizeLocalizedListing(source && source.localized);
    if (nested) return nested;
    const flat = cloudNormalizeLocalizedListing(source);
    if (flat) return flat;
  }
  return undefined;
}

// 데스크탑 localizedListingProblems(package.ts:1777-1794) 토씨 동일.
function cloudLocalizedListingProblems(value) {
  if (!value) return ["localized object missing"];
  const issues = [];
  if (!value.titleEn) issues.push("titleEn missing");
  if (!value.titleKo) issues.push("titleKo missing");
  if (!value.descriptionEn) issues.push("descriptionEn missing");
  if (!value.descriptionKo) issues.push("descriptionKo missing");
  if (/[가-힣]/.test(value.titleEn)) issues.push("titleEn contains Hangul");
  if (/[가-힣]/.test(value.descriptionEn)) issues.push("descriptionEn contains Hangul");
  if (
    value.descriptionEn
    && value.descriptionEn === value.descriptionKo
    && /[가-힣]/.test(value.descriptionKo)
  ) {
    issues.push("English description is not translated");
  }
  return issues;
}

function cloudReadStableSlug(snapshot) {
  const manifest = cloudReadPackageJson(snapshot);
  return stringFirst(
    manifest.agentlas?.slug,
    manifest.agentlas?.id,
    manifest.manifest?.package,
    manifest.manifest?.slug,
    manifest.agentCard?.slug,
    manifest.agentCard?.id,
    manifest.routingCard?.agent_card_ref?.slug,
  );
}

function cloudInferKind(snapshot) {
  const paths = [...snapshot.keys()];
  if (paths.some((file) => file === "TEAM.md" || file === "team.json" || /^(?:agents|team|departments|hr-departments)\//.test(file))) return "team";
  return "agent";
}

function cloudDetectRuntimeLabels(snapshot) {
  const paths = new Set(snapshot.keys());
  const labels = [];
  if (paths.has("CLAUDE.md") || [...paths].some((file) => file.startsWith(".claude/"))) labels.push("claude-code");
  if (paths.has("AGENTS.md")) labels.push("codex");
  if (paths.has("GEMINI.md")) labels.push("gemini");
  if (paths.has(".cursorrules") || [...paths].some((file) => file.startsWith(".cursor/"))) labels.push("cursor");
  return labels.length ? labels : ["generic"];
}

function cloudPackageDir(slug) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(userDataDir(), "cloud-agent-packages", `${slug}-${stamp}`);
}

// ── Windows 실행 비트 복원 ──
// Windows에는 모드 비트가 없으므로, 마지막 restore 마커의 executablePaths가
// 포터블 실행 비트의 진실이다. 이게 없으면 win32 재저장이 실행 비트를 전부
// 잃어 패키지 해시(v2)가 바뀐다.
function cloudReadRestoreExecutablePaths(rootPath) {
  if (process.platform !== "win32") return new Set();
  const marker = path.join(rootPath, CLOUD_RESTORE_MARKER_PATH);
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (cloudPackageHashVersion(parsed.packageHashVersion) !== CLOUD_PACKAGE_HASH_V2) return new Set();
    if (!Array.isArray(parsed.executablePaths)) return new Set();
    return new Set(parsed.executablePaths
      .filter((value) => cloudPortableRelativePath(value))
      .map((value) => cloudPortablePathKey(value)));
  } catch {
    return new Set();
  }
}

function cloudPortableExecutableForFile(relativePath, statMode, restoredExecutablePaths, platform = process.platform) {
  if (platform === "win32") return restoredExecutablePaths.has(cloudPortablePathKey(relativePath));
  return Boolean(statMode & 0o111);
}

// ── 폴더 스캔 (TOCTOU-안전) ──

function scanCloudFolder(rootPath) {
  const files = [];
  const included = [];
  const findings = [];
  const restoredExecutablePaths = cloudReadRestoreExecutablePaths(rootPath);
  let localPackageMarker = null;
  let totalBytes = 0;
  let count = 0;
  let hasDefinition = false;
  function addFinding(kind, severity, category, message, file, remediation) {
    findings.push({ id: `${kind}-${sha(file || message).slice(0, 10)}`, severity, category, message, ...(file ? { file } : {}), ...(remediation ? { remediation } : {}) });
  }
  function insideRoot(candidate) {
    const relative = path.relative(rootPath, candidate);
    return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }
  // no-follow open + 전/후 fstat/realpath 대조: 읽는 동안 파일이 바뀌면(스왑·append)
  // 무조건 실패한다. 캡처한 바이트와 디스크 상태가 다르면 패키지에 넣지 않는다.
  function readStableFile(file, rel) {
    const beforeReal = fs.realpathSync.native(file);
    if (!insideRoot(beforeReal)) throw new Error("file resolves outside the approved package root");
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const nonBlock = fs.constants.O_NONBLOCK || 0;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlock);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile()) throw new Error("package entry is not a regular file");
      if (before.size > CLOUD_MAX_FILE_BYTES) throw new Error(`file exceeds ${CLOUD_MAX_FILE_BYTES} bytes`);
      const chunks = [];
      let actualBytes = 0;
      for (;;) {
        const capacity = Math.min(64 * 1024, CLOUD_MAX_FILE_BYTES + 1 - actualBytes);
        if (capacity <= 0) throw new Error(`file exceeds ${CLOUD_MAX_FILE_BYTES} bytes`);
        const chunk = Buffer.allocUnsafe(capacity);
        const read = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (read === 0) break;
        actualBytes += read;
        if (actualBytes > CLOUD_MAX_FILE_BYTES) throw new Error(`file exceeds ${CLOUD_MAX_FILE_BYTES} bytes`);
        chunks.push(chunk.subarray(0, read));
      }
      const after = fs.fstatSync(fd);
      const afterReal = fs.realpathSync.native(file);
      const pathStat = fs.statSync(file);
      if (
        !insideRoot(afterReal) || beforeReal !== afterReal ||
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mode !== after.mode || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        after.dev !== pathStat.dev || after.ino !== pathStat.ino || after.mode !== pathStat.mode ||
        actualBytes !== after.size
      ) {
        throw new Error("package entry changed while it was being read");
      }
      return {
        bytes: Buffer.concat(chunks, actualBytes),
        executable: cloudPortableExecutableForFile(rel, after.mode, restoredExecutablePaths),
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  function walk(dir) {
    let directoryBefore;
    let directoryRealBefore;
    try {
      directoryBefore = fs.lstatSync(dir);
      directoryRealBefore = fs.realpathSync.native(dir);
      if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink() || !insideRoot(directoryRealBefore)) {
        throw new Error("directory is not stable inside the approved root");
      }
    } catch (error) {
      addFinding("unsafe-directory", "blocker", "policy", `Package directory could not be read safely: ${error.message || error}`, path.relative(rootPath, dir).split(path.sep).join("/"), "Remove linked or changing directories and retry.");
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      addFinding("unsafe-directory", "blocker", "policy", `Package directory could not be read safely: ${error.message || error}`, path.relative(rootPath, dir).split(path.sep).join("/"), "Remove linked or changing directories and retry.");
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith("._")) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootPath, abs).split(path.sep).join("/");
      if (cloudIsLocalExperienceLineagePath(rel)) {
        // 경험 계보는 로컬에서 재구축 가능한 별도 자산 — 절대 업로드되지 않고
        // 베이스 패키지 해시에도 참여하지 않는다.
        let bytes = 0;
        try { bytes = Number(fs.lstatSync(abs).size) || 0; } catch { /* excluded local state */ }
        files.push({ path: rel, bytes, sha256: "", kind: "text", included: false, reason: "experience-lineage-separate-asset" });
        continue;
      }
      if (cloudPortablePathKey(rel) === cloudPortablePathKey(CLOUD_RESTORE_MARKER_PATH)) {
        // 로컬 restore/CAS 메타데이터는 런타임 상태다 — 포터블 자산이 아니지만
        // 같은 no-follow 안정성 게이트로 캡처해 베이스 리비전으로 쓴다.
        if (entry.isSymbolicLink() || !entry.isFile()) {
          addFinding("unsafe-local-state", "blocker", "policy", "Agent Cloud local revision marker must be a stable regular file.", rel, "Remove the linked or special marker and restore/list the asset again.");
          continue;
        }
        try {
          const stableMarker = readStableFile(abs, rel);
          localPackageMarker = JSON.parse(stableMarker.bytes.toString("utf8"));
        } catch (error) {
          addFinding("invalid-local-state", "blocker", "policy", `Agent Cloud local revision marker could not be read safely: ${error.message || error}`, rel, "Repair or remove the marker, then restore/list the asset again.");
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        addFinding("symlink", "blocker", "policy", "Symbolic links are not allowed in cloud agent packages.", rel, "Replace the symlink with an ordinary file or remove it.");
        files.push({ path: rel, bytes: 0, sha256: "", kind: "binary", included: false, reason: "symlink-blocked" });
        continue;
      }
      if (entry.isDirectory()) {
        if (CLOUD_SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) {
        addFinding("unsupported-entry", "blocker", "policy", "Only stable ordinary files and directories are allowed in Cloud packages.", rel, "Remove sockets, FIFOs, devices, and other special filesystem entries.");
        files.push({ path: rel, bytes: 0, sha256: "", kind: "binary", included: false, reason: "unsupported-entry" });
        continue;
      }
      if (!cloudPortableRelativePath(rel)) {
        addFinding("unsafe-path", "blocker", "policy", "File path is not portable across supported hosts.", rel, "Rename the file to a Unicode NFC, relative, cross-platform-safe path.");
        files.push({ path: rel, bytes: 0, sha256: "", kind: "binary", included: false, reason: "unsafe-path" });
        continue;
      }
      count++;
      if (count > CLOUD_MAX_FILES) {
        addFinding("file-count-limit", "blocker", "size", `Package has more than ${CLOUD_MAX_FILES} files.`, "", "Publish a focused agent/team folder.");
        continue;
      }
      if (CLOUD_AGENT_FILES.has(entry.name)) hasDefinition = true;
      let hint;
      try { hint = fs.lstatSync(abs); } catch { hint = { size: 0 }; }
      if (CLOUD_BLOCKED_FILE_RE.some((re) => re.test(entry.name))) {
        addFinding("blocked-file", "blocker", "secret", "Secret-bearing file names are not allowed in cloud packages.", rel, "Remove credentials and publish only env key names.");
        files.push({ path: rel, bytes: Number(hint.size) || 0, sha256: "", kind: "binary", included: false, reason: "secret-file-blocked" });
        continue;
      }
      if (Number(hint.size) > CLOUD_MAX_FILE_BYTES) {
        addFinding("large-file", "blocker", "size", `File exceeds ${CLOUD_MAX_FILE_BYTES} bytes.`, rel, "Move large assets out of the package.");
        files.push({ path: rel, bytes: Number(hint.size), sha256: "", kind: "binary", included: false, reason: "file-too-large" });
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const isText = CLOUD_TEXT_EXTS.has(ext) || CLOUD_AGENT_FILES.has(entry.name);
      let stable;
      try {
        stable = readStableFile(abs, rel);
      } catch (error) {
        addFinding("unstable-file", "blocker", "policy", `Package file could not be read safely: ${error.message || error}`, rel, "Remove linked or concurrently changing files and retry.");
        files.push({ path: rel, bytes: Number(hint.size) || 0, sha256: "", kind: isText ? "text" : "binary", included: false, reason: "unstable-file" });
        continue;
      }
      const content = stable.bytes;
      const executable = stable.executable;
      totalBytes += content.length;
      const digest = sha(content);
      cloudAddSecretFindingsFromBytes(content, rel, addFinding);
      if (isText) {
        const decoded = cloudDecodeTextAsset(content);
        if (!decoded.ok) {
          addFinding("invalid-text-encoding", "blocker", "policy", "A text agent asset is not valid UTF-8 or BOM-marked UTF-16.", rel, "Save the file as UTF-8 or BOM-marked UTF-16 before packaging.");
          files.push({ path: rel, bytes: content.length, sha256: digest, kind: "text", executable, included: false, reason: "invalid-text-encoding" });
          continue;
        }
        const text = decoded.text;
        if (/(?:curl|wget)[^\n|&;]+[|]\s*(?:sh|bash)/i.test(text)) {
          addFinding("curl-pipe-shell", "high", "network", "Remote shell install pattern detected.", rel, "Use explicit, reviewable install steps.");
        }
      }
      files.push({ path: rel, bytes: content.length, sha256: digest, kind: isText ? "text" : "binary", executable, included: true });
      included.push({ path: rel, bytes: content.length, sha256: digest, executable, contentBase64: content.toString("base64") });
    }
    try {
      const directoryAfter = fs.lstatSync(dir);
      const directoryRealAfter = fs.realpathSync.native(dir);
      if (
        !directoryAfter.isDirectory() || directoryAfter.isSymbolicLink() || !insideRoot(directoryRealAfter) ||
        directoryRealBefore !== directoryRealAfter || directoryBefore.dev !== directoryAfter.dev ||
        directoryBefore.ino !== directoryAfter.ino || directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
        directoryBefore.ctimeMs !== directoryAfter.ctimeMs
      ) {
        throw new Error("directory changed while it was scanned");
      }
    } catch (error) {
      addFinding("unstable-directory", "blocker", "policy", `Package directory changed while it was scanned: ${error.message || error}`, path.relative(rootPath, dir).split(path.sep).join("/"), "Stop concurrent edits and retry.");
    }
  }
  walk(rootPath);
  const pathConflict = cloudPortablePathConflict(included.map((file) => file.path));
  if (pathConflict) {
    addFinding(pathConflict.code, "blocker", "policy", pathConflict.message, "", "Rename aliased paths so every file and ancestor directory has one portable identity.");
  }
  if (!hasDefinition) addFinding("missing-agent-definition", "blocker", "structure", "No agent definition file was found.", "", "Add AGENTS.md, CLAUDE.md, GEMINI.md, AGENT.md, or README.md at the package root.");
  if (totalBytes > CLOUD_MAX_TOTAL_BYTES) addFinding("package-size-limit", "blocker", "size", `Package exceeds ${CLOUD_MAX_TOTAL_BYTES} bytes.`, "", "Publish a smaller agent folder.");
  files.sort(cloudCodePointPathOrder);
  included.sort(cloudCodePointPathOrder);
  return { files, included, findings, totalBytes, localPackageMarker };
}

// ── 라우팅 카드 (공개 Hub 발행 전용 게이트) ──

function cloudRoutingCardFinding(id, message, remediation) {
  return {
    finding: {
      id,
      severity: "blocker",
      category: "structure",
      file: CLOUD_ROUTING_CARD_PATH,
      message,
      remediation,
    },
  };
}

function cloudRoutingCardProblem(card) {
  if (card.schemaVersion !== "routing-card/2.0") return "schemaVersion must be routing-card/2.0";
  if (typeof card.id !== "string" || !card.id.trim()) return "id must be a non-empty string";
  if (card.type !== "agent" && card.type !== "team" && card.type !== "plugin") return "type must be agent, team, or plugin";
  if (typeof card.name !== "string" || !card.name.trim()) return "name must be a non-empty string";
  if (typeof card.summary !== "string" || !card.summary.trim()) return "summary must be a non-empty string";
  if (card.summary.length > 240) return "summary must be at most 240 characters";
  if (!Array.isArray(card.capabilities) || card.capabilities.length === 0) return "capabilities must be a non-empty array";
  for (const capability of card.capabilities) {
    if (typeof capability !== "string" || !CLOUD_ROUTING_CARD_CAPABILITY_RE.test(capability)) {
      return `capability ${JSON.stringify(capability)} must be snake_case with at least two words`;
    }
  }
  if (typeof card.routing_status !== "string" || !CLOUD_ROUTING_CARD_STATUSES.has(card.routing_status)) {
    return "routing_status must be draft, searchable, candidate, routing_ready, or trusted";
  }
  const workforce = card.workforce;
  if (!workforce || typeof workforce !== "object" || Array.isArray(workforce)) {
    return "workforce must be a complete semantic resume";
  }
  // `skills` has a floor of 0, not 1. Skills are modules and live outside the
  // core, so a fully modular agent legitimately declares none. Requiring one
  // here would block publishing every modular package. Kept identical in
  // agentlas_desktop/electron/cloud-agents/package.ts — the two must not drift.
  const semanticLists = [
    ["communities", /^community:[a-z0-9][a-z0-9-]*$/, 1, 5],
    ["roles", /^role:[a-z0-9][a-z0-9-]*$/, 0, 4],
    ["skills", /^skill:[a-z0-9][a-z0-9-]*$/, 0, 12],
    ["knowledge", /^knowledge:[a-z0-9][a-z0-9-]*$/, 0, 256],
  ];
  for (const [field, pattern, minimum, maximum] of semanticLists) {
    const values = workforce[field];
    if (!Array.isArray(values) || values.length < minimum || values.length > maximum) {
      return `workforce.${field} must contain ${minimum}-${maximum} English semantic IDs`;
    }
    if (new Set(values).size !== values.length ||
        values.some((value) => typeof value !== "string" || !pattern.test(value))) {
      return `workforce.${field} contains an invalid or duplicate semantic ID`;
    }
  }
  for (const field of ["languages", "modalities"]) {
    const values = workforce[field];
    if (!Array.isArray(values) || new Set(values).size !== values.length ||
        values.some((value) => typeof value !== "string")) {
      return `workforce.${field} must be a unique string array`;
    }
  }
  return null;
}

function readCloudRoutingCard(snapshot) {
  const file = snapshot.get(CLOUD_ROUTING_CARD_PATH);
  if (!file) {
    return {
      finding: {
        id: "routing-card-required",
        severity: "blocker",
        category: "structure",
        file: CLOUD_ROUTING_CARD_PATH,
        message: "Cloud registration requires a Hephaestus Network routing card.",
        remediation: "Add .agentlas/routing-card.json before publishing. In Hephaestus packages, run the routing-card migration or package verifier.",
      },
    };
  }
  try {
    const parsed = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return cloudRoutingCardFinding("routing-card-invalid", "Routing card must be a JSON object.", "Replace .agentlas/routing-card.json with a routing-card/2.0 object.");
    }
    const problem = cloudRoutingCardProblem(parsed);
    if (problem) {
      return cloudRoutingCardFinding("routing-card-invalid", `Routing card is invalid: ${problem}`, "Fix .agentlas/routing-card.json before publishing.");
    }
    return { card: parsed };
  } catch {
    return cloudRoutingCardFinding("routing-card-invalid-json", "Routing card is not valid JSON.", "Fix .agentlas/routing-card.json before publishing.");
  }
}

// ── Career Graph 공개 카드 (redact 후에만 발행 패키지에 들어간다) ──

function cloudCareerFinding(id, category, message) {
  return {
    id,
    severity: "blocker",
    category,
    file: ".agentlas/public-career-card.json",
    message,
    remediation: "Regenerate a redacted aggregate-only public Career Graph card before publishing.",
  };
}

function cloudContainsAbsoluteLocalPath(value) {
  return (
    (os.homedir() && value.includes(os.homedir())) ||
    /(?:^|["'\s:(])\/(?:Users|home|var|tmp|private|Volumes|opt|etc)\//i.test(value) ||
    /(?:^|["'\s:(])[A-Za-z]:[\\/]/.test(value) ||
    /(?:^|["'\s:(])\\\\[^\\\s]+\\/.test(value)
  );
}

function cloudSanitizeCountRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, count] of Object.entries(value).slice(0, 200)) {
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(key) && Number.isSafeInteger(count) && count >= 0) result[key] = count;
  }
  return Object.keys(result).length ? result : undefined;
}

function cloudSanitizePublicCareerCard(parsed) {
  const card = { kind: "agentlas-public-career-card" };
  for (const [key, max] of [["schemaVersion", 80], ["generatedAt", 80], ["projectName", 200], ["indexStatus", 80], ["policy", 160]]) {
    if (typeof parsed[key] === "string" && parsed[key].length <= max) card[key] = parsed[key];
  }
  card.privacy = {
    rawLocalPathsIncluded: false,
    rawPromptsIncluded: false,
    rawTranscriptsIncluded: false,
    sourceTextIncluded: false,
  };
  for (const key of ["counts", "sourceKinds", "nodeTypes", "edgeTypes"]) {
    const safe = cloudSanitizeCountRecord(parsed[key]);
    if (safe) card[key] = safe;
  }
  for (const key of ["canonicalSources", "staleSourceCount"]) {
    if (Number.isSafeInteger(parsed[key]) && parsed[key] >= 0) card[key] = parsed[key];
  }
  return card;
}

function cloudReadPublicCareerCard(snapshot, findings) {
  const relativePath = ".agentlas/public-career-card.json";
  const file = snapshot.get(relativePath);
  if (!file) return undefined;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")); }
  catch {
    findings.push(cloudCareerFinding("career-card-invalid-json", "structure", "Career Graph public card is not valid JSON."));
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.kind !== "agentlas-public-career-card") {
    findings.push(cloudCareerFinding("career-card-invalid-kind", "structure", "Career Graph public card has an invalid kind."));
    return undefined;
  }
  const privacy = parsed.privacy && typeof parsed.privacy === "object" && !Array.isArray(parsed.privacy) ? parsed.privacy : {};
  for (const key of ["rawLocalPathsIncluded", "rawPromptsIncluded", "rawTranscriptsIncluded", "sourceTextIncluded"]) {
    if (privacy[key] !== false) findings.push(cloudCareerFinding(`career-card-privacy-${key}`, "policy", `Career Graph public card must set privacy.${key}=false.`));
  }
  if (cloudContainsAbsoluteLocalPath(JSON.stringify(parsed))) {
    findings.push(cloudCareerFinding("career-card-local-path", "policy", "Career Graph public card contains a local absolute path."));
  }
  if (findings.some((finding) => finding.severity === "blocker" && finding.id.startsWith("career-card-"))) return undefined;
  return cloudSanitizePublicCareerCard(parsed);
}

function cloudReplacePublicCareerCard(scan, card) {
  const relativePath = ".agentlas/public-career-card.json";
  const includedIndex = scan.included.findIndex((file) => file.path === relativePath);
  const existing = includedIndex >= 0 ? scan.included[includedIndex] : null;
  if (includedIndex >= 0) scan.included.splice(includedIndex, 1);
  const fileRecord = scan.files.find((file) => file.path === relativePath);
  if (!card) {
    // redact 실패 시 원본 카드는 절대 발행 패키지에 실리지 않는다.
    if (fileRecord) { fileRecord.included = false; fileRecord.reason = "public-career-card-blocked"; }
    return;
  }
  const bytes = Buffer.from(JSON.stringify(card, null, 2) + "\n", "utf8");
  const replacement = { path: relativePath, bytes: bytes.length, sha256: sha(bytes), contentBase64: bytes.toString("base64"), executable: false };
  scan.included.push(replacement);
  scan.included.sort(cloudCodePointPathOrder);
  scan.totalBytes += bytes.length - (existing?.bytes || 0);
  if (fileRecord) Object.assign(fileRecord, { bytes: bytes.length, sha256: replacement.sha256, kind: "text", executable: false, included: true, reason: undefined });
  else scan.files.push({ path: relativePath, bytes: bytes.length, sha256: replacement.sha256, kind: "text", executable: false, included: true });
}

// ── 리뷰/요약 ──

/** 개인 저장(save)에서는 구조 게이트(정의 문서/라우팅 카드)를 요구하지 않는다 — 보안·크기만. */
function privateCloudSafetyFindings(findings) {
  return findings.filter((finding) =>
    (finding.severity === "blocker" && !finding.id.startsWith("missing-agent-definition"))
    || finding.category === "secret"
    || finding.category === "size");
}

function cloudStaticReview(findings, scope = "hub-public") {
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const high = findings.filter((f) => f.severity === "high").length;
  return {
    mode: "static-only",
    verdict: blockers ? "fail" : high ? "needs-review" : "pass",
    costOwner: "none",
    summary: blockers || high
      ? `${blockers} blocker(s), ${high} high-risk finding(s).`
      : scope === "owner-private"
        ? "Private Agent Cloud safety checks passed."
        : "Static public package review passed.",
    findings,
    reviewedAt: new Date().toISOString(),
  };
}

function cloudSecuritySummary(findings) {
  const blockerCount = findings.filter((f) => f.severity === "blocker").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  return { verdict: blockerCount ? "fail" : highCount ? "needs-review" : "pass", blockerCount, highCount, findingCount: findings.length };
}

// ── 메인: 패키지(+등록) ──

/**
 * 이 계정이 소유한 자산의 현재 리비전을 서버에서 조회한다.
 * 로컬 관측 기록이 전혀 없는 새 PC/새 클론에서 갱신을 가능하게 하는 유일한 경로다.
 * 소유자 세션이 없거나 자산이 없으면 null — 조용한 폴백은 만들지 않는다.
 */
async function lookupOwnedCloudDescriptor(slug, scope) {
  let response;
  try {
    response = await cargoSearchAgents({ q: slug, limit: 20 });
  } catch {
    return null;
  }
  const rows = Array.isArray(response && response.results) ? response.results : [];
  const row = rows.find((item) => item && item.slug === slug && item.scope === scope);
  if (!row) return null;
  try {
    return normalizeCloudAssetDescriptor(row, "owner cloud search result");
  } catch {
    return null;
  }
}

async function packageCloudAgent(db, root, opts = {}) {
  const requestedRoot = path.resolve(root);
  let st;
  try { st = fs.lstatSync(requestedRoot); } catch { throw new Error(`Folder not found: ${root}`); }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Not a real directory: ${root}`);
  const rootPath = fs.realpathSync.native(requestedRoot);
  const visibility = opts.visibility || "private-link";
  const isPublicHubPublish = visibility === "marketplace";
  if (isPublicHubPublish && opts.llmReview) {
    // 정직 정지: v1의 로컬 런타임 LLM 리뷰(runCloudLocalReviewCli)는 아직 v2 실행
    // 계층에 배선되지 않았다. 조용히 static 리뷰로 다운그레이드해 "리뷰됨"으로
    // 위장하지 않는다 (no-facade 이주 정책).
    const error = new Error(
      "--llm-review is not wired into the v2 engine yet (v1 reference: git tag legacy-v1-engine-snapshot). " +
      "Publish runs the static security review; rerun without --llm-review.",
    );
    error.code = "AGENTLAS_V2_NOT_WIRED";
    throw error;
  }
  const scan = scanCloudFolder(rootPath);
  let snapshot = cloudPackageSnapshot(scan.included);
  let careerGraph;
  if (isPublicHubPublish) {
    careerGraph = cloudReadPublicCareerCard(snapshot, scan.findings);
    cloudReplacePublicCareerCard(scan, careerGraph);
    snapshot = cloudPackageSnapshot(scan.included);
  }
  const routingCard = isPublicHubPublish ? readCloudRoutingCard(snapshot) : {};
  if (routingCard.finding) scan.findings.push(routingCard.finding);
  if (isPublicHubPublish) {
    // 데스크탑 package.ts:435-449 동형: 공개 Hub 리스팅은 검증된 EN/KO 메타데이터 필수.
    const localizedProblems = cloudLocalizedListingProblems(cloudReadLocalizedListing(snapshot));
    if (localizedProblems.length > 0) {
      scan.findings.push({
        id: "localized-metadata-required",
        severity: "blocker",
        category: "structure",
        file: ".agentlas/agent-card.json",
        message: `Public Hub metadata needs verified English and Korean fields: ${localizedProblems.join(", ")}.`,
        remediation:
          "Add localized.titleEn, titleKo, descriptionEn, and descriptionKo to .agentlas/agent-card.json, or use local-runtime review so Agentlas can translate them with your connected model.",
      });
    }
  }
  const packageFindings = isPublicHubPublish ? scan.findings : privateCloudSafetyFindings(scan.findings);
  const name = cloudReadName(snapshot, path.basename(rootPath));
  const slug = cloudSlug(opts.slug || cloudReadStableSlug(snapshot) || name || path.basename(rootPath));
  const scope = cas.cloudScopeForVisibility(visibility);
  let baseDescriptor = state.cloudBaseDescriptorForSource(scan.localPackageMarker, rootPath, slug, scope);
  const packageHashVersion = CLOUD_PACKAGE_HASH_V2;
  const packageHash = cloudHashPackage(scan.included, packageHashVersion);
  const manifest = {
    version: "0.1",
    kind: "agentlas-cloud-agent",
    slug,
    name,
    tagline: cloudReadTagline(snapshot),
    agentKind: cloudInferKind(snapshot),
    runtimeLabels: cloudDetectRuntimeLabels(snapshot),
    visibility,
    // Content-derived and host-independent. Never persist an absolute local
    // path fingerprint into a portable Cloud package.
    rootFingerprint: sha(`agentlas-package-root:${packageHash}`),
    packageHash,
    packageHashVersion,
    fileCount: scan.files.length,
    includedFileCount: scan.included.length,
    totalBytes: scan.included.reduce((sum, file) => sum + file.bytes, 0),
    createdAt: new Date().toISOString(),
    billingMode: "static-only",
    costOwner: "none",
    security: cloudSecuritySummary(packageFindings),
    ...(careerGraph ? { careerGraph } : {}),
  };
  if (routingCard.card) manifest.routingCard = routingCard.card;
  const packageDir = cloudPackageDir(slug);
  fs.mkdirSync(packageDir, { recursive: true });
  const manifestPath = path.join(packageDir, "package.manifest.json");
  const bundlePath = path.join(packageDir, "package.bundle.json");
  const bundle = {
    manifest,
    files: scan.included,
    source: { packagedBy: "agentlas-cli", packagedAt: manifest.createdAt, costOwner: manifest.costOwner },
    ...(careerGraph ? { careerGraph } : {}),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
  const review = cloudStaticReview(packageFindings, isPublicHubPublish ? "hub-public" : "owner-private");
  const allFindings = [...packageFindings, ...review.findings.filter((f) => !packageFindings.some((s) => s.id === f.id))];
  manifest.security = cloudSecuritySummary(allFindings);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  fs.writeFileSync(bundlePath, JSON.stringify({ ...bundle, manifest }, null, 2) + "\n", "utf8");
  const blocked = review.verdict === "fail" || allFindings.some((f) => f.severity === "blocker");
  let registration = null;
  let status = blocked ? "blocked" : opts.dryRun ? "dry-run" : "ready";
  if (!blocked && !opts.dryRun) {
    // 자산의 정체성은 (로그인 계정, slug)다 — 어느 폴더에서 올리는지는 중요하지 않다.
    // 쓰기 전에 서버가 들고 있는 내 자산의 현재 버전을 조회해서:
    //   · 이 폴더에 기록이 없으면(새 PC, 새 클론) 그 버전을 기준으로 업데이트한다.
    //   · 이 폴더 기록이 서버보다 오래됐으면(다른 곳에서 먼저 올림) 덮어쓰기 전에 멈춘다.
    // 이것은 412 뒤의 자동 재시도가 아니라 쓰기 전 refresh다. 등록 자체는 여전히
    // 조회한 정확한 리비전에 대한 조건부 쓰기(If-Match)라 경합은 서버가 막는다.
    const remote = await lookupOwnedCloudDescriptor(slug, scope);
    if (!baseDescriptor && remote) {
      baseDescriptor = state.rememberCloudAssetDescriptor(remote, { sourceRoot: rootPath });
    } else if (baseDescriptor && remote && baseDescriptor.revision !== remote.revision) {
      if (opts.overwriteRemote) {
        baseDescriptor = state.rememberCloudAssetDescriptor(remote, { sourceRoot: rootPath });
      } else {
        const error = new Error(
          `업로드하지 않았습니다. "${slug}"에 더 새 버전이 있습니다 (${remote.updatedAt || "시각 미상"}에 다른 곳에서 저장됨).\n` +
          `  지금 폴더 내용으로 그 버전을 덮어쓰려면: --overwrite\n` +
          `  먼저 그 버전을 받아서 비교하려면:      agentlas cloud restore ${slug}\n` +
          `  (서버 cloudId ${remote.cloudId} · revision ${remote.revision})`,
        );
        error.code = "cloud_agent_revision_conflict";
        error.current = remote;
        throw error;
      }
    }
    registration = await cas.registerCloudAgent(manifest, bundlePath, review, visibility, { baseDescriptor });
    let descriptor;
    try {
      descriptor = state.rememberCloudAssetDescriptor(registration, { sourceRoot: rootPath });
    } catch (error) {
      // 서버에는 커밋됐는데 로컬 관측 상태를 못 남기면 다음 save가 stale 베이스로
      // 충돌한다 — 눈 감고 재시도하지 말라는 정직한 오류로 승격.
      const stateError = new Error(
        `Cloud save committed on the server, but this machine could not persist revision ${registration.revision}. ` +
        "Do not retry blindly; run `agentlas cloud list` and restore the asset before the next update. " +
        `Local state error: ${error.message || error}`,
      );
      stateError.code = "AGENTLAS_CLOUD_LOCAL_STATE_COMMIT_FAILED";
      stateError.receipt = registration;
      throw stateError;
    }
    try {
      state.writeCloudSourceMarker(rootPath, scan, descriptor, {
        previousMarker: scan.localPackageMarker,
        packageHash,
        packageHashVersion,
        fileCount: scan.included.length,
        totalBytes: manifest.totalBytes,
        executablePaths: packageHashVersion === CLOUD_PACKAGE_HASH_V2
          ? scan.included.filter((file) => file.executable).map((file) => file.path).sort()
          : undefined,
      });
    } catch (error) {
      registration.localStateWarning = `Cloud save succeeded, but the source marker could not be updated: ${error.message || error}`;
    }
    status = "registered";
  }
  return {
    status,
    rootPath,
    packageDir,
    manifestPath,
    bundlePath,
    manifest,
    files: scan.files,
    review,
    registration,
    summary: status === "registered"
      ? isPublicHubPublish
        ? `Published ${slug} publicly to Agentlas Hub.`
        : `Saved ${slug} privately in Agent Cloud.`
      : status === "blocked"
        ? isPublicHubPublish
          ? `Hub publish blocked: ${review.summary}`
          : `Private Agent Cloud save blocked: ${review.summary}`
        : isPublicHubPublish
          ? `Hub package ready: ${slug}.`
          : `Private Agent Cloud package ready: ${slug}.`,
  };
}

module.exports = {
  CLOUD_TEXT_EXTS,
  CLOUD_AGENT_FILES,
  CLOUD_SKIP_DIRS,
  CLOUD_BLOCKED_FILE_RE,
  CLOUD_ROUTING_CARD_PATH,
  CLOUD_SECRET_RE,
  cloudDecodeUtf16CredentialText,
  cloudDecodeTextAsset,
  cloudCredentialValueLooksReal,
  cloudTextContainsStructuredCredential,
  cloudAddSecretFindingsFromBytes,
  cloudPackageSnapshot,
  cloudReadName,
  cloudReadTagline,
  cloudReadLocalizedListing,
  cloudLocalizedListingProblems,
  cloudReadStableSlug,
  cloudInferKind,
  cloudDetectRuntimeLabels,
  cloudPackageDir,
  cloudReadRestoreExecutablePaths,
  cloudPortableExecutableForFile,
  scanCloudFolder,
  readCloudRoutingCard,
  cloudRoutingCardProblem,
  cloudReadPublicCareerCard,
  cloudReplacePublicCareerCard,
  cloudSanitizePublicCareerCard,
  privateCloudSafetyFindings,
  cloudStaticReview,
  cloudSecuritySummary,
  packageCloudAgent,
};
