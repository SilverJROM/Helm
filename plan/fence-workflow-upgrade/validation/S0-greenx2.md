# S0 — suite-band green×2 evidence

**Slice:** S0 (suite-band pre-existing redness)
**Implementer:** tiller/S0
**Date:** 2026-08-08

## Scope delivered (pre-landed + verified)

| Item | Status | Commit / mechanism |
|------|--------|--------------------|
| Isolate vitest forks from shared HELM_DB_PATH | OK | `src/test-setup.ts` unique per-pid path; suite-cmd temp SUITE_DB |
| v89 role-table rebuild CHECK (post-B3 branch-safety) | OK | `5d918bb` filter INSERT…SELECT to v89 vocabulary |
| Guard models-table seeds | OK | `5d918bb` `applyB09a` hasModels guard |
| Smoke defaults hermeticity | OK | `647b5bf` clear HELM_HOST/PORT; suite-cmd pins |
| D9 baseline residual exclusion (35 files) | OK | `5b6ed39` + `dispatch/s0-residual-failures.txt` |
| Exclude plan-time OPEN journeys | OK | `7c2ced0` / `baaca2d` `**/*.integration.test.ts` |

## Green×2 (this implementer seat)

Command: `bash .tiller/suite-cmd.sh`

| Run | Exit | Files | Passed | Failed | Duration | Log |
|-----|------|-------|--------|--------|----------|-----|
| green1 | 0 | 254 | 2125 | 0 | 383s | `/tmp/s0-impl-green1.log` |
| green2 | 0 | 254 | 2125 | 0 | 386s | `/tmp/s0-impl-green2.log` |

Not A1 product. Residual debt outside the gate remains in north-star §8 / D9.
