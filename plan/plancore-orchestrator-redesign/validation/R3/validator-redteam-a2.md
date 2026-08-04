# R3 Validator A2

Scope: validate R3.9, R3.10, and R3.11 for attempt 2.

Focused test command run exactly:

```sh
npx vitest run src/services/planning-review-round-proposer-signer.test.ts --minWorkers=1 --maxWorkers=4
```

Result: PASS. Transcript: `validation/R3/focused-vitest-a2.txt` (16 tests passed).

## AC Check

- R3.9 PASS: `runReviewRound` now carries exactly two clean round-1 `PublishedDraft` values into round 2 and calls `runProposerSignerRound`, which designates via D3 over the engine-recomputed full SHA-256 values and exposes the auditable designation log.
- R3.10 PASS: mismatch reaches one fresh `plan-reconcile` proposer with both draft paths, then one fresh `plan-signature` signer with only the candidate path. The focused spec proves round 2 is not `diff-review` or another `plan-draft` round.
- R3.11 PASS: signer agreement is the candidate's current engine-recomputed `short12`; stale signatures, objections, proposer silence, and signer silence all fail closed as typed non-agreement.

## Red-Team Lenses

1. Reachability: PASS. The previous A1 defect is closed inside `runReviewRound`: round 1 no longer returns immediately when two blind drafts exist and round budget remains; round 2 invokes the real resolver.
2. Ordering and seat lifecycle: PASS. The focused reachability spec asserts round-1 seats are reaped before proposer/signer spawn, preserving fresh-seat isolation.
3. Dual-author regression: PASS. The R3 path does not spawn two new full-draft authors; only `plan-reconcile` then `plan-signature` run.
4. Hash-match shortcut: PASS. Matching round-1 hashes skip proposer spawn, copy identical bytes to candidate, and still require a signature round.
5. Fail-closed semantics: PASS. Missing/stale signer SHA and signer objections do not agree; proposer silence never spawns signer.
6. Slice boundary: PASS. `planning-phase-service.ts` still not passing `blindDraftRound1` is deferred to P1/P2 per `plan.md`; R3's owned round-engine handoff is now reachable without forcing candidate promotion before P2.

Residual risk: R3.12 alternation and R6 objection monotonicity are explicitly outside this slice.

Verdict: PASS for R3.9,R3.10,R3.11.
