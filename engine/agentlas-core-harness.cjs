"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { compareSemVer, normalizeSemVer } = require("./semver.cjs");

const HARNESS_SCHEMA_VERSION = "agentlas.stormbreaker.goal-ultracode-harness.v1";
const HARNESS_ID = "agentlas-core/stormbreaker-goal-ultracode";
const HARNESS_MODE = "stormbreaker-goal-ultracode";
const CONTEXT_MAP_MIN_CORE_VERSION = "1.1.86";
const CORE_MANIFEST_MAX_BYTES = 64 * 1024;
const CORE_RUNTIME_MARKERS = [
  ["agentlas_cloud", "__main__.py"],
  ["schemas", "workforce-work-order.schema.json"],
  ["schemas", "workforce-selection.schema.json"],
];

const PY_BOOTSTRAP =
  "import os, runpy, sys; " +
  'cwd=os.getcwd(); root=os.environ["HEPHAESTUS_RUNTIME_ROOT"]; ' +
  'sys.path=[p for p in sys.path if p not in ("", cwd, root)]; ' +
  "sys.path.insert(0, root); " +
  "sys.argv=sys.argv[1:]; " +
  'runpy.run_module(sys.argv[0], run_name="__main__", alter_sys=True)';

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(String(value))))];
}

function runtimeRoots(explicitRoot) {
  if (explicitRoot) return unique([explicitRoot]);
  const binRoot = process.env.HEPHAESTUS_BIN
    ? path.dirname(path.dirname(path.resolve(process.env.HEPHAESTUS_BIN)))
    : null;
  const roots = [
    process.env.HEPHAESTUS_RUNTIME_ROOT,
    binRoot,
    path.join(os.homedir(), ".agentlas", "runtime", "current"),
  ];
  // Monorepo/development parity with Desktop's signed-bundle candidate.
  roots.push(path.resolve(__dirname, "..", "..", "agentlas_desktop", "Hephaestus"));
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "Hephaestus"));
  if (process.platform === "darwin") roots.push("/Applications/Agentlas.app/Contents/Resources/Hephaestus");
  return unique(roots);
}

function readCoreRuntimeVersion(root) {
  const jsonCandidates = [
    path.join(root, "manifest.json"),
    path.join(root, "host_adapters", "manifest.json"),
  ];
  for (const manifestPath of jsonCandidates) {
    try {
      const stat = fs.statSync(manifestPath);
      if (!stat.isFile() || stat.size > CORE_MANIFEST_MAX_BYTES) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const version = normalizeSemVer(String(manifest.version || ""));
      if (version) return version;
    } catch {
      // Try the next bounded local manifest.
    }
  }
  try {
    const releasePath = path.join(root, "RELEASE");
    const stat = fs.statSync(releasePath);
    if (stat.isFile() && stat.size <= 256) {
      return normalizeSemVer(fs.readFileSync(releasePath, "utf8").trim());
    }
  } catch {
    // A legacy runtime may not publish RELEASE metadata.
  }
  return null;
}

function resolveCoreRuntimeRootFromCandidates(candidateRoots, requiredMarkers = [], options = {}) {
  const markers = [...CORE_RUNTIME_MARKERS, ...requiredMarkers];
  const minVersion = options.minVersion ? normalizeSemVer(String(options.minVersion)) : null;
  if (options.minVersion && !minVersion) throw new Error(`Invalid minimum Core version: ${options.minVersion}`);
  const eligible = [];
  for (const root of unique(candidateRoots)) {
    try {
      if (!markers.every((segments) => fs.existsSync(path.join(root, ...segments)))) continue;
      const version = readCoreRuntimeVersion(root);
      if (minVersion && (!version || compareSemVer(version, minVersion) < 0)) continue;
      // `~/.agentlas/runtime/current` 는 업데이터가 원자적으로 갈아 끼우는 심볼릭
      // 링크다. 그 경로를 그대로 넘기면 Python 이 import 를 늦게 해석하는 특성상,
      // 긴 실행 도중 업데이트가 일어나면 **옛 버전 모듈과 새 버전 모듈이 한 프로세스에
      // 섞여 로드된다** — 어떤 버전에서도 시험된 적 없는 조합이고 버전 번호로는
      // 재현조차 못 한다(감사 D3).
      //
      // 실경로로 고정해도 라이브 버전 선택은 그대로다: **다음** 호출이 다시 해석해
      // 새 릴리스를 집는다. 없어지는 것은 실행 중 교체뿐이다.
      let pinned = root;
      try { pinned = fs.realpathSync(root); } catch {}
      eligible.push({ root: pinned, version });
    } catch {
      // Continue to the next installed/bundled root.
    }
  }
  // Desktop and Terminal must attach to the same newest valid Core. Candidate
  // order is only a tie-breaker; an older managed runtime may never shadow a
  // newer signed Desktop bundle after an app update.
  eligible.sort((left, right) => {
    if (!left.version && !right.version) return 0;
    if (!left.version) return 1;
    if (!right.version) return -1;
    return compareSemVer(right.version, left.version);
  });
  return eligible[0]?.root ?? null;
}

function resolveCoreRuntimeRoot(explicitRoot, requiredMarkers = [], options = {}) {
  return resolveCoreRuntimeRootFromCandidates(runtimeRoots(explicitRoot), requiredMarkers, options);
}

function pythonCandidates() {
  return [...new Set([
    process.env.HEPHAESTUS_PYTHON,
    process.env.PYTHON,
    ...(process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python", "py"]),
  ].filter(Boolean))];
}

function pythonInvocation(executable) {
  const basename = path.basename(String(executable)).toLowerCase();
  return {
    executable,
    prefix: basename === "py" || basename === "py.exe" ? ["-3"] : [],
  };
}

function resolvePython() {
  for (const candidate of pythonCandidates()) {
    const invocation = pythonInvocation(candidate);
    try {
      const probe = spawnSync(
        invocation.executable,
        [...invocation.prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"],
        { stdio: "ignore", windowsHide: true },
      );
      if (probe.status === 0) return invocation;
    } catch {
      // Continue to the next candidate.
    }
  }
  return null;
}

function spawnCoreModule(moduleName, args, opts = {}, explicitRoot) {
  const root = resolveCoreRuntimeRoot(explicitRoot);
  const python = resolvePython();
  if (!root || !python) return null;
  return spawn(
    python.executable,
    [...python.prefix, "-c", PY_BOOTSTRAP, moduleName, ...args],
    {
      ...opts,
      windowsHide: true,
      env: {
        ...(opts.env || process.env),
        HEPHAESTUS_RUNTIME_ROOT: root,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
    },
  );
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function validateCoreStormbreakerHarness(harness) {
  if (
    !harness ||
    harness.schema_version !== HARNESS_SCHEMA_VERSION ||
    harness.harness_id !== HARNESS_ID ||
    harness.mode !== HARNESS_MODE ||
    typeof harness.system_prompt !== "string" ||
    !harness.system_prompt.trim() ||
    typeof harness.prompt_sha256 !== "string"
  ) {
    throw new Error("Agentlas Core returned an invalid Stormbreaker harness contract.");
  }
  const digest = crypto.createHash("sha256").update(harness.system_prompt, "utf8").digest("hex");
  if (digest !== harness.prompt_sha256) {
    throw new Error("Agentlas Core Stormbreaker harness failed its SHA-256 integrity check.");
  }
  if (
    harness.system_prompt.split("GOAL MODE:").length - 1 !== 1 ||
    harness.system_prompt.split("ULTRACODE MODE:").length - 1 !== 1
  ) {
    throw new Error("Agentlas Core Stormbreaker harness must contain exactly one Goal mode and one UltraCode mode.");
  }
  return harness;
}

async function captureCoreJson(moduleName, args, opts = {}, explicitRoot) {
  const child = spawnCoreModule(moduleName, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }, explicitRoot);
  if (!child) throw new Error("Agentlas Core runtime or Python 3.9+ is unavailable.");
  const result = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: String(error.message) }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
  const json = parseJsonOutput(result.stdout);
  if (result.code !== 0 || !json) {
    throw new Error(result.stderr.trim() || `Agentlas Core ${moduleName} did not return JSON.`);
  }
  return json;
}

function captureCoreJsonSync(moduleName, args, opts = {}, explicitRoot) {
  const root = resolveCoreRuntimeRoot(explicitRoot);
  const python = resolvePython();
  if (!root || !python) throw new Error("Agentlas Core runtime or Python 3.9+ is unavailable.");
  const result = spawnSync(
    python.executable,
    [...python.prefix, "-c", PY_BOOTSTRAP, moduleName, ...args],
    {
      ...opts,
      encoding: "utf8",
      windowsHide: true,
      timeout: opts.timeout || 120_000,
      env: {
        ...(opts.env || process.env),
        HEPHAESTUS_RUNTIME_ROOT: root,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
    },
  );
  const json = parseJsonOutput(result.stdout);
  if (result.status !== 0 || !json) {
    throw new Error(String(result.stderr || result.error?.message || `Agentlas Core ${moduleName} did not return JSON.`).trim());
  }
  return json;
}

async function loadCoreStormbreakerHarness(cwd, explicitRoot) {
  const harness = await captureCoreJson(
    "agentlas_cloud",
    ["stormbreaker", "harness"],
    { cwd },
    explicitRoot,
  );
  return validateCoreStormbreakerHarness(harness);
}

module.exports = {
  HARNESS_SCHEMA_VERSION,
  HARNESS_ID,
  HARNESS_MODE,
  CONTEXT_MAP_MIN_CORE_VERSION,
  PY_BOOTSTRAP,
  readCoreRuntimeVersion,
  resolveCoreRuntimeRootFromCandidates,
  resolveCoreRuntimeRoot,
  resolvePython,
  spawnCoreModule,
  parseJsonOutput,
  validateCoreStormbreakerHarness,
  captureCoreJson,
  captureCoreJsonSync,
  loadCoreStormbreakerHarness,
};
