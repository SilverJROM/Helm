# B3 validator attempt 1

Validator: drv-B3-val-a1
Commit: 94be10ff7b79ea515cf7e7acad788ed1aeaa4d7b

## Scope

Validated B3 against R2.8, R3.10, R3.11, R3.14, and R5.19.

## Focused tests

Command run exactly:

```sh
npx vitest run src/services/brief-writer-plan-reconcile-signature.test.ts src/services/brief-writer-diff-review-unaffected.test.ts --minWorkers=1 --maxWorkers=4
```

Result: PASS

Observed summary:

```text
Test Files  2 passed (2)
Tests       13 passed (13)
```

## Independent AC validation

- R2.8 PASS: `plan-reconcile` uses `planAuthoringSchemaContract()`, matching the B2 task-JSON / R-XX schema contract.
- R3.10 PASS: `plan-reconcile` renders both round-1 draft path sets as read-only inputs, includes an optional prior objection list, and directs exactly one candidate output at candidate paths only.
- R3.11 PASS: `plan-signature` renders only the candidate plan path, computes an expected sha256/short12 line when readable, and fails closed when the candidate is missing.
- R3.14 PASS: signature grammar is limited to `SIGNED plan=<sha12>` or a bounded numbered objection callback; it forbids competing drafts and `PLAN-READY`.
- R5.19 PASS: `diff-review` remains on the default verdict body with canonical plan/requirements paths and `VERDICT-READY`, and regression tests assert no draft/reconcile/signature grammar leaks.

## Red-team pass

Elite adversarial lenses applied:

- Grammar-confusion lens: no `VERDICT-READY` or `PLAN-READY` terminal appears inside reconcile/signature agreement paths.
- Authority lens: reconcile writes candidate paths, not canonical `plan.md` / `og-requirements.md` or seat draft paths.
- Stale-revision lens: signature brief binds to current candidate bytes via `readPlanRevision()` and explicitly stops on mismatch/unavailable state.
- Leakage lens: B3 bodies return early before the default diff-review body; focused tests pin absence of B3 authoring/signature text in diff-review.
- Schema-drift lens: reconcile reuses the shared schema helper instead of duplicating a separate task contract.

Verdict: PASS, elite-clean.
