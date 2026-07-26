# Changelog

## 0.9.10 — 2026-07-26

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
