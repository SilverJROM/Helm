# A1 fix-cycle test-report.md

Date: 2026-07-30

## Required A1 Gate

```bash
HELM_DB_PATH=/tmp/helm-a1-fix-<ts>.db npx vitest run src/services/run-orchestrator-planning-terminal-a1.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

## Regression Checks

```bash
HELM_DB_PATH=/tmp/helm-a1fix-a2-<ts>.db npx vitest run src/services/worker-runtime-finalize-a2.test.ts
HELM_DB_PATH=/tmp/helm-a1fix-a4-<ts>.db npx vitest run src/services/run-orchestrator-planning-cycle-a4.test.ts
npx tsc --noEmit -p tsconfig.json
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
```

Results:
- A2 update-only finalizer: 4/4 passed.
- A4 planning-cycle terminalization: 5/5 passed.
- TypeScript: exit 0.
- Raceguard count: `3`.

## I-P0 Slice Recheck

```bash
HELM_DB_PATH=/tmp/helm-ip0-recheck-<ts>.db npx vitest run \
  src/a0-convene-race-regression.test.ts \
  src/services/plan-revision-b1.test.ts \
  src/services/real-transport-unique-seat-c1.test.ts \
  src/planning-regression-index.test.ts \
  src/services/run-orchestrator-planning-terminal-a1.test.ts \
  src/services/worker-runtime-finalize-a2.test.ts \
  src/services/worker-runtime-finalize-a3.test.ts \
  src/services/run-orchestrator-planning-cycle-a4.test.ts \
  src/services/planning-phase-reap-before-finalize-a5.test.ts \
  src/services/planning-phase-one-terminal-owner-a6.test.ts
```

Result:

```text
Test Files  10 passed (10)
Tests       46 passed | 7 skipped (53)
```
