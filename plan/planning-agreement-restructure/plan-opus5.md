# plan-opus5 — Planning agreement restructure

**Planner:** `opus5` (claude-opus-5, xhigh) · **Effort:** `planning-agreement-restructure`
**Authored:** 2026-07-29 PHT · **Base:** `0a0c883` on `fix/planning-agreement-restructure`
**Scope source of truth:** `og-requirements.md` (23 ACs) · **Topology:** `topology.yaml`
**Worked alone.** Did not read the other planners' output.

---

## 0. Code state correction — read this before the table

The panel read the **uncommitted working tree** of 2026-07-30 ~06:00 PHT, which contained the in-flight
A1/A2/A4 convergence fix. That fix was **halted** (north-star: *"Halting it was right… 'do nothing' beat
'ship half'"*). Two consequences that change what must be built:

1. **The BROKEN fail-fast is BACK.** `planning-phase-service.ts:1026-1041` returns `false` on any BROKEN
   once `plan.md` exists. So opus F1's *exact* failing sequence (A CLEAN@R1 → B BROKEN@R1 → revise → B
   CLEAN@R2) **cannot fire today** — B's BROKEN kills the run first. The gate is still fail-OPEN, but by a
   different door: **sol #1's second form** — `planning-phase-service.ts:523-529` only checks that plan.md
   exists and is non-empty, so a partner can CLEAN a **stale plan.md left in the cycle folder by a previous
   attempt** before this attempt's plancore writes anything, and `:1041` accepts it. That door is open on
   every retry into a cycle directory. AC7 closes both doors and is a **hard precondition** for P2-6, which
   removes the fail-fast.
2. **The plancore brief was never fixed.** `brief-writer-service.ts:345` still emits the literal
   `PLAN-READY — plan agreed with ${mode}` (the false claim run 32 made) and `:347` still says
   `AFTER emitting PLAN-READY, STOP COMPLETELY`. There is no §8 revise loop in the tree. P2-7 writes it.

Every `file:line` below was re-verified against `0a0c883`. Where I narrow a panel finding on new
evidence, I say so in §3.

## 1. What the engine must own (the one design decision)

The keystone is architectural, not stylistic: **`planning-phase-service.ts` has no `transport.send`** —
only `spawn` (`:454`, `:536`, `:943`), `reap` (`:468`) and `inspectSeat`/`resubmitIfComposerHeld`
(`:790-813`), and the inspect/resubmit pair runs **only for `brainRole`** (`:461`). The code comment at
`:520-522` already states the consequence: *"a seat that already emitted VERDICT-READY does not re-emit."*

So the round machine cannot be a loop that *nudges*. It is a loop that **reaps and re-spawns**:

```
for round in 1..roundCap:                     # AC10 — integer rounds, per-round deadline
    planSha  = sha256(plan.md bytes)          # AC6  — engine computes, engine publishes
    seats    = spawn FRESH partners, batchId = <batch>-partner[-N]-r<round>, briefed with planSha
    verdicts = collect until round deadline   # AC8  — newest-per-seat, UNKNOWN blocks
    if all seats CLEAN AND every verdict.planSha == planSha:  -> AGREED   # AC7 — engine declares
    if round == roundCap:                                      -> BLOCKED # AC9 — returns, never throws
    reap seats; spawn FRESH plancore revise seat with this round's findings   # AC11 — the actuator
    wait for plan.md sha to CHANGE (bounded); no change -> BLOCKED
```

Three invariants move out of prose and into the engine: **which bytes were reviewed** (hash on every
verdict), **who is still owed a verdict** (fresh per-round seat identity), and **who may declare
agreement** (the engine, never `PLAN-READY`).

## 2. Slice table

`est_min` is implementation only (excludes validation/red-team). Every non-test slice is **< 30 min**.
`deps` encode the **non-negotiable P0 → P1 → P2 → P3 order**: each phase's first slice depends on the
previous phase's last slice, so no P2 work can start before all of P1 has landed.

**Legend** — `deliberation`: `panel-3` = full 4-model panel (strict-unanimous, ≤3 rounds, settle
opus5+sol) · `settle` = settle pair only (opus5+sol) · `none`.
`redteam`: `elite`/`standard` = 4 seats (codex55·sol·grok45·sonnet5), N=2 consecutive clean ·
`budget` = 3 seats. `budget` column: `S` ≈ ≤60k tok · `M` ≈ 60-150k · `L` ≈ 150-300k.

| id | scope | acs | tests | est_min | deps | impl_tier | val_tier | deliberation | redteam | budget |
|---|---|---|---|---|---|---|---|---|---|---|
| **P0-0** | **Pin `8024452` before anything touches the gate.** Token-free convene-before-artifacts regression (`planning-phase-service.ts:1026-1041`, `:1033-1039`) + a suite assertion that `grep -c planMdPathForRaceGuard` == 3 (`:995`, `:1033`, `:1035`). Test-only, zero src change. | AC23#1 | 2 | 20 | — | L2 | L2 | none | budget | S |
| **P0-1** | Capture pre-terminal run state (`runs.phase` + run_tasks count) **before** the blocked UPDATE at `run-orchestrator-service.ts:371-377`; skip `assertImplementationBrainComplete` (`:406-412`, impl `:559-592`) entirely when execution never started. Never derive `helm-ibrain-<slug>` from the project slug with no row (`:571-577`). | AC1, AC23#6 | 2 | 26 | P0-0 | L3 | L2 | settle | elite | M |
| **P0-2** | `finalizeBrainSessionRow`: delete the `\|\| 'unknown'` provider/model defaults (`worker-runtime-finalize.ts:209-210`); put the register-if-needed INSERT (`:236-254`) behind an opt-in flag that also requires explicit provider+model. No row + no flag ⇒ `return false`, no synthesis. Sole prod caller `run-orchestrator-service.ts:579` passes neither. | AC2, AC23#6 | 3 | 24 | P0-1 | L3 | L2 | settle | elite | M |
| **P0-3** | **E5-class.** `assertRegistryIdle` (`worker-runtime-finalize.ts:48-68`, called `:91-93`) joins `helm_sessions` on **name alone**. Add `AND s.run_id = wr.run_id`; skip when either is NULL. A persistent project-scoped `helm-ibrain-<slug>` is then never idled by a per-run teardown. Consumers proving the blast radius: `session-reconcile-decision.ts:85-92` (idle ⇒ REAP), `worker-service.ts:494-547`. | AC3, AC23#6 | 3 | 28 | P0-2 | L3 | L2 | panel-3 | elite | L |
| **P0-4** | A run that failed **in planning** must not terminalize its cycle. Gate `terminalizeCycleAtRunEnd` (`run-orchestrator-service.ts:393`, impl `:601-620`) on P0-1's captured state — leave `cycles.phase` untouched, exactly as the operator-pause path already does at `:391`. Kills the `complete` write **and** the `FREEZE_ON_OR_AFTER` freeze it triggers (`cycle-service.ts:22`, `:400-402`). **No schema change:** the cycle stays `planning`, which `startPlanningFromConfirmedHandoff:871-879` already accepts ⇒ retryable, no manual SQL. Update `cycle-terminal-on-run-complete.test.ts` in-slice. | AC4 | 3 | 28 | P0-3 | L3 | L2 | panel-3 | elite | M |
| **P0-5** | The handoff CAS `starting→started` fires at `run-orchestrator-service.ts:985-989` **before** the `agreed` check at `:991-998`, so a dead run wedges the bridge forever via the idempotent-return at `discovery-handoff-owner-bridge.ts:194-207`. Move the CAS below the branch; on `notAgreed` call `handoffs.fail(id, blockedReason, 'starting')` (the method already exists, `:354`). | AC4, AC21 | 2 | 25 | P0-4 | L3 | L2 | settle | elite | M |
| **P0-6** | Retain each seat's `spawned.handle` (`planning-phase-service.ts:454`, `:536-549` — discarded today) and `await transport.reap(handle, …)` **before** `finalizeWorkerRuntime` on both exits (`:669-670` not-agreed, `:711-712` agreed). Today the DB row goes terminal first, so the outer `finalizeRunWorkerRuntimes` (`worker-runtime-finalize.ts:127-142`, non-terminal rows only) skips it and the pane survives to poison the retry. Also covers the confirmed-handoff path, which has no reap at all in `:718-1037`. | AC5 | 2 | 28 | P0-5 | L3 | L2 | settle | elite | M |
| **P1-1** | New pure module `src/services/plan-revision.ts`: `planRevision(bytes) → {sha256, short12}`, `readPlanRevision(path) → null on absent/empty`. The single definition of "which plan revision" for the gate, the briefs and provenance. | AC6 | 2 | 15 | P0-6 | L2 | L2 | none | elite | S |
| **P1-2** | `generatePanelBrief` (`brief-writer-service.ts:431-470`) tells partners nothing true: `planPath:'plan.json'` (`:444`) — a file that **cannot exist before the gate** (derived only at `planning-phase-service.ts:695`) — `runDir:'.'` (`:445`), and a `projectDir` default of `/home/agjrom/TGBOTS/Helm` (`:451`), a path this repo left. Add `canonicalArtifactRoot`/`planMdPath`/`planSha12`/`roundDeadlineMs`; render **absolute** `plan.md` + `og-requirements.md`; verdict template (`:468`) becomes `VERDICT-READY — CLEAN\|BROKEN plan=<sha12> — <details>`. Update call site `planning-phase-service.ts:509-534`; **leave `8024452`'s wait-for-artifacts requirement text at `:523-531` byte-intact.** | AC6, AC14 | 3 | 28 | P1-1 | L2 | L2 | settle | elite | M |
| **P1-3a** | `parseAgreementCallbackLine` (`planning-phase-service.ts:844-848`) accepts only `[—-]` — an **en-dash or a colon yields `note=null`** ⇒ "no verdict yet" ⇒ silent 30-min hang. Widen to `[—–\-:]` and add a pure `parseVerdictNote(note) → {verdict:'CLEAN'\|'BROKEN'\|'UNKNOWN', planSha}`. | AC6, AC8 | 3 | 18 | P1-2 | L2 | L2 | none | elite | S |
| **P1-3b** | Fail-closed on the **stale** side. At `:1010-1018` the `!verdicts.has(id)` + `if (verdictMatch)` pair walks *past* an unparseable newest line and records an **older** verdict as "latest" — a second, independent route to a stale CLEAN. Select each seat's newest `VERDICT-READY` **first**, then parse exactly that line; unparseable ⇒ `UNKNOWN` ⇒ keep waiting, never inherit. | AC8 | 3 | 26 | P1-3a | L3 | L2 | settle | elite | M |
| **P1-4** | **The fail-closed gate.** `:1041` accepts a bare enum with no binding to bytes. Each pass computes `currentSha` (P1-1) and accepts only when **every** seat's latest is CLEAN **and** `verdict.planSha === currentSha`. Raise the sleep at `:1043` from 20 ms to 1000 ms (opus F11 — otherwise a non-converging run hashes plan.md ~90 000 times). Fail-fast + `planMdPathForRaceGuard` untouched; grep count stays 3. | AC7, AC23#7 | 3 | 28 | P1-3b | L3 | L2 | panel-3 | elite | L |
| **P1-5** | Non-convergence must **return**, not throw. `waitForAgreement` returns false at `:580`, then control falls into the plan poll (`:598-609`) and `readCanonicalPlan` (`:613-664`) — whose `:661` `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` throw **skips** the seat finalizes (`:669-670`), the fence advance (`:671`) and the operator-visible `blockedReason` (`:675`). Hoist `if (!agreed)` above the poll; return `plan:{tasks:[]}` when plan.md is unreadable. | AC9 | 2 | 25 | P1-4 | L3 | L2 | settle | elite | M |
| **P2-1** | Unique seat identity on disk. `real-transport.ts:240-241` writes `prompts/${role}.brief.md`, and both partners spawn with `role: partner` (`planning-phase-service.ts:536`) ⇒ seat 2 overwrites seat 1's brief, byte-proven identical on runs 31 **and** 32. Add optional `briefFileName` to spawn params (default `${role}.brief.md`); planning passes `${partner}-${seatLabel}.brief.md`. **Narrowed on new evidence:** tmux session names are already unique (`real-transport.ts:183` keys on `batchId`, and partner batchIds differ at `:502`), so no role-token, dispatch or callback-matching change is needed. | AC13 | 2 | 22 | P1-5 | L2 | L2 | settle | elite | M |
| **P2-2** | Behaviour-preserving refactor: extract the partner spawn loop (`:491-562`) + the single `waitForAgreement` call (`:580`) into `runReviewRound(round, planSha)`. No behaviour change — the existing 973-line `planning-phase-service.test.ts` must pass **unmodified**. This is the seam every later P2 slice edits. | AC11 | 2 | 28 | P2-1 | L3 | L2 | settle | elite | M |
| **P2-3** | `roundCap` becomes **rounds**. Delete `effectiveTimeoutMs = PLANNING_TIMEOUT_MS * roundCap` (`:368`); wrap `runReviewRound` in `for (round = 1..roundCap)`, each bounded by `PLANNING_TIMEOUT_MS`. `blockedReason` (`:675`) names the round reached, not a millisecond budget. | AC10 | 3 | 26 | P2-2 | L3 | L2 | panel-3 | elite | M |
| **P2-4** | **Keystone.** Each round **reaps** the prior round's partner seats and **spawns fresh ones** with round-scoped batch ids `${batchId}-partner[-N]-r${round}`, briefed against the current `planSha`. Justification is mechanical, not stylistic: no `transport.send` exists and inspect/resubmit is `brainRole`-only (`:461`), so a partner whose turn ended is unreachable (`:520-522`). Round-scoped ids mean a prior round's verdict cannot satisfy the current one **even if** the hash check were bypassed. | AC11, AC13 | 3 | 28 | P2-3 | L3 | L2 | panel-3 | elite | L |
| **P2-5** | **The revise actuator.** New `generatePlanRoundReviseBrief` in `brief-writer-service.ts`, mirroring the existing per-task `generatePlanReviseBrief` (`:543-575`, which is slice-scoped and not reusable as-is). On BROKEN with `round < cap` the engine aggregates that round's verdict notes, spawns a **fresh plancore seat**, then polls plan.md until its sha **differs** from the round's frozen sha (bounded by the round window). No new hash ⇒ BLOCKED with a mechanism-level reason — never "emit then hope". | AC11 | 3 | 28 | P2-4 | L3 | L2 | panel-3 | elite | L |
| **P2-6** | **Removes the honest fail-fast — deliberately last of the round core.** `waitForAgreement` returns a typed `AGREED\|BROKEN\|TIMEOUT` instead of a bare boolean; the round loop, not the poll, decides. `8024452` survives in meaning and in text: `planMdPathForRaceGuard` (`:995`/`:1033`/`:1035`) still decides whether a BROKEN counts at all (absence ⇒ NOT-YET) — it now suppresses **round advancement** instead of a fail-fast return. **Acceptance includes `grep -c planMdPathForRaceGuard … == 3`.** Landing this before P1-4 would rebuild the fail-open the north-star halted. | AC11, AC23#2, AC23#3 | 3 | 24 | P2-5 | L3 | L2 | panel-3 | elite | M |
| **P2-7** | `PLAN-READY` ≠ agreement. Rewrite `brief-writer-service.ts:288` (scope), `:340` (§7), `:345` (the literal `plan agreed with ${mode}` string run 32 emitted with zero verdicts on file) and `:347` (`AFTER emitting PLAN-READY, STOP COMPLETELY` — what actually made a revise loop impossible). PLAN-READY now means *both artifacts written, awaiting the engine's verdict*; plancore is told it may be re-briefed. The engine records an `AGREEMENT_DECLARED` run_event at the gate and **that event is the only ingest permission**. | AC12 | 3 | 26 | P2-6 | L2 | L2 | panel-3 | elite | M |
| **P2-8** | Partner watchdog parity. `brainRole` gets 3 spawn attempts, a 120 s first-callback window, a session-alive probe and the `resubmitIfComposerHeld` Enter re-press (`:439-476`, `:732-837`, `:813`). The partner loop (`:536-561`) gets **none** — run 32's partner-2 emitted zero callbacks in 5 m 07 s and nothing noticed. Route partner spawns through `waitForFirstCallback` with a shorter window + one respawn; `blockedReason` (`:675`) names the **specific** mute `partnerBatchId` instead of listing all of them. | AC15, AC23#4 | 3 | 28 | P2-7 | L2 | L2 | settle | elite | M |
| **P2-9** | Transactional ingest. `plan-parser-service.ts:169-197` inserts tasks one at a time, writes the artifact row, then enqueues one at a time — no transaction, no idempotency key, no compensation. Wrap inserts + artifact row + enqueues in one better-sqlite3 `db.transaction`; write plan.json via tmp+rename (and stop the duplicate write at `:225-232`). A mid-way failure leaves **zero** `run_tasks`. | AC16 | 2 | 28 | P2-8 | L2 | L2 | settle | elite | M |
| **P3-1a** | Delete rediscovery. The legacy interview branch (`run-orchestrator-service.ts:1532-1566`) spawns a discovery seat with `canonicalArtifactRoot` = the cycle doc dir (`:1370`) and a brief that overwrites the canonical docs — three different `north-star.md` md5s for cycle 13, confirmed by bytes. Refuse the branch with a typed `REDISCOVERY_REFUSED` when `input.cycleId != null` and the cycle already has non-empty `north-star.md` + `conversation-log.md`, pointing at the confirmed-handoff route. | AC17, AC23#5 | 3 | 26 | P2-9 | L2 | L2 | settle | standard | M |
| **P3-1b** | Both start-planning guards fail **open** today: the handoff-store check (`src/index.ts:2917-2929`) and the active-run check (`:2932-2939`) each `catch { fall through }`. A transient store error therefore bypasses the owner handoff entirely. Make an unevaluable guard return 503. | AC17 | 2 | 18 | P3-1a | L2 | L2 | none | standard | S |
| **P3-1c** | UI: `src/public/app.js:6307-6341` renders Start/Re-run Planning and describes a rerun as "interview + planning". Reflect P3-1a so the operator sees the handoff route, not a 409. **Only slice touching app.js** — hand-written browser ESM, 560 KB, no build step: `node --check` then `npm run build` (the tree ships two copies). UI proof on **:3110 via `playwright.cap.config.ts` only** (the default config is :3111/fake tmux/scratch DB and is not evidence). | AC17 | 1 | 22 | P3-1b | L2 | L2 | none | budget | S |
| **P3-2a** | `PlanningResult` (`planning-phase-service.ts:156-174`) exposes `planMdPath` but not the bytes or their digest, so nothing carries the ingested revision forward. Add `planSha256` computed via P1-1 from the **exact `planMarkdown` passed to `ingestExecutionPlan` at `:695`**. | AC18 | 2 | 20 | P3-1c | L2 | L2 | none | standard | S |
| **P3-2b** | Provenance must pin what was **ingested**, fatally. `planning-provenance-service.ts:145-152` re-reads mutable plan.md **after** `runPlanningPhase` returned, and both call sites swallow the error and continue (`run-orchestrator-service.ts:1001-1017`, `:1758-1773`) — so `run_tasks` can come from v_n while provenance pins v_n+1, and the AC28 gate then blesses the mismatch. Accept `planSha256` from P3-2a; a disk mismatch or a write failure **blocks the run**. **Do not weaken the AC28 guard at `:210-243`** (safety rule 4). | AC18 | 3 | 26 | P3-2a | L2 | L2 | settle | standard | M |
| **P3-3a** | Freeze the discovery **bytes**, not just staffing. `discovery-handoff-ingress.ts:55-95` checks only presence/non-emptiness and `:206-239` digests the staffing manifest. Snapshot sha256 of `north-star.md` + `conversation-log.md` into a new `discovery_handoffs.docs_digest`, via a guarded `ALTER TABLE … ADD COLUMN` in `database.ts`'s existing in-line migration style (cf. `:875`) — **ADD COLUMN only, no table rebuild.** | AC19 | 2 | 26 | P3-2b | L2 | L2 | settle | standard | M |
| **P3-3b** | Enforce the freeze. Owner confirm (`discovery-handoff-owner-bridge.ts:244-300`) and the planning read (`run-orchestrator-service.ts:881-900`) both compare against `docs_digest`; a mismatch is a typed refusal. The owner then provably approved the bytes the planners receive. | AC19 | 2 | 24 | P3-3a | L2 | L2 | settle | standard | M |
| **P3-4** | Never persist `executing` without a driver. The confirmed path sets `phase='executing'` and returns (`run-orchestrator-service.ts:1026-1036`); `OrchestratorLoop` is constructed only on the legacy path (`:1711`). Meanwhile `finishPlanning` advances an autonomous cycle to implementation (`cycle-service.ts:430-438`) and the manual start refuses while an active run exists (`src/index.ts:2969-2976`) — an indefinite wedge on the intended entry path. Leave the planning run parked/awaiting-implementation; start-implementation creates the execution run against P3-2b's provenance. | AC20 | 2 | 26 | P3-3b | L2 | L2 | settle | standard | M |
| **P3-5a** | Close the acquisition crash gap. `discovery-handoff-owner-bridge.ts:303-362` CASes `pending→starting`, creates the run, then writes `planning_run_id` in a **separate** op (`:360-362`); a crash between them leaves a `starting` handoff with no run, permanently `CAS_LOST` at `:211-216` while live-handoff lookup still counts it. Do create+link in one transaction and give `starting` a lease with a deterministic reclaim rule. | AC21 | 2 | 24 | P3-4 | L2 | L2 | none | standard | M |
| **P3-5b** | The detached failure catch (`discovery-handoff-owner-bridge.ts:373-395`) marks the handoff failed and hand-updates `runs`, skipping the cycle transition, worker finalization, brain/session reconciliation and operator notification. Route it through `transitionRunToBlocked` — which by now (P0-1…P0-4) does all four **correctly**. One terminal path owns every consequence. | AC21 | 2 | 24 | P3-5a | L2 | L2 | none | standard | M |
| **P3-6** | Adaptive planning is a **second planner with weaker semantics**: `planning-phase-service.ts:338-344` delegates wholesale, and `adaptive-planning-phase.ts:1550-1551` returns `agreed:true` from its own local-readiness path (own tier cap `:1243`; can read pre-existing canonical artifacts `:1491-1501`) — bypassing every fix above behind one feature flag. AC22 explicitly permits refusal: throw a typed `ADAPTIVE_PLANNING_REFUSED` naming the incompatible semantics until a later effort brings it under this contract. Cheapest honest close of a second fail-open gate. | AC22 | 2 | 15 | P3-5b | L1 | L2 | none | standard | S |
| **P3-7** | AC23 completion sweep. One `planning-regression-index.test.ts` naming all seven historical failures and failing if any is unpinned — mapping: #1→P0-0, #2/#3→P2-6, #4→P2-8, #5→P3-1a, #6→P0-1/P0-2, #7→P1-4. Catches a slice landing without its test, which is the exact way attempts 1-4 lost their guarantees. Test-only. | AC23 | 7 | 25 | P3-6 | L1 | L2 | none | standard | S |

**Totals:** 33 slices · ~833 impl-min (~14 h) · P0 179 · P1 140 · P2 238 · P3 276.

## 3. AC coverage matrix

| AC | Slice(s) | AC | Slice(s) |
|---|---|---|---|
| 1 | P0-1 | 13 | P2-1, P2-4 |
| 2 | P0-2 | 14 | P1-2 |
| 3 | P0-3 | 15 | P2-8 |
| 4 | P0-4, P0-5 | 16 | P2-9 |
| 5 | P0-6 | 17 | P3-1a, P3-1b, P3-1c |
| 6 | P1-1, P1-2, P1-3a | 18 | P3-2a, P3-2b |
| 7 | P1-4 | 19 | P3-3a, P3-3b |
| 8 | P1-3a, P1-3b | 20 | P3-4 |
| 9 | P1-5 | 21 | P0-5, P3-5a, P3-5b |
| 10 | P2-3 | 22 | P3-6 |
| 11 | P2-4, P2-5, P2-6 | 23 | P0-0, P0-1, P0-2, P1-4, P2-6, P2-8, P3-1a, P3-7 |
| 12 | P2-7 | | |

**AC23 spread (the seven named failures, deliberately not one slice):**

| # | Historical failure | Pinned by |
|---|---|---|
| 1 | convene-before-artifacts | **P0-0** (first slice — pins `8024452` before the gate is touched) |
| 2 | BROKEN → revise → CLEAN | **P2-6** (round advance) with **P2-5** (the actuator) |
| 3 | partner1 CLEAN + partner2 BROKEN | **P2-6**; refusal half in **P1-4** |
| 4 | partner-2 silent until timeout | **P2-8** |
| 5 | legacy path refuses when north-star exists | **P3-1a** |
| 6 | ibrain row count unchanged on planning block | **P0-1** + **P0-2** |
| 7 | stale-CLEAN rejected across revisions | **P1-4** |

All seven are token-free: `src/services/planning-phase-service.test.ts` already runs `USE_FAKE_TMUX=1`
with `FakeTransport` + a temp `DatabaseService` and drives `callbacks.md` by hand — no model is spawned.
Every new test follows that harness. Run **file-by-file** (safety rule 3).

## 4. Ordering gates (do not start a phase before its gate is green)

- **P0 → P1:** a failed planning run mutates **zero** rows outside `runs` — ibrain count unchanged, no
  `cycle_topology_freezes` row, `cycles.phase` unchanged, `helm_sessions` for a live master unchanged,
  handoff reclaimable, every planning pane reaped.
- **P1 → P2:** the gate is **fail-CLOSED**. The panel's exact scenario refuses. An unparseable or
  hash-less verdict never counts as CLEAN. Non-convergence returns a mechanism-level reason. The system
  is *safe while still broken* — the state the north-star says P1 exists to reach.
- **P2 → P3:** a real BROKEN→revise→CLEAN converges token-free with fresh seats each round;
  `planning_round_cap=3` produces **three rounds**, not 30 minutes; `grep -c planMdPathForRaceGuard` == 3.
- **P3 → done:** one entry path; provenance pins ingested bytes fatally; no `executing` run without a
  driver; adaptive planning cannot bypass the gate.

## 5. Hard constraints carried into every slice

1. **`8024452` survives.** `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` == 3.
   Asserted in the suite from P0-0 onward; re-asserted explicitly in P2-6.
2. **`HELM_SESSION_JANITOR` stays `0`.** No slice sets it. P0-3 is a precondition for ever reconsidering
   it, and re-enabling additionally needs a fresh independent audit + JROM's approval.
3. **Cycle 13** (`memory_mcp` "UI Upgrade") is JROM's live test cycle — do not mutate its data or its
   canonical folder. Tests use temp dirs + temp DB (`src/test-setup.ts` forces a temp path).
4. **No merge to `main`** (SD10). Branch only.
5. **`app.js`** — hand-written browser ESM, 560 KB, no build step: `node --check` after any edit, then
   `npm run build`. Only P3-1c touches it.
6. **UI proof** targets :3110 via `playwright.cap.config.ts`. The default config is not evidence.
7. **vitest file-by-file.** A bare full-suite run with extra pool flags hangs.
8. **Never weaken the AC28 provenance guard** to make stale fixtures pass. Known pre-existing failures,
   leave unless your change touches them: `pause-after-planning-gate` (3), `finish-planning-production`
   (1), `b25-fix1-orphan-model` (1), `model-service` (1), `smoke` (1).

## 6. Risk register — the four places this plan can still go wrong

| Risk | Slice | Why it is contained |
|---|---|---|
| **P2-6 lands before P1-4** (or P1-4 regresses) — restores the fail-OPEN the north-star halted, and this time convergence *works*, so it ships an unreviewed plan silently. | P2-6 | Encoded in `deps` (P2-6 ⊃ P1-4 transitively through five slices) **and** P2-6's acceptance re-runs P1-4's stale-CLEAN test. This is the single highest-consequence ordering constraint in the effort. |
| **Fresh-seat-per-round multiplies cost.** roundCap 3 × 2 partners = up to 6 partner spawns + 2 plancore revise spawns per planning run. | P2-4, P2-5 | Intrinsic to having no `transport.send` — the alternative is the 30-minute hope that has failed four times. Mitigate by bounding each round with the *per-round* window (P2-3), so worst case is unchanged wall-clock with real rounds inside it. Surface the spawn count in `blockedReason`. |
| **P0-4's "leave the phase untouched" is not a first-class failure state.** A cycle stuck in `planning` after a failed run is retryable but not *labelled* failed. | P0-4 | Deliberate: `cycles.phase` has a CHECK constraint (`schema.ts:180`) with no failure terminal, so a real failure phase means a `cycles` table rebuild — out of proportion to the AC, which asks only for "retryable, no manual SQL". The blocked run row and the failed handoff (P0-5) carry the failure semantics. Flagged for a future effort. |
| **P2-2's refactor silently changes round-1 behaviour**, invalidating every test written against it. | P2-2 | Acceptance is that the existing 973-line `planning-phase-service.test.ts` passes **unmodified** — no test edits permitted in that slice. Any needed edit means the refactor was not behaviour-preserving. |

## 7. Two judgement calls I made, stated so they are not re-litigated silently

1. **P3-6 refuses adaptive planning rather than unifying it.** AC22 permits either. Unifying means
   pushing the revision/verdict/gate contract through a 1,679-line second planner that runs today's flag
   off, on a branch where P0-P2 have just rewritten the contract underneath it. Refusal is 15 minutes and
   removes the bypass; unification is a separate effort with its own red-team. If JROM wants it unified in
   this effort, it is roughly six more slices and belongs after P3-7, not folded into P3-6.
2. **P2-1 narrows grok45 F3 to the brief path only.** F3 called for unique identity "on disk and in
   transport". Re-reading `real-transport.ts:183`, session names already key on `batchId`, and partner
   batchIds already differ (`planning-phase-service.ts:502`) — so tmux identity is *not* colliding, only
   `prompts/${role}.brief.md` is. Changing the role token would touch dispatch, session naming and
   callback matching for no defect. If the red-team finds a transport-level collision I missed, P2-1 is
   the slice to widen.

---

PLAN-DONE opus5
