# test-report.md — B6

## Dedicated B6 gate

```
HELM_DB_PATH=/tmp/helm-fix3-b6-$$.db npx vitest run src/services/planning-phase-nonconvergence-b6.test.ts
```

Result: 3/3 passed.

Covers:
- no partner agreement returns typed blocked result and does not canonical-poll/read;
- B5 current-plan SHA mismatch returns typed blocked result and does not surface the unagreed plan;
- agreed success path still reads/ingests canonical `plan.md`.

## Rule-6 shared-boundary gate

```
HELM_DB_PATH=/tmp/helm-verify-b6-boundary2-$$.db npx vitest run \
  src/a0-convene-race-regression.test.ts \
  src/services/planning-phase-reap-before-finalize-a5.test.ts \
  src/services/planning-phase-one-terminal-owner-a6.test.ts \
  src/services/plan-revision-b1.test.ts \
  src/services/brief-writer-panel-plan-contract-b2.test.ts \
  src/services/planning-phase-verdict-parser-b3.test.ts \
  src/services/planning-phase-newest-verdict-b4.test.ts \
  src/services/planning-phase-current-plan-sha-b5.test.ts \
  src/services/planning-phase-nonconvergence-b6.test.ts
```

Result: 9 files, 44/44 passed.

## Typecheck

```
npx tsc --noEmit -p tsconfig.json
```

Result: exit 0.

## Raceguard

```
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
```

Result: 3.
