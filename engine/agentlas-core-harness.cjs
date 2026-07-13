"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const HARNESS_SCHEMA_VERSION = "agentlas.stormbreaker.goal-ultracode-harness.v1";
const HARNESS_ID = "agentlas-core/stormbreaker-goal-ultracode";
const HARNESS_MODE = "stormbreaker-goal-ultracode";

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
  const binRoot = process.env.HEPHAESTUS_BIN
    ? path.dirname(path.dirname(path.resolve(process.env.HEPHAESTUS_BIN)))
    : null;
  const roots = [
    explicitRoot,
    process.env.HEPHAESTUS_RUNTIME_ROOT,
    binRoot,
    path.join(os.homedir(), ".agentlas", "runtime", "current"),
  ];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "Hephaestus"));
  if (process.platform === "darwin") roots.push("/Applications/Agentlas.app/Contents/Resources/Hephaestus");
  return unique(roots);
}

function resolveCoreRuntimeRoot(explicitRoot) {
  for (const root of runtimeRoots(explicitRoot)) {
    try {
      if (fs.existsSync(path.join(root, "agentlas_cloud", "__main__.py"))) return root;
    } catch {
      // Continue to the next installed/bundled root.
    }
  }
  return null;
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
  PY_BOOTSTRAP,
  resolveCoreRuntimeRoot,
  resolvePython,
  spawnCoreModule,
  parseJsonOutput,
  validateCoreStormbreakerHarness,
  captureCoreJson,
  captureCoreJsonSync,
  loadCoreStormbreakerHarness,
};
