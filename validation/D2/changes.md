# D2 — Remove model-named agent rows (R-02A) — changes.md

**Batch:** D2 · **Requirement:** R-02A · **Schema:** v31→**v32** · **Branch:** main
**Lifecycle:** pre-live (Deferral OFF, ZERO-FAILING-TESTS) · **Escalation:** complexity:high [REDTEAM:standard]

## What & why
Purge the 4 model-named **stub agents** (`grok-build`, `grok-composer`, `spark`, `codex-5.4`) so
only real role agents remain in Agent Studio. The stub **models** stay (D2 touches agents only);
affected project bindings fall back to `role_defaults` (real agents).

## Files changed (6)

### `src/db/schema.ts`
- `SCHEMA_VERSION` 31 → 32.
- Removed the 3 stub agent seeds (grok-composer/spark/codex-5.4) + POCFIX1 comment from
  `applyB3AgentRoleCapabilitySeeds` so fresh DBs seed only the 9 real role agents.
  (`grok-build` was never seeded as an agent — line 443 is a *models* seed.)

### `src/db/database.ts`
- Added the **v32 purge migration**: resolve the 4 stub ids by name (env-safe), delete their
  stale `role_bindings` first (agents FK is `ON DELETE RESTRICT`), then delete the stub agents.
  Guarded with `hasTable('agents')`/`hasTable('role_bindings')` (GREEN-1 pattern) — required for
  synthetic fixtures that lack the agents table (caught by the v29→v30 fixture test).

## [REDTEAM] deviations from the brief's literal instructions (approved scope expansion)

**1. Placement — v32 block at the END of the migration runner, NOT "after the v31 block".**
Migration blocks run in **file order, not version order**. There is a `COMMIT` mid-runner, and
*after* it the **v22 block re-seeds the 3 stubs** (`INSERT OR IGNORE`). The brief's "after v31"
spot is *before* v22 → a DB migrating from <22 would delete then immediately resurrect the stubs.
Placing the purge last makes it the final word for **any** source version. (Proved by D2 Test 3.)

**2. Scope expansion — 4 affected tests beyond the brief's 3-file list.** The purge breaks tests
that asserted the stubs are present / that migration never loses agents. Coordinator approved
expanding scope (callbacks.md, NEEDS-INFO → APPROVED-PLAN). Tests updated to the post-D2 state:
- `src/model-service.test.ts` — repurposed the "POCFIX1 v21→v22 live mig seeds stubs" test to assert
  the stubs are **purged** (models retained); changed the B3 test from 12→9 agents (stubs absent).
- `src/services/run-orchestrator-service.test.ts` — the "3 agents selectable" assertions now expect
  real role agents present + stubs absent. (Red-team `roleBindings` use the binding's model string
  directly — PanelService does no agent-by-name lookup — so those assertions were unaffected.)
- `src/p2-1.test.ts` (×2 migration tests) + `src/services/plumbing-watcher.test.ts` — the
  "migration preserves all agents" count assertions now allow the intended ≤4-stub purge
  (`postStubAgents===0`, `preAgents-4 ≤ post ≤ preAgents`); the MIG1 def_md sample now picks a
  **non-stub** survivor (the old `LIMIT 1` hit deleted stub id=1).

**Path note:** test file is `src/model-service.test.ts` (brief said `src/db/...`).

## Tests added (`src/model-service.test.ts`, new `describe('D2 R-02A …')`)
- Test 1: fresh DB seeds NO stub agents (9 real agents).
- Test 2: v31→v32 migration removes the 4 stubs + their role_bindings; role_defaults (9) + real agents intact.
- Test 3 (REDTEAM): v21→v32 migration does NOT resurrect stubs — proves the v22 re-seed can't win over the end-of-runner purge.

## Live DB applied + verified (`data/helm.db`, gitignored)
Ran the real migration once (30→32): `schema_version=32`, stub agents **0**, role_defaults **9**,
agents **11** (real only), dangling role_bindings **0**, stub models retained **3**. Backed up + verified, backup removed.
