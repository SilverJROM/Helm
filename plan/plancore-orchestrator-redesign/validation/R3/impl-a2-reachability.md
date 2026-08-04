# R3 implementer attempt 2 — reachability correction

**Validator finding addressed (verbatim):** `FAIL helper green but production never calls R3 resolver`
(defect_class=UNREACHABLE_R3, gate=G3). Findings R3-F1 lenses 1, 2, 4.

## What was wrong

`runProposerSignerRound` was correct but only ever invoked by its own unit spec:

- `planning-review-round.ts:1408` (pre-fix) returned `resolveRoundOneDraftPhase(...)` immediately when
  `blindDraftRound1` was set — the R2→R3 handoff did not exist, so the engine's round loop could never
  reach the asymmetric resolver;
- `rg "runProposerSignerRound\("` found production definition + tests only.

## Fix (scope: `planning-review-round.ts` round engine only)

1. Round 1's blind-draft phase now feeds the loop instead of terminating it: on a clean two-seat draft
   phase with round budget remaining, the publications are carried into the next iteration.
2. At the top of that iteration — **after** the loop's existing C5 reap of round-1 handles — the engine
   calls the real `runProposerSignerRound`. Round 2 of a blind-draft run **is** the asymmetric exchange;
   it never falls through to `spawnRoundSeats`' diff-review path or to `waitForAgreement`.
3. `toReviewRoundResult` projects the exchange onto the loop's existing `ReviewRoundResult` contract.
   Every non-agreement gets a typed cause: `candidate-not-committed`, `signer-no-response`,
   `signer-objections`, `signature-mismatch` (new union members). The full typed outcome rides on the
   additive `proposerSignerRound` field (candidate paths + designation log for P2's promotion).

Round 1 stays terminal in exactly two cases, so no existing caller changes shape: a typed
`draft-not-submitted` block (nothing to reconcile), and a caller with only one round of budget (the
default `roundCap`) — the engine never starts an exchange it cannot finish. A panel whose draft phase
yields anything other than exactly two publications also ends at the draft phase rather than silently
picking two of N (D3 designates between exactly two drafts).

## Tests — real path, nothing mocked

Added to the row's own spec (`planning-review-round-proposer-signer.test.ts`), a second suite driving
`runReviewRound` — the single production entry into this module — end to end. Seats are driven by a
`ScriptedSeatTransport` that reacts **only** to spawns the engine actually performs: a seat writes its
draft/candidate and posts its callback at spawn time, never before. The resolver, D3 designation,
brief-writer purposes, disk re-reads and signature check are all the real implementations.

Covered: divergence → D3 designation + rule log over engine-recomputed shas → proposer (both drafts) →
signer (candidate only) → signature agreement; round-1 seats reaped before round-2 spawn; hash-match →
no proposer spawned, signature round still runs; stale SIGNED → `signature-mismatch` fail-closed;
objections → typed non-agreement; proposer silence → bounded block with no signer spawn; one-round
budget → R2's shipped shape; draft block → exchange never reached. `waitForAgreement` is never called
on this path and no canonical `plan.md` / `og-requirements.md` is written.

**Mutation check (proof the tests drive the real path, not a fixture):** re-inserting the old
`return draftPhase;` at the handoff fails exactly the 5 reachability tests that assert an exchange
happened (11 pass — including the two that assert the exchange must NOT happen). Restored; 16/16 green.

## Deliberate boundary — not an omission

`planning-phase-service.ts` still does not pass `blindDraftRound1`, and that is **P1/P2's row**, not
R3's: PPS still spawns plancore as the authoring seat (P1 removes it) and nothing promotes a signed
candidate to canonical `plan.md` (P2 adds it). Enabling the flag from this slice would make a real run
agree on a candidate and then fail at canonical read/ingest — a production regression mid-spine. R3
owns the round-engine handoff; the resolver is now reached by production control flow, not by a spec.

## Commands run

```sh
npx vitest run src/services/planning-review-round-proposer-signer.test.ts --minWorkers=1 --maxWorkers=4   # 16/16
npx vitest run src/services/planning-review-round-blind-draft.test.ts \
  src/services/planning-review-round-c2..c8.test.ts \
  src/services/planning-review-round-gate-rescoped.test.ts \
  src/planning-regression-index.test.ts --minWorkers=1 --maxWorkers=4                                    # 59 passed, 7 skipped
npx tsc -p tsconfig.json --noEmit                                                                        # clean
```
