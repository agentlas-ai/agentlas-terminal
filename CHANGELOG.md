# Changelog

## 0.8.1 — 2026-07-14

- Load the canonical, digest-addressed Stormbreaker Goal + UltraCode harness
  from Agentlas OS instead of maintaining a Terminal-local prompt variant.
- Verify byte-identical harness behavior across macOS, Linux, and Windows, and
  fail closed when the Core digest or runtime contract does not match.
- Isolate Windows test hosts and ACL-specific cleanup behavior so successful
  product assertions are not misreported as failures by platform-only process
  or temporary-directory semantics.
- Initialize every active project through the canonical Agentlas OS first-contact
  contract before Terminal work begins. The shared Core owns `.gitignore`
  privacy, project soul, memory and code maps, ontology, and Career Graph;
  Terminal's older merge-only seeder is only a compatibility fallback when an
  older Core is installed.
- Remove vendor model alias tables and first-in-tier model selection. The parent
  AI must choose an exact model and runtime from live inventory; Terminal only
  validates pins, cost tier, capability, context, and effort, and otherwise
  preserves the active model.

GitHub release and npm package: `v0.8.1` / `agentlas@0.8.1`. Both are built
from the exact immutable tag.

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
