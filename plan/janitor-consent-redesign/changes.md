# S11 changes — pure reconcile decision (AC14/18/25/26)

## Root cause / objective
The legacy janitor treated `run_id == null` as “done” (F3) and used idleness/TTL as kill
authority — E5 class. North-star: **reap only when Helm asserted completion** (`status=idle`),
or **converge** when the session is already gone. Never human/legacy/unasserted. S11 is the pure
decision model only; S12 wires `sessionJanitorTick`.

## Mechanism
1. **Pure** `decideSessionReconcile(row, facts)` → `{ action: REAP|CONVERGE|KEEP, reason }`.
2. **Priority (keep-biased):**
   - `status === reaped` → `KEEP` (`already_reaped`)
   - `owner !== helm` → `KEEP` (`owner_not_helm`) — human / legacy / null
   - `sessionExists === false` → `CONVERGE` (`session_gone`) — AC14, no kill
   - `sessionExists == null` → `KEEP` (`session_unknown`)
   - `status !== idle` → `KEEP` (`unasserted`) — AC8/26
   - helm + idle + live → `REAP` (`asserted_complete_live`) — AC25
3. **`run_id` is never authority** (AC18): explicitly `void`ed; F3 null clause deleted from model.
4. No idle-age / TTL / run-terminal inputs. No tmux, no DB, no writes.

## Code changes
- `src/services/session-reconcile-decision.ts` — pure decision + stable reasons
- `src/services/session-reconcile-decision.test.ts` — exhaustive table + AC18 pairs + source guards
- `plan/janitor-consent-redesign/changes.md` — this file

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged in `.env` and `ecosystem.config.cjs`
- Synthetic facts only; no live tmux; no live `data/helm.db` mutation
- No janitor tick wiring (S12); no housekeeper; no flag flip

## Out of scope
- S12 wire into `sessionJanitorTick` / retire legacy F3 + TTL kill path
- S13 shadow mode, S14 human close, S18 housekeeper

## Test status
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**
- `HELM_SESSION_JANITOR=0 npx vitest run src/services/session-reconcile-decision.test.ts --poolOptions.forks.maxForks=2` → **23 passed**
