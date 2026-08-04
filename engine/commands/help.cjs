"use strict";
/* help / usage — v2 명령 표면. 재구축이 진행되며 이 표가 곧 진실이다. */

const HELP = `agentlas — the operating system for agents, in your terminal

  agentlas                 open the terminal (REPL)
  agentlas "<task>"        run once with this project's controller

PROJECT WORK
  run [agent] [prompt]     project-first one-shot; exact agent is an explicit advanced override
  firm <firm> [task]       delegate to a CEO (--runtime · --model · --effort)

AGENTS & HUB
  search "<what you need>" discover agents in the Hub
  install <slug>           install an agent from the Hub
  plugin add <slug> · plugin list      Hub plugins (MCP servers)
  build "<request>"        build/repair/package an agent or team
  upload <path>            save owner-private in Agent Cloud (--visibility marketplace to publish)
  import <path> · cd · native prepare  local folder agents
  list                     installed agents/companies + orchestrator/worker runtimes
  experience <sub>         portable Experience: list|inspect|validate|save|publish|status|export|unpublish
  variant resolve --base-release <id>   local variant selection (variant help)

EXECUTE
  storm <goal>             Goal+UltraCode harness: plan → allocate → execute → verify  [--research]
  swarm <goal>             emergent agent swarm  [--parallel N]
  workforce | network <request>   Agent Workforce Ontology route
  hep-local | hep-cloud | hep-hub "<request>"   same, restricted to one source scope
  call "a,b" "<ctx>" · browser · route "<req>" [--json] · research <sub>

KNOWLEDGE
  memory import · evolve   memory & prompt-evolution proposals
  ontology · career-graph  project knowledge & source routing
  journal <sub>            Stormbreaker run journal
  project [status|init]    private .agentlas project state (init is explicit)
  context <sub>            dependency map: refresh|locate|refs|slice|impact|verify

ACCOUNT & OPS
  login | logout | whoami  Agentlas Cloud sign-in (browser flow)
  cloud <sub>              cloud assets: save|publish|package|list|restore|field-test
  automation <sub>         list|add|on|off|remove|run <id>|runs|daemon
  graph <sub>              graphs: list|show|run|export <name>|inspect|install <file>
  creds <sub> · env        credentials and shared env keys
  usage · telegram · mcp   local usage · telegram bindings · MCP servers (mcp probe <id>)
  multimodal               image/video/audio provider settings
  doctor · setup · update  health check · first-run wizard · npm update check
  oberon | film <sub>      AI film render (scaffold|render|list|open)
  hep <sub…> · netadmin    Hephaestus passthrough · local agent network
  version · help

IN-REPL (agentlas → interactive, Orca multi-session)
  /sessions · /tree · /s <n> | /switch <n> · /kill <n> · /rm <n>
  /runtime <kind> · /model <id> · /effort <level> · /permission <level>   (applies to new sessions)
  every command above also works as a slash command (/graph, /search, /automation, …) — /help lists them all
  typing during a running turn queues steering; ctrl-c interrupts the turn

Options: -p|--print · --runtime claude-code|codex|gemini · --model <exact-id> ·
         --effort none|minimal|low|medium|high|xhigh|max ·
         --tier economy|balanced|frontier (requires --model) ·
         --permission read|write|full
`;

function run(ctx) {
  ctx.out(HELP.trimEnd());
  return 0;
}

function runForCommand(ctx, command) {
  const name = String(command || "").trim();
  const rows = HELP.split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith(":"))
    .filter((line) => {
      const commandColumn = line.split(/\s{2,}/, 1)[0];
      return commandColumn
        .split(/\s*·\s*|\s*\|\s*/)
        .some((entry) => entry === name || entry.startsWith(`${name} `));
    });
  ctx.out(`Usage: agentlas ${name} [options]`);
  if (rows.length > 0) {
    for (const row of rows) ctx.out(`  ${row}`);
  } else {
    ctx.out(`  See "agentlas help" for the full command list.`);
  }
  return 0;
}

module.exports = { run, runForCommand, HELP };
