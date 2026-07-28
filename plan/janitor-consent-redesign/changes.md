# Batch S15 Changes

## Branch: `s15-housekeeper-seed` (cut from `3fe5c48` @ S14b VERIFIED tip)

## User Report (verbatim from brief)
Seed `housekeeper` as `agent_type='house'`, `classification='tiered'`, main `grok45`, backups `spark` then `haiku`.
Seed only missing values so Studio edits survive. `definition_md` contains all four locked guardrails + bounded-input contract.
No new agent-configuration schema.

## Root Cause (mechanism-level)
Housekeeper did not exist in the B09a canonical roster. B09b prunes any non-canonical agent name, so a side seed would be deleted on every open. AC28/31 require a durable house+tiered Studio-editable agent with main+2 backups and a locked prompt — delivered by extending B09a allowlist + an idempotent seed helper and SCHEMA 102→103 two-track.

## Code Changes
- `src/db/schema.ts` — `SCHEMA_VERSION` 102→103; `HOUSEKEEPER_DEFINITION_MD` (4 guardrails + bounded-input); `housekeeper` added to `B09A_CANONICAL_AGENT_SEEDS`; `applyHousekeeperSeed` (MIG1 def, default_model_id if NULL, escalations INSERT OR IGNORE pos1=spark pos2=haiku, classification=tiered).
- `src/db/database.ts` — fresh path calls `applyHousekeeperSeed` after B09b; classification map includes housekeeper; v103 migration calls seed helper.
- `src/s15-housekeeper-seed.test.ts` — fresh / idempotent / Studio preserve / v102→v103 upgrade.
- `src/b09a-roster-seed.test.ts`, `src/b09b-prune.test.ts`, `src/model-service.test.ts` — canonical count 10→11 + housekeeper name.

## Commits
- (this commit) `[batch-S15] seed housekeeper house+tiered main+2 backups | scenarios: AC28,AC31`

## Standing Rules
- HELM_SESSION_JANITOR remains 0 for the whole effort; no flag flip.
- Studio-edited definition_md / default_model_id / escalation rungs must not be clobbered by re-seed.
- House agents must stay on B09a canonical list or B09b will prune them.

## Tests
- `HELM_SESSION_JANITOR=0 npx vitest run src/s15-housekeeper-seed.test.ts src/b09a-roster-seed.test.ts src/b09b-prune.test.ts --poolOptions.forks.maxForks=2` → pass
- Related: model-service B3 AG1 + Test1/Test2 agent counts; p2-1; b1-classification → pass
- Synthetic temp DB only; no live tmux; live `data/helm.db` not written by tests

## Caveats
- Live-DB-dependent model-service case expecting model name `grok-composer-2.5-fast` may fail on this env if live models table uses different names — pre-existing, not S15 scope.
- S16 still must prove Studio tier editor for house+tiered in the UI.
