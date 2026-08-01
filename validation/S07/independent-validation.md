# S07 Independent Validation

Validator: L2 independent
HEAD: `37187c6`
Scope: AC 22-25
Cycle: 13
Redteam: not requested
Verdict: PASS

## Test Command

```bash
HELM_SESSION_JANITOR=0 npx vitest run src/s07-seat-preview.test.ts
```

Result: PASS

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

## Acceptance Criteria Check

- AC22: PASS. A no-run cycle returns a pre-start seat preview from the S05 staffing manifest, including plancore, two configured co-planner seats, and a stable digest instead of an empty runtime-only response.
- AC23: PASS. Unavailable configured seats return a typed blocked preview row with the configured model preserved and no invented fallback seat.
- AC24: PASS. Post-start runtime rows are mapped against preview identities; matching plancore and co-planner worker runtimes produce `matchesPreview`, preview role/slot mapping, and a true digest/identity match.
- AC25: PASS. The owner-guarded cycle seats endpoint exposes the enriched preview/readiness shape while preserving the runtime `seats` list behavior.

## Evidence

- `src/services/cycle-seat-preview.ts:46` defines the full readiness DTO with preview, runtime, blocked, digest, and empty-panel fields.
- `src/services/cycle-seat-preview.ts:86` maps the S05 `PlanningStaffingManifest` into public preview rows.
- `src/services/cycle-seat-preview.ts:113` maps `worker_runtimes` rows back to preview identities and reports digest/identity match state.
- `src/services/cycle-seat-preview.ts:187` builds the read-only cycle readiness response via `PlanningStaffingService` with non-throwing empty/mismatch behavior.
- `src/index.ts:1880` registers owner-guarded `GET /api/cycles/:id/seats`.
- `src/index.ts:1886` reads runtime rows for the cycle from `worker_runtimes`; `src/index.ts:1922` enriches them with the S05 preview; `src/index.ts:1932` returns the backward-compatible `seats` list plus preview/readiness fields.
- `src/s07-seat-preview.test.ts:88` verifies no-run preview output; `src/s07-seat-preview.test.ts:118` verifies unavailable-slot blocking; `src/s07-seat-preview.test.ts:148` verifies runtime identity mapping; `src/s07-seat-preview.test.ts:217` verifies HTTP preview response shape.

## Conclusion

S07 passes independent validation at HEAD `37187c6`: the requested focused Vitest suite is green with `HELM_SESSION_JANITOR=0`, and the code/test evidence covers AC 22-25 without implementation changes.

## Callback Emission

Requested callback:

```bash
PROJCORE_CALLBACKS_FILE=/home/agjrom/websites/Helm/plan/discovery-planning-handoff/callbacks.md ~/.codex/skills/projcore/lib/projcore-emit-status.sh validator S07 PASS "37187c6 independent PASS: focused vitest 4/4; AC22-25 verified"
```

Result: BLOCKED by the Codex-owned emitter before append.

```text
FATAL: STATE 'PASS' not in validator enum. Allowed: WORKING REPRO-CONFIRMED REPRO-FAILED REPRO-CLEARED-ON-LOCAL REPRO-STILL-PRESENT BLOCKED NEEDS-INFO
```

The independent validation verdict remains PASS. No manual callback line was appended outside the requested emitter.
