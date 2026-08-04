# B2 — test report

## Gate command (per brief)

```
HELM_DB_PATH=/tmp/helm-b2-$$.db npx vitest run src/services/brief-writer-panel-plan-contract-b2.test.ts
```

Result: **2/2 passed**.

- `generatePanelBrief` names the absolute plan.md + og-requirements.md paths and the
  expected revision when plan.md is readable — asserts `Plan: <abs plan.md>`,
  `Canonical plan.md: <abs>`, `Canonical og-requirements.md: <abs>`, the exact `sha256=` and
  `short12=` values (computed independently via B1's `planRevision()` on the same bytes),
  and the absence of the literal `Plan: plan.json` string.
- `generatePanelBrief` fails closed in the generated contract text when plan.md is missing
  or unreadable — asserts the absolute canonical paths are still stated, plus
  `Expected plan revision: UNAVAILABLE`, `FAIL CLOSED`, and `do NOT emit a verdict yet`, and
  the absence of `Plan: plan.json` / any `sha256=`.

## Type check

`npx tsc --noEmit -p .` — clean, no errors.

## Regression sweep (existing `generatePanelBrief` consumers)

Ran every existing test file that calls `generatePanelBrief`, since the change touches a
shared method used by `panel-service.ts` and `planning-phase-service.ts` (neither of which
was edited):

```
HELM_DB_PATH=/tmp/helm-b2-final-$$.db npx vitest run \
  src/services/brief-writer-panel-plan-contract-b2.test.ts \
  src/services/brief-writer-focus-contract.test.ts \
  src/services/brief-writer-q11.test.ts \
  src/services/brief-writer-plan-schema.test.ts \
  src/services/dispatch-service.test.ts
```

Result: **5 files, 40/40 tests passed.** None of these pre-existing tests asserted on
`plan.json` or exact body equality for panel briefs, so the new canonical-path/revision
content is additive and did not break any of them.

## Scope verification

`git diff --stat` confirms zero changes to `planning-phase-service.ts`, `src/index.ts`, or
any schema file; the only changed/added files are `src/services/brief-writer-service.ts`
and the new `src/services/brief-writer-panel-plan-contract-b2.test.ts`.
