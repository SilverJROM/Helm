# review.md — Batch C1 (implementer self-check)

**Verdict:** READY for independent validator  
**AC13:** Unique seat identity on disk and in transport for concurrent same-role reviewers.

## Checklist

| Check | Status |
|-------|--------|
| Collision seam is RealTransport `prompts/${role}.brief.md` (not artifacts.writeBrief) | Confirmed — artifacts already unique; transport was the clobber |
| Pure helper + spawn write only | Yes |
| External role semantics preserved | Yes — return/dispatch role unchanged |
| Default bare-role path backward compatible | Yes — `${role}.brief.md` when no batchId/seat/round/attempt |
| Partner distinct batchIds uniquify path without PPS edit | Yes |
| Additive optional params (`seatId`, `round`, `briefFileName`) | Yes |
| No `planning-phase-service.ts` / `index.ts` / schema edits | Yes |
| Own new unit-test file is the gate | Yes — 9/9 PASS |
| No schema version invented | N/A |

## Residual risk for later slices

- PPS may later pass explicit `seatId` / `briefFileName` for clearer audit names; not required for uniqueness once partner `batchId`s differ (already true).
- Callers that hardcoded `prompts/<role>.brief.md` after a RealTransport spawn **with** `batchId` will need the composed name; dispatch itself receives the absolute path and is unaffected.

## Evidence

See `test-report.md` — vitest green on the C1-only file.
