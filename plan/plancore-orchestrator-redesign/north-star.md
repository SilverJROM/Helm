# Effort north-star — Plancore coordinates; co-planners author

**Effort:** `plancore-orchestrator-redesign`
**Authored by:** `[north]` `helm-97`, 2026-08-01
**Project:** Helm — `/home/agjrom/websites/Helm`, live on `:3110` (pm2 `helm-harness`, DB `data/helm.db`)
**Append-only.** Dated entries. Never retconned.

> **INHERITS** the project north-star at `/home/agjrom/websites/Helm/north-star.md` by citation, not by
> copy. SD1-SD10 and its standing constraints bind this effort without being restated here. This effort
> also builds directly on `plan/planning-agreement-restructure/` (P0-P2, shipped `93d7cd7`) — its engine
> mechanics (fresh seats per round, fail-closed SHA-bound agreement, engine-not-agent declares agreement)
> are the foundation this redesign re-points, not replaces.

---

## 2026-08-01 — Why this effort exists

`plancore-orchestrator-redesign` corrects a defect in the very design `plan/planning-agreement-restructure`
just spent ~30 hours stabilizing: **the wrong agent was writing the plan.**

JROM's original framing, from the effort that started this whole thread of work (verbatim, preserved
because it is the actual spec):

> *"i want discovery to stop and the initial docs then hand it over to helm then helm calls plancore
> -> orchestrates the planning with the planners -> **debat the plans** -> before implementation"*

What got built instead — through `discovery-planning-handoff` and reinforced by `planning-agreement-
restructure` — was: **plancore authors** `og-requirements.md` and `plan.md` alone
(`brief-writer-service.ts:generatePlanningBrief`), and the two configured co-planners are spawned only
to **render a verdict** on plancore's draft (`generatePanelBrief` — "Report CLEAN/BROKEN... Emit
VERDICT-READY"). Every fix through P0-P2 made that review gate honest and safe. None of it changed who
holds the pen. JROM caught this the first time he watched the mechanism explained back to him:

> *"no this is not what i wanted, i want plancore to not write anything, but only drive the coversation
> between co-planners and act just as a orchestrator but not plan writer."*

Clarified further, verbatim, when asked how the co-planners actually produce content:

> *"the most plancore can do is give inputs (minimal) its main function is that co-planners coordinate
> effectively to arrive at the best plan."*

## The one sentence

**Plancore drives the conversation. The co-planners write the plan.**

## The governing principle

**Authority over content follows authorship, not review.** A reviewer can reject a plan; only an author
can be said to have written it. Assigning plancore the pen and the co-planners a verdict button — no
matter how rigorously that verdict is gated — always produces a plan whose real author was never
debated with anyone. P0-P2 made that verdict trustworthy. It never made it the right question.

Its corollary: **"coordinate effectively" is plancore's entire job description.** Minimal contextual
input (pointing co-planners at north-star.md/decisions/conversation-log, sequencing turns, tracking
convergence) is the ceiling of plancore's content contribution. Anything beyond that is plancore quietly
becoming the author again under a different name.

## The keystone finding — what carries forward from P0-P2 unmodified, and what re-points

**REVISED 2026-08-01, after an independent 3-seat review (grok45/sol/opus, unanimous `NEEDS-REVISION`)
found the first version of this section unimplementable.** v1 defined convergence as two independent
seats producing byte-identical drafts through symmetric "reconcile toward one document" debate. All
three reviewers traced this to the same failure with matching concrete rounds: the only symmetric fixed
point in that space is "copy the other's file verbatim," which produces a **swap**, not agreement — A
adopts B's draft, B adopts A's, hashes stay unequal forever. Round-cap exhaustion becomes the steady
state. Full findings: `SYNTHESIS.md`.

The round-machine mechanics built in `planning-agreement-restructure` are **still correct primitives**
— what needed fixing was the *shape of the agreement question*, not the engine loop that enforces it:

- **C5's keystone (fresh seats per round)** still applies unmodified: there is no `transport.send`, so a
  seat whose turn ended cannot be re-engaged. Every round — draft, reconcile, or signature — spawns
  fresh seats.
- **B5's fail-closed SHA binding is re-pointed, not replaced, correctly this time**: agreement means a
  **signer's** SHA matches the **candidate's** current bytes — the exact same check B5 already performs,
  just aimed at a co-planner-authored candidate instead of plancore's draft. This is **asymmetric**
  (one proposer, one signer, alternating each round) rather than v1's symmetric dual-draft comparison —
  asymmetry is what makes it terminate.
- **C6's revise actuator currently spawns plancore** (`planning-review-round.ts:311` builds the brief,
  `:692` spawns it) to "surgically revise" on disagreement. **Correction to v1's own citation, found by
  the review and verified directly:** `brief-writer-service.ts:523` is a *different* mechanism —
  `generateBrainBrief`'s mid-implementation escalation replan (Phase C, a single failing task during
  implementation) — not this whole-plan revise path. That mid-implementation path is explicitly
  preserved, untouched by this effort. C6's actual revise path is re-pointed to spawn the **proposer**
  co-planner (never plancore) each round, alternating.
- **`generatePlanningBrief`** (`brief-writer-service.ts:268-350`) is **deleted**, not reduced to a
  coordination brief — the review found the engine already performs every operative coordination act
  (spawn, relay, hash, designate proposer); a model seat with no ability to spawn or message the
  co-planners has no function left to hold a brief for. Plancore survives only as a phase/coordinator
  **label** (topology, staffing, UI), never as a spawned seat during initial whole-plan authoring.
- **`generatePanelBrief`** (`:433-480`) becomes purpose-discriminated: a `plan-draft` brief for round-1
  blind authoring, a `plan-reconcile` brief for the round's proposer, a `plan-signature` brief for the
  round's signer — plus its existing, unaffected `task-conflict-reconvene` and `diff-review` callers,
  which the review found v1 had undercounted.
- **The canonical-plan ingest path** (`planning-phase-service.ts:617-689`) no longer asserts a
  specific agent failed to author — it asserts no agreed candidate exists, promoted by the engine only
  once a signature matches.

## What "done" means here (the bar)

- Plancore's brief, read cold, could not be mistaken for an authoring brief. It contains no
  requirements-schema instructions, no task-JSON format spec, no "author og-requirements.md FIRST."
- The co-planners' brief instructs an **independent draft**, not a verdict on someone else's draft.
- A run where plancore is unreachable after seat-spawn does not silently produce a worse plan — it fails
  the same way a co-planner going silent does (C7's watchdog, generalized).
- Convergence is defined precisely enough to implement: what does "the co-planners agree" mean when they
  started from two different drafts? (Byte-identical final plan.md? Each explicitly signs off on a
  single reconciled document? This is the first open question for requirements to resolve.)
- Every historical failure mode P0-P2 closed stays closed. This effort re-points *who authors*; it does
  not reopen *whether a stale revision can pass* or *whether a failed run corrupts state*.

## Ordering rationale

**Requirements before implementation, deliberately slower than the redesign itself would need.**
`planning-agreement-restructure` was fixed four times before the diagnosis (a brief is not a protocol)
held. This effort is a second core-contract change to the same subsystem inside 48 hours. JROM chose
"scope it properly as a follow-up effort" explicitly over a fast patch — that decision is the ordering
rule: north-star → og-requirements → (likely) an independent panel sanity-check on the requirements,
given how much a wrong read cost the first time → implementation plan → the same gate discipline
(isolated unit tests, full regate, staged deploy) P0-P2 used.

## Non-goals

- Reopening any P0-P2 mechanism that is not about *authorship*. The fail-closed gate, fresh-seats-per-
  round, teardown-corruption fixes, and terminal-owner ordering all stay as built.
- Changing the discovery→handoff bridge (`discovery-planning-handoff`) — this effort starts after a
  confirmed handoff, inside the planning phase only.
- D1-D11 from `planning-agreement-restructure` (legacy-path cleanup, provenance tightening) — still
  separately deferred, untouched by this effort.
- Re-enabling `HELM_SESSION_JANITOR`. Still `0`.
- Merging to `main` (SD10).

## The meta-pattern this effort closes

`planning-agreement-restructure` closed the pattern of *Helm asking an agent to uphold an invariant
instead of enforcing it*. This effort closes a sibling pattern discovered in the same subsystem:
**Helm assigning a role's title (co-planner) without assigning it the role's actual authority
(authorship).** A "planner" who only reviews was never really a planner. Promotion candidate for the
project north-star: *when a role is named for what it should DO, verify the mechanism actually gives it
that power — a review gate wearing a decision-maker's name is a design smell, not a detail.*
