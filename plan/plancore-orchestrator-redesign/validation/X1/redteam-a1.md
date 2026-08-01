# X1 Validator Red-Team A1

Verdict: PASS

Focused command:
`npx vitest run src/planning-regression-index.test.ts --minWorkers=1 --maxWorkers=4`

Result: PASS, 21 tests.

Adversarial lenses:
- Coverage: seven historical modes are indexed; five new registry modes are required and enforced, with `alternation` mapped to `proposer-signer-alternation`.
- Active-proof integrity: `redteam-active-proof-check-a1.txt` verifies all 33 declared proof titles resolve to real `it(...)` / `test(...)` declarations in their target specs, not comments or loose strings.
- Skip/skeleton resistance: the focused suite checks registered and historical proof files for skip/todo/only disarm markers and checks the index file itself has no such markers.
- Requirement alignment: stale CLEAN is paired with a stale SIGNED companion under R6.21; silent partner, no-ibrain-on-planning-block, legacy-north-star refusal, and proposer/signer role-integrity modes all resolve to active behavioral specs.

Residual risk: X1 enforces proof registration/resolution; it does not execute every downstream proof spec in this slice. That matches the focused X1 command in the driver prompt.
