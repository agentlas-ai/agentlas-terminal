# agentlas

```
  █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗      █████╗ ███████╗
 ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║     ██╔══██╗██╔════╝
 ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║     ███████║███████╗
 ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ██║     ██╔══██║╚════██║
 ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ███████╗██║  ██║███████║
 ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚══════╝
```

**Agentlas Terminal CLI** — Independent AI agent runtime installed via `npm install -g agentlas` and launched with `agentlas`. Run exact installed agents, teams, and parallel sessions directly from your shell without keeping Desktop open. When Desktop is installed, Terminal reads the same local project, agent, and runtime state. Bring your own model — use Antigravity (`agy`), Claude Code, Codex, legacy Gemini CLI, or BYOK API keys.

Use this existing independent Terminal as the command-line runtime: inspect owner-private packages with `agentlas cloud list`, restore one with `agentlas cloud restore <slug>`, or install an eligible public package with `agentlas install <slug>`.

> **We are Agent Trust. Your agent is not a program. It is an asset. — Agentlas —**

Agent Trust is our product principle: agent packages are treated as portable, owner-scoped, inspectable, and restorable assets. (It does not imply regulated financial or fiduciary services.) Agent Cloud stores package assets in your private cloud account, while Agentlas Terminal verifies and executes local runtime copies on your host machine.

---

## Requirements

| Category | Requirement |
| --- | --- |
| **Node.js** | **Node 22+ recommended.** `package.json` specifies `engines: ">=20"`, but if native optional dependency `better-sqlite3` build fails, the launcher falls back strictly to `node:sqlite` in Node 22+. Node 20 works when `better-sqlite3` native build succeeds. |
| **Agent CLI** | Requires at least one supported runtime CLI: `agy` (Antigravity, preferred), `claude`, `codex`, or legacy `gemini` in your `PATH`. Halts honestly with `no_runtime` if none are found (no fake model responses). |
| **OS** | macOS is verified by the current local release gate. Linux is covered by the public adapter/CI contract. A Windows launcher is provided, but this release does not claim independent end-to-end Windows verification. |

*Note: active runtimes include `claude-code`, `codex`, `agy` (Antigravity),
legacy `gemini`, and the shared ACP-backed `kimi`, `grok`, and `cursor-agent`
adapters. `doctor` reports the exact locally executable set.*

## Installation

```sh
npm install -g agentlas
# Or from local source: npm install -g .
# Or via shell installer: sh install.sh              # Symlinks to ~/.local/bin/agentlas (no sudo needed)
# Or with custom prefix:  sh install.sh --prefix /usr/local/bin
```

Windows (launcher available; end-to-end release not independently verified): `powershell -ExecutionPolicy Bypass -File install.ps1`

## Quick Start

```sh
agentlas
```

**1. Interactive Onboarding Wizard** — On first TTY execution, a 3-step setup guides you through language selection, default runtime preference (`auto` or installed CLI), and default permission level (`read`/`write`/`full`). Settings are saved in `cli-prefs.json` and re-configurable via `agentlas setup`. If no local database exists, it bootstraps SQLite with Desktop-compatible schemas and seeds built-in agents (Orchestrator, PM Soul, Memory Curator).

**2. Single Task Execution**

```sh
agentlas "Identify why repository tests are failing"      # Uses the connected project's first agent as controller
agentlas run -p "Summarize the last 3 CHANGELOG entries"  # Prints the project controller's final answer to stdout
git log --oneline -20 | agentlas run                      # Reads stdin; still requires a connected project
agentlas run <agent> "Advanced direct request"            # Explicit one-turn exact-agent override
agentlas firm <firm> "Request"                            # Delegates to an exact firm CEO
```

Ordinary one-shot work is project-first: run it inside a folder connected to a Desktop Work project. The first agent in that project's ordered pool owns the task; remaining members are eligible task-scoped sub-agents. Missing projects, empty teams, and unavailable controllers stop without substituting another agent. The separate `agentlas route` preview is model-judged and stays unresolved when no exact installed agent can be justified.

## Command Reference

Run `agentlas help` for the authoritative command list. Below is the organized command structure:

### PROJECT WORK
```sh
agentlas                         # Open the connected project's controller session
agentlas run [agent] [prompt]    # Project-first run; optional agent is one explicit turn
agentlas firm <firm> [task]      # Delegate task to firm CEO
agentlas cd <agent>              # Print folder path of an agent (cd "$(agentlas cd x)")
```

### AGENTS & HUB
```sh
agentlas search "<query>"        # Search Hub agents (no login required)
agentlas install <slug>          # Install Hub agent locally (gated by security trust checks)
agentlas plugin add <slug>       # Add Hub plugin (MCP server)
agentlas plugin list             # List active plugins (= agentlas plugins)
agentlas build "<prompt>"        # Build, repair, and package agents or multi-agent teams
agentlas upload <path>           # Upload package to private Agent Cloud (default)
agentlas upload <path> --visibility marketplace   # Explicitly publish to public Agentlas Hub
agentlas connect <sub>           # Connect external platforms (e.g. Telegram)
agentlas import <folder>         # Import local agent or firm directory
agentlas native prepare <agent>  # Generate native CLI context files
agentlas list                    # List installed agents/firms and active runtimes
agentlas uninstall <agent> [--yes] # Remove an installed agent (fails if chat history exists unless --yes)
agentlas experience <sub>        # Manage agent experience (list|inspect|validate|save|publish|status|export|unpublish|withdraw)
agentlas variant resolve --base-release <id> # Preview local variant compatibility
```

### EXECUTE
```sh
agentlas storm "<goal>"          # Goal + UltraCode harness: plan -> assign -> execute -> verify [--research]
agentlas swarm "<goal>"          # Emergent multi-agent swarm [--parallel N]
agentlas workforce "<prompt>"    # Route through Agent Workforce Ontology (public Hub menu)
agentlas network "<prompt>"      # Alias for workforce
agentlas taskforce "<prompt>"    # Alias for workforce
agentlas hep-network "<prompt>"  # Staff across Local + owner Cloud + public Hub (local Core federation)
agentlas hep-local "<prompt>"    # Same staffing, registered Local agents only
agentlas hep-cloud "<prompt>"    # Same staffing, owner Agent Cloud only
agentlas hep-hub "<prompt>"      # Same staffing, public Hub only
agentlas call "a,b" "<context>"  # Call explicitly named Hub or Cloud agents
agentlas browser [...]           # Real browser hardpoint launcher
agentlas route "<prompt>" [--json] # Preview routing decisions without execution
agentlas research <sub>          # Research loadout (status|gather|search|read|plan)
```

### KNOWLEDGE
```sh
agentlas memory import <path> --agent <id> [--apply]
agentlas evolve [list|apply <id>|revert <id>]
agentlas ontology <sub>          # Manage project ontology (status|list|add)
agentlas career-graph <sub>      # Ingest, query, verify, and trace career graph indices
agentlas journal <sub>           # Run journal operations (status|verify|repair|gate)
agentlas project [status|init]   # Explicit entry point to initialize `.agentlas/` context
agentlas context <sub>           # Context slice operations (refresh|locate|refs|slice|impact|verify)
```

Only in projects explicitly initialized with `agentlas project init` do single runs, team executions, Stormbreaker, and Workforce receive local Context Slices. Read, write, or full permissions do not create or alter `.agentlas/` or `.gitignore` files. Code maps, source paths, and file contents are never transmitted during Hub/Cloud search.

### ACCOUNT & OPS
```sh
agentlas login | logout | whoami  # Agentlas Cloud authentication (loopback browser flow)
agentlas billing                  # Check account credit balance
agentlas cloud <sub>              # Manage private Agent Cloud packages (save|publish|package|list|restore|delete|search|install|security scan|runtime bundle|field-test)
agentlas automation <sub>         # Scheduled automations (list|add|on|off|remove|run <id>|runs|daemon)
agentlas creds save --provider <n> --key <ENV> --value <v>
agentlas creds file --source <path> [--env <ENV>]  # Imports credentials (values never logged)
agentlas env                      # List shared environment variable keys (values hidden)
agentlas usage                    # Local usage statistics
agentlas telegram                 # Telegram binding status (read-only)
agentlas mcp                      # List configured MCP servers
agentlas mcp probe <id>           # Check initialize -> tools/list handshake
agentlas multimodal               # Configure provider settings for image/video/audio
agentlas doctor                   # Runtime, database, and session diagnostics
agentlas setup                    # Re-run first-time onboarding setup wizard (TTY required)
agentlas update                   # Check for latest package updates on npm
agentlas oberon <sub>             # AI film rendering pipeline: scaffold|render|list|open (= agentlas film)
agentlas hep <sub...>             # Native Hephaestus passthrough
agentlas netadmin <sub>           # Local network administration (init|status|reindex|bench|add-source)
agentlas version | help
```

Common flags across subcommands: `-p|--print`, `--runtime claude-code|codex|agy|gemini`, `--permission read|write|full`.

### Typo Guard & Desktop Surface Redirection

If a single non-flag word is entered that does not match a valid command or installed agent slug, Agentlas halts with exit code 1 instead of sending the mistyped command to an LLM:

```
$ agentlas lst
'lst' is not an agentlas command. Did you mean: list
Command list: agentlas help  ·  To run this exact prompt: agentlas run -p "lst"
```

Desktop-only surface names (`site`, `trex`, `prompts`, `dashboard`, `marketplace`, `library`, `settings`, `apps`, `quests`, `bookmarks`, `one`) also halt with typo guard guidance directing you to equivalent terminal commands. To run a single word as a prompt, wrap it in quotes or pass `run -p`.

### Permission Levels

| Agentlas Level | Claude Code | Codex | Gemini CLI |
| --- | --- | --- | --- |
| `read` | `plan` | `read-only` sandbox | `plan` |
| `write` | `acceptEdits` | `workspace-write` sandbox | `auto_edit` |
| `full` | bypass permission prompts | approval + sandbox bypass | `yolo` |

*Note: Saved `full` permission is session-bound and automatically fails closed to `write` on subsequent executions. REPL shell execution (`!<command>`) runs strictly under `full` permission, enforced with 8MB output capping, secret masking, and process-group termination.*

## Project Work Execution Tree

Executing `agentlas` with no arguments resolves the current folder to an Agentlas project and starts its first ordered agent as the task controller. The controller may create task-scoped worker runs; users can inspect the real execution tree, but cannot replace the controller or address workers around it.

### REPL Slash Commands

| Command | Action |
| --- | --- |
| `/help` | Display available commands and keybindings |
| `/sessions` · `/tree` | View session table or parent-child process tree |
| `/s <n>` · `/switch <n>` | Switch active session (replays tail logs & subscribes to live stream) |
| `/kill <n>` | Interrupt active turn in session `n` |
| `/rm <n>` | Remove session `n` |
| `/agents` · `/list` | List installed agents |
| `/mcp` | List active MCP servers |
| `/doctor` | Run runtime & database diagnostics |
| `/runtime <kind>` | Set runtime for new sessions (`claude-code` \| `codex` \| `agy` (Antigravity) \| legacy `gemini`) |
| `/permission <level>` | Set permission level for new sessions (`read` \| `write` \| `full`) |
| `/quit` · `/exit` | Exit REPL |

Unrecognized slash commands halt with `unknown: /xxx (see /help)`.

### Controls & Input Shortcuts

| Input | Behavior |
| --- | --- |
| Typing + `Enter` during execution | Queues message into session's **steering queue** for next turn (does not abort current turn) |
| `Ctrl+C` (during execution) | Interrupts current turn |
| `Ctrl+C` (when idle) | 1st press shows warning; **2nd consecutive press exits** |
| `Tab` | Autocompletes slash commands, agent/firm slugs, **live session keys (s1, s2...)**, and `/runtime` / `/permission` values |
| `@path` + `Tab` | Autocompletes local file paths |
| `Up` / `Down` | Input history navigation |
| `!<shell-command>` | Execute shell command (requires **`full` permission**) |

Parallel execution limit defaults to 4 concurrent sessions. Exceeding the limit halts with explicit refusal; increase limit via `AGENTLAS_MAX_PARALLEL` (up to 16).

## Operating Architecture

### Engine Boundary — No Duplicated Core OS Logic

Agentlas Terminal does not re-implement Agentlas OS. It resolves and executes the installed **Agentlas OS (Hephaestus/Core)** runtime on your system.

Runtime Search Order (`engine/agentlas-core-harness.cjs`, `engine/hephaestus/runtime.cjs`):
1. `HEPHAESTUS_BIN` / `HEPHAESTUS_RUNTIME_ROOT`
2. `~/.agentlas/runtime/current`
3. Packaged Core (`<resources>/Hephaestus`, macOS: `/Applications/Agentlas.app/Contents/Resources/Hephaestus`)

Commands including `storm`, `swarm`, `workforce`/`network`, `route`, `research`, `context`, `career-graph`, `journal`, `netadmin`, `hep`, `build`, `call`, `browser`, and `connect` pass directly through to this core runtime. If no core runtime is found, Agentlas Terminal halts with an explicit error and exit code 1 (no silent fallback).

The terminal package owns REPL orchestration, session trees, agent registries, Hub/Cloud HTTP client surfaces, credential storage, MCP preflight probing, automation scheduling, and SQLite schema management.

### Shared State with Agentlas Desktop

The launcher (`bin/agentlas.cjs`) runs system Node against `engine/`. The default data directory is identical to Agentlas Desktop's `userData`:

| OS | Default Data Path |
| --- | --- |
| macOS | `~/Library/Application Support/Agentlas` |
| Windows | `%APPDATA%\Agentlas` |
| Linux | `$XDG_CONFIG_HOME/Agentlas` (default `~/.config/Agentlas`) |

The SQLite database file is `agentlas.sqlite` (`user_version=97`). When launched for the first time without an existing database, it bootstraps schemas using `engine/bootstrap-schema.sql`. Consequently, **projects, installed agents, task history, automation sessions, and MCP registrations are shared across Desktop and Terminal**. The first ordered project agent remains the controller; additional agents are task-scoped and are stored only as execution ledgers, never as global conversations or durable owners.

**Single migration authority.** The Desktop app owns the schema migration ladder; the CLI never migrates the shared database. `engine/bootstrap-schema.sql` is generated by running that ladder to completion against an empty database, so a CLI-created store already sits at the ladder head and has nothing left for Desktop to upgrade. If the CLI opens a store older than the version it knows, it refuses with an actionable message instead of migrating or silently proceeding — a second migrator on this lock-free file is what corrupted the store once before. On a machine with no Desktop app, an operator can set `AGENTLAS_STORE_MIGRATION_ROLE=owner` for a single deliberate upgrade run with every other Agentlas process closed.

SQLite driver priority: `better-sqlite3` (optional dependency native build), then Node 22+ `node:sqlite` when the first driver is unavailable.

### Hub Installation & Safety Policy

Local installation of Hub agents is gated by `assertHubInstallAllowed` (`engine/hub/install.cjs`). Installation is restricted in the following scenarios:

- **Cloud-callable / Call-only Agents**: Local install blocked. Use via `agentlas call <slug>`. Owners restore via `agentlas cloud restore <slug>`.
- **Packages without Instructions**: Blocked if required instruction manifests are missing.
- **Untrusted Trust Grades**: Packages with trust grade lower than A/B require explicit side-load overrides.
- **Web-only Agents**: Blocked on terminal surface.
- **Withdrawn Catalog Items**: Fails with `Hub agent not found`.

Package uploads (`upload`) default to private owner-scoped Agent Cloud storage; public Hub publishing requires explicit `--visibility marketplace`.

## Desktop-Only Surface Scope

The following GUI-specific features are reserved for Agentlas Desktop and are not exposed in the terminal CLI:
- Telegram bot token issuance & port configuration (`agentlas telegram` is read-only)
- Visual project-team composition and ordering
- Interactive GUI approval sheets & browser popups
- Custom MCP server addition GUI (Terminal supports listing & `mcp probe`)
- Site Studio, T-rex slide studio, Prompt Store GUI
- Mobile pairing QR sheets & Quests
- Provider quota dashboards & visual marketplace browsing

## Environment Variables

| Variable | Description |
| --- | --- |
| `AGENTLAS_USER_DATA_DIR` | Custom data directory override (default: shared Desktop `userData`) |
| `AGENTLAS_LANG` | Preferred locale (`ko` \| `en`) — overrides system `LANG` |
| `AGENTLAS_MAX_PARALLEL` | Maximum concurrent execution sessions (default: 4, max: 16) |
| `AGENTLAS_SESSION` | Agentlas Cloud session cookie token |
| `AGENTLAS_WEB_BASE_URL` | Base URL for Web services (default: `https://agentlas.cloud`) |
| `AGENTLAS_MCP_BASE_URL` | Base URL for Hub MCP APIs (default: `<web>/api/mcp/v1`) |
| `HEPHAESTUS_BIN` / `HEPHAESTUS_RUNTIME_ROOT` | Custom path to Agentlas OS core runtime |
| `AGENTLAS_MODEL_MAX_TIER` | Max model tier cap for swarms (`economy` \| `balanced` \| `frontier`) |
| `NO_COLOR` | Disables ANSI color output if non-empty (`FORCE_COLOR=1` forces color on) |

## Troubleshooting & Diagnostics

```sh
agentlas doctor      # Checks database, PATH runtimes, active CLI drivers, and cloud session
agentlas --where     # Outputs JSON diagnostic of launcher, engine, DB paths, driver, and Node version
```

- **`no_runtime: no agent CLI found`**: Connect Antigravity and put `agy` on `PATH` first, or install `claude`/`codex`; `gemini` remains available as a legacy CLI. Kimi, Grok, and Cursor use the shared ACP driver when their local CLIs are available.
- **`runtime '<kind>' has no v2 streaming driver yet`**: Specified `--runtime` is not supported for active execution. Supported values: `claude-code`, `codex`, `agy` (Antigravity), `gemini` (legacy).
- **`Node vX — Node 22+ (node:sqlite) is required when better-sqlite3 is unavailable`**: `better-sqlite3` native build failed on Node 20/21. Upgrade to Node 22+ or install build tools for native compilation.
- **`storm`/`context`/`hep` halting due to missing runtime**: Agentlas OS core runtime is missing. Install Agentlas OS or set `HEPHAESTUS_BIN=<path>`.
- **`'xxx' is not an agentlas command`**: Typo guard intercepted an unrecognized command. Use `agentlas run -p "xxx"` to run it as a prompt.

## Development & Verification

Engine source code resides in `engine/*.cjs`.

```sh
sh test/smoke.sh                              # Runs surface tests, guard tests, fresh DB tests, contract tests & parity gates
npm run smoke                                 # Equivalent to npm run test:release-contracts
node scripts/gen-bootstrap-schema.cjs         # Regenerates engine/bootstrap-schema.sql from the Desktop ladder (never reads a live store)
```

Smoke tests run isolated inside a temporary `AGENTLAS_USER_DATA_DIR` and do not touch local user data.

## Release & Security Allowlist

Published package versions on npm are governed strictly by OIDC trusted publisher workflows (`.github/workflows/npm-publish.yml`).

Release verification enforces tag identity (`vX.Y.Z`), contract tests, smoke tests, and manifest allowlists preventing non-release files (development tests, fixtures, internal documents) from being packaged into npm artifacts.

Detailed release logs and source-to-registry boundaries are documented in [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE) — Agentlas Terminal is the independent terminal runtime for the [Agentlas OS](https://github.com/agentlas-ai/Agentlas-OS) package contract.
