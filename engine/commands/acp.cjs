"use strict";
/*
 * acp — run Agentlas as an Agent Client Protocol agent on stdio (PRD 2026-08-15 B-3).
 *
 *   agentlas acp            start the ACP v1 agent server (stdin/stdout are the wire)
 *   agentlas acp --info     print the registry-style descriptor and exit
 *
 * Register in an ACP client (Zed settings.json example):
 *   "agent_servers": { "Agentlas": { "command": "agentlas", "args": ["acp"] } }
 * JetBrains / other clients: same command + args. The client then runs Agentlas'
 * project controller on the runtime you subscribe to — no keys leave your machine.
 */
const { AcpAgentServer, PROTOCOL_VERSION } = require("../acp/server.cjs");

function descriptor() {
  let version = "0.0.0";
  try { version = require("../../package.json").version || version; } catch { /* keep */ }
  return {
    id: "agentlas",
    name: "Agentlas",
    version,
    description: "Agentlas project controller over ACP — runs on the coding runtime you already subscribe to (Claude Code, Codex, Antigravity, ACP agents).",
    protocolVersion: PROTOCOL_VERSION,
    distribution: { npm: { package: `agentlas@${version}`, args: ["acp"] } },
    authMethods: [],
    capabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
  };
}

async function run(ctx, args) {
  const descriptorMode = ctx.output?.format === "json" || (args.length === 1 && ["--info", "--json"].includes(args[0]));
  if (descriptorMode) {
    if (args.some((arg) => !["--info", "--json"].includes(arg)) || new Set(args).size !== args.length) {
      const error = new Error("Usage: agentlas acp [--info]");
      error.code = "INVALID_ARGUMENT";
      throw error;
    }
    ctx.out(JSON.stringify(descriptor(), null, 2));
    return 0;
  }
  if (args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
    ctx.out("Usage: agentlas acp [--info]\n  Speak the Agent Client Protocol (v1) on stdio so an editor can run Agentlas as its agent.");
    return 0;
  }
  if (args.length) {
    const error = new Error("Usage: agentlas acp [--info]");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  // stdout is the protocol wire from here on: route everything human to stderr.
  const server = new AcpAgentServer({ ctx, input: process.stdin, output: process.stdout });
  await server.start();
  return 0;
}

module.exports = { run, descriptor };
