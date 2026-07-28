# S10 changes — observed idle helper (AC16/17/18, AC21 trigger, AC26)

## Root cause / objective
Idleness must be **observed** from DB + tmux facts (`max(last_used_at, session_activity)`), never from
`last_used_at` alone. Attached seats are never candidates. `run_id IS NULL` is normal for chat seats and
is not abandonment. Observation may only **trigger investigation** — never REAP (S11 owns decisions;
S12 owns janitor wiring).

## Mechanism
1. **Pure** `observeSessionIdleness(facts)` in `session-observation.ts` — no tmux I/O, no DB writes.
2. **effectiveActivityMs** = max of parseable `last_used_at` (fallback `created_at`) and S08
   `session_activity` (epoch seconds → ms). Missing sides ignored, never coerced to 0.
3. **Priority rules:**
   - `attached === true` → `KEEP` (`attached_excluded`) — AC17
   - `attached === null` → `KEEP` (`attached_unknown`) — fail-safe
   - no usable activity → `KEEP` (`missing_activity_facts`)
   - idle age < hours-scale threshold (default 4h) → `KEEP` (`within_idle_threshold`)
   - else → `INVESTIGATE` (`hours_idle_anomaly`) — AC21/26
4. **Return union** is only `KEEP | INVESTIGATE` — REAP is not representable.
5. **`runId` is never authority** (AC18): null neither forces INVESTIGATE nor blocks a positive idle signal.

## Code changes
- `src/services/session-observation.ts` — pure helper + timestamp normalizers + DEFAULT_IDLE_THRESHOLD_MS
- `src/services/session-observation.test.ts` — table tests (stale/fresh cross, attached, null run, unknown,
  hours-idle INVESTIGATE, no-REAP source guard, HELM_SESSION_JANITOR=0)

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged in `.env` and `ecosystem.config.cjs`
- Pure/synthetic facts only; no live tmux; no live `data/helm.db` mutation
- No janitor tick wiring, no S11 decision fn, no housekeeper spawn

## Out of scope
- S11 pure `REAP | CONVERGE | KEEP` decision
- S12 `sessionJanitorTick` / startup reconciliation wiring
- S18 housekeeper dispatch / investigation table
- Flag flip to enable janitor

## Test status
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**
- `HELM_SESSION_JANITOR=0 npx vitest run src/services/session-observation.test.ts --poolOptions.forks.maxForks=2` → **16 passed**
