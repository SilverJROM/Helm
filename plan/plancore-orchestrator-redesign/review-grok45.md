# Review — grok45 seat · plancore-orchestrator-redesign requirements

**Seat:** grok45 · **Charter:** `REVIEW-CHARTER.md` · **Date:** 2026-08-01  
**Scope (read-only):** `north-star.md`, `og-requirements.md`, verified against current
`brief-writer-service.ts`, `planning-review-round.ts`, `planning-phase-service.ts`,
`panel-service.ts`, `planning-staffing-service.ts`, and background from
`plan/_panels/planning-path-review/SYNTHESIS.md`.

---

## VERDICT: NEEDS-REVISION

The north-star correctly re-points *who holds the pen* (co-planners author; plancore does not), and most
P0–P2 primitives (fresh seats, fail-closed hashing, engine-declared agreement, round-cap → BLOCKED) are
the right machinery to keep. The requirements fail the charter’s own stress-test on the single largest
bet: **R2.7’s definition of agreement as byte-identical independently-authored `plan.md` drafts is not
achievable as written** and will produce near-infinite reconciliation under the R2.8 fresh-seat design.
That definition must be replaced before implementation planning, or this becomes effort #3 on the same
subsystem for a different wrong protocol. Secondary: R1.2 / R2.8 / R4.14 disagree on whether plancore
actually does anything; R2.4 strips authoring from plancore without relocating the machine task-JSON
schema; R2.9 retires `PLAN-READY` without rewriting the gate that still requires it; and at least one
cited line is the wrong revise path.

---

## R2.7 CONVERGENCE DEFINITION — achievable as written, or needs a different mechanism?

**Needs a different mechanism. Byte-identical convergence of two independently authored drafts is the
wrong analogue of B5 and will not hold in practice.**

### Why the bet is wrong

B5 binds a *reviewer’s CLEAN* to *one existing plan’s bytes*
(`planning-phase-service.ts:1002–1007`, `waitForAgreement` + `readPlanRevision`). That is
**verification of a single artifact**, not **co-production of identical prose**. R2.7 inverts that:

> agreement = `sha256(seat-A draft) === sha256(seat-B draft)` after independent authorship.

`plan.md` is not a pure structural AST. Canonical shape is markdown wrapper + fenced JSON with free-text
fields (`title`, `validation_criteria`, `exception_handling`, task id/batch naming) —
`generatePlanningBrief` at `brief-writer-service.ts:314–328`. Two competent models that agree
substantively still diverge on:

- task id / batch naming (`T01` vs `B1-T01`)
- title and validation_criteria wording
- task order and deps graph layout
- markdown headings / blank lines outside the fence
- JSON key order and indentation if they pretty-print differently

Byte-identity therefore requires **one seat to copy the other’s bytes**, not “arrive at the same
document through debate.” Nothing in R2.8 instructs a seat to byte-copy on substantive agreement; it
asks each to “reconcile toward one document.” That produces *new* prose each round.

### Concrete R2.8 trace (oscillation, 3 rounds)

Assume round-cap = 3, two different models, engine relays drafts only (R2.8).

| Round | What engine does | What seats produce | Hashes |
|------:|------------------|--------------------|--------|
| 1 | Concurrent blind draft (R2.6) | A writes structure S_A + prose P_A; B writes S_B + P_B | H_A ≠ H_B |
| 2 | Fresh seats; A sees B’s draft, B sees A’s | A adopts B’s batching but keeps A’s validation wording → H_A2; B adopts A’s task ids but keeps B’s titles → H_B2 | H_A2 ≠ H_B2 (hybrid, not copy) |
| 3 | Fresh seats; A sees B2, B sees A2 | A swings toward B2’s titles; B swings toward A2’s structure | H_A3 ≠ H_B3, often *farther* from either parent than round 2 |

No round produces matching bytes unless a seat is explicitly told “if you accept the other’s draft,
write it **verbatim** to your draft path.” Without that, R2.11’s round-cap → BLOCKED is the *steady
state*, not the exception. That is not “fail-closed honesty”; it is a protocol that cannot succeed.

### Replacement (take a position)

**Replace R2.7 with a dual-draft → single-proposer → SHA-bound co-signer model** (B5 re-pointed to
authorship, not dual independent identity):

1. **Round 1 (unchanged intent):** both co-planners draft independently to seat-scoped paths
   (`draft-<seatId>.md` / `draft-<seatId>-req.md`). Engine never treats either as canonical.
2. **Divergence handling (replace pure dual-reconcile):** engine picks a **proposer** by a
   deterministic rule (document it — e.g. lower `sha256` of draft bytes, or configured seat-0). The
   other seat is the **co-signer**.
3. **Reconciliation round(s):** both still spawn fresh (C5).  
   - Proposer brief: read own draft + other draft; emit a **single** reconciled draft at
     `draft-reconciled.md` (or overwrite proposer path). Must incorporate concrete defects from the
     other draft or state why not.  
   - Co-signer brief: read `draft-reconciled.md` only as the candidate; either (a) emit
     `CLEAN plan=<short12 of that file’s current bytes>` with no rewrite, or (b) emit
     `BROKEN plan=<short12>` with a defect list (no alternate full plan, or optional counter-draft
     that becomes the *next* proposer’s input — pick one, don’t leave both).
4. **Agreement (new R2.7):** engine computes `short12` of the candidate file and accepts agreement
   only when the co-signer’s newest callback is `CLEAN` bound to **that exact** short12 (same fail-closed
   rules as B5: missing/malformed/mismatched SHA = not agreement). Engine then **copies** candidate →
   canonical `plan.md` / `og-requirements.md`. No seat writes the canonical path.
5. **Optional tight variant if you still want “both authored bytes”:** after co-signer CLEAN, engine
   may require the co-signer path to be a **byte-copy** of the candidate (engine-verified). That is
   achievable because the brief can say “cp the candidate”; pure independent re-authoring cannot.

This preserves: dual independent first drafts (real debate input), engine-owned agreement, SHA
fail-closed, fresh seats, no plancore pen. It drops the fantasy that two models will hash-collide on
prose.

**Do not** “loosen the hash” to fuzzy/semantic similarity. That reopens C1-class fail-open
(`plan/_panels/planning-path-review/SYNTHESIS.md` C1). Keep cryptographic binding; change *what* is
bound (co-signer CLEAN → one candidate), not the strictness of the bind.

---

## RANKED FINDINGS

### F1 — CRITICAL · R2.7/R2.8 convergence protocol is unimplementable as written

**Mechanism:** R2.7 (`og-requirements.md:74–77`) + R2.8 (`:78–82`) + north-star open bar (`north-star.md:92–94`, resolved the wrong way).

**Why it matters:** Every downstream piece (revise actuator deletion in R3, canonical ingest in R1.3,
BLOCKED semantics in R3.11, provenance) inherits a success condition that independent dual-authorship
almost never hits. Failure sequence: ship R2 as written → live run burns 3 fresh dual-spawns →
`ROUND-CAP-EXHAUSTED` with two “good but different” plans → operator sees “disagreement” when models
agreed on substance → next wrong fix is looser agreement → C1 returns.

**Concrete fix:** Replace R2.7/R2.8 with the proposer/co-signer mechanism above. Keep byte-identity only
for **co-signer CLEAN ↔ candidate file**, never for two independent full rewrites. Specify engined
canonical write. Require R3.11 BLOCKED payload to include both draft hashes **and** last candidate
short12 + co-signer note.

---

### F2 — CRITICAL · Machine contract (task-JSON schema) has no new owner after plancore stops authoring

**Mechanism:** Today the ingestible plan contract lives only in plancore’s brief —
`brief-writer-service.ts:306–328` (derive order, field enums, `COPY THIS EXACT EXAMPLE TASK`). R1.1
deletes that from plancore. R2.4 tells co-planners to draft from north-star/conversation-log/decisions
only — **no mention of moving the schema block**.

**Why it matters:** Two free-form “plans” that never parse under `validateExecutionPlan`
(`planning-phase-service.ts:617–621`) never become a run. Failure sequence: co-planners write prose or
wrong JSON types → engine never sees R2.7 match **or** match-then-fail at ingest →
renamed `PLANCORE-DID-NOT-PRODUCE-…` still fires, but now neither seat was given the contract.

**Concrete fix:** Add an explicit R2 requirement: co-planner authoring brief **must** include the same
helm-algo task-JSON contract (or a shared constant/string builder used by both old plancore brief and
new co-planner brief). “Minimal inputs” for plancore ≠ “no schema for authors.” Schema is engine
contract, not plancore authorship.

---

### F3 — HIGH · R1.2 vs R2.8 vs R4.14: three different plancore jobs, one recommendation

**Mechanism:**

| Claim | Source | Plancore does… |
|-------|--------|----------------|
| Sequences rounds, relays drafts, tracks hash convergence, reports to engine | R1.2 (`og-requirements.md:49–53`) | Real coordination seat |
| Engine relays drafts and dispatches revise rounds; plancore not in loop | R2.8 (`:78–82`) | Nothing in the loop |
| Keep real seat for topology/UI/S05–S06; may be thin label | R4.14 (`:139–147`) | Maybe a label |

S05 still hard-requires plancore: `planning-staffing-service.ts:244–246`
(`required brain unavailable for phase planning: plancore`). Phase still spawns brain first:
`planning-phase-service.ts:370`, `:496–504`. C6 revise still spawns `brainRole` today:
`planning-review-round.ts:690–714`.

**Why it matters:** Implementation will invent a third shape under time pressure (likely “spawn plancore
with a hollow brief so staffing does not throw”) while R1.2’s text still claims coordination work the
engine already owns — exactly the “title without authority” smell the north-star is trying to close,
inverted (authority without work / work claimed without mechanism).

**Concrete fix:** Requirements must **pick one** before plan:

- **(A) Thin label (recommended with R2.8):** engine owns spawn/relay/hash/BLOCKED. Plancore seat is not
  spawned for planning (or is a no-op fixture). S05/S06/UI get a follow-up to stop requiring phase
  brain — R4.14’s “topology rewrite is bigger” is true but is not a reason to leave dual truths in
  *this* effort’s AC; at minimum stamp “plancore not spawned; staffing still lists phase brain for
  display only” as an accepted transitional defect with a ticket.  
- **(B) Real coordinator:** plancore receives callbacks of draft paths/hashes and may **only** emit
  sequencing signals the engine already enforces (redundant). Argue why the token cost is worth it.  
- Do not ship “brief says coordinator, code is engine, seat still billed.”

R4.14’s keep-seat recommendation is **acceptable as transitional staffing**, **not** as proof that
plancore still “coordinates.” Retiring content contribution does **not** break S05 if the resolver
still returns a phase brain row — but spawning that brain with R1.2’s ambitions is pure waste. Prefer
(A) + explicit “no spawn” or “spawn only for mid-run `generatePlanReviseBrief` (out of scope)” note.

---

### F4 — HIGH · R2.9 retires `PLAN-READY` without specifying the gate rewrite that still requires it

**Mechanism:** `waitForAgreement` requires projcore/`brainRole` `PLAN-READY` **and** partner CLEANs
(`planning-phase-service.ts:976–987`, `:1047–1048`, `:1087+`). Review-round comments restate the same
(`planning-review-round.ts:568–569`). R2.9 (`og-requirements.md:83–86`) retires PLAN-READY as
authorship-completion; R1.2 says plancore’s callback never contains PLAN-READY as authorship claim —
but nothing states the new gate predicate.

**Why it matters:** Naïve implementation deletes PLAN-READY from briefs and leaves `waitForAgreement`
unchanged → every run times out / never agrees. Or someone reuses PLAN-READY from a co-planner as a
side channel → C9-class confusion (`brief-writer-plan-ready-not-agreement-c9.test.ts` exists because
this already burned once).

**Concrete fix:** Add R2.9b: agreement predicate becomes engine-only observation of R2.7’ (replacement)
with **no** PLAN-READY required. List call sites that must change: `waitForAgreement`,
`runReviewRound` comments/contracts, C9 tests (intent: still “no agent declares agreed”), fake-transport
fixtures that seed PLAN-READY lines, provenance/start-implementation if any still keys off PLAN-READY.
Name the replacement observability artifact if operators still need a “planning finished writing”
signal (e.g. engine log line, not agent status).

---

### F5 — HIGH · R2.7 hashes only `plan.md`; dual-draft `og-requirements.md` is unbounded

**Mechanism:** R2.5 (`og-requirements.md:66–69`) requires seat-scoped drafts for **both**
`og-requirements.md` and `plan.md`. R2.7 only compares plan draft hashes. Ingest still needs both
canonical files (`planning-phase-service.ts:624–636`, `:689`).

**Why it matters:** Plan drafts can converge (or co-sign) while requirements IDs/text diverge →
`req_refs` point at different R-IDs → validator contract is nonsense. Or engine copies plan from seat A
and reqs from seat B.

**Concrete fix:** Convergence (or co-sign) must cover **both** artifacts: either one candidate pair
`(req, plan)` hashed/bound together (e.g. hash of `sha256(req)||sha256(plan)` or two short12s on the
CLEAN line), or a single packaged draft directory the engine promotes atomically. Spec which seat’s
reqs win under proposer model (same proposer for both).

---

### F6 — HIGH · Shared `generatePanelBrief` has three planning-adjacent callers; R6 under-counts

**Mechanism — actual call sites today:**

| Site | Role | Act |
|------|------|-----|
| `planning-review-round.ts:511–536` | co-planner / partner | plan review (to become authoring) |
| `planning-phase-service.ts:952–960` | partner reconvene | **per-task verdict** after whole-plan agreement (A13) |
| `panel-service.ts:63–71` | deliberation panelist | approach verdict |
| `panel-service.ts:123–132` | red-team | diff verdict (`implementedDiff`) |

Function body is verdict-shaped end-to-end: `brief-writer-service.ts:433–493` (scope CLEAN/BROKEN,
VERDICT-READY, plan revision bind). R6 (`og-requirements.md:129–136`) correctly protects
deliberation/red-team but **omits A13 reconvene**, which also needs verdict semantics and still speaks
`plancore verdict=` (`:957`) — meaningless if plancore no longer authors or emits task verdicts
(`collectTaskVerdicts` at `:704–707`, `:897–917` still partitions plancore vs partner).

**Why it matters:** Editing `generatePanelBrief` in place regresses diff review **and** A13. Leaving
reconvene/plancore-verdict machinery untouched after dual-author leaves dead or lying conflict
detection on the post-agreement path.

**Concrete fix:** R6 must require a **split** (preferred) or a discriminated mode parameter with tests
for all four call sites. Separate AC: A13 / `collectTaskVerdicts` / `detectTaskReconveneConflicts`
either (i) re-point to co-planner-A vs co-planner-B task tags, or (ii) deferred out of scope with an
explicit “post-convergence per-task reconvene disabled until redesigned” note — not silent leave-as-is.

---

### F7 — MEDIUM · Stale / wrong citation: `brief-writer-service.ts:523` is not the C6 revise path

**Mechanism claimed:** north-star `north-star.md:69–72` and R3 item 10 (`og-requirements.md:90–93`)
cite `planning-review-round.ts:692` + `generatePlanRoundReviseBrief` **and**
`brief-writer-service.ts:523` “Wakes plancore to surgically revise THIS slice.”

**What the code actually is:**

- **C6 whole-plan round revise (in scope):** local `generatePlanRoundReviseBrief` at
  `planning-review-round.ts:311–349`, dispatched at `:690–714`, role `plancore` / `brainRole`, rewrites
  whole `plan.md`, emits PLAN-READY. **Not** in `brief-writer-service.ts`.
- **Line 523** is inside **`generateBrainBrief`** (ibrain escalation classifier):
  `brief-writer-service.ts:517–524` — routes `plan` root-cause → “Wakes plancore to surgically revise
  THIS slice.” That is **mid-run re-plan**, not planning-phase C6.
- **Mid-run surgical slice revise:** `generatePlanReviseBrief` at `brief-writer-service.ts:560–624`
  (scope at `:585`).

**Why it matters:** Charter says a wrong citation is a finding. Implementers following `:523` will
touch ibrain/re-plan (out of scope / different contract) or think deleting one string removes C6.

**Concrete fix:** Retarget R3 cites to `planning-review-round.ts:311–349` + `:690–714` only. Explicitly
state mid-run `generatePlanReviseBrief` / ibrain re-plan is **out of scope** (or a named follow-up if
plancore must also stop authoring mid-run slices — currently still plancore-authored).

---

### F8 — MEDIUM · R5 “nothing regresses” is under-specified against panel prescription item 2

**Mechanism:** Prior panel prescribed engine-owned loop:
artifact-ready → review → BROKEN → **plancore revises (new plan hash)** → **respawn partners**
(`plan/_panels/planning-path-review/SYNTHESIS.md:51–53`). P0–P2 built that. This effort **deletes**
plancore revise (R3.10) and changes agreement from verdict-vs-plan to draft-vs-draft.

R5 (`og-requirements.md:114–127`) correctly locks fresh seats, fail-closed hash, teardown files,
janitor=0, regression index — but does **not** list the re-pointed tests that will legitimately need
intent changes (C6 revise-spawns-plancore tests, PLAN-READY+CLEAN fixtures, B5 “CLEAN plan=current”
against a single plan.md, convene-before-artifacts partner wait language at
`planning-review-round.ts:525–533`).

**Why it matters:** “Unmodified in intent” (R5.19) will either block the redesign or force silent test
deletes — the charter’s failure mode. Also: convene-race fix text still assumes plancore authors after
partner spawn (`:516–524`); dual concurrent authoring removes that race **and** invents a new one
(two seats writing different drafts; canonical absent until convergence).

**Concrete fix:** Add an R5 appendix: table of P0–P2 tests that **must change intent** (list by file
where known: `planning-review-round-c*.test.ts`, `planning-phase-nonconvergence-b6.test.ts`,
`brief-writer-plan-ready-not-agreement-c9.test.ts`, panel contract B2) vs tests that **must stay green
byte-identical** (teardown A1–A6, janitor, B5 fail-closed on malformed SHA). Require new TOKEN-FREE
tests: dual blind round-1 (no draft path cross-ref), no canonical write before agreement, co-signer
SHA mismatch fails closed, engine canonical copy only after agreement.

---

### F9 — MEDIUM · Adaptive planning already implements “plancore = driver, others author”

**Mechanism:** `adaptive-planning-phase.ts:1–5` (module header): plancore = DRIVER only; lead_planner
and tiers author; integrator produces plan.md. Out of scope flag `adaptive_planning` still exists;
panel called adaptive a second planner with weaker agreement (SYNTHESIS sol #13 / P3).

**Why it matters:** Shipping a third dual-author shape on the **core** path without citing adaptive’s
lessons (skeleton → critique → settle → integrate, not dual full-plan hash race) risks rediscovering
the same integration problems. R2’s blind dual full-plan is *harder* than adaptive’s staged handoff.

**Concrete fix:** Requirements should either (a) explicitly borrow adaptive’s staged authoring
(independent drafts of structured intermediate artifacts, one integrator step — but integrator must be
a **co-planner seat or engine merge**, not plancore, per JROM), or (b) state why core path rejects
that pattern. Do not ignore the sibling module.

---

### F10 — MEDIUM · JROM “coordinate effectively” / “minimal inputs” / “debate” not fully captured

**Verbatim (north-star):**

1. plancore orchestrates; planners **debate** the plans before implementation.  
2. plancore must **not write anything**; only drive conversation.  
3. most plancore can do is **minimal inputs**; main function is co-planners coordinate effectively.

**Gaps in R1–R4:**

- **Debate ≠ dual independent rewrite until hash match.** Debate implies critique of *differences*
  (structured defect list, forced responses). R2.8 never requires a seat to answer the other’s
  concrete objections — only to “reconcile toward one document.”  
- **Minimal inputs:** should enumerate the **closed set** of allowed injections (paths only?
  round number? other draft path? schema pointer?). R4.12 lists paths; R1.2 also says “hand context”
  and “track when both drafts hash identically” — tracking is engine work if R2.8 is honest.  
- **Coordinate effectively:** if engine sequences everything, “coordination” is a product of brief
  design + engine protocol, not a live plancore dialogue. Requirements should say so so no one builds
  a chat-relay through plancore’s pane (no `transport.send` — C5 keystone, `north-star.md:64–65`).

**Concrete fix:** Add R4.15: allowed plancore/engine inputs are an enumerated allowlist; debate round
briefs must include a mandatory “respond to these N defects from the other draft” section generated
by the engine from the prior BROKEN/defect notes (or from a required `## Diff vs other` section each
seat writes). No free-form “just make them similar.”

---

### F11 — LOW · Citation range nits (accurate enough, tighten)

- `generatePlanningBrief` `brief-writer-service.ts:268–350` — **correct** (function ends `:351`).  
- `generatePanelBrief` `:433–480` — body continues through `:493`; range is short but start is correct.  
- `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` at `planning-phase-service.ts:689` — **correct**.  
- Canonical ingest block `:617–689` — **correct** for read/validate/throw; materialize/ingest continues
  `:694–698`.  
- C7 `waitForFirstCallback` generalization — exists on planning phase for plancore
  (`planning-phase-service.ts:509`) and in review-round for partners; R4.13’s “generalized” claim is
  directionally right, not fully re-verified line-by-line here.

---

## WHAT I COULD NOT DETERMINE

1. **Whether live production projects currently run `adaptive_planning=1`** and thus already exercise a
   dual-author path — would change how urgent F9 is for rollout sequencing.  
2. **Exact operator-facing surfaces** (UI seat preview strings) that hard-code “plancore authored plan”
   — R4.14 asserts them; I did not audit the frontend.  
3. **Whether `planning_panel_size` / solo panelSize=1** (`waitForAgreement` allows empty partners,
   `:986–987`) is still a supported mode under dual-author: one co-planner cannot “debate.” Requirements
   never define panelSize=1 behavior after redesign.  
4. **Provenance service** (`planning-provenance-service.ts`) pins `plan_sha256` after agreement — should
   still work if engine writes canonical bytes, but I did not re-read every Start Implementation gate
   path for PLAN-READY assumptions.  
5. **Full regression index file list** for R5.19 — asserted existence of
   `planning-regression-index.test.ts`; did not re-inventory every AC23 case against the redesign.

---

## Citation verification summary

| Citation in docs | Status |
|------------------|--------|
| `generatePlanningBrief` `:268–350` authoring plancore | **Verified** |
| `generatePanelBrief` `:433–480` verdict co-planners | **Verified** (range slightly short) |
| C6 dispatch `planning-review-round.ts:692` | **Verified** (revise spawn block `:690–714`) |
| `generatePlanRoundReviseBrief` `:311` | **Verified** |
| `brief-writer-service.ts:523` as C6 surgical revise | **Wrong path** (ibrain classifier; see F7) |
| `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` `:689` | **Verified** |
| Shared `generatePanelBrief` deliberation/red-team | **Verified** (`panel-service.ts:63`, `:123`) |
| S05 plancore required | **Verified** (`planning-staffing-service.ts:244–246`) |

---

## Bottom line for `[north]`

Do not send this requirements pack to implementation planning until **R2.7/R2.8 are rewritten** to a
mechanism that can succeed with real models (proposer + SHA-bound co-signer), **schema ownership** is
assigned to co-planner briefs, **agreement gate without PLAN-READY** is specified, and **plancore’s
residual role is a single chosen shape**. The effort’s one-sentence goal is right; the convergence
definition reintroduces “protocol as wishful cooperation” — the same class of failure
`planning-agreement-restructure` was built to end.

REVIEW-DONE grok45
