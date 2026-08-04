# PANEL FINDINGS — `opus` (claude-opus-5)

**Seat:** independent panelist, no cross-talk (did not read `findings-grok45.md` / `findings-sol.md`).
**Written:** 2026-07-30 ~06:0x PHT (DB/file timestamps below are UTC as stored; PHT = UTC+8, so run 31
ended 04:45 PHT and run 32 ended 05:28 PHT — matching the charter's own timeline).
**Code state read:** working tree of `fix/planning-convergence-panes`, i.e. **including** the uncommitted
in-flight A1/A2/A4 convergence fix (`git diff` on `planning-phase-service.ts` + `brief-writer-service.ts`).
Line numbers are worktree lines. Where a finding is *caused or worsened by the in-flight fix* I say so.

---

## VERDICT: NEEDS-RESTRUCTURING

Restructuring is needed in exactly one place, and it is the place all eight defects live: **the agreement
loop.** The phase decomposition (discovery → plancore authors → panel reviews → gate → ingest → provenance)
is the right shape and should be kept. What is wrong is that the *protocol* between those phases is not
implemented anywhere. It is implied by English prose in three separately-generated briefs, transported over
an append-only text file, arbitrated by a regex, and driven by seats the engine cannot address after it
spawns them. There is no state, no round counter, no version binding, and no actuator: `planning_round_cap=3`
is multiplied into a wall-clock timeout (`planning-phase-service.ts:368`) and never counts a round, and the
only verbs Helm has for a partner seat are `spawn` and `reap` — there is no `send` in the entire file, so
"round 2" is a thing Helm hopes the model does on its own initiative for thirty minutes.

That is why "one root cause" was never credible and why four rounds of patching have not converged: each fix
addresses one prose instruction or one branch, while the missing thing is the state machine. The in-flight fix
is the clearest evidence — it is a careful, well-reasoned change, and it introduces a **fail-open in the
unanimity gate** (F1) that will ship an unreviewed plan the first time convergence actually works. You cannot
patch your way out of this; a coordination protocol with no explicit state will keep producing novel defects
at roughly the rate you run it. Build the loop as a bounded engine-driven state machine with versioned
artifacts (F1/F2 fixes below), and the other findings become ordinary bugs.

Do not ship the in-flight fix as-is. It converts run 32's honest 5.5-minute failure into a 30-minute silent
hang with the same outcome (F2), and if it ever gets past that, F1 lets an unreviewed plan through.

---

## RANKED FINDINGS

Ranked by: will it bite a real run × how soon × how badly.

---

### F1 — Stale CLEAN is counted as agreement on a plan that seat never saw (fail-OPEN in the "unanimous" gate)

**NEW. Introduced by the in-flight fix. Highest severity: it is silent and it passes bad work forward.**

**Mechanism.** `waitForAgreement` decides success at `planning-phase-service.ts:1055`:

```ts
if (sawPlanReady && partnerBatchIds.every((id) => verdicts.get(id) === 'CLEAN')) return true;
```

`verdicts` is built at `:1012-1027` as `Map<partnerBatchId, 'CLEAN'|'BROKEN'>`. It stores **a bare enum**.
There is no binding to the plan bytes the verdict judged, and **no ordering constraint** between a verdict
line and the `PLAN-READY` matched at `:1016` — the only requirement is that both appear somewhere in the
same fence-scoped window during one poll pass.

The in-flight partner brief then tells a CLEAN seat to leave (diff, `planning-phase-service.ts` partner
`requirement`, the A4 block):

> "Only stop watching once you have emitted CLEAN, or the plan.md content has stayed identical…"

**Failing sequence** (round 2, panel of 2 — project 3's exact configuration):

1. `partner` reviews plan v1 → `VERDICT-READY — CLEAN`. Per the brief, it stops watching. Seat idles.
2. `partner-2` reviews plan v1 → `VERDICT-READY — BROKEN` (gating findings).
3. plancore (in-flight §8) fixes the findings → writes **plan v2** → re-emits `PLAN-READY`.
4. `partner-2` re-reads v2 → `VERDICT-READY — CLEAN`.
5. Poll pass: `sawPlanReady` true, `verdicts = {partner:'CLEAN', partner-2:'CLEAN'}` → gate returns true.
6. `:692` materializes, `:694` `ingestExecutionPlan` ingests **v2** into `run_tasks`.

`partner`'s CLEAN was rendered against **v1** and was never refreshed. The plan that ships was reviewed in
full by exactly one seat, and the gate whose entire purpose is unanimity reports unanimity. Nothing on disk
records the discrepancy.

**Trigger.** The *first time round 2 ever converges* — i.e. the first time the in-flight fix does what it was
written to do. It is not an edge case; it is the designed happy path.

**Blast radius.** Silent. An unreviewed plan becomes the implementation queue. Worse than any hang, because
the operator gets a green gate and a plan with a real defect in it — exactly the class of thing run 32's
partner caught (its G1/G2 were both genuine). This also feeds F7: provenance then pins a SHA for a plan the
panel never unanimously reviewed, and `assertPlanningProvenanceForImplementation` rubber-stamps it.

**Fix.** Engine-side, no agent cooperation required — an **ordering fence**: in each poll pass, record the
byte offset of the newest matching `PLAN-READY` line, and accept a seat's CLEAN only if that CLEAN's line
offset is **greater** than that PLAN-READY offset. A stale CLEAN from before the latest revision then simply
does not count, and the gate keeps waiting — which is the behaviour the round-cap budget already exists to
bound. Strengthen it by having the partner include `sha256(plan.md)` (or a 12-char prefix) in its
`VERDICT-READY` note and requiring it to equal the hash of the plan.md read in that same pass; that also
gives you the audit record ("seat X approved these exact bytes") that AC28 provenance currently cannot
produce. Also delete "stop watching once you have emitted CLEAN" from the brief — a CLEAN seat must keep
watching until the gate closes.

**Confidence: HIGH.** Mechanism is plain from `:1012-1055` plus the brief text; no inference about model
behaviour is needed for the fail-open (a CLEAN seat that *does* keep polling merely narrows the window).

---

### F2 — Round 2 has no engine-side actuator; "convergence" is a 30-minute hope against self-contradictory brief text

**THE ONE THING most likely to break the next run.** See its own section below; stated here for ranking.

**Mechanism.** Three facts, each verifiable:

1. **The engine cannot re-engage a partner.** Across all of `planning-phase-service.ts` the only transport
   calls are `spawn` (`:454`, `:536`, `:942`), `reap` (`:468`), and `inspectSeat` / `resubmitIfComposerHeld`
   (`:791`, `:812`). There is **no `transport.send`**. The inspect/resubmit pair lives inside
   `waitForFirstCallback` (`:731-836`), which is invoked **only for `brainRole`** (`:461`) — never for a
   partner. So once a partner has emitted its verdict and its CLI turn has ended, nothing in Helm can start
   another turn in that pane. The code comment at `:520-522` already knows this: *"a seat that already
   emitted VERDICT-READY does not re-emit."*
2. **The brief contradicts itself.** `generatePanelBrief` renders, at `brief-writer-service.ts:474`:
   *"Provide ONLY your independent verdict. Emit the callback then stop."* The in-flight A4 text countermands
   it — *"this brief's boilerplate below says 'emit the callback then stop' — that default does NOT apply to
   you here"* — but that countermand is injected via `requirement`/`northStarAnchors`, which render at
   **lines 3, 26 and 32** of the produced file, while the contradicted boilerplate renders further down. Both
   instructions ship in the same brief. Which one wins is model-dependent. Verified in the real artifact:
   `data/runs/helm-run-3-rms6l9kn5/prompts/deliberation.brief.md`.
3. **The deadline is never told to the seat.** `generatePanelBrief`'s signature
   (`brief-writer-service.ts:438-447`) has no round-cap or timeout parameter — `planningRoundCap` is passed
   to the *plancore* brief only. So the partner brief hardcodes *"up to ~8 minutes"* (`:527`) and then, in the
   A4 block, *"several minutes; you are not told the exact deadline."* The engine knows the number exactly:
   `PLANNING_TIMEOUT_MS` 600 000 (`:361`) × `roundCap` 3 (`:367-368`, `projects.planning_round_cap = 3` for
   project 3, verified) = **1 800 000 ms = 30 minutes**.

**Failing sequence.** Partner emits BROKEN → in-flight `waitForAgreement` no longer returns false (`:1046-1055`)
→ it polls for the full 30 minutes → the seat, having obeyed either the boilerplate or its own 8-minute
figure, is idle and will never emit again → `:1055` never satisfied → `:1062` returns false →
`:674` `ROUND-CAP-EXHAUSTED`. **Identical outcome to run 32, 25 minutes later.**

**Blast radius.** Every non-trivially-perfect plan. Any real critique — which is the normal case, and run 32
proves the panel produces good ones — costs 30 minutes of dead wall-clock and then fails the run anyway.
Operator-visible symptom: the UI sits in `planning` with live panes and no progress for half an hour.

**Fix.** Make the round loop engine-driven and bounded by *rounds*, not by a multiplied timeout:

- Track `(round, planSha)` in `waitForAgreement`. On observing a new `PLAN-READY` whose plan.md bytes differ
  from the last reviewed hash, **re-spawn each partner seat** (a fresh `spawn` with a re-review brief carrying
  the prior verdict text and the new plan path) — `spawn` is the only verb Helm has that reliably starts an
  agent turn. `round += 1`; block at `round > roundCap`, which is what D7 actually says.
- Pass the real per-round deadline into `generatePanelBrief`.
- Remove the contradictory "emit the callback then stop" from the panel body when a convergence loop is
  expected, rather than countermanding it in a different section of the same file.

**Confidence: HIGH** on the mechanism (absence of `send`, the watchdog's `brainRole`-only scope, and the
brief contradiction are all directly verifiable). **MED** on how often a given CLI self-polls for 30 minutes
— but note that F2 does not require the seat to misbehave, only to obey the older of two conflicting
instructions.

---

### F3 — Partners are never told where the canonical plan is; both runs' partners *guessed* it

**Mechanism.** `generatePanelBrief` (`brief-writer-service.ts:438-462`) hardcodes `planPath: 'plan.json'`
(`:452`) and `runDir: '.'` (`:453`), and its parameter list accepts **no** `canonicalArtifactRoot`. The call
site (`planning-phase-service.ts:509-534`) passes `role`, `batchId`, `seat`, `lens`, `requirement`,
`projectDir`, `callbacksFile` — and never the canonical root, even though the function computing it is three
lines away (`:585`). For runs 31/32 that root is `/home/agjrom/tools/memory_mcp/cycle/ui-upgrade_0727`,
resolved at `run-orchestrator-service.ts:1370`.

**Evidence, from the real brief on disk** (`data/runs/helm-run-3-rms6l9kn5/prompts/deliberation.brief.md`):

- `:23` — `Plan: plan.json`  ← the only plan path the seat is given
- `:40` — "…relative to runDir", with runDir rendered as `.`
- `:43` — `Project dir: /home/agjrom/tools/memory_mcp`
- `:3`, `:26`, `:32` — the phrase "canonical plan.md" appears three times, **with no path, ever**

So the seat is told to review a "canonical plan.md" whose location it must infer, and is separately told the
plan is at `plan.json`. Run 31's partners inferred `cycle/ui-upgrade_0727/plan.md` — correctly, by reading
project docs — which is why their callbacks name that path. That was luck, not design; run 32's `partner`
(opus5) also found it and produced a genuinely excellent review.

The literal reading is a guaranteed deadlock: `runDir/plan.json` **cannot exist** before the gate. It is
derived only at `:694` (`ingestExecutionPlan`) *after* agreement, and `:692` materializes the canonical set
into runDir only on the agreed path. A seat that polls `plan.json` waits its instructed 8 minutes on a file
that cannot appear until after its own verdict, then goes silent → F2's 30-minute hang.

**Blast radius.** A coin-flip per seat per run, decided by whether the model chooses to hunt for the real
file. Also a latent landmine at `brief-writer-service.ts:459`: `projectDir` defaults to
`'/home/agjrom/TGBOTS/Helm'`, a path this repo no longer lives at.

**Fix.** Add `canonicalArtifactRoot` to `generatePanelBrief` and render **absolute** paths for `plan.md` and
`og-requirements.md`. This is a two-line change and removes the guess entirely.

**Confidence: HIGH** — the produced artifact is on disk and says exactly this.

---

### F4 — No first-callback or submit watchdog on partner seats (only plancore has one)

**Mechanism.** The spawn-retry block at `planning-phase-service.ts:439-476` gives `brainRole` three spawn
attempts, a 120 s first-callback window, `waitForFirstCallback` (`:731-836`) with a session-alive probe
(`:789-795`) and the `resubmitIfComposerHeld` Enter-re-press watchdog (`:809-828`) that exists specifically
for the documented *"variable codex Enter-drop window"* (`:458-460`). The partner spawn loop at `:536-561`
gets **none** of it: `await this.transport.spawn(...)`, then `registerWorkerRuntime`, then straight into
`waitForAgreement`. No first-callback wait, no submit watchdog, no session probe, no retry.

**Evidence.** Run 32: `partner` (worker_runtimes id 524, claude/claude-opus-5) emitted three callbacks;
`partner-2` (id 525, codex/gpt-5.6-sol, spawned 21:23:23, reaped 21:28:30) emitted **zero** in 5 m 07 s.
`data/runs/helm-run-3-rms6l9kn5/dispatch/` is empty and `callbacks.md` contains **no** `[helm ACK]` lines at
all — including from `partner`, which demonstrably worked — so ACK absence proves nothing either way here.
**I could not determine** whether partner-2's brief was ever submitted or whether it was simply still inside
its instructed ~8-minute artifact wait when reaped at 5.5 minutes. The latter alone fully explains it.

**Why it matters regardless of which it was:** the engine has no way to *notice* either case. The gate
requires unanimity across every configured seat (`:1055`), so one silent partner deterministically consumes
the whole 30-minute budget and forces `ROUND-CAP-EXHAUSTED`, with no diagnostic naming the mute seat. This
also answers charter Q4: **partner-2 is absolutely load-bearing — it is the binding constraint.** It is not a
discarded opinion; it is the single seat whose silence has now killed the gate in the only run that reached it.

**Fix.** Route partner spawns through the same `waitForFirstCallback` + retry path as plancore (shorter
window is fine), and name the specific mute `partnerBatchId` in `blockedReason` at `:674` instead of listing
all of them.

**Confidence: HIGH** on the missing watchdog. **LOW** on the cause of partner-2's specific silence — stated
as undetermined.

---

### F5 — A failed run marks the cycle `complete`, which wedges the new bridge *and* stamps an immutable topology freeze

**Mechanism (two distinct consequences from one call).** `transitionRunToBlocked` with `kind='failure'`
(`run-orchestrator-service.ts:362`) calls `terminalizeCycleAtRunEnd` (`:393`), which calls
`setCyclePhase(cycleId, 'complete')` (`:616`). This is not a slip — it is a schema limitation. Verified:

```sql
phase TEXT NOT NULL DEFAULT 'discovery'
  CHECK(phase IN ('discovery','planning','implementation','final_tests','complete'))
```

There is **no failure terminal for a cycle**, so `'complete'` is the only value available, and the docstring
at `:596-598` says so outright ("the sole terminal cycle phase"). Consequences:

**(a) The new bridge refuses the retry.** `startConfirmedHandoffPlanning` requires
`phase ∈ {discovery, planning}` (`:871-879`) and throws `BAD_STATE` otherwise. So after any failed planning
run, the confirmed-handoff path cannot be re-entered for that cycle until someone hand-edits `cycles.phase`.
Cycle 13 reads `'discovery'` today only because it was walked back by hand — twice, matching the charter's
"cycle 13 twice". **Charter Q6 answered: the cycle is genuinely wedged, and the only recovery is a manual DB
write.**

**(b) An immutable freeze is stamped at the failure.** `setCyclePhase` → `freezeTopologyOnCycleStart`
(`cycle-service.ts:396-397` → `:155-158`) → `cycle_topology_freezes`, which is `UNIQUE(cycle_id)` with
`BEFORE UPDATE`/`BEFORE DELETE` `RAISE(ABORT)` triggers. Verified row:

```
id=8  cycle_id=13  project_id=3  frozen_at = 2026-07-29 20:45:20
```

— **run 31's exact `ended_at`.** So cycle 13's "intended topology" baseline is permanently the snapshot taken
at the teardown of a failed run, it can never be re-stamped when the cycle actually reaches implementation,
and `:156`'s presence check makes every future freeze attempt a silent no-op.

**Scope correction (I checked, and it is narrower than it looks):** the freeze is **not** read by planning
seat resolution. Its only consumers are `intended-actual-service.ts:164` and `index.ts:882/904/940` —
reporting surfaces. So this corrupts intended-vs-actual drift reporting for the life of cycle 13; it does
**not** silently override seat changes. Related gap worth noting: the snapshot contains only `role_tiers` and
`team_tiers` — `project_planner_panel` is **absent**, so *who planned a cycle* is neither frozen nor
auditable, which is a hole under the same provenance goal as AC28.

**Blast radius.** (a) is operational and recurring — every failed planning run needs a hand-repair before the
next attempt, on the path JROM is meant to be using. (b) is permanent per-cycle reporting corruption.

**Fix.** Add a non-terminal failure phase (or, simpler, do what the operator-pause path already does at
`:392` and leave `cycles.phase` untouched on failure — a failed run is not a completed cycle). Gate
`freezeTopologyOnCycleStart` on a genuine forward transition, never on a failure terminalization. Add
`project_planner_panel` to the snapshot.

**Confidence: HIGH** — schema, trigger definitions, and the `frozen_at`/`ended_at` coincidence are all direct
reads.

---

### F6 — The phantom `ibrain` seat is ledger fiction, and it asserts a *project-wide* session idle (charter Q1, answered)

**Mechanism.** `transitionRunToBlocked` → `assertImplementationBrainComplete` (`:406`, with `state:'failed'`)
→ session name derived from the **project** slug, not the run (`:574-577` → `helm-ibrain-memory_mcp`), with
`provider`/`model` omitted → `finalizeBrainSessionRow` (`worker-runtime-finalize.ts:168`) defaults them to
`'unknown'`/`'unknown'` (`:209-210`) → a planning-only run has no ibrain row, so the *register-if-needed*
branch at `:237-253` **INSERTs** a row (`spawned_by='brain-phase-end'`,
`correlation_id='brain:ibrain:<runId>'`) and immediately finalizes it to `'failed'`.

**Evidence** (`worker_runtimes`, verbatim):

```
522 | ibrain | unknown | unknown | helm-ibrain-memory_mcp | brain:ibrain:31 | failed | brain-phase-end | 31 | run-blocked-failure | 20:45:20 | 20:45:20
526 | ibrain | unknown | unknown | helm-ibrain-memory_mcp | brain:ibrain:32 | failed | brain-phase-end | 32 | run-blocked-failure | 21:28:30 | 21:28:30
```

`started_at == ended_at == runs.ended_at`, `spawned_by='brain-phase-end'`.

**Answer to Q1: no ibrain seat ever existed in runs 31 or 32.** It is a bookkeeping row manufactured *by the
assertion that it was complete*, at run teardown, on a run that never reached implementation. It **suppresses
nothing and corrupts nothing functionally** — it is not a hidden cause of the planning failures. Two real
costs remain:

- Every failed planning run manufactures a fake `state='failed'` seat with `provider/model='unknown'`, which
  pollutes the seat ledger, any human-facing seat list, and any monitoring keyed on worker failures. It is
  the app reporting something that did not happen — the exact class of thing SD3 in `north-star.md:72`
  forbids for planning seats.
- `finalizeWorkerRuntimeRow` runs the registry-idle writer (`assertRegistryIdle`), and the session name is
  **project-scoped**. A genuinely live `helm-ibrain-memory_mcp` pane belonging to a *different* run would be
  asserted idle by an unrelated planning failure.

**Fix.** At a terminal, finalize only an **existing** row; never register-if-needed a seat that never
spawned. If a "brain was asserted complete" record is wanted, write a `run_events` row, not a
`worker_runtimes` seat.

**Confidence: HIGH** on the mechanism and on "it suppresses nothing". **MED** on the registry-idle
consequence — I did not trace `assertRegistryIdle`'s consumers to a concrete collision.

---

### F7 — Provenance can pin a different plan than the one ingested (charter Q7, answered) — and only on the *new* bridge

**Mechanism.** `plan.md` is read **twice, independently**:

1. `planning-phase-service.ts:616` `readCanonicalPlan()` → `planMarkdown` → `:694`
   `ingestExecutionPlan(rid, planMarkdown, …)` creates `run_tasks`.
2. `planning-provenance-service.ts:147` `fs.readFile(planPath)` → `:152` `sha256Hex` → `recordSuccess`,
   invoked from `run-orchestrator-service.ts:1003` **after** `runPlanningPhase` has already returned.

Nothing carries bytes or a hash from (1) to (2) — `PlanningResult` exposes `planMdPath` but not the content
or its digest.

On the **legacy** path the window is closed by luck: `:1738` reaps the planning session
(`planning-done-yield-to-algo`) *before* the provenance call at `:1762`. On **`startConfirmedHandoffPlanning`
there is no reap at all** — I grepped `:700-1037` for `reap|finalizeRunWorkerRuntimes` and the method contains
neither. And `finalizeWorkerRuntime` at `planning-phase-service.ts:710` is DB bookkeeping only; it explicitly
does **not** kill the pane (`run-orchestrator-service.ts:557`: *"Does NOT reap/terminate"*). The in-flight fix
then *deliberately keeps plancore alive past PLAN-READY* in its §8 watch-and-revise loop.

So a single further plancore write between (1) and (2) yields: `run_tasks` built from plan v_n, while
`planning_provenance.plan_sha256` pins v_n+1. `assertPlanningProvenanceForImplementation` (`:220-243`) then
re-reads disk, matches the pinned SHA, and **passes** — certifying an implementation queue that does not
correspond to the pinned plan. The gate designed to prevent exactly this drift is the thing that blesses it.

Combined with F1, the worst case is coherent and fully silent: a plan only one seat reviewed, ingested at one
version, pinned at another, and gated green.

**Fix.** Compute `sha256(planMarkdown)` inside `runPlanningPhase` from the exact ingested bytes, return it on
`PlanningResult`, and have `recordProvenanceAfterAgreement` accept it instead of re-reading. Reap plancore on
the handoff path too.

**Confidence: HIGH** on the mechanism and the missing reap. **MED** on frequency (needs a plancore write in
the window).

---

### F8 — Legacy Start Planning re-authors the cycle's discovery docs (defect 8, confirmed by bytes)

**Mechanism.** `startRunInner`'s interview branch (`run-orchestrator-service.ts:1530-1562`) spawns a
**discovery** seat whose brief carries `canonicalArtifactRoot` = the cycle doc dir (resolved at `:1370`), so
the seat re-runs the interview and re-authors the canonical docs in place.

**Evidence — md5 + mtime, not inference:**

```
229c82d2851f16ea779b0a66d1d87bfc  /home/agjrom/tools/memory_mcp/cycle/ui-upgrade_0727/north-star.md  (21:22)
229c82d2851f16ea779b0a66d1d87bfc  data/runs/helm-run-3-rms6l9kn5/north-star.md                       (run 32)
8c55a9fd93a2f6d74fea818da750c701  data/runs/helm-run-3-rms6jr3eg/north-star.md                       (20:42, run 31)
```

The cycle's live `north-star.md` is **run 32's** authored version; run 31's differs and now survives only
inside run 31's own runDir. Run 32's `state/transitions.json` is `["interview","planning","blocked"]`,
confirming the interview branch executed. So run 32's discovery overwrote the cycle-13 north-star that run
31's discovery had produced — which AC15 forbids.

**And the new bridge has never run.** `SELECT * FROM discovery_handoffs` returns **zero rows**. The entire
S10–S14 ASK/confirm bridge — the path built precisely to *not* do this — has never executed in production.
The only path anyone has used is the one that destroys the docs.

For accuracy: `:1433`'s guard (`canonicalArtifactRoot === runDir`) *correctly* prevents the raw-prompt write
at `:1434` from clobbering a cycle's north-star. The damage is the re-spawned discovery seat, not that line.

**Charter Q5 answered.** The two entry paths do not merely diverge — they have **opposite contracts** on the
same bytes: the bridge treats existing discovery docs as read-only inputs
(`:886-900`, "we never write these paths"), while the legacy path treats them as its own output. They can
absolutely reach inconsistent state, and per D-03 (new cycles over old cycles) the legacy path **should not
exist for a cycle-linked run**.

**Fix.** In `startRunInner`, if `input.cycleId != null` and the cycle already has non-empty `north-star.md`
+ `conversation-log.md`, refuse the interview branch with a typed error pointing at the confirmed-handoff
route. Then work out why the bridge has never been exercised — a path with zero production rows is not
"shipped".

**Confidence: HIGH.**

---

### F9 — Verdict parsing is fail-open on the stale side and fail-silent on the separator

**(a) An unparseable newest verdict promotes an older one.** At `:1019-1027` the reversed scan takes a
seat's verdict only when `/^\s*(CLEAN|BROKEN)\b/i` matches the note; if it does not match, **nothing is set**
and the loop keeps walking to older lines, so an *earlier* verdict is recorded as "latest". A round-2 line
phrased `VERDICT-READY — Revised plan resolves G1 and G2; no remaining gating findings` carries no leading
token, so it is discarded and the seat's round-1 verdict stands. Paired with F1 this is a second, independent
route to a stale CLEAN passing the gate. The docstring at `:980-981` claims omission is "fail-closed", which
is true for a *first* verdict and false once any prior verdict exists.

**(b) Only two separator characters are accepted.** `parseAgreementCallbackLine` (`:844`):

```ts
/^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+([A-Z-]+)(?:\s+[—-]\s+(.+))?\s*$/
```

`[—-]` is em-dash or ASCII hyphen only. An **en-dash** (U+2013) or a colon yields `note = null` → "no verdict
yet" → the seat never registers a verdict → 30-minute hang. Both runs' seats happened to emit em-dashes.

**Fix.** Select the newest `VERDICT-READY` per seat **first**, then parse it; an unparseable newest is
`UNKNOWN` and must block, never fall through to an older line. Widen the separator class and accept a
colon.

**Confidence: HIGH** on mechanism, **MED** on likelihood (the brief does specify the tokens).

---

### F10 — The non-convergence exit can throw instead of returning the mechanism-level blocked reason

**Mechanism.** When `waitForAgreement` returns false at `:579`, control does **not** go to the `if (!agreed)`
block. It first runs the plan-existence poll (`:597-608`) and `readCanonicalPlan` (`:614-618`). If plancore
never wrote a valid `plan.md`, the catch at `:619` throws `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN`
(`:660-661`) — **before** `:665`. That throw skips:

- `:668-669` both `finalizeWorkerRuntime` calls → planning seats stay `state='running'`, `ended_at` NULL
- `:670` `advanceAgreementFence`
- `:674` the A11 `ROUND-CAP-EXHAUSTED` `blockedReason` the operator is supposed to see

**Blast radius.** MED. The run still fails (via the detached catch at `run-orchestrator-service.ts:460-501`),
but the operator loses the mechanism-level reason and the seat ledger leaks `running` rows — the precise
symptom A15 was written to eliminate.

**Fix.** Move the `!agreed` check above the plan poll/read. One-line reorder.

**Confidence: HIGH** — the statement order is unambiguous.

---

### F11 — (minor) 20 ms poll now runs for the full 30 minutes

`waitForAgreement` sleeps 20 ms between passes (`:1057`) and each pass re-reads and re-parses the whole
fence-scoped `callbacks.md` (`:1009`). Under the old fail-fast this ended quickly; the in-flight fix makes a
non-converging run do this ~90 000 times. Not a correctness bug (the file is small and the loop yields), but
it is pure waste and it will grow with callback volume. 1–2 s is plenty.

**Confidence: HIGH.** Severity: low.

---

## THE ONE THING most likely to break the NEXT run

**F2 — the next run will hang for 30 minutes and then fail with the same `ROUND-CAP-EXHAUSTED` as run 32.**

The in-flight fix removed the fail-fast (`:1046-1055`) but added no way for Helm to make a partner speak
again. `planning-phase-service.ts` has no `transport.send`; the submit/first-callback watchdog is
`brainRole`-only (`:461`); and the partner brief simultaneously says "emit the callback then stop"
(`brief-writer-service.ts:474`) and "that default does NOT apply to you" (in-flight A4 text), while quoting a
~8-minute horizon against an engine budget of 30 minutes it is never told. Whether the run converges is
therefore decided by whether two CLI seats independently choose to sleep-poll a file whose path they were
never given (F3) for six times longer than their brief suggests.

Run 32 failed honestly in 5 m 30 s. With this fix it fails in 30 minutes. That is the most likely next
outcome, and it will look like a hang, not a verdict.

**Then, the moment F2 is fixed, F1 bites** — and F1 is worse, because it is silent: the first successful
round-2 convergence ships a plan that only one seat ever reviewed, through a gate that reports unanimity.

Minimum to make the next run worth spending: (1) F3 — put absolute canonical paths in the panel brief;
(2) F2 — engine re-spawns partners on a new PLAN-READY, counting real rounds against `roundCap`;
(3) F1 — the ordering fence, so a stale CLEAN cannot satisfy the gate; (4) F5(a) — stop marking a failed
run's cycle `complete`, so the retry does not need a hand-edited DB. Items 1, 3 and 4 are small and
mechanical. Item 2 is the restructuring.

---

## WHAT I COULD NOT DETERMINE

1. **Why run 32's `partner-2` (codex/gpt-5.6-sol) emitted nothing in 5 m 07 s.** Its instructed artifact wait
   was ~8 minutes and it was reaped at 5.5 — sufficient on its own. I cannot separate that from an
   unsubmitted brief (the codex Enter-drop window the code documents at `:458-460`), because
   `data/runs/helm-run-3-rms6l9kn5/dispatch/` is empty and `callbacks.md` has **no `[helm ACK]` lines from any
   seat**, including the one that demonstrably worked. F4 stands regardless: there is no watchdog for either
   case.
2. **Whether any of grok-4.5 / gpt-5.6-sol / claude-opus-5, spawned as a Helm partner seat, will actually
   sleep-poll a file for 30 minutes off one brief.** This is empirical and decides whether F2 is fatal or
   merely fragile. It is also the cheapest thing to measure: spawn one partner, revise plan.md by hand after
   its first verdict, and watch for a second `VERDICT-READY`. Do that before spending another full run.
3. **`run_events.run_id` integrity.** It is `TEXT NOT NULL` with **no** foreign key, and rows 267 / 337 carry
   `run_id='32'` with `created_at` 2026-07-26 23:30 and 2026-07-27 07:54, while `runs.id=32` did not start
   until 2026-07-29 21:20. I could not determine whether this is renumbering from the 2026-07-27
   `cards2-ibrain.db → helm.db` migration (`ecosystem.config.cjs:23-29`) or plain id reuse. Either way, any
   audit or provenance read keyed on `run_events.run_id` is currently untrustworthy — worth its own look, but
   I will not guess the cause.
4. **Whether `assertRegistryIdle` has a consumer that would actually collide** on the project-scoped
   `helm-ibrain-<slug>` session named in F6. The write happens; I did not prove a live victim.
5. **Whether `panelSize` and the panel table can disagree in a way that matters.** `projects.planning_panel_size = 2`
   for project 3 while `project_planner_panel` holds 2 member rows (slots 0,1 → models 27, 22), and
   `:494` ignores `panelSize` whenever `coPlannerSeats` is non-empty. Observed behaviour (2 partners) is
   consistent, so I did not chase whether a stale `planning_panel_size` can ever be the operative value.

---

PANEL-DONE opus
