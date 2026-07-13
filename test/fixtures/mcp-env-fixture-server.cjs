#!/usr/bin/env node
"use strict";

// The parent passes names and a non-secret isolated home only. Secret values
// are verified by presence inside this process and are never printed.

const readline = require("node:readline");

const allowedName = String(process.argv[2] || "");
const expectedHome = String(process.argv[3] || "");
const forbiddenNames = process.argv.slice(4).map(String);
if (!allowedName || !process.env[allowedName]) process.exit(41);
if (!expectedHome || process.env.HOME !== expectedHome) process.exit(42);
if (forbiddenNames.some((name) => Object.prototype.hasOwnProperty.call(process.env, name))) process.exit(43);

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === 1) {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "env-fixture", version: "1" } },
    })}\n`);
  } else if (message.id === 2) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\n`);
  }
});
