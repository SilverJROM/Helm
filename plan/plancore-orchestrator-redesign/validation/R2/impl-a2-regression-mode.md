# R2 attempt 2 — correction for validator FAIL (defect_class=REGRESSION_MODE_MISSING, gate=G6)

## Validator finding addressed (verbatim)

> FAIL R6.24 blind-draft-isolation not in regression index
>
> R6.24 FAIL: R2 explicitly requires registering regression mode `blind-draft-isolation`. The only
> source occurrence is in the focused spec comment; `src/planning-regression-index.test.ts` still
> contains only the seven historical skeleton entries with `it.skip`, and does not include
> `blind-draft-isolation`.

Scope of this correction: registration only. No product behavior in
`planning-review-round.ts` changed; the historical seven skeleton entries are left byte-identical
for X1 (whose row owns replacing them — "Spread registration is done in R2/R4/R6/R8/P2; X1 only
enforces").

## What was missing

The mode existed only as prose. There was no machine-readable registry for a slice to register into,
so the sweep had nothing to enforce over.

## Change

1. **`src/services/planning-regression-modes.ts` (new, product code — not a test)** — the R6.24
   registry. `registerRegressionMode` validates and refuses malformed/duplicate/skeleton entries at
   module load; `listRegressionModes` / `getRegressionMode` expose them; `resolveRegressionMode`
   reads the registered spec off disk and reports whether it exists, any skip/todo/only marker that
   would silently disarm it, and any declared proving test that has gone missing. R2 registers
   `blind-draft-isolation` → `src/services/planning-review-round-blind-draft.test.ts` with four named
   proving tests and the R2.5/R2.6/R2.7/R6.20/R6.24 requirement set.

2. **`src/services/planning-review-round-blind-draft.test.ts`** — 4 added tests driving the real
   registry and the real resolver (nothing stubbed): the mode is registered active and owned by R2;
   it resolves to this spec with all proving tests present and zero disarm markers; a probe mode
   pointing at a real temp-dir spec that is skipped / has a renamed proof / is deleted is reported as
   disarmed, missing, and non-existent respectively (proves the resolver reads files rather than
   rubber-stamping); and duplicate / skeleton-state / no-proving-test registrations throw.

3. **`src/planning-regression-index.test.ts`** — additive `R6.24 registered regression modes` block
   that iterates the registry: asserts `blind-draft-isolation` is present and owned by R2, that no
   registered mode is a skeleton, and that each registered mode resolves to an existing, non-disarmed
   spec with all proving tests intact. `blind-draft-isolation` is now IN the regression index and is
   an **active, non-skipped** case there.

## Evidence

`plan/plancore-orchestrator-redesign/validation/R2/focused-vitest-a2.txt` — the row's command plus
the index spec the finding named:

```
npx vitest run src/services/planning-review-round-blind-draft.test.ts src/planning-regression-index.test.ts --minWorkers=1 --maxWorkers=4
Test Files  2 passed (2)
     Tests  17 passed | 7 skipped (24)     # 7 skipped = the untouched historical skeleton (X1's row)
```

Row command alone: 12/12 pass (was 8/8 at a1; +4 registration tests).

## Negative control (the guard bites — not a no-op)

Renamed one registered proving test title in the R2 spec, then re-ran the index sweep:

```
 ❯ src/planning-regression-index.test.ts:130:46
     expect(resolution.missingProvingTests).toEqual([])
 + Array [ "fences each seat strictReadAllow to its own draft dir + context inputs, excluding the peer draft dir (R2.6)" ]
 Test Files  1 failed (1)   EXIT=1
```

Mutation reverted; both specs green again at the committed tree.

`npx tsc -p tsconfig.json --noEmit` reports no errors for any of the three touched files.
