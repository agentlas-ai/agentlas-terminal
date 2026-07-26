#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const terminal = require("../engine/sessions/prompt.cjs");

const emptyDb = {
  prepare() {
    return { get: () => null, all: () => [] };
  },
};

assert.equal(
  terminal.approximatePromptTokens(terminal.TERMINAL_MEMORY_CORE) <= terminal.TERMINAL_MEMORY_CORE_MAX_TOKENS,
  true,
  "the real UTF-8/3 always-on memory block must stay within 150 tokens",
);

const ordinary = terminal.memoryEmitterPromptFor("write a compact product report");
assert.equal(ordinary, terminal.TERMINAL_MEMORY_CORE);
assert.doesNotMatch(ordinary, /request_context|Local Credential Index/);

const memoryTask = terminal.memoryEmitterPromptFor("remember this decision in project memory");
assert.notEqual(memoryTask, terminal.TERMINAL_MEMORY_CORE);
assert.match(memoryTask, /request_context/);
assert.doesNotMatch(memoryTask, /Local Credential Index/, "credential lookup must not remain in the full memory schema");

assert.equal(terminal.credentialIndexReminderFor("write a product report"), "");
assert.match(terminal.credentialIndexReminderFor("deploy the API with OAuth credentials"), /Local Credential Index/);

const base = "BASE_AGENT_INSTRUCTIONS_MUST_STAY_EXACT";
const ordinarySystem = terminal.augmentSystem(emptyDb, base, { projectPath: null, lang: "en" }, true, "write a compact product report");
assert.match(ordinarySystem, new RegExp(base));
assert.match(ordinarySystem, /## Memory/);
assert.doesNotMatch(ordinarySystem, /request_context|Local Credential Index/);
const injectedCore = ordinarySystem.slice(ordinarySystem.lastIndexOf("## Memory"));
assert.equal(terminal.approximatePromptTokens(injectedCore) <= 150, true, "the actual assembled ordinary API path exceeded core150");

const memorySystem = terminal.augmentSystem(emptyDb, base, { projectPath: null, lang: "en" }, true, "기억해 이 결정을 메모리에 기록해");
assert.match(memorySystem, /request_context/);

const credentialSystem = terminal.augmentSystem(emptyDb, base, { projectPath: null, lang: "en" }, true, "deploy API auth credentials");
assert.match(credentialSystem, /Local Credential Index/);
assert.doesNotMatch(credentialSystem, /Add "request_context"/, "credential work alone must not load the full memory schema");

console.log(JSON.stringify({
  ok: true,
  checks: 14,
  coreApproxTokens: terminal.approximatePromptTokens(terminal.TERMINAL_MEMORY_CORE),
}, null, 2));
