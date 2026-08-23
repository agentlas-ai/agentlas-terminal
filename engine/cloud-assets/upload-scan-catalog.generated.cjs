// ⚠️ GENERATED FILE — do not hand-edit; the next generation erases your change.
// 정본: agentlas/AgentsAtlas/app/src/lib/agentlas-cloud/upload-scan-catalog.json
// 생성: (agentlas/AgentsAtlas/app) node scripts/gen-upload-scan-catalog.mjs
//
// Cloud-agent upload + secret-scan catalog. Three products used to restate
// this by hand and drifted; the server-side scan was the one that lost.

"use strict";

const SECRET_SCAN_TEXT_EXTENSIONS = Object.freeze([
  ".bat",
  ".cfg",
  ".cjs",
  ".cmd",
  ".conf",
  ".config",
  ".css",
  ".csv",
  ".env",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".md",
  ".mjs",
  ".properties",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const UPLOAD_SKIP_DIRECTORIES = Object.freeze([
  ".git",
  ".next",
  ".studio-runtime",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
]);

const AGENT_DEFINITION_FILES = Object.freeze([
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "agent.md",
  "manifest.md",
  "system-prompt.md",
  "system.md",
  "soul.md",
  "prompt.md",
  "persona.md",
]);

const UPLOAD_AGENT_DEFINITION_FILES = Object.freeze([
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "agent.md",
  "manifest.md",
  "system-prompt.md",
]);

const FOLDER_SCAN_AGENT_DEFINITION_FILES = Object.freeze([
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "agent.md",
  "manifest.md",
  "system-prompt.md",
  "system.md",
  "soul.md",
  "prompt.md",
  "persona.md",
]);

const PACKAGE_MAX_TOTAL_BYTES = 10485760;
const PACKAGE_MAX_FILE_BYTES = 2097152;
const PACKAGE_MAX_UNCOMPRESSED_TOTAL_BYTES = 41943040;
const PACKAGE_MAX_UNCOMPRESSED_FILE_BYTES = 8388608;
const PACKAGE_MAX_FILES = 400;
const PACKAGE_MAX_REQUEST_BYTES = 15728640;

module.exports = {
  SECRET_SCAN_TEXT_EXTENSIONS,
  UPLOAD_SKIP_DIRECTORIES,
  AGENT_DEFINITION_FILES,
  UPLOAD_AGENT_DEFINITION_FILES,
  FOLDER_SCAN_AGENT_DEFINITION_FILES,
  PACKAGE_MAX_TOTAL_BYTES,
  PACKAGE_MAX_FILE_BYTES,
  PACKAGE_MAX_UNCOMPRESSED_TOTAL_BYTES,
  PACKAGE_MAX_UNCOMPRESSED_FILE_BYTES,
  PACKAGE_MAX_FILES,
  PACKAGE_MAX_REQUEST_BYTES,
};
