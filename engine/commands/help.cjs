"use strict";
/* help / usage — v2 명령 표면. 재구축이 진행되며 이 표가 곧 진실이다. */

const HELP = `agentlas — the operating system for agents, in your terminal

  agentlas                 open the terminal (REPL)
  agentlas <agent>         jump into a chat with one agent
  agentlas "<task>"        auto-route to the best agent and run once

AVAILABLE (v2)
  list                     installed agents/companies + active runtime
  chats [n]                recent conversations
  mcp                      registered MCP servers
  doctor                   check runtimes, data, credentials
  version · help · usage

REBUILDING (returns as each v2 module lands; full v1: npm agentlas@0.9.10)
  run · search · install · build · upload · storm · swarm · network ·
  workforce · call · login · automation · experience · cloud · memory ·
  context · project · telegram · update · …
`;

function run(ctx) {
  ctx.out(HELP.trimEnd());
  return 0;
}

module.exports = { run, HELP };
