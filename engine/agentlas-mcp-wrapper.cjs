#!/usr/bin/env node
"use strict";

// Trusted Agentlas-owned hop between an authenticated provider CLI and an MCP
// server. Never print the descriptor or inherited environment: either can
// reveal private local metadata even though credential values are not encoded.

const { spawn } = require("node:child_process");
const { buildMcpChildEnv, decodeLaunchDescriptor } = require("./agentlas-mcp-env.cjs");

function fail(code) {
  process.stderr.write(`agentlas MCP wrapper: ${code}\n`);
  process.exitCode = 1;
}

let descriptor;
try { descriptor = decodeLaunchDescriptor(process.argv[2]); }
catch { fail("invalid_launch_descriptor"); }

if (descriptor) {
  let child;
  try {
    child = spawn(descriptor.command, descriptor.args, {
      cwd: process.cwd(),
      env: buildMcpChildEnv(process.env, descriptor.credentialKeyNames, {
        runtimeHome: descriptor.runtimeHome,
      }),
      stdio: ["inherit", "inherit", "inherit"],
      windowsHide: true,
    });
  } catch {
    fail("child_spawn_failed");
  }

  if (child) {
    const relay = (signal) => {
      try { child.kill(signal); } catch { /* child already stopped */ }
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      try { process.on(signal, () => relay(signal)); } catch { /* unavailable on this platform */ }
    }
    child.once("error", () => fail("child_spawn_failed"));
    child.once("close", (code, signal) => {
      if (signal) {
        process.exitCode = 1;
        return;
      }
      process.exitCode = Number.isInteger(code) ? code : 1;
    });
  }
}
