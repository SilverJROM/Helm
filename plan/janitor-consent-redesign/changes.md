# S04 changes — helm_sessions.owner column (AC1)

## Root cause / objective
Binary decision authority is not stored on the session registry. Without `owner`, the reconciler cannot structurally exclude human/legacy seats. S04 adds the column and threads types; S05 refuses create without owner; S07 backfills legacy rows.

## Mechanism
1. **`SessionOwner`** = `helm` | `human` | `legacy:unknown`
2. **Two-track DDL** `SCHEMA_VERSION` 100→101:
   - Fresh: `schema.ts` `helm_sessions.owner` with CHECK `(owner IS NULL OR owner IN (...))`
   - Upgrade: `database.ts` v101 guarded `ALTER TABLE … ADD COLUMN` same CHECK
3. **Types**: `RegisterOpts.owner?`, `TmuxSessionCreateOpts.owner?`, `HelmSessionRow.owner: SessionOwner | null`
4. **UPSERT**: `owner = COALESCE(excluded.owner, helm_sessions.owner)` so recreated names never silently drop authority
5. Existing rows may stay **null** until S07; janitor stays off

## Code changes
- `src/db/schema.ts` — SCHEMA_VERSION 101 + owner column
- `src/db/database.ts` — v101 migration
- `src/services/session-registry-service.ts` — SessionOwner, RegisterOpts, INSERT/UPSERT
- `src/tmux/tmux-service.ts` — TmuxSessionCreateOpts.owner
- `src/services/session-registry-service.test.ts` — S04 synthetic suite

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged (`.env` + `ecosystem.config.cjs`)
- Synthetic DB only; live `data/helm.db` mtime asserted untouched in tests
- No create-path refusal (S05); no backfill (S07)

## Test status
`npx vitest run src/services/session-registry-service.test.ts --poolOptions.forks.maxForks=2` → **30 passed**  
`npx tsc --noEmit -p .` → **exit 0**  
Live `data/helm.db` mtime asserted untouched by S04 suite.
