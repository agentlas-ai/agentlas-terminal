# Changelog

## 1.0.39 — 2026-08-11

pi-tui shell increment 2 + architecture mirror sync.

- Experimental pi shell (`AGENTLAS_TUI=pi`): persisted history (cli-history.json
  v2 contract), Shift-Tab permission cycling (same two-step FULL arming state
  machine as the classic REPL), `!` shell passthrough (full-permission gate,
  secret masking), and `/s` `/switch` `/kill` `/rm` `/sessions` `/tree` session
  observation wired to the same orchestrator/renderer pair.
- Streaming display masks the Memory Events envelope (runtime contract, not
  user-facing text); the harvest pipeline is unchanged.
- ARCHITECTURE_VERSION mirror synced 1.7.0 → 1.7.1 (vendor regenerated from
  the desktop dist, value-level parity gate green).

## 1.0.38 — 2026-08-11

Silence was the worst failure mode — this release makes failures speak.

- The presentation boundary (`Ui.error`) now has conditions. Machine-coded
  messages (usage guidance, honest stops, server relays) pass through; only
  uncoded raw provider text is still replaced by the neutral recovery line.
  Previously every failure — including usage help for eight argless slash
  commands — collapsed into the same "One is recovering" sentence.
- `/s` `/switch` `/kill` `/rm` `/runtime` `/model` `/effort` `/permission`
  without arguments now print their usage line instead of a recovery notice.
- Workforce sign-in expiry is relayed honestly: the server's `auth_required`
  guidance reaches the user (run `agentlas login`), instead of being
  misreported as an invalid continuity receipt and then swallowed.
- `doctor` verifies the cloud session against the server instead of only
  checking that a session file exists. Expired sessions are reported as a
  warning with the login hint; offline is reported as "unverified", never as
  a false all-clear. `--json` output remains observation-only.
- Authored guidance in storm/swarm/workforce flows (planner refusals, unknown
  options, persisted receipt issues) is no longer swallowed by the boundary.
- `npm run sync:architecture` works again — the script was restored to
  `scripts/` where its relative paths are correct.

## 1.0.37 — 2026-08-10

Agentlas One can now carry its owner-bound identity and curated memory tickets
across Terminal sessions without turning the agent into the owner of a project.

- When One is explicitly enabled, Terminal loads its bounded directive at the
  per-turn system boundary and forwards only `agent_repo` and `user_identity`
  memory candidates to One's existing ledger. Project memory stays with the
  project, and a missing or disabled One workspace remains a no-op.
- The Memory Events parser accepts both the canonical ticket envelope and the
  legacy array form, so valid candidates are no longer silently discarded.
- Global `--json` output now reaches doctor, list, roles, Cloud restore, and
  upload commands consistently; machine-readable output is no longer prefixed
  by human status text.
- The built-in architecture projection includes Agentlas One as a hidden
  orchestrator rather than a top-level project or user-facing worker.

## 1.0.34 — 2026-08-06

Telegram, standalone. The terminal can now connect a Telegram bot with no desktop app.

- `connect telegram <agent|firm>` reads a bot token from stdin (never argv), verifies it
  against api.telegram.org, stores it 0600, polls getUpdates and pairs the first private
  chat, then sends a confirmation.
- `connect test <id>` / `connect remove <id>` / `connect status`. The connection core is
  plain HTTPS ported from the desktop; no Electron, no plugin, no raw JSON dump.

Not yet standalone: auto-creating the bot by piloting BotFather in a browser (the CDP
browser hardpoint makes this a tractable next layer; it needs a live Telegram web session).

## 1.0.33 — 2026-08-06

Defect sweep: ran every command with a real prompt and fixed what dumped or stalled.

- `connect telegram` / `connect status` no longer dump the raw Hephaestus router JSON —
  they show the local Telegram binding table and honestly note that bot issuance/pairing
  still live in Desktop Connect.
- `route "<request>"` shows a progress spinner during its ~13s Hub round-trip instead of
  sitting silent.

## 1.0.32 — 2026-08-06

Standalone: the terminal no longer requires Desktop or the plugin for its core flows.
(They share artifacts and settings; they are not a prerequisite.)

- `project use <agent>` / `project team <agent>…` connect the current folder as a
  project and set an ordered team, entirely from the terminal — so `run "<task>"` and
  plain REPL input work without ever opening Desktop. `project status` shows the team.
- `build "<request>"` now builds locally: the terminal runtime produces an installable
  agent package (AGENTS.md + manifest.md + README.md) and auto-installs it, instead of
  printing "open the Claude Code / Codex plugin and run /hep-build".
- Honest-stops in a project-less folder point at `project use`, not "open Desktop".

Verified standalone end-to-end: project use → run answered correctly; build produced and
installed an agent that then ran correctly.

## 1.0.31 — 2026-08-06

Interactive UX, measured against first-class REPLs with a real PTY.

- The empty prompt now guides: a dim ghost hint ("type a task · / commands · @ files
  · ? shortcuts"), `?` prints a shortcuts card, a second empty Enter points the way.
- Tab-completing a command that takes arguments appends the space, so you can type the
  argument immediately; no-arg commands are unchanged.
- A plain-language task in a folder with no connected project now says exactly why and how
  to run anyway (localized), instead of a single "recovering…" line that hid the reason.
  Every controller honest-stop carries a machine code so this can never be swallowed again.
- New PTY-driven gates (repl-guidance, honest-stop-not-swallowed) — these paths live inside
  the readline session and are invisible to spawnSync tests.

## 1.0.30 — 2026-08-06

CLI-conventions hardening, measured against clig.dev and first-class CLIs.

- A closed pipe is a reader saying stop: `agentlas … | head` no longer crashes with EPIPE.
- Unexpected crashes now print a one-line summary and a pre-filled GitHub issue URL, not just a raw stack.
- `TERM=dumb` disables ANSI colors (editor shells, some CI).
- Secrets stop landing in shell history: `creds save --value -` reads the secret from stdin;
  passing it via argv now prints an exposure notice.
- `list --json`, `doctor --json`, `roles --json` — machine contracts for scripts.
- Workforce staffing survives transient API failures: a typed transient error
  (connection closed mid-response, timeouts, overload) on a no-authority/read-only stage
  is retried exactly once; write-capable stages are never retried. A 40-minute, 2.1M-token
  live run previously died on the final re-verification call for exactly this.
- New gate: clig-conventions-contract; retry contract added to the workforce runtime gate.

## 1.0.29 — 2026-08-05

Terminal-wide audit release. Every command was executed for real; what follows fixes what that audit found.

- Native federated staffing: `hep-network` / `hep-local` / `hep-cloud` / `hep-hub` now run this
  terminal's own workforce loop with the local Agentlas-OS core federating the declared source scope.
  (They previously passed through to an external CLI stub that always answered exit 3.)
  Honest stop with install guidance when the local core is missing — no silent fallback to the public Hub.
- `workforce` now declares its sourceScope ("hub") explicitly instead of relying on the server default.
- `doctor` distinguishes installed from signed-in: local sign-in evidence per runtime, a warning
  (not "all clear") when the active runtime has none.
- New `roles` command: view and set orchestrator/worker model roles from the terminal
  (`roles set <role> <runtime> [--model id] [--effort lv]`, `roles set worker --inherit`).
  REPL `/model`·`/runtime` now say they are session-scoped and point to `agentlas roles`.
- Setup wizard prints install/sign-in guidance when the chosen runtime is missing or unauthenticated.
- `creds list` (names and stores only — values never printed), `mcp list`, Korean `help` body.
- The graph command group ships in the npm package for the first time (it landed after 1.0.28 was published).
- New gates: user-scenarios (93 real CLI invocations), local-core transport wire contract,
  doctor auth-evidence, roles round-trip, onboarding guidance, EN/KO help sync.
- `agentlas <command> --help` reaches the command's own help. It printed a two-line stub
  scraped from the help table, so `graph --help` never showed the eight lines `graph help` has —
  and that is the spelling people try first. (The gate had pinned the stub as correct; its
  contract now asks whether real help was shown.)
- `graph install --name "<new name>"` works. The documented flag had never worked: its value was
  appended to the file path, so the install died with "no such file".
- `graph show` stops indenting a straight chain deeper at every step — fourteen steps meant
  twenty-eight columns. Depth now marks real branches (a fork, a failure exit).
- Building a graph follows your language setting. One Korean character anywhere in the request
  forced the interview to Korean while `graph show`, the list, and errors stayed English.
- Graph steps written as code declare the pip packages they import, and a verification step is
  now required whenever a step that changes something outside sends out a value an earlier step
  computed — an unattended run must not ship an empty or invented result.

## 1.0.26 — 2026-08-03

- **`agentlas list` stops letting the terminal cut its own output.** Slugs were
  padded to a fixed width, so a longer one pushed that row's description out of
  alignment, and the tagline had no bound at all — the terminal cut it mid-word
  with no marker, so a short description and a truncated one looked identical.
  Rows reached 109 display columns in an 80-column terminal. The slug column now
  sizes to the widest slug present and the tagline is truncated on a word
  boundary with an explicit ellipsis, measured in display cells so Korean and
  other wide characters are counted at their real width. COLUMNS is honoured when
  stdout is not a TTY.

## 1.0.25 — 2026-08-02

- **Every Terminal session now closes a governed learning episode.** Direct
  agent runs, project sessions, automation, and firm orchestration share the
  same turn receipt, Memory Ticket, curator, scoped-memory, and Experience
  intake boundary instead of merely printing or discarding `Memory Events`.
- Hidden control envelopes are removed from `run --print` and every downstream
  consumer while firm-owned delegation remains available to the firm
  orchestrator through a private control channel.
- Successful exact-agent runs use a no-authority connected-model judgment for
  canonical task classes. No keyword dictionary or default task class is used;
  valid judgments create run receipts even when no durable memory candidate is
  promoted.
- Memory emitter turn IDs are separated from punctuation, and the Experience
  bridge now accepts structured task signatures from both current sessions and
  legacy runtime loadouts.

## 1.0.24 — 2026-08-02

- **Firm runs now finish the real dependency chain.** Independent production
  roles still run in parallel, integration waits for their files, and release
  verification runs only after the integrated surface exists.
- **A verification failure triggers one bounded repair and re-check.** Terminal
  no longer ends with a truthful failure report while leaving a fixable product
  defect unresolved, and the newest result for each role determines completion.
- Firm names/slugs are directly callable from `agentlas list`, and final user
  output removes orchestration fences, internal skill reports, and verification
  control tags.

## 1.0.23 — 2026-08-01

- **Semantic routing stays with the connected model.** Image-capability and
  installed-agent routing no longer retain regex hints, keyword glossaries,
  deterministic role vetoes, or caller-authored fallback labels. If the model
  cannot return a valid judgment, the decision remains unavailable.
- **Fresh Terminal databases match Desktop schema 86.** The retired
  chat-level hired-agent roster is absent from the bootstrap schema; project
  order and current-turn task-force targets own controller and helper binding.

## 1.0.22 — 2026-08-01

- **Task classes no longer come from a fixed keyword dictionary.** An explicit
  user/project declaration remains authoritative; otherwise only the connected
  model may classify the full request, and an unavailable or invalid judgment
  stays unresolved.
- Preserve an explicit `declaredTaskClasses` value across the Desktop loadout
  boundary so removing the dictionary fallback does not discard user-owned
  structured intent.

## 1.0.21 — 2026-08-01

- Align the independent Terminal sentence with the exact cross-surface
  architecture-sync marker used by the Web release gate.

## 1.0.20 — 2026-08-01

- Restore the explicit independent-Terminal and private Cloud list/restore
  guidance required by the cross-surface architecture contract. This corrects
  the public README without changing the v1.0.19 runtime behavior.

## 1.0.19 — 2026-08-01

- **Ordinary runs now honor Desktop Work project ownership.** From a connected
  project folder, the first member of the saved ordered agent pool is the task
  controller and the remaining members are task-scoped sub-agent candidates.
  Missing projects, empty teams, remote-only controllers, and unavailable
  controller releases stop without silently selecting a default agent.
- Exact-agent invocation remains available as an explicit advanced path. The
  separate route preview is judged by the connected model against the installed
  roster and remains unresolved when the evidence or model is unavailable;
  regex intent gates, keyword dictionaries, and lexical fallback selection were
  removed.
- The fresh Terminal schema now matches Desktop project-first schema v85,
  including ordered project pools and AutomationSession transcript ownership.
- The npm publication gate now verifies against the exact Agentlas OS v1.1.92
  source commit used by Desktop instead of an older Core snapshot.
- Documentation now distinguishes verified macOS behavior, Linux CI coverage,
  and the provided but not independently end-to-end verified Windows launcher.

## 1.0.18 — 2026-07-31

- **Private Agent Cloud inventory is readable by default.** `agentlas cloud
  list` now identifies the owner-private scope, shows how many rows are
  displayed, and labels slug, kind, callability, update date, and name instead
  of dumping an unlabeled TSV stream.
- The inventory ends with exact next actions for machine-readable revision
  inspection and restoring one selected package. `--json` remains the stable
  full-fidelity contract.

## 1.0.17 — 2026-07-31

- **Terminal requires the verification-aware Context Map engine.** Context
  commands now select Agentlas OS 1.1.86 or newer, whose impact graph connects
  code changes to tests, test commands, CI workflows, and product-version
  contracts, including local test files intentionally excluded from Git.
- A stale Core can no longer satisfy the Terminal context capability merely by
  exposing the old module path; the version gate fails closed before execution.

## 1.0.16 — 2026-07-30

- **Project-scoped plugin listing now fails closed.** A missing, unsafe, or
  uninitialized `--project` path returns a clear error instead of silently
  showing the global Hub catalog as if project compatibility had been checked.
- Plugin listing names its actual scope: the global Hub catalog does not claim
  to evaluate project compatibility or local installation state.
- Unknown, conflicting, or incomplete plugin flags now return usage errors
  instead of being ignored.

## 1.0.15 — 2026-07-29

- **Agent Cloud saves work from a new machine or fresh clone.** Before writing,
  the terminal resolves the signed-in owner's exact asset revision by
  `slug` and scope, then keeps the conditional-write guard on that revision.
  A missing local receipt no longer turns an owned asset into a false create
  conflict.
- **A real stale-copy conflict stays fail-closed.** The terminal stops before
  replacing a newer server revision, reports its identity, and offers an
  explicit `--overwrite` only when the owner deliberately chooses the current
  folder over the newer copy.
- Conflict messages now describe ownership and the next command instead of
  exposing storage precondition terminology.

## 1.0.14 — 2026-07-29

- **Write-capable commands now prepare every project automatically.** The first
  `run`, `storm`, `swarm`, or workforce execution in any folder installs the
  same private, merge-only Agentlas project infrastructure through Core. This
  is based on the folder the user opened, not on the Agentlas source checkout.
  Read-only commands remain passive and do not create files.
- **Per-command help works before database startup.** Commands such as
  `agentlas run --help` and `agentlas workforce --help` no longer require an
  SQLite driver or open the project database just to print usage.

## 1.0.13 — 2026-07-28

- **MCP servers reach the chat again.** `runNativeTurn` only injects them at
  `full` permission and that gate was right, but `sessions/session.cjs` never
  put `mcpServers` in the request — zero callers — so no CLI ever received a
  server. `agentlas mcp probe` printed "connected" while the turn that followed
  could not use it. Turns now carry servers the user already consented to;
  nothing new is asked mid-turn, because a turn is not a place a user can answer.
- **The shared database stops taking a write lock every turn.** Four
  `CREATE TABLE IF NOT EXISTS`, five indexes and an `ALTER TABLE` ran on every
  single turn against the file Desktop also uses. All idempotent, all taking the
  lock; during a Desktop migration that burns the 15s busy timeout and every
  call site swallowed the failure. Schema repair is once per connection now, and
  the three copies of `ensureMemoryContextColumn` are one function.
- **Rows written here are checked for referential integrity.** `foreign_keys` is
  a connection property, not a file property — Desktop opened with it ON and the
  terminal did not, so terminal writes skipped the check on shared tables.
- **A zero-byte database file no longer blocks first run forever.** One stray
  `sqlite3 <missing-path>` left an empty file, and every run after that read
  "already exists" and died on `no such table` with nothing visible to explain it.
- **Bootstrap schema is current again** (v81; it was a v45 snapshot from
  2026-07-07), and a mismatch with Desktop's migration target now fails a gate.
- **An engine update landing mid-run cannot mix two releases.** Core roots
  resolve to their real path, so a long run keeps the modules it started with.
  The next call still picks up the new release.
- `/ontology` says what it manages — this project's knowledge sources, not the
  engine's knowledge runtime. The command itself is unchanged.

## 1.0.12 — 2026-07-28

- **Orchestrator/worker model roles now resolve from ordered candidate
  pools.** The shared `model_role_members` table (Desktop schema v80) holds
  n candidates per role in priority order; the terminal picks the first
  member that is actually executable here, records every skipped member
  with its reason, and never silently substitutes a lower-priority runtime
  when all members are unavailable — the head member is used and the skip
  list is preserved. An empty worker pool inherits the orchestrator pool,
  matching the single-row inherit contract, and databases without pools
  keep resolving through the v79 single-row and legacy `active_runtime`
  ladders unchanged.
- **Workforce escalation is bounded and receipted end to end.** A worker
  that violates the handoff output contract twice — or is named in two
  consecutive verifier failures — gets exactly one orchestrator-role
  retry, stamped with `escalated-after-failure`, the failure count, and
  the attempt number; a failing escalation stops honestly instead of
  looping or downgrading.
- **BYOK Anthropic calls mark the system prefix as a prompt-cache
  breakpoint.** Real Anthropic endpoints receive the system prompt as one
  `cache_control: ephemeral` block (~90% cheaper cached input on hits;
  a silent no-op below the per-model minimum). Anthropic-compatible
  endpoints (GLM/Kimi/DeepSeek) keep the plain string form they expect.
- Model-allocation receipts split "no allocation was provided"
  (`allocation_not_provided`) from "the allocation was malformed"
  (`invalid_ai_allocation`), and real invocations now retain the
  provider-reported token usage per role instead of discarding it.

## 1.0.11 — 2026-07-27

- **The slash palette repaints in place instead of stacking copies of
  itself.** Every keystroke left the previous frame on screen, so a few
  arrow presses filled the terminal with duplicate palettes and pushed the
  prompt out of view. Two causes, both measured on an emulated terminal:
  the frame was drawn with the cursor saved and restored by absolute
  position, and the frame was 18 lines tall with no regard for the window.
  In a REPL the prompt sits at the bottom of the screen, so drawing below
  it always scrolls — and after a scroll the saved absolute row points at
  different content, so the next repaint erased the wrong region and left
  the old frame behind. The palette now returns to the prompt with a
  relative cursor move, which survives scrolling, and never draws a frame
  taller than the window: the list shrinks around the highlighted entry,
  and the selection detail folds away before the list does, so the
  highlighted row and the controls hint survive at any height. Verified at
  14, 18, 24 and 50 rows — one palette on screen, prompt intact.
- Quitting no longer announces a wait for commands that finish in
  milliseconds; the notice now appears only after 400ms.

## 1.0.10 — 2026-07-27

Four defects in the REPL's slash surface, all found by sweeping for the shape
that produced 1.0.8: a v2 caller using a v1-era contract.

- **Quoted arguments survive.** Slash arguments were split on whitespace, so
  the quotes the palette itself advertises (`/search "<what you need>"`) were
  passed through as part of the query — `/search "hello world"` searched for
  `"hello`. The quote-aware tokenizer the top-level CLI uses was exported but
  had no call sites; the REPL now uses it.
- **Aliases work inside the REPL.** `agentlas hep-network …` was accepted
  while `/hep-network …` answered "unknown", because alias resolution lived
  only in the top-level dispatcher. Both surfaces now resolve the same names,
  and a test pins every alias to a command that actually exists.
- **A command issued just before `/quit` is no longer discarded.** Slash
  commands are async and were fire-and-forget, so closing the prompt resolved
  immediately and the process exited mid-flight: `/search …` followed by
  `/quit` printed nothing at all, while the same pair typed 25 seconds apart
  worked. In-flight commands are now awaited — bounded at 30s, so quitting
  can never hang — and the wait is announced rather than silent.
- **The first-run wizard's language applies to the whole session.** Choosing a
  language wrote it to preferences and to `ui.lang`, but not to `ctx.lang`, so
  the banner switched while `/help`, the palette, orchestrator notices and the
  shortcut hints stayed in the OS-locale language until the next launch.

## 1.0.9 — 2026-07-27

Three repairs of one mistake, found by a live run that a 4-agent task force
(two of them managers over 8 and 10 sub-workers) completed in full before the
result was thrown away.

- **Field bounds are now stated in the prompt that must obey them.** A nested
  manager wrote a synthesis brief over 2,000 characters and the whole run —
  20 model calls, 14 minutes, every worker's finished output — was discarded
  on a contract error. The engine enforced that ceiling and had never told the
  manager it existed, so the one repair attempt it does allow failed the same
  way. Every enforced bound now appears in the stage's schema requirements
  with headroom (1,900 against a 2,000 ceiling).
- **An empty worker deliverable reaches its retry.** The corrective re-run had
  always existed but a contract assertion fired first, so it was dead code.
- **A failed nested team leaves a real ledger.** Nested executions were
  recorded only on success, so a mid-flight failure left `nestedExecutions`
  empty while 20 model calls had already been billed, and the failure receipt
  minted an `invocationId` with `crypto.randomUUID()` that had never named a
  real call. Nested runs are now written as `running` when they start and
  updated per stage; stages that never ran stay `null` rather than invented,
  and failures carry the real invocation id.

These four defects (with the verifier overflow in 1.0.7) share one shape: a
fail-closed assertion placed ahead of the repair path it makes unreachable,
enforcing a limit the other side was never told. Four regression tests pin it.

## 1.0.8 — 2026-07-27

- **Arrow keys navigate the slash palette instead of collapsing it.** Moving
  the highlight also wrote the highlighted command into the input line, and
  the candidate list is derived from that line — so the list became a function
  of the selection rather than of what you typed. Typing `/s` offered nine
  commands; two presses of Down rewrote the line to `/switch` and cut the list
  to two, leaving `/spawn`, `/steer`, `/search`, `/storm` and `/swarm`
  unreachable no matter how many keys you pressed. Arrows now move the
  highlight only and leave your query alone. Deleting the line rewrite was not
  enough on its own: readline treats Up/Down as history navigation and a
  prepended keypress listener runs first but cannot suppress that default, so
  the query is now restored if readline moved through history.

## 1.0.7 — 2026-07-27

- **The selection prompt no longer carries the whole candidate set.** Measured
  on a live 30-candidate search, the complete set was 116KB — roughly 30k
  tokens shipped on the single most expensive call of every run — while the
  leader only reads names, communities, roles and top skills to staff a team.
  Digests, package hashes and qualification evidence were paying for prompt
  space and then being re-verified in full by the Hub anyway. The leader now
  receives a projection: **2.8k tokens, a 91% reduction**, with every exact
  `agentReleaseId` preserved so the leader still authors its own exact
  selection and the Hub still validates against the complete set.
- A verifier that reports absence as `[""]`, `[null]` or `[{}]` no longer
  fails the run on a contract error; non-empty non-string issues are
  serialized rather than dropped, and oversized issues still go through the
  bounded schema repair that shortens them without losing intent.

## 1.0.6 — 2026-07-27

- **The startup banner is back.** The v2 REPL called `renderBanner` with the
  v1 contract — no `ui`, and using the return value as a string — so it threw
  a TypeError on every launch, and an argument-less `catch` disguised the
  crash as a one-line `agentlas <version>` fallback. Nobody could see it,
  including the tests. A banner contract test now guards it.
- **Per-stage model assignment.** One workforce run has stages with very
  different demands: the leader must author a large exact schema (measured:
  Haiku failed it twice in a row), while a worker writes one packet of prose
  (measured: Haiku workers produced real code patches in the SWE run). The
  engine used a single model for all of them. Stages now resolve their model
  independently:
  `AGENTLAS_WORKFORCE_MODEL_LEADER` (leader/selection/planner/refinement),
  `AGENTLAS_WORKFORCE_MODEL_WORKER`, `AGENTLAS_WORKFORCE_MODEL_SYNTHESIS`,
  `AGENTLAS_WORKFORCE_MODEL_VERIFIER`. Unset stages inherit the leader
  setting, and with nothing set the behaviour is byte-identical to before.

## 1.0.5 — 2026-07-27

- A verifier that reports "no issues" as `[""]` instead of `[]` no longer
  fails the run on a contract error. An empty string is a mis-spelling of
  absence, not content, so it is normalized away before the issue contract
  is checked — a passing verification stopped the last step of a real run
  this way.

## 1.0.4 — 2026-07-27

**The hub boundary stops guessing.** Owner decision after live runs: rules
that infer private data from shape were removed rather than tuned, because
each one refused work orders whose flagged phrase *was* the task — a slash
between Korean words read as a file path, "멱등키 설계" read as a credential
assignment, "고객 ID를 조회하는 API" read as a labeled identifier. No repair
was possible, so the request simply died.

- Gone: path inference from a slash, labeled-identifier inference, UUID/IP/
  phone shape matching, keyword-adjacency credential matching.
- Kept: forms that can only be one thing — issuer-prefixed provider tokens,
  PEM headers, JWTs, credentials embedded in a URL, email addresses.
- Those are now **redacted from the outgoing text instead of refusing the
  run**, and the redaction is printed, so a pasted secret never leaves the
  machine and the task still proceeds. `AGENTLAS_HUB_BOUNDARY=off` sends
  text verbatim.
- Upload and packaging are unchanged: they already block by file identity
  (`.env*`, `*.pem/key/p12`, `credentials*`, `id_rsa`), which is fact rather
  than inference.

Shared fixtures (`privacy-guard-fixtures/`) and `scripts/sync-privacy-guard.sh`
now pin this contract across the terminal engine and the server.

## 1.0.3 — 2026-07-27

Live `workforce` runs surfaced four defects that no unit gate could reach.

- **A slash after Korean/Japanese/Chinese text no longer reads as a file
  path.** The hub-boundary guard's absolute-path lookbehind excluded only
  ASCII, so ordinary phrases ("진단/멱등키", "한국어/영어") were rejected as
  private paths — and the phrase being the task itself meant no repair was
  possible. Shared fixtures now pin this in both this engine and the server
  (`scripts/sync-privacy-guard.sh`).
- **Bundle preparation is no longer killed by the connect timeout.** The
  15s "connect" budget actually measured time-to-response-headers, and the
  server computes a multi-slot roster before its first byte, so preparation
  died as a transport error. Workforce calls now use their own budget.
- **Selection cycle rules match the Hub exactly.** Local validation only
  checked handsOffTo/reportsTo, so a `reviews` cycle passed locally and came
  back as a Hub rejection. All relations and self-edges now count.
- **A worker that exits non-zero reports its stdout tail too**, so a failure
  whose stderr holds only unrelated warnings is no longer a dead end.

Also in this release:

- **Live narration**: a `workforce` run now prints the slot count and hub
  menu size, the picked agent per slot by name, hub acceptance, each worker
  as it starts, and the synthesis→verification transition.
- **One name per feature across platforms**: `hep-network`, `hep-cloud`,
  `hep-build`, `hep-call`, `hep-search`, `hep-upload`, `hep-storm`,
  `hep-browser`, `hep-connect` now work as terminal commands, matching the
  skill names used from Claude Code and Codex. The typo guard suggests them.

## 1.0.2 — 2026-07-27

Workforce execution-contract fixes. Every worker in a `workforce` run now
knows its exact execution authority, and the run recovers honestly instead
of shipping broken output:

- Tool-less (no-authority) workers are told explicitly that zero tools are
  granted and that the deliverable must be authored directly in the reply.
  Previously a borrowed worker was silently stripped of tools, tried to
  call them anyway, leaked raw tool-call markup into deliverables, and
  produced empty output on content-type tasks.
- Worker handoffs are gated: leaked tool-call markup or an empty
  deliverable triggers exactly one corrective re-run with a repair
  directive; a repeat violation stops the run honestly with
  `worker_output_contract_violation` (never a silent cleanup).
- A verifier rejection now triggers exactly one corrective synthesis pass
  with the verifier's issues attached, then a re-verification. A second
  rejection still fails honestly (`workforce_verification_failed`), now
  reporting both attempts' issues.
- Selection handoff graphs are validated locally for circular
  handsOffTo/reportsTo chains, so the structured repair loop fixes a cyclic
  task force before the Hub sees it (previously a `task_force_cycle`
  round-trip rejection).
- Failure display: verifier/server `issues` arrays are printed line by line
  instead of being truncated inside a capped JSON blob.

## 1.0.1 — 2026-07-27

- Fixes the two gates that failed on the v1.0.0 tag (never published):
  project bootstrap no longer applies the context-map minimum-version gate
  when probing Core capability — the real probe is
  `agentlas_cloud/project_bootstrap.py`, and a source checkout without
  version metadata (exactly what CI pins) was being filtered out, skipping
  bootstrap entirely; and the smoke gate now asserts that `doctor` produces
  a report rather than that the machine happens to have an agent CLI
  installed (`doctor` still exits non-zero when it finds problems, which is
  what scripts want).

## 1.0.0 — 2026-07-27 (tagged, not published)

- The 13,347-line v1 engine monolith is replaced by a modular v2 engine
  (one concern per module: core/ runtimes/ agents/ sessions/ ui/ commands/
  cloud/ hub/ mcp/ automation/ workforce/ storm/ experience/ project/
  hephaestus/ oberon/ cloud-assets/). The full v1 command surface (56
  commands, plus `uninstall` and `billing`) is live; nothing is stubbed and
  there are no facades. The complete v1 engine remains recoverable at git
  tag `legacy-v1-engine-snapshot`.
- Multi-session subagent orchestration (Orca) is first-class: every run —
  foreground chat, one-shot, storm/swarm worker, automation run — is a
  session owned by one orchestrator. Subagent sessions persist as Desktop
  division sub-chats (`kind='division'` + `parent_chat_id`). In the REPL:
  `/spawn /sessions /tree /s /steer /kill /rm /broadcast`; typing during a
  running turn queues steering on the resume session; ctrl-c interrupts the
  turn. Background turn completions surface as one-line notices.
- Cross-product contracts preserved and gated: shared Desktop SQLite schema
  (user_version=45) and userData; runtime-doctor 3-product parity
  (sync-runtime-doctor.sh PASS); experience taxonomy checksum;
  desktop-terminal ontology loadout v2; portable Experience Bundle v1;
  workforce ontology digests; mcp-child-launch env boundary; pinned
  Agentlas OS Core harness. The known dev-only Hephaestus root defect and
  the terminal-owned Desktop .app self-updater were removed (the latter
  belongs to Desktop; `agentlas update` is npm-channel only).
- Product-model parity with the current Desktop, not with v1: the Hub is
  borrow-first, so `install` refuses call-only listings (bookmark or
  `agentlas call`), instruction-less packages, trust grades below A/B, and
  web-only agents, with Desktop's exact wording; `uninstall` mirrors
  Desktop's firm-membership guard. Hub plugins register stdio servers
  disabled and needing approval (the table is shared with Desktop, so an
  auto-enabled row would have bypassed Desktop's own gate); remote MCP
  endpoints must be https and a real `/mcp`|`/sse` path. Automation runs
  execute in Desktop-identical hidden division sessions and skip
  hub/browser/computer-use rows without consuming the lease or the
  scheduled occurrence.
- New-user protection: an unknown one-word argument is refused with an
  edit-distance suggestion instead of being spent as a model call (a typo
  used to start an agent and run shell); Desktop-only screen names
  (site, trex, prompts, dashboard, marketplace, settings…) stop honestly;
  invalid `--permission` values are refused before any model call instead
  of being silently downgraded to read; `no_runtime` now prints the exact
  CLI install commands.
- Release validation pins Agentlas Core v1.1.67 commit
  `04258b7541f604479dc04279146a506e363ad85e` (carried from 0.9.10).
- smoke gate: 54 checks (surface, no-arg guards, fresh bootstrap, 30+
  restored/new contract tests, runtime-doctor 3-product parity) — all
  green. Verified end to end against a packed tarball installed with
  `npm i -g` into a clean prefix and a pristine userData.

## 0.9.10 — 2026-07-26

- `agentlas context refresh|refs|slice|impact|verify` now invokes the installed
  Agentlas Core module directly. Context commands no longer fall through the
  natural-language Hephaestus command route.
- Context Slice generation refreshes the project fingerprint before each
  concrete Terminal task, so a long-running Terminal session sees newly added
  or changed CommonJS, ESM, TypeScript, and JavaScript files.
- Release validation pins Agentlas Core v1.1.67 commit
  `04258b7541f604479dc04279146a506e363ad85e`, including Code Map v2 backlinks,
  functional Sitemap dependencies, and fail-closed impact verification.

- Concurrent Terminal work against the Desktop-shared SQLite database now uses
  one bounded lock policy. Every Terminal write transaction acquires writer
  authority before reading mutable shared state, preventing deferred
  read-to-write upgrades from failing with `database is locked` after a
  provider already completed the user's work.
- One-shot runs now honor the saved read/write boundary across run, firm,
  Stormbreaker, swarm, build, Workforce, and context surfaces; an explicit
  `--permission` remains a session-only override.
- `agentlas context` invokes the compatible Agentlas Core context-map
  capability directly and fails closed when it is unavailable. Older
  Hephaestus launchers can no longer reinterpret `context verify` as a Hub
  search. When multiple local Core installations coexist, Terminal now checks
  bounded version metadata and skips an earlier runtime that cannot satisfy the
  v1.1.66 context contract.
- Scheduled automation output now renders only the model's final answer instead
  of leaking Claude or Gemini stream-protocol JSON. The slash palette also
  respects a real 40-column terminal while preserving arrow-key selection.
- Top-level runtime failures follow the saved Terminal language, including
  unknown runtime names and the no-runtime-available recovery message.
## 0.9.9 — 2026-07-26

- In an explicitly initialized project, ordinary runs, firms, Stormbreaker, and
  Workforce now receive the same local Context Slice from Agentlas OS v1.1.66
  after the task is concrete. The slice carries inherited goals and constraints
  plus exact definitions, backlinks, and structurally related files without
  sending the project map to Hub or Cloud.
- Read, write, and full task permission no longer doubles as consent to create
  `.agentlas/` or edit `.gitignore`. `agentlas project status` is passive, and
  only the explicit `agentlas project init` boundary creates private project
  state after announcing the side effects.
- Workload-routing receipts now conform to the public v1 nested schema, treat a
  missing model/runtime pair as unresolved, and fail closed on unknown required
  metadata or ambiguous duplicate model identifiers.
- The shared architecture seeder is monotonic: it preserves newer or
  unparseable shared state, upgrades older state atomically, and repairs only
  missing built-ins at an equal version instead of flipping the Desktop-shared
  database back to an older Terminal bundle.
- Interactive output is append-only while a task runs, preserves long streamed
  output and scrollback through resize/cancellation, wraps command meaning at
  narrow widths, and keeps saved runtime, permission, lifecycle, and Korean/
  English status text truthful.
- Release validation targets the exact Agentlas OS v1.1.66 contract commit
  `3f6f9ac3929b9238330de18c758ba200fb371017`.

## 0.9.8 — 2026-07-25

- No more silent keyword fallback. When the connected model can't judge a route
  (no runtime, or the model timed out / returned junk), Agentlas no longer picks
  a specialist by keyword — it answers with the plain assistant and says why. The
  note distinguishes "no model connected" (connect one) from "the model didn't
  answer in time" (retry / check it), so a transient timeout isn't mistaken for a
  missing model. Image-capability routing is likewise model-only: a keyword guess
  never hijacks which runtime an agent runs on.
- The embedded Agentlas OS runtime's own judge (content-guard, pipeline,
  research, privacy) now uses this host's connected model too, via a universal
  callback — so provider/CLI users, not only local Ollama, get real judgment
  there, with no model hardcoded. Pins Agentlas OS v1.1.62.

## 0.9.7 — 2026-07-25

- Fix: the resident judge now reaches API/Ollama/BYOK runtimes, not only CLI
  subprocess runtimes. Previously, when your connected runtime was Ollama or a
  BYOK API model, every route, intent, and classification silently used the
  deterministic wordlist fallback because the judge was wired to null — so a
  non-English request the keyword lists could not read never got a model
  verdict. The judge now runs on whatever runtime you actually have connected,
  and its timeout signal aborts the underlying request cleanly.
- Fix: the judge is installed at startup, before the first routing decision.
  It was previously wired only inside the run turn, which happens after routing,
  so the very first auto-route in a one-shot always fell back.
- Routing gives the model a more generous deadline (a one-shot pre-run gate), so
  a slower local model is judged rather than frequently falling back. When it
  still cannot answer in time, the route receipt says so explicitly.

## 0.9.6 — 2026-07-25

- Agent and App Builder routing is now decided by the connected model: lexical
  scores only recruit candidates, and the model can route a request the keyword
  lists never matched (any language). The App Builder consent handshake is
  unchanged, and every route receipt says whether the connected model or the
  deterministic fallback decided.
- Whether an agent produces images (and therefore which runtime runs it) is now
  judged by the connected model from the agent's own identity, with the old
  keyword list demoted to reference hints. Conservative non-image vetoes stay.
- Task classification, routing, and image judgments all fail over to the
  previous deterministic behavior — explicitly labeled — when no connected
  model is available.
- Publication gates pin the Agentlas OS v1.1.61 runtime commit, which ships the
  same judgment-engine migration across the bundled Core runtime.

## 0.9.4 — 2026-07-23

- `plugin add` no longer registers a code-hosting page (GitHub/GitLab/Bitbucket
  repo or homepage URL) as if it were a live MCP server, even when a manifest
  row explicitly claims `transport:"http"`. A connectorless catalog entry now
  refuses honestly with its docs link instead of writing an unreachable
  server into the local MCP config.
- stdio rows (`command`+`args`+`envKeys`) from a plugin manifest now install
  correctly into the local MCP server registry.
- `plugin-add-contract` runs as part of the regular smoke suite.

## 0.9.3 — 2026-07-20

- Preserve the terminal UI spinner lifecycle through the memory-output guard,
  so completed one-shot Claude/Codex turns exit cleanly instead of throwing
  after the model result has already been printed.
- Keep Agentlas Terminal focused on independent agent and team execution; this
  release does not add an Agentlas One surface.

## 0.9.2 — 2026-07-20

- Require the installed or Desktop-bundled Agentlas Core runtime to include the
  canonical Workforce WorkOrder and Selection schemas before Terminal selects
  it. Incomplete older bundles are skipped so another valid runtime candidate
  can be used instead of failing immediately before execution.
- Pin cross-platform and npm publication gates to the same Agentlas OS v1.1.50
  commit shipped by Agentlas Desktop 0.8.58.

## 0.9.1 — 2026-07-16

- Record exactly one compact Memory Ticket receipt for every completed,
  failed, or cancelled user turn, including turns with zero durable memory
  candidates and resumed Claude/Codex sessions.
- Run semantic curation as a separate no-tools advisory pass, then apply
  deterministic privacy, permission, owner, and scope gates before any durable
  write. Read-only turns keep the central receipt but never write project files
  or durable memory.
- Add owner-isolated user-global, team, agent, and project timeline lanes with
  idempotent completion and redacted Core-compatible JSONL mirrors. Raw prompts,
  transcripts, secrets, and absolute paths are rejected from logs and payloads.
- Restrict npm artifacts to the runtime allowlist; tests, fixtures, benchmarks,
  internal docs, credentials, and signing material remain unpublished.

## 0.9.0 — 2026-07-16

- Add `agentlas plugin add <slug>` and `agentlas plugin list`. The Hub has
  advertised `npx agentlas@latest plugin add <slug>` on every catalog plugin
  and serves the manifest for it, but the subcommand did not exist, so every
  listing pointed at a command that could not run. (`agentlas install` is
  agent-only and fails with "Hub agent not found" on a plugin slug.)
- Register a plugin's MCP servers from its published manifest, separating stdio
  launch commands from remote URLs so a mixed entry cannot violate the codex
  config.toml schema and take the runtime down. Reinstalling is idempotent, and
  a plugin that ships no MCP server is refused instead of reported installed.
- Translate remaining Korean runtime messages to English across the launcher,
  doctor, parity, bootstrap schema, and tests.

## 0.8.5 — 2026-07-16

- Preserve the exact bounded, host-authored contract diagnostic in each local
  model's one allowed structured-output repair prompt. The host still never
  mutates model output or replays private stage inputs, but a model can now see
  which exact Selection, WorkOrder, or planner field failed instead of receiving
  only a generic schema error.
- Keep Codex CLI Workforce execution fail-closed before the first model or Hub
  call because Codex 0.144.4 continued to expose collaboration authority after
  every available isolation flag and an isolated `CODEX_HOME` were applied.
- Pin both release workflows to Agentlas OS v1.1.45 at immutable commit
  `49752a783e944c898ea023705104661b3beb87b2`, whose finite 23-code Hub
  coverage-gap contract accepts the live aggregate response while rejecting
  unknown or identity-bearing reasons.

## 0.8.4 — 2026-07-16

- Make Workforce Ontology the default for ordinary direct, goal-like work on
  new or untouched installs while preserving an explicit `network off` opt-out.
  Sparse legacy role/tool declarations are optional semantic evidence instead
  of accidental zero-candidate hard requirements.
- Persist every benchmark run as a scorer-ready, private JSON artifact with the
  work order, content-only candidate set, host selection, three MCP receipts,
  and real planner/worker/synthesis/verifier execution evidence.
- Give the host LLM one bounded schema-only repair attempt per structured phase
  for malformed work orders, selections, or delegation plans, plus at most two
  total semantic WorkOrder refinements from redacted required-cardinality gaps
  or one valid `requestExpansionForSlots` content-expansion decision. Each
  refinement has its own audited phase, re-searches the Hub, and supersedes the
  prior search without exposing candidate identities, content, rankings, or
  history to the refinement prompt. A repeated expansion or exhausted budget
  fails closed; Terminal never fills a missing hard field, coerces expansion
  through schema repair, falls back to a lexical router, or persists raw prior
  model output. Only the idempotent Hub search may replay once after an outer
  transport/JSON ambiguity; validation and preparation remain single-shot.
- Treat `consumes` and `produces` as exact candidate-profile declaration gates,
  not ordinary workflow handoffs, and explain each hard-skill/tool/artifact or
  entity-kind coverage gap to the same host LLM. General HR decomposition now
  keeps any explicitly named specialized domain with distinct accountability
  in its own slot instead of collapsing it into generic implementation work.
- Recompute every prepared roster row's domain-separated runtime bundle digest
  from the exact selected release identity and complete directive bundle before
  execution. Only execution-plan v5 with the explicit v4 digest-schema marker
  is accepted. The shared Python/JavaScript domain rejects numbers, lone
  surrogates, unsafe keys including `__proto__`, and non-JSON values; every row
  must expose a nonblank top-level `systemPrompt`, `instructions`, or `agentMd`.
  Directive or identity tampering now fails closed, while the sanitized nested
  runtime package hash remains separate from the AgentRelease upload package
  hash.
- Execute team releases as their declared manager and every graph worker in
  exact order, followed by manager synthesis. A missing worker, flattened team,
  unparseable manager plan, or fallback plan now rejects the v2 execution
  receipt instead of masquerading as a successful team run.
- Build the local `tools/list` inventory only after Hub discovery, bind required
  capabilities through the active host LLM, and validate the private inventory
  and capability-binding plan against the public pair-scoped receipt. Raw local
  tool inventory never crosses the Hub boundary.
- Probe Codex Workforce isolation and fail closed before the first model or Hub
  call when Codex still exposes collaboration authority. Claude workforce
  subprocesses run without inherited tool authority, API and Ollama workers are
  zero-tool, and Gemini workforce execution fails closed until equivalent
  isolation is proven. Required-tool work cannot start without an exact
  policy-filtered native grant.
- Require direct WorkOrder and Selection objects from the active host LLM and
  reject ceremonial tool-call envelopes, unknown keys, contradictory community
  exclusions, and exhaustive "everything else" exclusion lists. Explicit user
  prohibitions remain hard constraints while unused or adjacent communities do
  not become accidental disqualifiers.
- Validate every Hub CandidateSet, slot, candidate, semantic snapshot,
  evidence row, and operational card against exact keys before candidate text
  reaches the selection prompt. Candidate metadata remains explicitly
  untrusted data; unknown prompt-bearing fields fail closed. Structured repair
  receipts persist fixed error-code messages instead of fragments copied from
  rejected model output.
- Parse the Terminal Hub transport's bounded buffered `{ status, headers, text }`
  response shape at the Workforce adapter boundary. This keeps real Hub MCP
  JSON from being misclassified as invalid merely because it is not a native
  Fetch `Response` object, and is covered by an end-to-end adapter regression.
- Ordinary `/network`, `/taskforce`, and `/workforce` requests now use the
  Agent Workforce Ontology protocol. The active host LLM creates the pinned
  work order and selects exact AgentRelease IDs from the Hub candidate menu;
  Terminal only validates and executes that choice.
- Require the exact three workforce MCP calls, a real manager plan, distinct
  pinned worker executions, synthesis, verifier, and auditable receipts. Stale
  ontology versions, history or popularity influence, silent substitution,
  planner fallback, and single-model masquerading fail closed.
- Keep the retired lexical router available only through explicit
  `/legacy-network`. Cross-platform and npm release gates now exercise the
  workforce runtime contract on Agentlas OS v1.1.44 at immutable commit
  `f29381f15c0ee4f244c2bac253bbb992765bc859`, including canonical ontology
  `awo:2026-07-15.2` and its reviewed singular payment/security aliases.
- This source commit does not prove a GitHub release or npm publication; both
  remain separate immutable-tag gates.

## 0.8.3 — 2026-07-14

- Pin all release and npm publication gates to Agentlas OS v1.1.28 commit
  `d741da796289678c38fac1059f0473f271d0f7e9`. Codex, Claude Code, MCP,
  Network, owner Cloud, and Storm plugin contacts now synchronously install the
  same Core-owned project soul memory, code map, ontology runtime, CareerGraph,
  and full `.agentlas/` privacy block before agent work starts.
- Ship the repository's npm OIDC trusted-publishing workflow. It accepts only
  an exact immutable release tag, reruns the Core contracts and 45-case smoke
  suite, and verifies registry visibility without storing a long-lived npm
  publish token in GitHub.

## 0.8.2 — 2026-07-14

- Include the post-`v0.8.1` hardened execution boundary: read-only discovery
  remains passive, while the first real write/full run installs the complete
  Core-owned project soul, memory, code map, ontology, Career Graph, and
  privacy-first `.gitignore` contract.
- Fail closed when the parent AI's exact model choice is absent from live
  inventory, exceeds a cost ceiling, or lacks required capabilities/context;
  no provider alias or tier-to-model table chooses a model for the AI.
- Pin the cross-platform release gate to Agentlas OS v1.1.27 commit
  `e024b68821b28aa40c7a22c94ac3832fed4155dd`, including the Windows ACL/POSIX
  mode correction, and require the same Goal + UltraCode prompt bytes on all
  three operating systems.

GitHub and npm publication remain separate operations. The registry version is
authoritative for `npm install -g agentlas` and must be verified after publish.

## 0.8.1 — 2026-07-14

- Load the canonical, digest-addressed Stormbreaker Goal + UltraCode harness
  from Agentlas OS instead of maintaining a Terminal-local prompt variant.
- Verify byte-identical harness behavior across macOS, Linux, and Windows, and
  fail closed when the Core digest or runtime contract does not match.
- Isolate Windows test hosts and ACL-specific cleanup behavior so successful
  product assertions are not misreported as failures by platform-only process
  or temporary-directory semantics.
- Select only exact models advertised by the live host inventory; when that
  inventory is unavailable, preserve the active model instead of inventing a
  provider-specific model ID or effort level.
- Bootstrap canonical Core project memory on the first real write/full Terminal
  execution while keeping read-only and discovery commands non-mutating. The
  complete `.agentlas/` namespace is ignored and owner-only even during the
  compatibility fallback to an older Core.
- Gate the Terminal release contract on the pinned Agentlas Core
  project-bootstrap surface across macOS, Linux, and Windows.

GitHub tag: `v0.8.1`. The npm registry remained on `0.7.0`; the attempted
`0.8.1` publication was rejected by the registry's OTP gate and was never
reported as installed.

## 0.8.0 — 2026-07-13

- Added separately owned Portable Experience/Taste assets, exact loadout and
  receipt validation, privacy-filtered local experience candidates, and
  explicit Desktop loadout opt-in.
- Added system-global-first MCP planning with one-pass consent, key-presence
  checks, ordered alternatives, isolated failures, and valid empty-MCP mode.
- Added AI-authored model allocation receipts with live runtime inventory,
  exact model/effort selection, explicit pins, cost ceilings, and visible
  fallback reasons.

GitHub release: `v0.8.0`. npm publication is a separate registry action and is
not implied by the tag or GitHub asset.
