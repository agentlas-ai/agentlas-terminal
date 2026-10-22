#!/usr/bin/env node
"use strict";
/*
 * verify-desktop-core-pin — the Desktop core Terminal runs must not be older than the pinned Desktop commit.
 *
 * Terminal reuses Desktop's compiled core (engine/core/desktop-core.cjs). An installed CLI downloads the core named by
 * engine/vendor/desktop-core.manifest.json; a development checkout may also carry engine/vendor/desktop-core/. Both must
 * be built from scripts/desktop-core-pin.json `desktopCommit` or a descendant of it, proven by git ancestry in the
 * Desktop repository. A gate that cannot measure fails: an unknown commit, a missing Desktop repository or a vendored
 * core with no recorded source commit is a failure, not a pass.
 *
 * How the core's commit is found:
 *   1. `desktopSourceCommit` (written by build-core-snapshot.cjs into VENDORED.json, and by
 *      write-desktop-core-manifest.cjs --desktop-source-commit into the manifest);
 *   2. for the manifest only, `desktopCompatibleRelease` resolved as a tag in the Desktop repository.
 *
 * Overrides (for contract tests and release machines): AGENTLAS_DESKTOP_REPO, AGENTLAS_CORE_PIN_FILE,
 * AGENTLAS_CORE_MANIFEST, AGENTLAS_CORE_VENDORED.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const desktopRepo = process.env.AGENTLAS_DESKTOP_REPO || path.resolve(root, "..", "agentlas_desktop");
const pinFile = process.env.AGENTLAS_CORE_PIN_FILE || path.join(__dirname, "desktop-core-pin.json");
const manifestFile = process.env.AGENTLAS_CORE_MANIFEST || path.join(root, "engine", "vendor", "desktop-core.manifest.json");
const vendoredFile = process.env.AGENTLAS_CORE_VENDORED || path.join(root, "engine", "vendor", "desktop-core", "VENDORED.json");
const FULL_SHA = /^[0-9a-f]{40}$/;
const TAG = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const failures = [];
const fail = (message) => failures.push(message);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function git(args) {
  return spawnSync("git", ["-C", desktopRepo, ...args], { encoding: "utf8" });
}

function commitExists(sha) {
  return git(["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

function resolveTag(tag) {
  const result = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  const sha = String(result.stdout || "").trim();
  return result.status === 0 && FULL_SHA.test(sha) ? sha : null;
}

/** 0 = descends from (or equals) the pin, 1 = older/unrelated, null = cannot measure. */
function descendsFromPin(sha, pin) {
  if (sha === pin) return 0;
  if (!commitExists(sha) || !commitExists(pin)) return null;
  const result = git(["merge-base", "--is-ancestor", pin, sha]);
  return result.status === 0 ? 0 : result.status === 1 ? 1 : null;
}

function verifyCore(label, sourceCommit, release, pin) {
  let sha = typeof sourceCommit === "string" ? sourceCommit.trim().toLowerCase() : "";
  let basis = "desktopSourceCommit";
  if (!sha && typeof release === "string" && TAG.test(release.trim())) {
    sha = resolveTag(release.trim()) || "";
    basis = `desktopCompatibleRelease ${release.trim()}`;
    if (!sha) {
      fail(`${label}: cannot prove its age — release tag ${release.trim()} is not in ${desktopRepo}.`);
      return;
    }
  }
  if (!FULL_SHA.test(sha)) {
    fail(`${label}: cannot prove its age — no desktopSourceCommit (40-hex) was recorded for it.`);
    return;
  }
  const verdict = descendsFromPin(sha, pin);
  if (verdict === null) {
    fail(`${label}: cannot prove its age — ${sha.slice(0, 12)} (${basis}) or the pin is not a commit in ${desktopRepo}.`);
  } else if (verdict === 1) {
    fail(`${label} (${sha.slice(0, 12)}, ${basis}) is older than the pinned Desktop commit ${pin.slice(0, 12)}.`);
  } else {
    console.log(`ok ${label}: ${sha.slice(0, 12)} (${basis}) descends from the pinned Desktop commit ${pin.slice(0, 12)}`);
  }
}

function main() {
  let pin;
  try {
    const pinned = readJson(pinFile);
    pin = String(pinned.desktopCommit || "").trim().toLowerCase();
  } catch (error) {
    fail(`cannot read the Desktop core pin ${pinFile}: ${error.message}`);
  }
  if (pin !== undefined && !FULL_SHA.test(pin)) fail(`the Desktop core pin must be a full 40-hex commit, got "${pin}".`);
  if (!fs.existsSync(path.join(desktopRepo, ".git")) && git(["rev-parse", "--git-dir"]).status !== 0) {
    fail(`cannot measure: the Desktop repository is not at ${desktopRepo} (set AGENTLAS_DESKTOP_REPO).`);
  }
  if (!failures.length) {
    let manifest = null;
    try { manifest = readJson(manifestFile); } catch (error) { fail(`cannot read ${manifestFile}: ${error.message}`); }
    if (manifest) verifyCore("manifest core (what installs download)", manifest.desktopSourceCommit, manifest.desktopCompatibleRelease, pin);
    if (fs.existsSync(vendoredFile)) {
      let vendored = null;
      try { vendored = readJson(vendoredFile); } catch (error) { fail(`cannot read ${vendoredFile}: ${error.message}`); }
      if (vendored) verifyCore("local vendored core (engine/vendor/desktop-core)", vendored.desktopSourceCommit, null, pin);
    }
  }
  if (failures.length) {
    for (const message of failures) console.error(`✖ ${message}`);
    console.error("  Re-vendor the Desktop core from the pinned commit or later (procedure: build-core-snapshot.cjs, then");
    console.error("  write-desktop-core-manifest.cjs --desktop-source-commit <sha>). The pin only moves forward, to the commit being vendored.");
    process.exit(1);
  }
  console.log("desktop-core pin ok");
}

main();
