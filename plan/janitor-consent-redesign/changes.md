# S12 changes — wire reconcile into janitor tick (AC6-inv/14/27)

## Root cause / objective
S11 landed pure `decideSessionReconcile` but `sessionJanitorTick` still killed on
TTL age, run-terminal “done”, and `run_id == null` orphan (E5/F3 class). S12 wires
the assertion-based decision into the tick + startup sweep and retires those kill
heuristics while preserving hard safety rails.

## Mechanism
1. **`sessionJanitorTick`** (and startup via same path):
   - Gate: `HELM_SESSION_JANITOR === false` → inert.
   - Candidates: registry rows with `status != 'reaped'` only.
   - Prefix: skip unless `name.startsWith('helm-')`.
   - Existence: `sessionExistsTriState` → `true|false|null` (unknown → KEEP).
   - **Decision:** `decideSessionReconcile(row, { sessionExists })`.
   - **KEEP** → no-op.
   - **CONVERGE** → `markReaped` only, **zero** `terminateSession` (AC14/27).
   - **REAP** → vetoes then kill:
     - live worker (`launching|running`) → KEEP
     - non-terminal mapped run → KEEP
     - `@helm_child` missing/throw → KEEP
     - else targeted `terminateSession` + `markReaped(reconcile:…)`
2. **Retired kill authority:** `HELM_SESSION_TTL_MS` / age, run-terminal as “done”,
   `run_id == null` orphan path. TTL config left in place for S13; tick no longer reads it.
3. **`sessionExistsTriState`** on `TmuxService`: fail-safe tri-state for the reconciler
   (boolean `sessionExists` still collapses error→false for other callers).

## Code changes
- `src/services/worker-service.ts` — rewrite janitor tick + probe helper; startup reuses tick
- `src/tmux/tmux-service.ts` — `sessionExistsTriState`
- `src/services/session-registry-service.test.ts` — S12 fake-tmux matrix (rewrite SL-R3 suite)
- `plan/janitor-consent-redesign/changes.md` — this file

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged in `.env` and `ecosystem.config.cjs`
- Synthetic DB + fake tmux only; no live tmux targets; live `data/helm.db` mtime unchanged
- No broad kill paths; no S13 shadow enum; no flag flip

## Out of scope
- S13 `off|shadow|on` parsing
- S14 human manual close
- Housekeeper / enabling janitor in deploy

## Test status
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**
- `HELM_SESSION_JANITOR=0 HELM_DB_PATH=/tmp/… npx vitest run src/services/session-registry-service.test.ts src/services/session-reconcile-decision.test.ts --poolOptions.forks.maxForks=2` → **66 passed** (43 registry/S12 + 23 S11)
- Live `data/helm.db` mtime/size unchanged across the run
