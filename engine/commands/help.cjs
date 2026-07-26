"use strict";
/* help / usage — v2 명령 표면. 재구축이 진행되며 이 표가 곧 진실이다. */

const HELP = `agentlas — the operating system for agents, in your terminal

  agentlas                 open the terminal (REPL)
  agentlas <agent>         jump into a chat with one agent
  agentlas "<task>"        auto-route to the best agent and run once

TALK & RUN
  <agent>                  jump into a chat with one agent
  run [agent] [prompt]     one-shot (-p print · --runtime · --permission; stdin ok)
  chats [n]                recent conversations

AGENTS & HUB
  search "<what you need>" discover agents in the Hub
  list                     installed agents/companies + active runtime

ACCOUNT & OPS
  login | logout | whoami  Agentlas Cloud sign-in (browser flow)
  usage · telegram · mcp   local usage · telegram bindings · MCP servers
  doctor                   check runtimes, data, credentials
  update                   check for a newer agentlas on npm
  version · help

IN-REPL (agentlas → interactive)
  /spawn /sessions /tree /s /steer /kill /broadcast — Orca multi-session control

REBUILDING (returns as each v2 module lands; full v1: npm agentlas@0.9.10)
  install · plugin · build · upload · storm · swarm · network · workforce ·
  call · automation · experience · cloud · memory · context · project · …
`;

function run(ctx) {
  ctx.out(HELP.trimEnd());
  return 0;
}

module.exports = { run, HELP };
