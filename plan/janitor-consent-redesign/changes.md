# S07 changes — owner backfill v102 (AC5)

## Root cause / objective
S04 added nullable `helm_sessions.owner`; S05 gates new creates with explicit authority. Pre-existing rows remain `NULL`, so any candidate query that does not structurally filter `owner='helm'` can still surface human/legacy/null seats for automatic paths. AC5 requires a one-time fail-safe backfill plus query-level Helm-owned selection.

## Mechanism
1. **`deriveSessionOwner(name, kind?)`** — pure fail-safe classifier:
   - `human` only for proven human shapes (`helm-discovery-*`, `helm-chat-*`, batch-role discovery, or `kind=discovery`)
   - `helm` only for proven agent name shapes (plancore/ibrain/preflight/workers/batch roles/tests) or proven kind + `helm-` prefix
   - everything else → closed sentinel `legacy:unknown` (prefer under-attribution)
2. **Two-track `SCHEMA_VERSION` 101→102** — `schema.ts` constant + `database.ts` guarded block (no new column DDL; data migration only).
3. **v102 migration** — `UPDATE … WHERE owner IS NULL` using `deriveSessionOwner` (single source of truth); already-set owners never rewritten; version stamp 102; second open idempotent.
4. **`listHelmOwnedCandidates()`** — SQL `WHERE owner = 'helm'` only; structurally excludes human / legacy:unknown / null.

## Code changes
- `src/services/session-registry-service.ts` — `deriveSessionOwner`, `listHelmOwnedCandidates`
- `src/db/schema.ts` — `SCHEMA_VERSION = 102`
- `src/db/database.ts` — v102 guarded backfill importing `deriveSessionOwner`
- `src/services/session-registry-service.test.ts` — S07 fixture + query exclusion; S04 migrate fixture updated for post-S07 backfill of proven worker

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged (not flipped)
- Synthetic/copied fixtures only; live `data/helm.db` mtime asserted untouched in S07 suite
- No live tmux reaping; no janitor enable

## Out of scope
- S08 tmux activity/attached readers
- Reaper decision wiring (S11/S12)
- CHECK tightening to non-null

## Test status
- `npx tsc --noEmit -p .` → **exit 0**
- `HELM_SESSION_JANITOR=0 npx vitest run src/services/session-registry-service.test.ts --poolOptions.forks.maxForks=2` → **34 passed** (includes S07 deriveSessionOwner table, v101→v102 reality-shaped fixture + idempotent re-open, listHelmOwnedCandidates exclusion, updated S04 migrate fixture)
