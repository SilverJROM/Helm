# og-requirements — plancore-orchestrator-redesign (v2)

**Authored by** `[north]` `helm-97`, 2026-08-01, **revised** same day after an independent 3-seat
review (grok45/sol/opus, unanimous `NEEDS-REVISION`) found the v1 convergence mechanism unimplementable.
Full findings: `SYNTHESIS.md`, `review-{grok45,sol,opus}.md`. **v1 is superseded; this is the source of
truth.**

---

## 1. Why this effort exists

`planning-agreement-restructure` (P0-P2, shipped `93d7cd7`) made the agreement gate honest and safe —
but never changed *who writes the plan*. Plancore authors `og-requirements.md`/`plan.md` alone; the two
configured co-planners only render a verdict on plancore's draft. JROM's design, stated before that
effort started and reaffirmed twice since:

> *"i want discovery to stop and the initial docs then hand it over to helm then helm calls plancore
> -> orchestrates the planning with the planners -> debat the plans -> before implementation"*
>
> *"i want plancore to not write anything, but only drive the coversation between co-planners and act
> just as a orchestrator but not plan writer"*
>
> *"the most plancore can do is give inputs (minimal) its main function is that co-planners coordinate
> effectively to arrive at the best plan"*

**This is a re-pointing, not a rebuild.** P0-P2's round-machine primitives — fresh seats per round
(C5), fail-closed SHA binding (B5), engine-not-agent declares agreement (C9), terminal-owner cleanup
ordering (A5/A6) — are correct here too. This effort changes *what the seats are asked to produce* and
*what "agreement" is checked against*.

## 2. THE ARCHITECTURAL NOTE — v1's mistake, corrected

v1 defined agreement as **byte-identical independent drafts**. All three reviewers found this
unimplementable with matching concrete traces: two models given a symmetric "reconcile toward one
document" instruction either swap drafts (A adopts B's, B adopts A's — still unequal) or each produce
new merge prose (semantically converging, byte-diverging). The only symmetric fixed point is a swap, and
nothing in the design breaks that symmetry. Round-cap exhaustion becomes the steady state, not a safety
valve — every real run would BLOCK.

**v2's mechanism: asymmetric candidate + signature**, an alternating re-pointing of B5 rather than a
new invention:

1. Round 1: both co-planners draft **blind and independent**.
2. On divergence, the engine — by a **deterministic, reproducible rule** (lower `sha256` of the two
   round-1 drafts) — designates one seat the **proposer** for round 2.
3. The proposer (fresh spawn) reconciles both drafts into **one candidate document**. The other seat
   (also fresh) reads **only that candidate** and either signs its exact hash or returns a bounded,
   numbered objection list — **never a competing draft**.
4. Agreement = the signer's `plan=<sha12>` matches the candidate's actual current bytes on disk — this
   is **B5's existing check, unmodified**, just re-pointed from "verdict on plancore's plan" to
   "signature on a co-planner's candidate."
5. **The proposer role alternates every round** (round 2: A proposes/B signs; round 3: B proposes/A
   signs). Without alternation, one seat becomes a permanent author and the other a permanent reviewer —
   the exact P0-P2 defect, one level down.

This terminates because every round has exactly one artifact and one asymmetric question, never two
seats racing to each produce the canonical file.

## 3. Acceptance criteria

**[DB]** needs a database assertion. **[TOKEN-FREE]** provable without a model call (P0-P2's AC23
discipline — this is attempt #2 on the same subsystem's authority model; the tests are what stop a #3).

### R1 — Plancore is retired as an authoring AND reviewing seat

1. `generatePlanningBrief` (`brief-writer-service.ts:268-350`) is **deleted**, not repurposed as a
   "coordination brief." Verified during the review: the engine already performs every operative
   coordination action (spawn, relay, hash, designate proposer) — a model seat with no API to spawn or
   message other seats has no function to hold a brief for. **[TOKEN-FREE]**
2. **No model call is made for "plancore" during initial whole-plan authoring.** The engine performs
   context injection (paths to north-star.md/conversation-log.md/decisions/), proposer designation, and
   draft relay directly, in code — not through a spawned agent's judgment.
3. `plancore` **survives** as: (a) a phase/coordinator **label** used in logging, topology contracts,
   staffing resolvers (S05/S06), and UI seat-preview surfaces — nothing there is renamed or removed —
   and (b) its **separate, unrelated** mid-implementation escalation-replan role
   (`brief-writer-service.ts:495-524`, `generateBrainBrief`, "Wakes plancore to surgically revise THIS
   slice" on a single failing task during implementation) — **explicitly untouched by this effort.**
   Confirmed by direct read: this is a different function serving a different phase (Phase C
   implementation escalation), not the whole-plan revise path. Do not conflate the two again.
4. `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` (`planning-phase-service.ts:689`) is renamed to a
   candidate/signature-shaped failure (e.g. `NO-AGREED-PLAN-CANDIDATE`) — the missing-artifact case still
   exists, but nothing asserts a specific agent-named failure to author.

### R2 — Round 1: co-planners draft blind

5. **[DB]** Each co-planner writes its own draft to a **seat-scoped path**
   (`draft-<seatId>.md`/`draft-<seatId>-req.md`) inside the run directory, never to the canonical
   `plan.md`/`og-requirements.md` path. Canonical paths are written **only** by the engine, **only**
   once R3's signature condition holds.
6. **[DB]** Round-1 drafting is genuinely blind: seat-private storage that a co-drafting seat cannot
   read or list before its own draft is committed, enforced at the storage layer — not merely "no brief
   mentions the other path." Proven by a test that attempts a cross-seat read/list during round 1 and
   asserts denial.
7. **[DB]** Draft publication is **atomic** (temp file + rename) and each seat emits a non-authoritative
   `DRAFT-SUBMITTED`/`CANDIDATE-SUBMITTED` callback carrying its own computed hash — the **engine
   recomputes the hash itself** from the committed file rather than trusting the callback's claim. This
   closes the "engine hashes a partial write" gap.
8. The task-JSON schema / `R-XX` requirement-ID format instructions that used to live in plancore's
   authoring brief (deleted per R1.1) now live in the **draft brief** each co-planner receives for round
   1, and in the **reconcile brief** the round-2+ proposer receives. The schema contract is not lost —
   it moves to wherever a complete document is actually produced.

### R3 — Divergence: asymmetric proposer + signer, not dual reconciliation

9. **[DB]** On round-1 hash mismatch, the engine computes a deterministic proposer assignment (lower
   `sha256` of the two round-1 drafts becomes proposer for round 2) and logs the rule used — reproducible
   from the artifacts alone, auditable after the fact.
10. **[DB]** The proposer seat (fresh spawn, C5) receives **both** round-1 drafts and authors **one**
    reconciled candidate at a single candidate path. The signer seat (fresh spawn) receives **only**
    that candidate — never a second competing document to author.
11. **[DB]** Agreement = `sha256(signer's stated plan=<sha12>)` equals `readPlanRevision(candidate
    path).short12`, recomputed by the engine at check time — B5's exact mechanism, re-pointed. A missing,
    malformed, or stale-relative-to-current-candidate SHA is never treated as agreement (fail-closed,
    unchanged from B5).
12. **[DB]** The proposer role **alternates every round**: round 2 A proposes/B signs; round 3 B
    proposes/A signs; and so on up to the configured round cap. A design that gives one seat the pen for
    every round is a v1-class defect and fails this criterion.
13. **Objection monotonicity**: a signer's rejection carries a bounded, numbered defect list. Round N+1's
    defect count against the (now-revised) candidate must be **strictly smaller** than round N's, or the
    run typed-BLOCKs early rather than burning the remaining round-cap chasing a non-shrinking objection
    set.
14. Only the **engine**, upon observing R3.11's signature condition, treats the plan as agreed and
    promotes the candidate to the canonical `plan.md`/`og-requirements.md` paths atomically. No agent —
    proposer, signer, or the retired plancore label — may emit a status meaning "this plan is ready to
    use." `PLAN-READY` as an authorship-completion signal is retired; the only publication signal is
    `DRAFT-SUBMITTED`/`CANDIDATE-SUBMITTED` (R2.7), which asserts existence, never agreement.
15. Non-convergence at round-cap exhaustion is a **visible BLOCKED** state, reported with a **diff**
    between the two seats' final positions (not bare hash pairs — two hex strings tell an operator
    nothing about how far apart they actually landed). **[DB]**

### R4 — The artifact-publication gate is re-scoped, not deleted

16. C3's existing gate (spawns reviewers only once canonical `plan.md`/`og-requirements.md` exist,
    non-empty, parseable) is **re-pointed**, not removed: it now gates round-2+ spawns on the **relevant
    seat-scoped draft/candidate** existing and being non-empty/parseable, never the old canonical-path
    check — which nothing writes until R3.14's promotion, and which would otherwise block 100% of runs
    from ever reaching round 2. **[DB]**

### R5 — `generatePanelBrief` needs an exhaustive purpose discriminant

17. `generatePanelBrief` (`brief-writer-service.ts:433-480`) is a **shared function with more than two
    callers** — confirmed by the review panel (independently, three times) to also serve post-ingest
    per-task conflict reconvene and generic deliberation, in addition to whole-plan review and
    diff/red-team review. Implementation must **re-verify the exact current call sites** before writing
    code (this document does not re-cite exact line numbers for the full caller list — the panel's three
    reviews disagreed slightly on precise ranges, and propagating an unverified citation a third time in
    this effort is exactly the mistake already made once tonight).
18. The function gains an **explicit, exhaustive `purpose` parameter with no default** — at minimum:
    `plan-draft` (round 1, co-planner), `plan-reconcile` (round 2+ proposer), `plan-signature` (round 2+
    signer), `task-conflict-reconvene` (post-ingest), `diff-review` (deliberation/red-team on
    implementation diffs). A caller that cannot state its purpose is a caller this change has not yet
    accounted for, and must not silently fall through to a default.
19. Diff/red-team review of **implementation diffs** (as distinct from planning drafts) is verified
    **unaffected** — proven by a render-contract test asserting a `diff-review`-purpose brief contains no
    draft-authoring or candidate-reconciliation instructions, before and after this change.

### R6 — Everything from P0-P2 that must NOT regress

20. **[TOKEN-FREE]** Fresh seats per round (C5) holds for every round type introduced here — draft
    rounds, reconcile rounds, signature rounds — exactly as it held for review rounds.
21. **[TOKEN-FREE]** Fail-closed holds: a malformed, missing, or stale-candidate SHA is never treated as
    a signature match.
22. **[DB]** Teardown/corruption fixes (A1-A6) are untouched — this effort does not touch
    `worker-runtime-finalize.ts`, the terminal-owner logic in `run-orchestrator-service.ts`, or the
    E5-class session-registry path.
23. **[TOKEN-FREE]** `HELM_SESSION_JANITOR` stays `0`.
24. **The historical-failure-mode regression sweep must assert real behavior, not existence-then-skip.**
    Confirmed by the panel: `planning-regression-index.test.ts` currently checks that seven scenario
    strings exist, then `it.skip`s every one — it can stay green through any regression in the mechanisms
    it claims to guard. Each historical mode must resolve to at least one **active** test with a real
    assertion; unresolved or skipped coverage fails the sweep, not passes it. New modes this effort
    introduces (blind-draft isolation, proposer/signer role integrity, alternation, objection
    monotonicity, atomic candidate promotion) join the sweep. **[DB]**

### R7 — Adaptive planning is explicitly out of scope, not silently forgotten

25. `adaptive_planning=1` (`planning-phase-service.ts:355-365` area — verify current line at
    implementation time) takes an early-return path before `generatePlanningBrief`/`runReviewRound`/the
    canonical gate this effort redesigns, and already implements a *different* co-author contract via
    lead-integration/settle semantics. R1-R6 govern **only** the non-adaptive path. This is stated
    explicitly so the same project-level directive does not silently mean two different things depending
    on a config flag. Reconciling the two is a **separate, deferred** follow-up — filed to backlog, not
    solved here.

## 4. The R4.14 question from v1 — resolved, not merely recommended

v1 asked whether plancore should stay a real (minimized) seat or be retired. **Resolved: retired as a
model seat for initial planning** (R1.1-R1.3). The review panel's finding was decisive: the engine
already performs every operative action a "coordinator" would perform, and a seat with no API to spawn
or message other seats — kept alive only to hold a brief describing what the engine does anyway — adds a
model call, a runtime row, a watchdog dependency, and a new way for a run to block, with no
corresponding function. `plancore` as a **label** (topology, staffing, UI) is unaffected.

## 5. Out of scope

- Re-litigating `planning-agreement-restructure`'s P0-P2 mechanics (R6, locked).
- The discovery→handoff confirmation bridge (`discovery-planning-handoff`) — unaffected.
- D1-D11 from `planning-agreement-restructure` — still separately deferred.
- Diff/red-team review of implementation diffs (R5.19, explicitly preserved).
- `adaptive_planning=1`'s existing co-author mechanism (R7) — separately deferred.
- Re-enabling `HELM_SESSION_JANITOR`.
- Merging to `main` (SD10).
