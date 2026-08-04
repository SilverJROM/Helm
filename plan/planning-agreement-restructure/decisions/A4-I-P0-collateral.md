# A4 / I-P0 Collateral Note

Date: 2026-07-30

Decision: Verify A4 on its own gate and carry the newly surfaced A1/A2 collateral to I-P0 instead of editing another stream's already-verified test file.

Facts:
- A4 dedicated gate passed: `src/services/run-orchestrator-planning-cycle-a4.test.ts` 5/5.
- Raceguard count stayed `3`.
- Target TypeScript check found no errors in `run-orchestrator-service.ts` or the A4 test.
- `src/services/run-orchestrator-planning-terminal-a1.test.ts` now has 2 failures in its executing-failure worker-row assertions.
- The failures match A2's update-only finalizer behavior: the A1 test expected a synthesized `worker_runtimes` row instead of pre-inserting a real one.
- A4 did not edit the A1 test because the A4 scope gate was `run-orchestrator-service.ts` plus one new A4 test only.

I-P0 ask:
- Decide whether the integration gate should include a small reconciliation slice that updates A1/A15 expectations to pre-insert/assert real worker rows under A2's update-only contract before P1 dispatch resumes.
