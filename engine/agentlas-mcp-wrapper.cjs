#!/usr/bin/env node
"use strict";

// Trusted Agentlas-owned hop between an authenticated provider CLI and an MCP
// server. Never print the descriptor or inherited environment: either can
// reveal private local metadata even though credential values are not encoded.

const { spawn } = require("node:child_process");
const { buildMcpChildEnv, decodeLaunchDescriptor } = require("./agentlas-mcp-env.cjs");

const CHILD_SHUTDOWN_GRACE_MS = 5_000;

function fail(code) {
  process.stderr.write(`agentlas MCP wrapper: ${code}\n`);
  process.exitCode = 1;
}

let descriptor;
try {
  if (process.argv.length !== 3) throw new Error("invalid wrapper arguments");
  descriptor = decodeLaunchDescriptor(process.argv[2]);
}
catch { fail("invalid_launch_descriptor"); }

if (descriptor) {
  let child;
  try {
    child = spawn(descriptor.command, descriptor.args, {
      cwd: process.cwd(),
      env: buildMcpChildEnv(process.env, descriptor.credentialKeyNames, {
        runtimeHome: descriptor.runtimeHome,
      }),
      detached: process.platform !== "win32",
      stdio: ["inherit", "inherit", "inherit"],
      windowsHide: true,
    });
  } catch {
    fail("child_spawn_failed");
  }

  if (child) {
    let terminationSignal = null;
    let shutdownTimer = null;
    const clearShutdownTimer = () => {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      shutdownTimer = null;
    };
    const terminateChild = (signal) => {
      const pid = Number(child.pid);
      if (process.platform !== "win32" && Number.isInteger(pid) && pid > 1) {
        try { process.kill(-pid, signal); return; } catch { /* fall through */ }
      }
      try { child.kill(signal); } catch { /* child already stopped */ }
    };
    const relay = (signal) => {
      if (terminationSignal) {
        terminateChild("SIGKILL");
        return;
      }
      terminationSignal = signal;
      terminateChild(signal);
      shutdownTimer = setTimeout(() => {
        terminateChild("SIGKILL");
      }, CHILD_SHUTDOWN_GRACE_MS);
      if (typeof shutdownTimer.unref === "function") shutdownTimer.unref();
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      try { process.on(signal, () => relay(signal)); } catch { /* unavailable on this platform */ }
    }
    child.once("error", () => {
      clearShutdownTimer();
      fail("child_spawn_failed");
    });
    child.once("close", (code, signal) => {
      clearShutdownTimer();
      if (terminationSignal || signal) {
        process.exitCode = 1;
        return;
      }
      process.exitCode = Number.isInteger(code) ? code : 1;
    });
  }
}
