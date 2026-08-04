# Requirement Matrix

| AC | Scope | Slice(s) | Status |
|---|---|---|---|
| 1 | Teardown terminalizes only this run's implementation brain; no implementation assertion before execution. | A1 | PENDING |
| 2 | Teardown never registers missing runtime and never defaults provider/model to unknown. | A2 | PENDING |
| 3 | Teardown never reconciles the global session registry by inferred session name. | A3 | PENDING |
| 4 | Failed planning run does not set cycle complete or freeze topology. | A4 | PENDING |
| 5 | Planning workers are transport-cleaned before DB finalize. | A5, A6 | PENDING |
| 6 | Partner verdicts carry the SHA-256 of the reviewed plan bytes. | B1, B2, B3 | PENDING |
| 7 | Agreement accepts only all seats CLEAN for current plan hash. | B5 | PENDING |
| 8 | Verdict parsing fails closed on malformed/stale verdicts. | B3, B4 | PENDING |
| 9 | Non-convergence returns a typed blocked reason and never throws. | B6 | PENDING |
| 10 | planning_round_cap means integer rounds, not timeout multiplier. | C4 | PENDING |
| 11 | Engine drives artifact-ready, review, revise, fresh seats and blocked exit. | C2, C3, C4, C5, C6, C8 | PENDING |
| 12 | PLAN-READY is not agreement; only engine grants ingest permission. | C9 | PENDING |
| 13 | Partner seats have unique disk and transport identity. | C1, C5 | PENDING |
| 14 | Partners receive canonical plan location explicitly. | B2 | PENDING |
| 15 | Reviewer seats get first-callback/submit watchdog. | C7 | PENDING |
| 16 | Plan ingestion is transactional. | C10 | PENDING |
| 23 | Token-free tests cover historical failures. | A0, A1, A2, A3, B5, C3, C7, C8, D12 | PENDING |

AC17-22 are D1-D11/P3 scope and deferred by JROM for this effort.
