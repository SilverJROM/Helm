# R6 validator red-team a1

Scope: R3.13 objection monotonicity and R6.24 sweep registration in HEAD
`3e3b21f2bf06d608740ff3ac88ee6d2e4ac12aef`.

Focused test:

`npx vitest run src/services/planning-review-round-objection-mono.test.ts --minWorkers=1 --maxWorkers=4`

Result: PASS, 8/8 tests.

Adversarial lenses:

1. Parser fail-closed lens: `parseBoundedObjectionList` rejects missing `n=`, `n=0`, over-bound
   declarations, non-contiguous numbering, empty lists, and declared-vs-parsed count mismatches.
   Malformed notes are not converted to zero, so a malformed later rejection cannot masquerade as
   progress.

2. Monotonicity/termination lens: the round loop stores the previous objection count and returns
   `blockedReasonKind: 'objection-not-monotone'` when the next objections round is equal, greater,
   or unparseable. The result records `roundsAttempted` at the detecting round and does not spawn
   remaining proposer/signer rounds.

3. Revised-candidate lens: monotonicity is evaluated only after a proposer/signer round produces a
   candidate and the signer returns `OBJECTIONS`; candidate commit and signature matching remain
   governed by the existing engine-recomputed candidate path logic, not callback claims.

4. Sweep-registration lens: `objection-monotonicity` is registered as active with R6/R3.13/R6.24
   ownership, resolves to the focused spec on disk, rejects disarming markers through the registry
   resolver, and refuses duplicate registration.

5. Neighbor-regression lens: the existing alternation test fixture was adjusted from n=1 then n=1
   to n=2 then n=1 so R4 still exercises a three-round role swap under the stricter R6 invariant
   instead of accidentally tripping the new early block.

Verdict: PASS. No red-team blocker found for R3.13/R6.24.
