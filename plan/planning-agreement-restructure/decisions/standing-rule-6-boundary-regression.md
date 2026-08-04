# Standing Rule 6 — Boundary Regression Gate

Date: 2026-07-30

Instruction from north:

Before declaring any phase ready (`I-P1`, `I-P2`), rerun every previously verified slice that shares a file or a semantic boundary with anything landed since it was verified.

Per-slice green at verification time is necessary but not sufficient.

Concrete P1 gate:
- `B3`, `B4`, `B5`, and `B6` write `src/services/planning-phase-service.ts`.
- `A0`, `A5`, and `A6` share that file or semantic boundary.
- Therefore I-P1 must rerun `A0`, `A5`, and `A6` in addition to the P1 B-slice gates.

Rationale:

A2 invalidated A1 after initial A1 verification and the P0 boundary gate failed to rerun A1 before P0-ready. That was a stale green. This rule prevents another phase-ready declaration from relying only on stale per-slice results.
