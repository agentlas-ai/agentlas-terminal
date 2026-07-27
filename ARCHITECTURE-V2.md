# Agentlas Terminal v2 — Ground-Up Rewrite Architecture

Status: REWRITE COMPLETE (2026-07-27). The full v1 command surface (56
commands) is live on the v2 engine; smoke runs 47 checks green including the
runtime-doctor 3-product parity gate. v1 remains recoverable at git tag
`legacy-v1-engine-snapshot`. Not yet released (release freeze applies);
version stays 0.9.10 until an explicit release decision.

## Why

v1 grew into a 13,347-line monolith (`engine/agentlas.cjs`) where routing,
cloud, REPL, storm, workforce, experience, credentials, and UI all interleave.
Owner directive: keep only the frame, rebuild from bare ground with the same
feature surface as Agentlas Desktop / Agentlas OS, Claude Code / Codex CLI
UX, and first-class multi-session subagent orchestration (Orca-style).

## Frame (kept, not rewritten)

- `bin/agentlas.cjs` — launcher: sqlite probe, DB bootstrap, engine spawn.
- `engine/bootstrap-schema.sql` (+ `scripts/gen-bootstrap-schema.sh`) — shared
  Desktop schema. Terminal shares the same userData SQLite as Desktop.
- `engine/agentlas-doctor.cjs` — Runtime Doctor. 3-product parity contract
  (Desktop TS ↔ Terminal CJS ↔ system-optimizer). Any rule change must PASS
  `Agentlas_F/scripts/sync-runtime-doctor.sh`.
- `engine/agentlas-sqlite-policy.cjs`, `engine/agentlas-secret-patterns.cjs`,
  `engine/semver.cjs` — small, clean, contract-bearing utilities.
- `install.sh` / `install.ps1`, packaging (`package.json` files list), signing,
  smoke harness shape (`test/smoke.sh` with doctor-parity gate at the end).

## v2 Engine Layout (one concern per module, no cross-imports upward)

```
engine/
  agentlas.cjs            entry: argv → command dispatch → REPL default
  core/                   no feature logic, no UI
    paths.cjs             userData/db/dirs (single source of truth)
    db.cjs                open + migrate shared schema, driver ladder
    config.cjs            terminal-local config (language, runtime, permission)
    i18n.cjs              ko/en tables
    credentials.cjs       keytar → encrypted-file fallback; env protection
    cloud.cjs             Agentlas Cloud/Hub HTTP client (auth, CAS, WRITE_MODE)
    judgment.cjs          resident LLM judge — NO wordlist fallback, honest stop
  runtimes/
    detect.cjs            claude-code / codex / gemini / ollama / api ladder
    exec.cjs              spawn + stream + permission mapping + env isolation
    doctor  = ../agentlas-doctor.cjs (parity module, unchanged)
  agents/
    registry.cjs          installed agents/teams/firms (DB), builtin seed
    loadout.cjs           experience/operational loadout receipts (Desktop parity)
    hub.cjs               search/install/plugin add (Hub)
    cloud-assets.cjs      save/publish/restore (Agent Cloud)
    mcp.cjs               MCP server config, probe, consent allowlist
    memory.cjs            memory import/governance/prompt budget
    experience.cjs        portable Experience exchange (list/save/publish/…)
  sessions/
    session.cjs           one live conversation: agent + runtime + transcript
    orchestrator.cjs      ORCA layer: spawn/list/attach/steer/kill/broadcast,
                          parent→subagent tree, per-session event bus
    store.cjs             chats persistence (shared schema)
  workforce/
    workorder.cjs         redacted WorkOrder → search_candidates → validate →
                          prepare (host-LLM picks; federation never scores)
    storm.cjs swarm.cjs   goal harnesses on top of orchestrator
    routing.cjs           workload routing receipts (labels ≠ slugs)
  ui/
    ansi.cjs              styling primitives (no chalk dep)
    input.cjs             raw-mode line editor, history, keybindings
    render.cjs            streaming markdown-ish renderer, spinner
    statusline.cjs        model · agent · session count · credits
    palette.cjs           `/` command palette
    repl.cjs              main loop (Claude Code-style)
    sessions-view.cjs     Orca panel: live session tree, 1-key switch
  commands/
    index.cjs             dispatch table; each command = own file, imports
                          feature modules only (never each other)
```

## Multi-session orchestration (the Orca requirement)

- Every run — foreground chat, `run`, storm worker, swarm worker, firm CEO
  delegation — is a **Session** owned by the **orchestrator**. There is no
  second execution path.
- REPL keys: `Ctrl-O` opens the session panel; digits/arrows jump; typing
  into a running subagent steers it; `Ctrl-B` sends a session to background;
  a background session's completion prints a one-line notice in the fronted
  session.
- Slash surface: `/sessions`, `/spawn <agent> <task>`, `/steer <n> <msg>`,
  `/kill <n>`, `/broadcast <msg>`, `/tree`.
- Sessions persist to the shared `chats` tables so Desktop sees the same
  history (and vice versa).

## Non-negotiable invariants (carried from owner decisions)

1. No silent fallbacks. A missing runtime/model is an honest stop
   (`no_runtime` / `model_unavailable`), never a keyword/lexical fallback.
2. Judgment = resident LLM; wordlists may exist only as *format* helpers.
3. Routing final pick = host LLM. Embedding/lexical layers are recall-wideners.
4. Doctor repairs only with structured evidence (host-matched plugin, backup
   first). Parity gate must PASS before any commit touching diagnosis rules.
5. Credentials never enter child env unprotected; MCP child env isolation.
6. `.agentlas/` project state is private — never committed, never uploaded.
7. Public npm publish uses the explicit files allowlist only.

## Migration policy

- v1 logic is a *reference*, not a dependency: port proven algorithms into the
  new module boundaries; never `require` the old monolith.
- Features land honestly: a command either works end-to-end or reports
  "not wired in v2 yet" with its v1 tag reference — no facades.
- Commit per completed batch (other sessions share this checkout).
