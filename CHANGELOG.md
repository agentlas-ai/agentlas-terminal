# Changelog

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
