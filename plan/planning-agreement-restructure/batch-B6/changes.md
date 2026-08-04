# changes.md — B6: return typed blocked reason before canonical plan read

**Batch:** B6
**AC:** 9
**Branch:** `fix/planning-agreement-restructure`
**Status:** VERIFIED by coordinator fix cycle

## Mechanism

`runPlanningPhase` already computed `agreed = await waitForAgreement(...)`, but the blocked-path check lived after canonical plan polling and read/validation. A genuine non-convergence result could therefore be masked by `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` or by reading a plan that was never agreed.

B6 moves the `if (!agreed)` return immediately after `waitForAgreement` and before the grace sleep, canonical poll, canonical read, materialization, or ingest. The blocked result returns a stable `ROUND-CAP-EXHAUSTED...` reason and `plan: { tasks: [] }`.

A boundary fix also preserves A6's thrown terminal class: if seats signal CLEAN/PLAN-READY but the current canonical plan bytes are absent/unreadable, `waitForAgreement` may allow the flow to reach the canonical read, which then throws and exercises A6 cleanup. Missing current bytes are not handed off because ingest still requires a successful canonical read.

## Files changed

- `src/services/planning-phase-service.ts`
- `src/services/planning-phase-nonconvergence-b6.test.ts`

## Notes

The original B6 worker was stranded by a network/API outage before terminal callback. Coordinator fix cycle settled the worker, reproduced the 2/1 failing B6 test, fixed the test harness timing around real-path first-callback fencing, and fixed the A6 boundary collision without editing A6.
