# R5 validator/red-team — attempt 2

Scope: validate R3.11, R3.14, and R6.21 for slice R5 after commit `88bf414f7ac52b6cf387f54a338ef8707690a5d3`.

Focused tests:
- `npx vitest run src/services/planning-review-round-signature-gate.test.ts src/services/planning-phase-current-plan-sha-b5.test.ts --minWorkers=1 --maxWorkers=4`
- Result: PASS, 2 files / 21 tests.
- Evidence: `plan/plancore-orchestrator-redesign/validation/R5/focused-vitest-a2.txt`

Independent source read:
- `SIGNED_RE` is now identity-only and passes the post-`SIGNED` tail to `SIGNED_CLAIM_RE`.
- `SIGNED_CLAIM_RE` is anchored at both ends and accepts only the exact lowercase `plan=<sha12>` token with surrounding whitespace.
- `waitForCandidateSignature` recomputes `readPlanRevision(candidatePlanFilePath)` at decision time.
- Missing, malformed, stale, suffix-smuggled, longer-hex, uppercase, prose-tailed, and double-token claims resolve as `signed-mismatched`, never agreement.
- `PLAN-READY` is not in the candidate-signature grammar.
- `runProposerSignerRound` sets agreement only from `decision.kind === 'signed-agreed'`.
- The legacy `waitForAgreement` path remains in `planning-phase-service.ts` and the B5 current-plan SHA tests still pass.

Elite red-team lenses:
- Attempt-1 suffix exploit: PASS, now returns `signed-mismatched`.
- Longer lowercase hex suffix: PASS.
- Trailing prose after correct SHA: PASS.
- Second `plan=` token smuggling: PASS.
- Uppercase same SHA: PASS.
- Stale candidate bytes: PASS.
- Wrong batch identity: PASS.
- `PLAN-READY` grammar confusion: PASS.

Executable red-team probe:
- Evidence: `plan/plancore-orchestrator-redesign/validation/R5/redteam-probe-a2.txt`
- Result: all adversarial cases returned the expected fail-closed or exact-agreement result.

Verdict: PASS for R3.11,R3.14,R6.21.
