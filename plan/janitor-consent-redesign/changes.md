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
     - **attached true or unknown** → KEEP (S12-V1; only `attached===false` proceeds)
     - `@helm_child` missing/throw → KEEP
     - targeted `terminateSession` then `markReaped` **only on success**
     - terminate throw + still live/unknown → **leave retryable** (S12-V2)
     - terminate throw + re-probe gone → `markReaped(reconcile:session_gone)`
2. **Retired kill authority:** TTL / age, run-terminal as “done”, `run_id == null` orphan.
3. **`sessionExistsTriState` (S12-V3):** only explicit missing-session/no-server messages
   → `false`; generic exit code 1 without that evidence → `null` (never over-CONVERGE).

## Attempt 2 corrections (val L3 FAIL → fix)
- **V1:** REAP path calls `sessionAttached`; true/unknown keep-biased KEEP.
- **V2:** no `markReaped` after failed terminate unless re-probe proves gone.
- **V3:** drop bare `err.code === 1` → false mapping.
- Synthetic regressions for each.

## Code changes
- `src/services/worker-service.ts` — tick + attached probe + terminate/markReaped policy
- `src/tmux/tmux-service.ts` — narrowed `sessionExistsTriState`
- `src/services/session-registry-service.test.ts` — S12 matrix + V1/V2 cases
- `src/tmux/tmux-helm-child-tag.test.ts` — S12-V3 production classifier cases
- `plan/janitor-consent-redesign/changes.md` — this file

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged in `.env` and `ecosystem.config.cjs`
- Synthetic DB + fake tmux only; no live tmux; live `data/helm.db` untouched
- No S13 shadow enum; no flag flip

## Test status
- `npx tsc --noEmit -p tsconfig.json` → exit 0 (re-run on commit)
- Focused vitest with temp DB + `HELM_SESSION_JANITOR=0` (re-run on commit)
