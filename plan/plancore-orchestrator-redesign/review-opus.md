# review-opus — plancore-orchestrator-redesign requirements sanity-check

**Seat:** `opus` · **Commissioned by** `[north]` `helm-97` per `REVIEW-CHARTER.md`, 2026-08-01
**Scope:** `north-star.md` + `og-requirements.md`, verified against `src/services/brief-writer-service.ts`,
`src/services/planning-review-round.ts`, `src/services/planning-phase-service.ts`,
`src/services/panel-service.ts`, `src/services/planning-staffing-service.ts`,
`src/services/run-orchestrator-service.ts`, `src/services/orchestrator-loop.ts`,
`src/services/role-alias.ts`, `src/planning-regression-index.test.ts`. Read-only; nothing edited.

---

## VERDICT: NEEDS-REVISION

The diagnosis is right and the governing principle is right — plancore holds the pen today
(`brief-writer-service.ts:308` "author **og-requirements.md FIRST**, then **plan.md**") and the co-planners
only render a verdict (`:463` "Report CLEAN/BROKEN… Emit VERDICT-READY"), and that is genuinely not what
JROM asked for. But the requirements document is not yet safe to plan against. Its single largest bet,
R2.7's byte-identical convergence, is not merely risky — it is unreachable by construction, because the
only strategy that could produce identical bytes ("adopt the other's draft verbatim") is symmetric, so both
seats executing it swap drafts and stay divergent; the deterministic outcome is `ROUND-CAP-EXHAUSTED`
BLOCKED on every planning run after burning six full-plan authoring turns at up to 600 s each
(`planning-phase-service.ts:382,388`). Independently of that, three requirements would cause real damage if
implemented as written: R3.10 cites `brief-writer-service.ts:523` — which is the **ibrain** brief's
description of the implementation-phase `re-plan` route, not C6's planning-round revise actuator — and says
"This is deleted," and R2.9's unscoped "PLAN-READY is retired" hits the same out-of-scope mechanism a second
time through the shared `helm_pm` face (`role-alias.ts:15-16`, `brief-writer-service.ts:254-256`,
`orchestrator-loop.ts:2283`); R1.1 deletes the plan.md schema-enum contract from plancore's brief without
requiring it to land in the co-planner brief, reopening a dated production ingest fault
(`brief-writer-plan-schema.test.ts:1-8`); and R5.19 rests the entire no-regression claim on
`planning-regression-index.test.ts`, which contains **zero** behavioral assertions — all seven historical
failure modes are `state: 'skipped'`, "No production-capable assertions yet" (`:15-44`), and the seven
skeleton cases are `it.skip` (`:89-94`). Fix R2.7's mechanism, scope R2.9/R3.10 to the planning phase, move
the schema contract, and name the real regression suite, and this is plannable.

---

## R2.7 CONVERGENCE DEFINITION — achievable as written, or needs a different mechanism?

**Not achievable. R2.7 is wrong and must be replaced, not loosened.**

### Why byte-identity cannot be reached

The artifacts under convergence are `og-requirements.md` (free prose, "structured sections with `R-XX`
requirement IDs", `brief-writer-service.ts:310-312`) and `plan.md` (a markdown wrapper plus a fenced JSON
array whose fields include free-text `title`, `validation_criteria`, and `exception_handling`,
`:314-328`). Byte-identity requires two different models to independently select the same element of a space
spanned by: every requirement's prose, every task title, task decomposition and count, task-id naming
convention, task ordering, JSON indentation and key order, and the markdown wrapper text. Nothing in R2
constrains any of those.

The inputs are not even identical to begin with. Each seat's brief differs by construction:
`partnerBatchId` (`planning-review-round.ts:504`), `seatLabel` (`:505`), and the per-spawn dispatch nonce
(`brief-writer-service.ts:22-27, 163`) are all seat-unique, and under S06 the two seats are deliberately
*different models* (`planning-staffing-service.ts:297-321` walks ordered panel members, and `used`/`modelKey`
at `:294,306` actively prevents the same model filling two slots). Two different models, given two
different briefs, are being asked to emit identical bytes.

### The trace R2.8 needs (3 rounds, concretely)

- **Round 1** — engine spawns seats A₁, B₁ blind (R2.6). A₁ writes `draft-A` (say 12 tasks, ids `T01…T12`,
  its own requirement prose); B₁ writes `draft-B` (9 tasks, ids `B1-T01…`, different titles). `sha(A) ≠
  sha(B)`. Divergence.
- **Round 2** — C5's keystone holds: there is no `transport.send`, so reconciliation is a fresh spawn
  (`planning-review-round.ts:499-564` respawns per round with a `-r{round}` id segment at `:501-506`). Fresh
  A₂ and B₂ each receive the *same symmetric instruction*: "here is the other's draft, reconcile toward one
  document." Three possible behaviors, all divergent:
  1. **Both adopt wholesale** → A₂ emits `draft-B`'s bytes, B₂ emits `draft-A`'s bytes. **They swap.** Still
     `≠`. This is the failure the charter asked about, and it is not a tail risk — wholesale adoption is the
     *most* cooperative reading of "reconcile toward one document," so it is what a well-behaved seat does.
  2. **Both merge** → A₂ emits `merge_A`, B₂ emits `merge_B`. Two models merging free text produce different
     bytes with probability indistinguishable from 1. Worse, each merge adds *new* reconciliation prose, so
     byte-distance can grow while semantic distance shrinks.
  3. **Both stand pat** → unchanged. `≠`.
- **Round 3** — same three outcomes over the new pair. Under (2) the drafts get semantically closer and
  remain byte-distinct.
- **Exit** — `resolvedRoundCap` (default 3, `projects.planning_round_cap`, `planning-phase-service.ts:388`)
  exhausts → `agreed:false` → `run-orchestrator-service.ts:1758-1773` → `transitionRunToBlocked`. There is
  **no retry**: `runPlanningPhase` is called once per run (`:1567`, `:1696`, `:1029`). Every planning run
  BLOCKS, after 6 full-plan authoring turns each bounded at `HELM_PLANNING_TIMEOUT_MS` = 600 000 ms
  (`planning-phase-service.ts:382`).

The fixed-point argument is the decisive one: the *only* Schelling point in this space is "copy the other's
file verbatim," and that point is symmetric — which is exactly outcome (1), the swap. R2 supplies no
asymmetric tie-breaker anywhere, so the one strategy capable of producing identical bytes provably cannot.
No termination condition rescues this, because the target itself is unreachable; better termination only
makes the failure cheaper.

### Replacement mechanism — asymmetric reconcile-and-sign

Adopt the charter's own alternative, made concrete. Keep byte-identity as the *binding* discipline (that
part of B5 is correct and is what makes the gate honest) but move it from **draft-vs-draft** to
**signature-vs-artifact**:

1. **Round 1 unchanged.** Both seats draft blind to seat-scoped paths (R2.5, R2.6 stand as written).
2. **Engine designates a reconciler by a neutral, deterministic rule** — e.g. the lexicographically smaller
   `sha256` of the two drafts, so it is not "slot 0 always wins" and is reproducible from the artifacts
   alone. Both hashes are already computable with the existing pure primitive (`plan-revision.ts:23-29`,
   `planRevision(bytes)`).
3. **Round N ≥ 2 is two seats with different jobs.** The reconciler seat is spawned fresh with *both*
   drafts and authors ONE reconciled document at the canonical path. The signer seat is spawned fresh, reads
   that document, and emits either `SIGNED plan=<sha12>` or a numbered objection list.
4. **Agreement = the signer's `plan=<sha12>` equals `readPlanRevision(canonical).short12`.** This is
   `waitForAgreement`'s existing B5 check *unmodified* (`planning-phase-service.ts:1092-1106`) — same
   fail-closed treatment of a missing/malformed/superseded SHA (`:1102-1105`), same re-derive-every-poll
   discipline (`:1088-1092`). The only change is which file the SHA binds to and which token carries it.
5. **The reconciler role alternates each round.** Round 2: A reconciles, B signs. Round 3: B reconciles,
   A signs. This is what keeps the mechanism faithful to JROM's directive — both co-planners hold the pen,
   neither is structurally the reviewer, and plancore holds it never. Without alternation you have merely
   moved the P0-P2 defect down one level: one permanent author, one permanent verdict button.

This terminates because each round has a single artifact and an asymmetric question. It preserves C5 (every
round is a fresh spawn), B5 (byte-bound agreement, fail-closed), C9/R2.9 (only the engine declares
agreement), and the governing principle (authority follows authorship; the author is a co-planner).

**Additional termination conditions worth specifying** (these help under the replacement; they cannot save
R2.7 as written):

- **Objection monotonicity.** The signer's objections must be numbered and bounded. Require round N+1's
  objection set to be a strict subset of round N's; a non-shrinking set is a typed early BLOCKED rather
  than burning the remaining cap. This is the analogue of C8's typed `blockedReasonKind`
  (`planning-review-round.ts:136-140`) for the new shape.
- **Diff, not just hashes, on BLOCKED.** R3.11 asks for "both seats' final draft hashes." Two hex strings
  tell an operator nothing about how far apart the seats landed. Emit a unified diff of the two drafts (or
  of the reconciled doc vs. the objections) into the run directory and name it in `blockedReason`.

---

## RANKED FINDINGS

### 1 · R3.10 + R2.9 jointly steer an implementer into deleting the out-of-scope implementation-phase re-plan path

**Mechanism:** R3.10 says: "C6's `generatePlanRoundReviseBrief` (`planning-review-round.ts:311`, dispatched
`:692`) currently spawns plancore to 'surgically revise' on disagreement (`brief-writer-service.ts:523`,
'Wakes plancore to surgically revise THIS slice'). **This is deleted.**"

`brief-writer-service.ts:523` is **not** part of C6's revise actuator. It is a line inside
`generateBrainBrief` (`:496-558`) — the **ibrain** escalation brief — describing route 3, the `plan` issue
route, which fires during the *implementation* phase after ibrain classifies a root cause. The brief it
actually wakes is `generatePlanReviseBrief` (`:564-624`), dispatched from `orchestrator-loop.ts:2225` inside
`consultPlancoreRevise`, whose result is awaited at `:2283`. Two entirely different mechanisms in two
different run phases have been merged into one citation.

R2.9 lands a second blow on the same target: "**`PLAN-READY` is retired as an authorship-completion
signal.** No agent — plancore or a co-planner — may emit a status meaning 'the plan is ready to use.'"
`orchestrator-loop.ts:2283` waits on exactly `['PLAN-READY', 'DECISION-READY', 'BLOCKED']` and parses the
revised task JSON out of the PLAN-READY note (`:2200`, and the emit template at
`brief-writer-service.ts:619`). Worse, `plancore` and `ibrain` share one worker face — `helm_pm`
(`role-alias.ts:15-16`) — and one role enum: `getRoleStates` returns the same
`PLANNING | PLAN-READY | … | BLOCKED` line for both (`brief-writer-service.ts:254-256`). Removing PLAN-READY
from that enum removes it for ibrain.

**Why it matters:** both documents list implementation-phase escalation as out of scope
(og-requirements §5), yet two separate requirements point an implementer at it and say delete/retire.
This is precisely the class of error the charter convened this panel to catch — a directive that reads
unambiguous and lands on the wrong mechanism.

**Fix:** (a) In R3.10, replace the `brief-writer-service.ts:523` citation with the actual actuator —
`planning-review-round.ts:311-354` (`generatePlanRoundReviseBrief`, a *local* function, deliberately not a
BriefWriterService method per its own doc comment at `:304-310`), dispatched at `:690-727`. Add an explicit
non-goal: "`generatePlanReviseBrief` (`brief-writer-service.ts:564`) and the ibrain `re-plan` route
(`orchestrator-loop.ts:2225`) are implementation-phase mechanisms and are NOT touched." (b) Scope R2.9 to
"PLAN-READY is retired **from the planning phase's agreement path**"; state that the shared `helm_pm` enum
at `brief-writer-service.ts:254-256` must keep PLAN-READY for ibrain's re-plan consumer, or that the enums
must be split by internal role first.

### 2 · R1.1 deletes the plan.md schema-enum contract without requiring it to land anywhere

**Mechanism:** R1.1 requires `generatePlanningBrief` to contain "**zero** of: the `og-requirements.md`-
then-`plan.md` derive order, the task-JSON schema instructions, the 'COPY THIS EXACT EXAMPLE TASK' block."
Those live at `brief-writer-service.ts:314-328`. R2.4 says the co-planner brief must instruct "an
**independent draft** of `og-requirements.md` + `plan.md`" — and says nothing about the schema.

That schema block exists because of a dated production failure. `brief-writer-plan-schema.test.ts:1-8`:
"PLAN.MD SCHEMA CONTRACT (cards2 ingest fault, 2026-07-16): the planning brief's plan.md task schema must
state the EXACT accepted enum for every field the plan parser validates — otherwise the planner emits
out-of-enum values (e.g. T-shirt effort sizes S/M/L) that throw at ingest ('invalid effort S') and BLOCK the
run." Six live assertions pin the effort enum, the L1/L2/L3 lane enum, the feature/issue type enum, the
T-shirt prohibition, `batch`-as-string, and the copy-this example. The enforcement point is unchanged:
`validateExecutionPlan` runs at `planning-review-round.ts:191` and again at
`planning-phase-service.ts:619-620`, and a parse failure on the real path throws
(`:689-690`).

**Why it matters:** an author who has never been shown the accepted enums emits `"effort":"M"`. Under the
new design *both* co-planners are that author. A known, dated, previously-fixed production defect reopens,
and R5's "nothing regresses" does not cover it because R5 never names this test.

**Fix:** add to R2.4: "the co-planner authoring brief must carry the full parser-accepted schema contract
(`brief-writer-service.ts:314-328`) verbatim in intent — effort enum, lane enum, type enum, T-shirt
prohibition, `batch` as non-empty string, and the complete example task — and
`brief-writer-plan-schema.test.ts` must be re-pointed at the co-planner brief, not deleted." Make it
`[TOKEN-FREE]` provable, same as R1.1.

### 3 · R5.19's named safety net has no behavioral assertions — the no-regression claim is vacuous

**Mechanism:** R5.19: "Every historical failure-mode regression test from `planning-regression-index.test.ts`
(P0-P2's AC23 sweep) stays green, unmodified in intent."

`src/planning-regression-index.test.ts` executes **no planning code at all**. All seven modes are
`state: 'skipped'` with the note "No production-capable assertions yet; index entry is present for migration
and future implementation streams" (`:15-44`). The two live `it(` blocks assert that the index has seven
keys matching a string list parsed out of a dispatch brief (`:64-78`) and that each note is non-empty and
free of "TODO" (`:80-87`). The seven per-mode cases are `it.skip` (`:89-94`). The file's only real
dependency is that `plan/planning-agreement-restructure/dispatch/D12-skeleton.implementer.brief.md` remains
readable and parseable (`:46-59`) — it throws if that artifact is ever pruned.

**Why it matters:** this test stays green no matter what this effort does to the planning subsystem. R5 —
the section whose entire job is "everything from P0-P2 that must NOT regress," in a document that opens by
saying "the tests are what stop it needing a #3" (§3) — is resting on a manifest check. Green here will read
as safety and is not.

**Fix:** replace R5.19 with the actual suite, and pre-declare which members this effort structurally
invalidates so nobody discovers it mid-implementation. From the call graph, the ones bound to changed
mechanisms are: `brief-writer-plan-ready-not-agreement-c9.test.ts` (PLAN-READY semantics in
`generatePlanningBrief`), `brief-writer-a12-split-brain.test.ts`, `brief-writer-plan-schema.test.ts`
(finding 2), `brief-writer-focus-contract.test.ts:104` (finding 7), `dispatch-service.test.ts:505`,
`brief-writer-panel-plan-contract-b2.test.ts` (asserts the panel brief names canonical `plan.md` + a
revision line — meaningless for a seat authoring from scratch), `planning-review-round-c8.test.ts` (finding
8), and `a0-convene-race-regression.test.ts`. Then either state that
`planning-regression-index.test.ts`'s seven skeletons get real assertions in this effort, or drop the
pretense that it protects anything.

### 4 · C3's artifact-publication gate blocks 100 % of runs under the new design, and no requirement mentions it

**Mechanism:** `runReviewRound` runs `checkArtifactsPublished` **once, before the round loop, before any
brief is written or any seat is spawned** (`planning-review-round.ts:451-464`). It requires canonical
`plan.md` to exist, be non-empty, and pass `validateExecutionPlan`, and `og-requirements.md` to exist and be
non-empty (`:175-216`). On failure it returns `{agreed:false, blockedReasonKind:'artifact-not-published'}`
immediately — no wait, no poll, no retry — and `run-orchestrator-service.ts:1758-1773` turns that into
`transitionRunToBlocked`.

Under this redesign, at the moment `runReviewRound` is entered, **nothing has authored anything** — the
co-planners have not been spawned yet, and by R1/R2 plancore never will author. The gate fails
deterministically on round 1 of every run.

**Why it matters:** this is a hard, silent, run-blocking incompatibility between the redesign and a P2
mechanism the north-star explicitly lists as carrying forward unmodified ("what carries forward from P0-P2
unmodified"). Neither document names C3 anywhere.

**Fix:** add a requirement re-pointing C3: the pre-round gate applies to **reconciliation rounds only** and
gates on the *drafts* (each seat-scoped draft exists, is non-empty, and — for `plan.md` drafts — parses via
the same `validateExecutionPlan` pipeline), never on canonical artifacts before round 1. Keep the
fail-closed shape and the `artifact-not-published` typed reason; only the paths and the round predicate
change.

### 5 · No draft-completion signal is defined — the engine cannot know when to hash

**Mechanism:** R2.7 says "the engine computes `sha256(seat-A's current draft)` and `sha256(seat-B's current
draft)` **after each round**." Nothing defines when a round is over per seat. The co-planner role enum
today is `panelist states: VERDICT-READY | CONSENSUS | SETTLED | CLEAN | BROKEN`
(`brief-writer-service.ts:257-259`) — there is no state meaning "my draft is written." And
`waitForAgreement` accepts evidence only from lines whose state is literally `VERDICT-READY`
(`planning-phase-service.ts:1053`) carrying a `CLEAN|BROKEN` note prefix (`:1057`) and a `plan=<sha12>`
(`:1105`). R2.9 then removes the one completion token the engine currently has.

Without a per-seat completion signal, the engine hashes a file that may be truncated mid-write — exactly the
class of bug C3's `TRUNCATED_PLAN_MD` fixture and B4's malformed-newest-line lockout
(`planning-phase-service.ts:1038-1063`, `planning-review-round.ts:252-259`) exist to close. A truncated
draft hashes differently, the engine calls divergence, and it spawns a reconciliation round against a
half-written document.

**Fix:** define the new grammar explicitly in R2: a co-planner emits `DRAFT-READY draft=<sha12>` where the
SHA is over the bytes it just wrote; the engine accepts a seat's draft as complete only when the seat's own
declared SHA matches what the engine reads from disk (self-verifying against truncation, fail-closed on
mismatch — the same discipline as B5). Add the state to `getRoleStates` for the planner/deliberation roles
and say so in the requirement, since R1/R2 currently change brief *text* without touching the enum that
gates callback parsing.

### 6 · R6 misses a third `generatePanelBrief` call site, and role-based discrimination collides on `planner`/`deliberation`

**Mechanism:** R6.20 states `generatePanelBrief` is "a **shared** function today, used for planning
co-planners AND for deliberation/red-team review of implementation diffs." There are **four call sites in
three files**:

| site | `role` passed | act |
|---|---|---|
| `planning-review-round.ts:511` | `partner` — `'planner'` \| `'deliberation'` | planning co-planner (in scope) |
| `planning-phase-service.ts:952` | `partner` — `'planner'` \| `'deliberation'` | **A13 per-task reconvene** (not named in R6) |
| `panel-service.ts:63` | `'panelist'` | deliberation panel on implementation |
| `panel-service.ts:123` | `agent?.role` \| `'panelist'` | red-team on a diff |

The A13 reconvene path (`planning-phase-service.ts:936-974`) runs **after** the whole-plan gate has passed
and the plan has been ingested (`:698-710`), to resolve per-task `ACCEPT/AMEND/ESCALATE` conflicts on an
*already-agreed* plan. It passes the **same role token** as the co-planner path. Any implementation that
discriminates on `role === 'planner' || role === 'deliberation'` — the obvious reading of R6 — will turn the
A13 reconvene brief into a full plan-authoring brief, which is wrong: reconvene must stay a verdict act.

**Why it matters:** R6's proof obligation ("a diff-review brief contains no draft-authoring instructions,
and a planning co-planner brief contains no diff-review instructions") is satisfiable while A13 silently
regresses, because R6 never names A13 as a call site to check.

**Fix:** enumerate all four call sites in R6 and add a third proof case for A13. Discriminate on an
**explicit parameter** (e.g. `mode: 'author' | 'verdict'`, defaulting to `'verdict'`), not on the role
string — the role token is genuinely ambiguous across acts and always will be.

### 7 · The Focus contract tells the new author not to read, and to route reads through a coordinator forbidden to answer

**Mechanism:** `brief-writer-service.ts:128-135` appends a Focus contract to every brief whose role is
**not** in `['plancore', 'ibrain', 'discovery']` (`:129`). Co-planner roles (`planner`, `deliberation`) are
not excluded, so they get it — asserted as required behavior by `brief-writer-focus-contract.test.ts:70-81`.
Its text: "Read only what the task requires… Do NOT explore or read unrelated files, projects, or
directories 'just because'… If you genuinely need data from outside the project, do NOT wander off to fetch
it yourself — **request it from the coordinator, which decides whether the read is warranted and fetches it
for you.**"

R2.4 makes that seat the author of the whole plan from north-star/conversation-log/decisions. R4.12 forbids
plancore from supplying anything but read-only path pointers — "It injects no requirements content, no task
breakdown, no scope judgment." So the brief instructs the author to narrow its reading and to escalate reads
to a seat the requirements forbid from answering.

**Why it matters:** this is a brief-level self-contradiction of exactly the kind
`brief-writer-service.ts:145-158` teaches implementers to report as `PLAN-CONTRADICTION`. It will produce
under-read plans, and the seat has no defined recourse.

**Fix:** state in R2.4 that the co-planner authoring path must be excluded from the Focus contract (add the
co-planner roles to the `:129` exclusion list for the authoring mode only — deliberation/red-team on diffs
keep it, per R6), and update `brief-writer-focus-contract.test.ts` accordingly. Note the exclusion list is
today a *role* list and the co-planner role serves two modes, so this depends on finding 6's explicit mode
parameter.

### 8 · R3.10 deletes the revise actuator but leaves C6/C8's BROKEN-evidence machinery orphaned

**Mechanism:** R3.10 names only `generatePlanRoundReviseBrief` as deleted. Three coupled mechanisms go with
it and are unmentioned: `collectSameShaBrokenEvidence` (`planning-review-round.ts:261-302`),
`waitForPlanRevisionChange` (`:362-370`), and C8's `blockedReasonKind: 'same-plan-broken'` classification
(`:136-140`, `:668-681`, `:730-747`). Under draft-convergence there are no CLEAN/BROKEN verdicts at all, so
`'same-plan-broken'` becomes unreachable and `planning-review-round-c8.test.ts` becomes inapplicable.

**Why it matters:** R5.19 explicitly asks that a test made "genuinely inapplicable" be reported as a finding
rather than silently deleted. Reporting it here, at requirements time, is cheaper than discovering it at
gate time — and the typed-reason taxonomy needs replacing, not just pruning: the new shape needs
`draft-not-converged` / `signer-objected` / `reconciler-silent` reasons.

**Fix:** extend R3.10 to name the coupled mechanisms and require a replacement `RoundBlockedReasonKind`
taxonomy for the draft/sign shape.

### 9 · R4.14 — my position: keep the plancore ROLE, stop spawning the plancore SEAT during the debate

The document frames this as binary — real seat vs. retiring the role — and picks "real seat, minimized" on
the grounds that retirement would force "every topology contract, UI seat-preview surface, and staffing
resolver (S05/S06) to be re-taught that plancore might not exist." That reason is **correct about the role
and overstated about the seat**, because in the current code those are two different things.

What genuinely depends on the plancore **role** existing:

- `phase-staffing.ts:13` — `brain: 'plancore'` is the declared brain for the planning phase.
- `planning-staffing-service.ts:242-246` — `resolveManifest` resolves the planning brain and **hard-throws**
  `required brain unavailable for phase planning: plancore` if absent; `:247-260` builds the `plancore`
  `StaffingSeat`; `:376-378` folds it into the manifest digest via
  `buildManifestDigestPayload({ plancore, coPlanners })` — the topology digest changes if plancore leaves.
- `cycle-seat-preview.ts:18,42,55,103,131-134,160,224,244` — `'plancore' | 'co-planner'` is a typed
  discriminant through the whole pre-spawn preview surface.
- `toCorePlanningStaffingArgs` (`planning-staffing-service.ts:186-196`) sets `brainRole: 'plancore'`.

So retiring the *role* is genuinely a large change, and R4.14 is right to refuse it. But **none of that
requires a seat to be spawned.** The preview surface is manifest-driven and pre-spawn; the live Planning
panes read `worker_runtimes` via `GET /api/cycles/:id/seats` (`index.ts:1878-1881`), so a role that resolves
but does not spawn simply has no pane — it does not break either surface.

And under R4.12's ceiling the plancore seat has **zero acts left**. R2.8 assigns the relay to "the engine —
not plancore." Sequencing is the round loop (`planning-review-round.ts:605-728`). Convergence tracking is an
engine hash. Handing co-planners their context is already done by the engine when it composes the brief —
`generatePanelBrief` resolves the canonical root and computes `planMdPath`/`ogReqPath` itself
(`brief-writer-service.ts:446-453`, the AC6/AC14 "do not guess the path" contract at `:475`). A spawned
plancore seat under these requirements costs a model call, can go silent (which is the only reason R4.13
needs a watchdog at all), can die and block a run, and contributes nothing.

**Recommendation:** state in R4.14 that plancore is retained as a **role** — phase brain, staffing manifest
member, digest contributor, preview row — and is **not spawned as a seat during the debate rounds**. That
delivers "the most plancore can do is give inputs (minimal)" honestly: the inputs are the context pointers
the engine bakes into each co-planner brief, deterministically, which is strictly better than asking an
agent to relay them (the exact meta-lesson `planning-agreement-restructure` closed — "Helm asking an agent
to uphold an invariant instead of enforcing it"). It makes R4.13's watchdog requirement moot rather than
new machinery. And the requirements should say explicitly what the Planning pane shows during a debate
round, since S14 shipped live seat panes (`0a0c883`) and R4 does not mention the UI at all — the honest
answer is "the two co-planner panes, which is where the work is."

*Counter-argument, stated fairly:* keeping a spawned plancore preserves a place to put future coordination
judgment (deciding when the debate is unproductive, choosing which round to cut short) without re-plumbing.
If `[north]` wants that option open, keep the seat — but then R4.12's ceiling has to move, and JROM should
be told that is the trade, because "a seat with a brief describing acts it does not perform" is the same
species of defect as "a planner who only reviews."

### 10 · The verbatim quotes ask for the *best* plan; the requirements optimize for the *same* plan

**Mechanism:** JROM's quote 1 is "**debat the plans**" — plural — and quote 3 is "its main function is that
co-planners **coordinate effectively to arrive at the best plan**." R2.7 encodes a *sameness* criterion.
Nothing in R1-R6 encodes a *quality* criterion: no bar, no lens, no ground the debate must cover, no
mechanism by which the stronger of two drafts prevails. Two seats can converge — under my replacement
mechanism, quite efficiently — on an identical mediocre plan and the gate is satisfied.

Compare what the current code loses. The verdict brief the redesign replaces carries a real lens:
"Pressure-test **atomicity, deps, fields, complexity/recommended_model, validation_criteria**"
(`planning-review-round.ts:515` and `:532-533`). Under R2.4 that lens disappears with the verdict, and no
requirement puts it back. The redesign correctly moves the pen; it should not also drop the standard.

**Fix:** add a requirement to R2: the reconciliation/sign round must be conducted against a **stated
lens** — atomicity, dependency DAG soundness, requirement coverage (every `R-XX` covered by ≥1 task), field
validity, and validation-criteria concreteness — carried forward from `planning-review-round.ts:515,532-533`
into the authoring/sign briefs. The signer signs *on that basis*, not merely on "I can live with these
bytes." That is what makes it a debate rather than a merge, and it is what "the best plan" actually asked
for.

### 11 · R3.11's `[DB]` obligation has no consumer today

**Mechanism:** R3.11 wants non-convergence at round-cap reported "with **both seats' final draft hashes**"
and marks it `[DB]`. Today the only thing that escapes `runPlanningPhase` is the human-readable
`blockedReason` string, consumed at `run-orchestrator-service.ts:1766` and `:1069`. C8's typed
`blockedReasonKind` (`planning-review-round.ts:151-154`, surfaced at `planning-phase-service.ts:609`) is
**read by nothing** in production — grep across `run-orchestrator-service.ts` finds no reference.

**Why it matters:** an `[DB]` acceptance criterion needs a named row and column, or it is provable only by
string-matching a prose reason — which is what P0-P2 already learned to stop doing.

**Fix:** name the persistence target in R3.11 (a `run_events` row via `recordRunEvent`, as A13 already does
at `planning-phase-service.ts:964-969`, is the closest existing precedent), and either wire
`blockedReasonKind` into the same row or state that it stays diagnostic-only.

### 12 · R2.5's draft path is under-specified against the canonical-root / runDir split

**Mechanism:** R2.5 says drafts go to "a **seat-scoped path**… in the run directory." But canonical
artifacts do not live in `runDir` — they live in `canonicalArtifactRoot`, which is the cycle folder for a
cycle-backed run and `runDir` only as fallback (`planning-phase-service.ts:367`, `:540`, `:581`), and are
copied into `runDir` only after the gate passes (`materializeCanonicalArtifactSet`, `:696`).
`checkArtifactsPublished` resolves the requirements path as `path.dirname(planMdPath)`
(`planning-review-round.ts:454`). Path-guessing in this subsystem already caused a fix (AC6/AC14,
`brief-writer-service.ts:475` "do not guess the path").

**Fix:** name the root explicitly — drafts under `<canonicalArtifactRoot>/drafts/<seatId>/{plan.md,
og-requirements.md}` — so the engine hashes and the seats write against one resolved root, and state
whether drafts are materialized into `runDir` at handoff.

### 13 · Minor citation drift (accurate enough to plan from, but stale as written)

- **R2.4 / north-star** cite `generatePanelBrief` as `:433-480`. The method is `433-493`; the range stops
  short of `:489-490`, which is where the verdict instruction actually lives ("Provide ONLY your independent
  verdict" / the `VERDICT-READY` emit template) — i.e. the range excludes the exact lines the requirement is
  about.
- **R1.1 / north-star** cite `generatePlanningBrief` as `:268-350`; the method is `268-351`. Immaterial.
- **R3.10** cites `generatePlanRoundReviseBrief` at `planning-review-round.ts:311` (correct) and dispatch at
  `:692` (correct — `writeBrief` at `:701`, `spawn` at `:702`).
- **R1.3** cites `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` at `planning-phase-service.ts:689` — correct.
- **north-star** cites the canonical ingest path at `planning-phase-service.ts:617-689` — correct
  (`readCanonicalPlan` at `:617`, the throw at `:689`).

Everything else I checked is accurate. The one materially wrong citation is finding 1's
`brief-writer-service.ts:523`.

---

## WHAT I COULD NOT DETERMINE

1. **Whether C3's pre-round gate is already misfiring on the current production path.** Reading the code
   alone, `runPlanningPhase` spawns plancore (`planning-phase-service.ts:499`), waits only for plancore's
   *first callback* (`:509-515` — satisfied by any parseable line for the batch, and the brief's streaming
   mandate at `brief-writer-service.ts:200-202` forces an append before any prose), then calls
   `runReviewRound` (`:551`), which immediately runs `checkArtifactsPublished` with no wait
   (`planning-review-round.ts:451-464`). If plancore's first callback is a `PLANNING` progress line rather
   than `PLAN-READY`, the gate fires before plan.md exists and the run blocks — and there is no retry
   (`run-orchestrator-service.ts:1758-1773`). C3's own comment says absence "this early is NOT-YET" and "No
   reviewer spawned for **this attempt** yet," which presumes an outer retry I could not find. I could not
   determine from static reading whether real plancore seats in fact emit nothing until PLAN-READY (which
   would mask this entirely). It does not change finding 4 — under the redesign the gate fails
   unconditionally — but if it *is* misfiring today it is a live P2 defect worth its own look. Checking
   `run_events` `CALLBACK_WAIT_RESULT` rows against `blockedReasonKind='artifact-not-published'` occurrences
   in `data/helm.db` would settle it; I did not query the DB (read-only charter, and a live DB read felt
   outside "just findings").

2. **Whether byte-identity might be salvageable under a canonicalization pass.** I considered whether
   normalizing the artifact (sorted JSON keys, fixed indentation, stripped markdown wrapper) could make
   R2.7 reachable. It removes formatting variance but not content variance — free-text `title`,
   `validation_criteria`, `exception_handling`, task decomposition, and the whole of `og-requirements.md`
   remain — so I am confident it does not rescue R2.7. I did not attempt an empirical two-model trial,
   which is the only thing that could disprove me; if `[north]` wants that, one round of two seats drafting
   the same tiny north-star and diffing the outputs would cost far less than discovering it in
   implementation.

3. **What JROM wants the Planning pane to show if plancore is not spawned** (finding 9). The seat-preview
   surface is manifest-driven and unaffected, and the live panes are `worker_runtimes`-driven so plancore
   would simply be absent. Given that he validates by attaching to sessions, I believe removing an idle
   pane is an improvement and the two co-planner panes are what he actually wants to watch — but that is a
   product call, not a mechanism one, and I did not want to assume it.

4. **Whether `plan/_panels/planning-path-review/` contains a finding this redesign reopens.** The charter
   offered it as optional background. I deliberately did not read `findings-opus.md` / `findings-sol.md` /
   `findings-grok45.md` / `SYNTHESIS.md` there, to keep this seat's read of the current mechanism
   uncontaminated by a prior panel's framing. My R5 verification is therefore grounded in the code and the
   test suite (findings 2, 3, 8), not in that panel's record — if it names a failure mode absent from my
   list, that gap is mine.

---

REVIEW-DONE opus
