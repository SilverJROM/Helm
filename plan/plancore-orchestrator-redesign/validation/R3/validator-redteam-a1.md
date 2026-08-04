# R3 Validator A1

Scope: validate R3.9, R3.10, and R3.11 for slice R3.

Focused test command run exactly:

```sh
npx vitest run src/services/planning-review-round-proposer-signer.test.ts --minWorkers=1 --maxWorkers=4
```

Result: PASS. Transcript: `validation/R3/focused-vitest-a1.txt`.

## AC Check

- R3.9 isolated helper path: PASS in `runProposerSignerRound`. It calls `designateRound2Proposer` with both full round-1 draft SHA-256 values and builds `formatProposerLog`.
- R3.10 isolated helper path: PASS in `runProposerSignerRound`. On mismatch it spawns one `plan-reconcile` proposer with both draft paths, then one `plan-signature` signer with only the candidate path.
- R3.11 isolated helper path: PASS in `runProposerSignerRound`. The signer claim is compared against `readPlanRevision(candidatePath).short12` at decision time; stale/missing/malformed claims do not agree.

## Red-Team Lenses

1. Production reachability: FAIL. `planning-phase-service.ts` calls `runReviewRound` without `blindDraftRound1` and no caller invokes `runProposerSignerRound`; `rg` only finds production definition plus tests. Therefore real planning never reaches the new R3 asymmetric resolver.
2. R2 to R3 handoff: FAIL. When `blindDraftRound1` is enabled, `runReviewRound` returns immediately after `resolveRoundOneDraftPhase` with `roundOneDraftPublications` instead of continuing into proposer/signer resolution. No caller consumes that return value today.
3. Agreement fail-closed semantics: PASS inside the isolated function. Candidate bytes are recomputed at signer decision time and mismatches return `signed-mismatched`.
4. Dual-author path removal: FAIL at integration level. The old `runReviewRound` agreement/revise loop remains the only production planning path. The added R3 code does not replace or govern it.

## Findings

R3-F1: The R3 implementation is not wired into production planning.

Evidence:

- `src/services/planning-phase-service.ts:540` destructures `runReviewRound(...)` directly and does not pass `blindDraftRound1`.
- `src/services/planning-review-round.ts:1408` returns immediately after round-1 blind drafts when the flag is set, before asymmetric proposer/signer resolution.
- `src/services/planning-review-round.ts:905` defines `runProposerSignerRound`, but `rg "runProposerSignerRound\\("` finds no production caller.

Impact: R3.9-R3.11 are only true for a standalone exported function and its unit spec. A real planning run still cannot perform the required round-1 hash mismatch behavior: D3 designate, proposer with both drafts, signer with only candidate, and signer SHA agreement against the candidate.

Verdict: FAIL for R3.9,R3.10,R3.11.
