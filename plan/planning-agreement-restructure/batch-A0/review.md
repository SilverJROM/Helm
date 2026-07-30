# A0 review.md (implementer self-review)

**Batch:** A0  
**Verdict:** READY FOR VALIDATOR  

## Scope discipline

- [x] New test file only (`src/a0-convene-race-regression.test.ts`)
- [x] Zero edits to `src/services/planning-phase-service.ts`
- [x] Zero edits to `src/index.ts`, schema, or cross-stream files
- [x] Wave-0 zero-collision: no shared production ownership

## Invariant coverage

| Invariant | How proven |
|-----------|------------|
| Absent plan ⇒ BROKEN not fail-fast | Elapsed time ≈ timeout under missing `plan.md` |
| Present plan ⇒ BROKEN fail-fast | Elapsed ≪ timeout with non-empty `plan.md` |
| Empty file ≡ absent | size === 0 still suppresses |
| Presence can flip mid-wait | Write plan after start → same BROKEN becomes dispositive |
| `8024452` text still present | Source count of `planMdPathForRaceGuard` === 3 |

## Risks / residual

- Tests call private `waitForAgreement` via `(phase as any)`. Acceptable for a pin suite; if the method is renamed without migration the source-count test still fails on symbol loss.
- Timing assertions use slack (±40ms / <400ms). Poll interval is 20ms; flake risk is low under load-free CI but not zero on a heavily contended host.
- Does **not** re-prove partner brief wait-text at `:523-531` (optional in some planner notes; not required by the A0 dispatch brief).

## Proof commands for validator

```bash
HELM_DB_PATH=/tmp/helm-a0-$$.db npx vitest run src/a0-convene-race-regression.test.ts
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts   # must print 3
```

## Done criteria vs brief

All expected acceptance criteria from `A0.implementer.brief.md` met. Artifacts written under `plan/planning-agreement-restructure/batch-A0/`.
