# SYNTHESIS — review panel (grok45 · sol · opus)

**By** `[north]` `helm-97`, 2026-08-01 · **Verdict: unanimous `NEEDS-REVISION`**, 949 lines across three
independent reviews. The requirements document below (v2) incorporates every decision made here.

## The one finding all three converged on, independently, with matching traces

**R2.7's byte-identity convergence bet is wrong.** Two independently-drafting models cannot be expected
to produce identical bytes through symmetric "reconcile toward one document" instructions — the only
Schelling point in that space is "copy the other's file verbatim," which is symmetric and therefore
produces a **swap**, not convergence. All three traced this out concretely to 2-3 rounds and landed on
the same failure: A adopts B's draft, B adopts A's draft, hashes stay unequal forever (or drift further
apart under "merge" behavior). Under this design, **round-cap exhaustion is the steady state, not the
exception** — every real planning run would BLOCK.

> opus: *"The fixed-point argument is the decisive one: the only Schelling point in this space is 'copy
> the other's file verbatim,' and that point is symmetric — exactly outcome (1), the swap. No termination
> condition rescues this, because the target itself is unreachable."*

## The replacement — asymmetric candidate + signature, converged on independently by all three

grok45, sol, and opus each proposed the same shape without seeing each other's work:

1. **Round 1 unchanged** — both co-planners draft blind, independently, to seat-scoped paths.
2. **On divergence, the engine designates one seat the proposer** by a deterministic, reproducible rule
   (opus/grok45: lexicographically smaller draft SHA — reproducible from the artifacts alone, no
   slot-order bias).
3. **The proposer (fresh spawn, per C5) reconciles both drafts into ONE candidate document.** The other
   seat (also fresh) reads only that candidate and either `SIGNED plan=<sha12>` or emits a numbered,
   bounded objection list — **never a competing draft**.
4. **Agreement = the signer's SHA matches the candidate's actual current bytes** — this is B5's existing
   mechanism, unmodified, just re-pointed from "verdict on plancore's plan" to "signature on a co-planner's
   candidate."
5. **The proposer role alternates each round** (opus: round 2 A proposes/B signs, round 3 B
   proposes/A signs) — without alternation, one seat becomes the permanent author and the other the
   permanent reviewer, which is the exact P0-P2 defect moved down one level.

This terminates because each round has a single artifact and an asymmetric question, not two seats
racing to write.

## Everything else, ranked by how many seats found it independently

| # | Finding | Found by |
|---|---|---|
| 1 | **R2.7 byte-identity is unimplementable** (the above) | grok45, sol, opus — all 3, matching traces |
| 2 | **The task-JSON schema / og-requirements format contract has no owner** once plancore stops authoring — it lived entirely in plancore's brief | grok45 (F2), opus (#2) |
| 3 | **`generatePanelBrief` has MORE call sites than R6 counted** — whole-plan planning, post-ingest per-task conflict reconvene, generic deliberation, and diff/red-team review are ≥3-4 semantically distinct callers sharing one function with no purpose discriminant | grok45 (F6), opus (#6), sol (#6) — all 3 |
| 4 | **Plancore's role is internally contradictory across R1/R2/R4.14** — R1 says plancore relays and sequences; R2 says the engine does that and plancore isn't in the loop; R4.14 recommends keeping a real seat. Current code confirms the engine already performs every operative action a "coordinator" would do | grok45 (F3), sol (#3), opus (#9) — all 3 |
| 5 | **The named regression sweep (R5.19-equivalent) asserts nothing behavioral** — `planning-regression-index.test.ts` checks that seven strings exist, then `it.skip`s every scenario. It stays green through any regression | opus (#3), sol (#10) |
| 6 | **Adaptive planning (`adaptive_planning=1`) is untouched by R1-R6 and already has a *different* co-author contract** — the same project-level directive would silently mean two different things depending on a config flag | grok45 (F9), sol (#11) |
| 7 | **My citation `brief-writer-service.ts:523` was wrong** — that's `generateBrainBrief`'s mid-implementation escalation replan (a different, still-needed system), not C6's whole-plan revise. Verified directly by `[north]` before accepting: confirmed. The real C6 revise brief is `planning-review-round.ts:311` (construction) / `:692` (spawn) | grok45 (F7), sol (#12) — independently, and I verified it myself |
| 8 | **No draft-completion signal is defined** — the engine has no way to know a seat's draft is finished (not a partial write) before hashing it | opus (#5), sol (finding #2, "no draft-commit signal") |
| 9 | **C3's artifact-publication gate (checks canonical plan.md/og-requirements.md exist before spawning reviewers) blocks 100% of runs under the new design** — nothing writes those canonical paths until a candidate is agreed; the gate needs re-scoping to seat-scoped draft existence, not deleting | opus (#4) |
| 10 | **R2.5's draft-path isolation has no enforcement** — nothing stops seat B from reading seat A's round-1 draft mid-write even if no brief names the path | sol (#8) |
| 11 | **The C6/C8 BROKEN-evidence machinery is orphaned** if the revise actuator is simply deleted rather than re-pointed | opus (#8) |
| 12 | **R3.11's `[DB]` obligation (log both seats' final hashes on BLOCKED) has no consumer** — should be a diff, not two hex strings, for operator legibility | opus (#11, also proposed independently as a termination-safety addition) |

## Decisions — what v2 of the requirements does about each

- **R2.7-R2.9 replaced wholesale** with the asymmetric proposer/signer protocol above, alternating each
  round, B5's exact SHA mechanism re-pointed rather than reinvented.
- **Plancore is retired as a spawned model seat for initial planning.** The engine performs relay,
  context injection, and proposer/signer designation directly — no separate model call, no watchdog
  dependency, no seat that can go silent without anyone noticing (opus #9's fix for its own #9 finding on
  R4.13's inadequate watchdog: retiring the runtime seat removes the problem rather than needing to solve
  it). `plancore` survives as a **phase/coordinator label** and its brief-writer entry for the *separate*,
  explicitly-preserved mid-implementation replan path (`brief-writer-service.ts:495-524`) is untouched.
- **The schema/task-JSON contract moves into the co-planner draft and reconcile briefs** — wherever
  `generatePlanningBrief`'s authoring instructions used to live, they now live in whichever brief
  produces a complete document (round-1 draft brief, and the proposer's reconcile brief).
- **`generatePanelBrief` gets an explicit, exhaustive purpose discriminant** — no default — covering at
  minimum: whole-plan draft authoring, whole-plan candidate reconciliation, whole-plan signature,
  post-ingest per-task conflict reconvene, and diff/red-team review. The diff/red-team path is verified
  unaffected.
- **C3 re-scoped**, not deleted: the artifact-publication gate now checks seat-scoped draft existence
  before round-2 spawns, instead of the old canonical-path check.
- **A draft-commit signal added**: seats publish atomically (temp file + rename) and emit a
  non-authoritative `DRAFT-SUBMITTED`/`CANDIDATE-SUBMITTED` callback; the engine recomputes the hash
  itself rather than trusting the callback's claim.
- **Adaptive planning explicitly scoped out**, with a backlog item to reconcile it later rather than
  silently diverge.
- **The regression sweep requirement rewritten** to require each historical mode resolve to an active,
  behavioral test — no bare existence-check-then-skip.
- **Objection monotonicity and a diff-on-BLOCKED** added as termination/legibility safeguards.

## What I did not adopt

Nothing — the three reviews were convergent enough on mechanism, and precise enough with file:line
evidence (which I spot-verified rather than trusted blindly), that there is no live disagreement to
arbitrate. Where opus, grok45, and sol differed slightly on exact citation line numbers for the more
diffuse findings (e.g. the full `generatePanelBrief` caller list), v2 describes those sites by function
and purpose rather than by a citation I have not personally re-verified — implementation must confirm
exact current lines before writing code, same discipline as everywhere else in this project.
