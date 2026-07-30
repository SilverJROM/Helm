# test-report.md — B3

## Dedicated B3 gate

```
HELM_DB_PATH=/tmp/helm-b3-$$.db npx vitest run src/services/planning-phase-verdict-parser-b3.test.ts
```

**Result:** 12/12 passed.

Coverage:
- em dash (—), hyphen (-), en dash (–), colon (:) separators all parse (including the two
  forms — en dash and colon — that previously returned `null`).
- no-note `PLAN-READY` still parses (`note: null`).
- malformed lines (bad bracket prefix, `STATE:` instead of `STATUS:`, lowercase state token)
  still return `null`.
- `plan=<12 lowercase hex>` extracts into the new `planSha` field, across all four separator
  forms.
- `planSha` is `null` (never throws) when the note is absent, has no `plan=` token, the hex
  run is shorter than 12 chars, or the hex is uppercase (grammar is lowercase-only per
  `plan-revision.ts`'s `short12`).

## Regression sweep

```
HELM_DB_PATH=/tmp/helm-b3-regress-$$.db npx vitest run \
  src/services/planning-phase-service.test.ts \
  src/services/planning-phase-one-terminal-owner-a6.test.ts \
  src/services/planning-phase-reap-before-finalize-a5.test.ts \
  src/services/run-orchestrator-planning-terminal-a1.test.ts \
  src/services/plan-revision-b1.test.ts \
  src/services/brief-writer-panel-plan-contract-b2.test.ts
```

**Result:** 6 files, 51/51 tests passed.

## Typecheck

```
npx tsc --noEmit -p .
```

**Result:** clean, no errors.

## Race-guard pin

```
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
```

**Result:** `3` (unchanged, before and after edit).
