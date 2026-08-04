# R5 validator/red-team — attempt 1

Scope: validate R3.11, R3.14, and R6.21 for slice R5.

Focused tests:
- `npx vitest run src/services/planning-review-round-signature-gate.test.ts src/services/planning-phase-current-plan-sha-b5.test.ts --minWorkers=1 --maxWorkers=4`
- Result: PASS, 2 files / 14 tests.
- Evidence: `plan/plancore-orchestrator-redesign/validation/R5/focused-vitest-a1.txt`

Independent source read:
- `waitForCandidateSignature` recomputes `readPlanRevision(candidatePlanFilePath)` at decision time.
- The new path ignores brain `PLAN-READY` lines and scopes by signer role plus signer batch id.
- `runProposerSignerRound` calls `waitForCandidateSignature` and maps only `signed-agreed` to `agreed:true`.
- Legacy `waitForAgreement` remains intact for existing B5 tests.

Elite red-team lenses:
- Stale candidate bytes: covered by focused test and implementation reread.
- Missing candidate path: covered by focused test and fail-closed return.
- Missing or short malformed SHA: covered by focused tests.
- Wrong batch id: covered by focused test.
- `PLAN-READY` grammar confusion: covered by focused test.
- Prefix/suffix grammar smuggling: FAIL.

Finding:
- `src/services/planning-review-round.ts:694` uses `SIGNED_RE = ... plan=([0-9a-f]{12})?` without an end-of-token or end-of-line boundary after the captured short SHA.
- A malformed signature line such as `STATUS: SIGNED plan=<current12>XYZ` is accepted as `signed-agreed` because the regex captures the first 12 hex characters and ignores the suffix.
- This violates R6.21 and R3.11: malformed SHA must never agree.

Executable red-team probe:
- Evidence: `plan/plancore-orchestrator-redesign/validation/R5/redteam-probe-a1.txt`
- Actual result: malformed `SIGNED plan=d81b83a40517XYZ` returned `{ ok: true, kind: "signed-agreed" }`.
- Expected result: `signed-mismatched`.

Verdict: FAIL for R3.11,R3.14,R6.21.
