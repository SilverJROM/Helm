# Planning-path review — findings (grok45)

**Seat:** grok45 · **Charter:** `plan/_panels/planning-path-review/CHARTER.md`  
**Evidence:** runs 31 (`helm-run-3-rms6jr3eg`) + 32 (`helm-run-3-rms6l9kn5`) callbacks + `worker_runtimes` + cycle freeze + on-disk briefs/archives  
**Read-only:** no `src/` edits, no DB writes, no other panelist output.

---

## VERDICT: NEEDS-RESTRUCTURING

This path is not “sound design, under-tested.” It is a **cooperative multi-agent chat with a passive timeout poll**, sold as an engine-owned agreement protocol. Eight defects across four kinds already prove the pattern: every new cooperative assumption (partners wait; plancore revises; partners re-verdict; round cap means rounds; terminalize is safe) is only discovered by burning a run. The in-flight A1/A2/convene-race brief patches fix **symptoms of that design**, not the design. Until agreement is a **single-writer engine state machine** (engine owns spawn → wait-for-artifacts → review → revise → re-review rounds, reaps/respawns seats, never trusts “emit then stop” free will), the next failure mode will keep being “something the agents were supposed to do and didn’t.” Stop patching briefs as the protocol layer.

---

## PATH TRACE (what the design claims vs what the code does)

```
Entry A (legacy Start Planning / startRun, cycleId optional)
  → seed conversation-log.md / possibly seed north-star if runDir==canonical
  → spawn discovery (interview) → wait NORTH-STAR-READY
  → reap discovery → runPlanningPhase(...)

Entry B (S10 startPlanningFromConfirmedHandoff)
  → handoff state=starting + digest match + read existing cycle docs (no overwrite)
  → NO discovery spawn → runPlanningPhase(...)

runPlanningPhase (core, adaptive_planning OFF):
  1. plancore spawn (+ first-callback retry)          ~:439-476
  2. partner[N] spawn IMMEDIATELY after               ~:498-562  (artifacts not required yet)
  3. waitForAgreement(timeout = PLANNING_TIMEOUT_MS * roundCap)  ~:579, :990-1062
       success ⇔ PLAN-READY + every partnerBatchId LATEST verdict == CLEAN
  4. poll canonical plan.md/og-requirements.md        ~:597-607
  5. if !agreed → reap seats, return blockedReason    ~:665-687  (no ingest, no provenance)
  6. if agreed → materialize + ingestExecutionPlan + S13 provenance + finishPlanning
  7. on notAgreed caller: transitionRunToBlocked → terminalizeCycleAtRunEnd(complete)
       + assertImplementationBrainComplete(ibrain failed/unknown)
```

**Runs 31/32 both used Entry A** (callbacks + `final.json` transitions `interview → planning → blocked`; discovery briefs present; three different `north-star.md` hashes across discovery-archive / run31 / run32).

---

## RANKED FINDINGS

### F1 — Round-2 cannot converge: partners are instructed to emit once and stop
**Rank:** will bite next run · soon · fatal (30 min burn then same block)

**Mechanism**
- Engine gate after A1 keeps polling until every partner’s **latest** verdict is CLEAN (`planning-phase-service.ts:1055`). Comment claims partners “re-verdict when plan.md’s content changes” (`:974-975`, `:1048-1051`).
- There is **no** engine re-spawn, re-nudge, or content-hash watch on partners. Convergence is pure free will.
- `generatePanelBrief` still ends with: “Provide ONLY your independent verdict. Emit the callback then stop.” (`brief-writer-service.ts:474-475`). No “watch for re-emitted PLAN-READY / re-read plan.md / re-emit VERDICT-READY.”
- Plancore brief **source** now has §8 revise loop (in-flight), but **run 32’s on-disk plancore brief** still said “AFTER emitting PLAN-READY, STOP COMPLETELY” and “plan agreed with deliberation” — and that is what the seat obeyed (`data/runs/helm-run-3-rms6l9kn5/prompts/plancore.brief.md` + callbacks line 5).
- Even if plancore §8 ships: plancore can rewrite plan.md and re-append PLAN-READY; partners who already emitted BROKEN **and stopped** never supersede it → latest stays BROKEN → `effectiveTimeoutMs` elapses → `ROUND-CAP-EXHAUSTED` (`:674`, `:1059-1062`).

**Trigger:** any legitimate BROKEN (run 32’s G1/G2 quality of critique is the happy path for co-planning).

**Blast radius:** every multi-round planning attempt dies after ~`planning_round_cap * HELM_PLANNING_TIMEOUT_MS` (default 3×600s = **30 min**) with no ingest.

**Fix:** engine-owned rounds: on BROKEN, (1) require plancore revise, (2) **reap or re-brief and respawn partners** (or send a hard re-review nudge with new dispatch nonce), (3) fence prior VERDICT-READY out of the next round. Briefs are not the protocol.

**Confidence:** high

---

### F2 — `planning_round_cap` is a wall-clock multiplier, not a round machine
**Rank:** next · design lie · high cost + false operator model

**Mechanism**
- `roundCap = inputs.roundCap ?? 3` (`planning-phase-service.ts:367`)
- `effectiveTimeoutMs = PLANNING_TIMEOUT_MS * roundCap` (`:368`)
- Single `while (Date.now() - start < timeoutMs)` in `waitForAgreement` (`:1008`) — no round counter, no “round N” boundary, no forced re-dispatch between rounds.
- Brief and D7 language still sell “≤N rounds of agreement” (`brief-writer-service.ts` planning brief; comment A11 at `:150-152`).

**Trigger:** any operator tuning `planning_round_cap` expecting discrete revise cycles.

**Blast radius:** misconfigured timeouts; “round 2 never executed” is structural, not bad luck. Run 32 never entered a second protocol round because no such state exists.

**Fix:** replace with explicit `round` state 1..cap: each round = (plan bytes frozen) → partner verdicts → if not all CLEAN and round&lt;cap → plancore revise → advance round; else BLOCKED.

**Confidence:** high

---

### F3 — Partner seats share `role: deliberation` → on-disk brief collision; second seat is structurally fragile
**Rank:** next / every multi-partner run · audit + re-read corruption · partner-2 unpaid

**Mechanism**
- Spawn loop uses the same transport role for every partner: `role: partner` where `partner` is `'deliberation'` (`planning-phase-service.ts:536-549`).
- `RealTransport.spawn` always writes `prompts/${role}.brief.md` (`real-transport.ts:240-241`). Second partner **overwrites** the first partner’s brief file with partner-2 content.
- Hard evidence: for both run 31 and 32, `deliberation.brief.md` and `deliberation-2.brief.md` are **byte-identical** (same md5) and both carry **partner-2** batch id and seat label:
  - run31: both files → `rms6jr3eg-partner-2` / “seat partner-2”
  - run32: both files → `rms6l9kn5-partner-2` / “seat partner-2”
- Live spawn still passes in-memory brief, so partner-0 on run 31 correctly emitted `rms6jr3eg-partner` (callbacks). Disk audit trail is a lie; any seat that re-reads `prompts/deliberation.brief.md` gets the wrong identity.

**partner-2 never rendered a real content verdict on either run**
| Run | partner-0 | partner-2 | wall clock seats alive |
|-----|-----------|-----------|------------------------|
| 31 | BROKEN (absent artifacts) | BROKEN (absent artifacts) | ~99s then reaped |
| 32 | BROKEN (2 gating, real review) | **no VERDICT-READY** | ~5m then reaped |

Run 32 partner-2 had the convene-race wait brief and was still waiting when fail-fast (old gate) killed the run. Under A1, gate requires **both** CLEAN (`:1055` + A10 tests) — so partner-2 is load-bearing, yet historically reaped mid-review. JROM is paying for a seat that has never completed a content review on this cycle.

**Trigger:** `coPlannerSeats.length ≥ 2` (project 3 panel: opus5 + codex56sol).

**Blast radius:** wrong brief on disk; partner-N&gt;1 easily starved; unanimous gate blocks on silent seats.

**Fix:** unique spawn role **or** brief path keyed by `batchId`/`seat` (e.g. `deliberation-partner-2.brief.md` only, never reuse `deliberation.brief.md`); engine must not require a seat that can be reaped before first content verdict without respawn.

**Confidence:** high

---

### F4 — Phantom `ibrain` at planning-block terminal (defect 5) is not cosmetic — it idles the real brain session
**Rank:** already bitten · every planning failure · session-state corruption

**Mechanism**
- On planning `agreed:false`, orchestrator calls `transitionRunToBlocked(..., 'failure')` (`run-orchestrator-service.ts:1684-1698`, handoff path `:992-998`).
- That path calls `terminalizeCycleAtRunEnd` then `assertImplementationBrainComplete({ reason: 'run-blocked-failure', state: 'failed' })` **without provider/model** (`:392-412`).
- `assertImplementationBrainComplete` builds session `helm-ibrain-${slug}` (`:577`) and calls `finalizeBrainSessionRow` (`:579-589`).
- `finalizeBrainSessionRow` defaults `provider||'unknown'`, `model||'unknown'` (`worker-runtime-finalize.ts:209-210`), **register-if-needed** insert (`:238-253`) with `spawned_by='brain-phase-end'`, then `finalizeWorkerRuntimeRow` → `markIdle` on matching `helm_sessions` name (`:48-64`, `:91-92`).

**Evidence (DB)**
```
worker_runtimes 522: run 31 ibrain unknown/unknown failed  ended_at=2026-07-29 20:45:20  exit=run-blocked-failure
worker_runtimes 526: run 32 ibrain unknown/unknown failed  ended_at=2026-07-29 21:28:30  exit=run-blocked-failure
helm_sessions: helm-ibrain-memory_mcp status=idle
```
Started_at == ended_at on both phantom rows: pure bookkeeping, never a live planning seat. Correlation ids `brain:ibrain:31` / `:32`.

**Trigger:** any planning-blocked / detached-start-failed / true terminal that calls assert without a real ibrain spawn.

**Blast radius:** pollutes `worker_runtimes`; **marks the project’s named implementation brain session idle** via markIdle even though planning never launched ibrain — interferes with D-a3 keep-alive / next implementation start assumptions.

**Fix:** do **not** call `assertImplementationBrainComplete` on planning-only failures; or only finalize an ibrain row that already exists as non-terminal for that run. Never invent unknown/unknown.

**Confidence:** high

---

### F5 — `terminalizeCycleAtRunEnd` treats planning failure as cycle `complete` + freezes topology (defect 7)
**Rank:** already bitten on run 31 · cycle board + freeze poison

**Mechanism**
- `terminalizeCycleAtRunEnd` → `cycleService.setCyclePhase(cycleId, 'complete')` (`run-orchestrator-service.ts:601-616`).
- `setCyclePhase('complete')` is in `FREEZE_ON_OR_AFTER` (`cycle-service.ts:22`, `:400-402`) → `freezeTopologyOnCycleStart` before UPDATE.
- Planning failure is a **run** terminal, not a **cycle** success. Operator still needs discovery/planning on the same cycle.

**Evidence**
```
cycle_topology_freezes: cycle_id=13, frozen_at=2026-07-29 20:45:20  (== run 31 ended_at exactly)
cycles.id=13 currently phase=discovery status=active  (phase walked back later; freeze remains)
```
Freeze stamp on a failed planning attempt is durable; later implementation will use a freeze taken **before** a successful plan/agreement.

**Trigger:** any `transitionRunToBlocked(..., 'failure')` with `cycle_id` set (both 31 and 32).

**Blast radius:** wrong cycle board semantics; topology freeze at the wrong lifecycle moment; operator confusion (“is the cycle done?”).

**Fix:** terminalize cycle to `complete` **only** on successful implementation/final-tests end. Planning block → leave cycle in `planning` or return to `discovery`; never freeze-on-fail.

**Confidence:** high (freeze timestamp match); med-high on current phase=discovery being a later manual/path walk-back (not fully traced)

---

### F6 — Dual entry paths diverge; legacy Start Planning rewrites Discovery docs (defect 8)
**Rank:** already bitten twice on cycle 13 · trust destruction

**Mechanism**
- **Legacy** `startRun` interview path: always spawns discovery with a new interview brief (`run-orchestrator-service.ts:1530-1562`), seeds `runDir/conversation-log.md` from prompt (`:1432-1435`), and discovery authors into `canonicalArtifactRoot` (cycle folder when cycle-linked).
- **S10** `startPlanningFromConfirmedHandoff`: reads existing docs, never overwrites (`:710-715`, `:881-901`), no discovery spawn (`:954`).

**Evidence**
| Artifact | Size / md5 | When |
|----------|------------|------|
| discovery archive NS | 10279 / b7c35a08… | 2026-07-29 00:22 |
| run31 archive NS | 16862 / 8c55a9fd… | 20:42 |
| run32 + live cycle NS | 17866 / 229c82d2… | 21:22 |

Three different north-stars for “the same” cycle 13. Live folder `/home/agjrom/tools/memory_mcp/cycle/ui-upgrade_0727/` now has **no** `plan.md` / `og-requirements.md` (only NS + log + decisions) — plans only in `plan/_archive/cycle13-run3*-failed-*`. Callbacks show full rediscovery both times (`INTERVIEWING` → `NORTH-STAR-READY`). Prompt: “plan cycle 13 from the project docs”.

**Trigger:** UI “Start Planning” still on legacy path while S10 handoff exists.

**Blast radius:** AC15 violation; operator-approved discovery destroyed; comparing run31 vs run32 is not even the same north-star.

**Fix:** remove or hard-gate legacy cycle planning behind “new cycle only”; for existing cycle docs force S10 handoff only. Delete the interview branch when `cycleId` already has north-star.md.

**Confidence:** high

---

### F7 — Convene race is papered with a brief; engine still spawns partners before artifacts exist
**Rank:** mitigated for run 32 absence-BROKEN · still architectural debt

**Mechanism**
- Partners still spawn at `:498-562` immediately after plancore first callback — **before** plan.md exists.
- Run 31: both partners BROKEN on absence within ~1 min; plan.md mtime 20:45:20 = reaped_at (authored as the run died). Plancore still emitted false PLAN-READY after.
- Run 32: partner brief had FIRST/wait-up-to-8-min text (`deliberation*.brief.md`); partner-0 waited and produced a real review; partner-2 never finished before gate death.
- A1 makes pre-plan BROKEN non-fatal (`:1046-1054`) but still depends on partners not stopping after a race BROKEN (see F1). Comment at `:520-522` already admits engine-side suppression alone deadlocks if seat already emitted VERDICT-READY.

**Trigger:** any planning run with co-planners.

**Blast radius:** residual race if a seat ignores wait brief; wasted partner-2 budget; depends on LLM compliance.

**Fix:** engine gate: do not spawn partners until `plan.md` + `og-requirements.md` exist and parse; or spawn in “hold” without brief until artifact event.

**Confidence:** high

---

### F8 — False PLAN-READY assertion (defect 6) + brief/engine contract still inconsistent
**Rank:** fixed-in-source for next dispatch · still confuses humans/agents mid-run

**Mechanism**
- Run 31/32 callbacks: `PLAN-READY — plan agreed with deliberation` while partners had only BROKEN or no verdict.
- On-disk plancore briefs for those runs ordered STOP after first PLAN-READY and claimed agreement.
- Current `generatePlanningBrief` source (in-flight) now says PLAN-READY = artifacts written, await verdicts, §8 revise — **but** scope line still says “emit PLAN-READY only after both artifacts written and whole-plan agreement holds” in places, and panel brief still has no re-verdict (F1).

**Trigger:** any plancore using shipped brief.

**Blast radius:** false operator signal; partners may treat PLAN-READY as “done”; gate text vs agent text diverge.

**Fix:** one contract string shared by engine + all briefs; PLAN-READY never means agreed; optional separate `PLAN-AGREED` engine-emitted only when gate passes.

**Confidence:** high

---

### F9 — Partner disagreement (CLEAN + BROKEN) is unanimous in theory; never exercised; multi-partner TASK-VERDICT collapses seats
**Rank:** latent · first real split panel · wrong reconvene

**Mechanism**
- Whole-plan: `partnerBatchIds.every(id => verdicts.get(id) === 'CLEAN')` (`:1055`) — ordering does **not** short-circuit success; one BROKEN blocks until superseded. Unanimity is real for the whole-plan gate.
- `collectTaskVerdicts` merges **all** partner batch ids into a **single** `partner` map (`:892-894`): first newest TASK-VERDICT per task_key wins across seats. Partner-1 AMEND + partner-2 ACCEPT for same task → only one retained → `detectTaskReconveneConflicts` sees a false consensus.

**Trigger:** panelSize≥3 / 2 co-planners with TASK-VERDICT lines (A13 path post-agreement).

**Blast radius:** silent skip of reconvene; wrong conflict detection after a hard-won whole-plan CLEAN.

**Fix:** per-seat task verdict maps; reconvene if any seat ESCALATE or pairwise AMEND conflict.

**Confidence:** high on code; med on how often TASK-VERDICT is emitted in prod

---

### F10 — Non-convergence leave-behind is partial and non-recoverable as a cycle state
**Rank:** after next timeout · operator stuck holding orphans

**Mechanism on `agreed:false` (`:665-687` + orchestrator `:1684-1699`)**
- Seats reaped `planning-not-agreed`; no `ingestExecutionPlan`; no `recordProvenanceAfterAgreement` (gated on agreed).
- Run → `phase=blocked status=failed`.
- Cycle → terminalize attempts `complete` + freeze (F5); board not a clean “planning failed, retry.”
- Canonical `plan.md` may exist on disk (run32 archive has a full plan with real gating defects) but is **not** bound by AC28 provenance; Start Implementation correctly refuses without provenance, but the operator has no first-class “resume planning from this plan.md” — only another full run (and legacy path re-interviews).

**If plan.md missing/invalid after timeout:** path throws `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` (`:660-661`) **after** waitForAgreement, different from soft `blockedReason` — two failure shapes for one phase.

**Confidence:** high

---

### F11 — `plan.md` byte-identity / AC28 provenance (Q7)
**Rank:** after first successful agreement + later edit · gate works; mid-round SHA not an issue yet

**Mechanism**
- Provenance recorded only post-agreement (`run-orchestrator-service.ts:1001-1017`, `:1758-1773`) via `recordProvenanceAfterAgreement` hashing final `plan.md` (`planning-provenance-service.ts:152`).
- Round-2 revisions **before** gate pass do not pin SHA (no row until success) — correct.
- After success, Start Implementation re-hashes and rejects drift (`:235-241`).
- **Gap:** if plancore rewrites plan.md **after** CLEAN but before ingest snapshot, race exists between last CLEAN bytes and ingest bytes; ingest reads file at gate-pass (`:690-694`), not the bytes partners reviewed. No content-hash in the CLEAN verdict.

**Trigger:** plancore continues editing after partners CLEAN (STOP discipline failure).

**Blast radius:** partners approved A; implementation runs B.

**Fix:** hash plan.md at gate success; pin that hash in provenance and refuse ingest if file drifted since the CLEAN pass.

**Confidence:** med (race theoretical; STOP failures have happened before)

---

### F12 — A13 reconvene ignores configured coPlannerSeats identity
**Rank:** post-first-success · wrong model on reconvene

**Mechanism:** `reconveneConflictingTasks` spawns with `inputs.partnerModel` / `partnerProvider` only (`planning-phase-service.ts:942`), not `coPlannerSeats[i]`. After S06 multi-seat staffing, reconvene can launch the wrong provider/model.

**Confidence:** high on code; low immediacy (whole-plan never agreed yet)

---

## CHARTER QUESTIONS — DIRECT ANSWERS

| # | Answer |
|---|--------|
| **1 ibrain** | Not a planner seat. Invented at run-block terminal by `assertImplementationBrainComplete` → `finalizeBrainSessionRow` with default unknown/unknown; same timestamp as run end. Can `markIdle` the real `helm-ibrain-memory_mcp` session. Does not suppress partner verdicts; corrupts implementation session ledger. |
| **2 Round 2** | Has never executed because there is no round loop—only a longer timeout. When A1+§8 ship without partner re-dispatch, expect: stale LATEST=BROKEN, fence offset OK for multi-attempt reruns, partners already stopped, 30 min burn, ROUND-CAP-EXHAUSTED. |
| **3 Partner disagreement** | Whole-plan gate enforces unanimity (every id CLEAN). Not ordering-based. Untested in a live run. |
| **4 partner-2** | Structurally load-bearing for the gate; never finished a content review on 31/32; brief-on-disk identity collided with partner-0; JROM is paying for an opinion the system often reaps. |
| **5 Two entry paths** | Yes diverge: legacy re-spawns discovery and rewrote NS three times; S10 does not. Legacy should not exist for cycles with existing Discovery docs. |
| **6 Non-convergence** | blocked run + reaped planners + orphan plan.md + no provenance + cycle freeze-on-fail. Not a clean retry posture. |
| **7 plan.md SHA** | Pins only post-agreement final file; good for AC28 after success; no pin of “bytes partners actually CLEANed.” |

---

## THE ONE THING most likely to break the NEXT run

**After the first real partner BROKEN, the gate will wait for a superseding CLEAN that no partner is instructed or forced to emit.** Plancore may revise (if the new brief is what actually launches); partners will not re-verdict; `waitForAgreement` will poll until `planning_round_cap × PLANNING_TIMEOUT_MS` and return `ROUND-CAP-EXHAUSTED`. Same death as run 32, slower and more expensive. Secondary landmine on that same run: **do not use legacy Start Planning** or Discovery docs get rewritten again; and the **ibrain idle/freeze side effects** will re-fire on block.

---

## WHAT I COULD NOT DETERMINE

- Exact operator/UI action that set `cycles.phase` back to `discovery` after freeze-at-complete on run 31 (freeze row proves complete path ran; current phase is discovery).
- Whether `markIdle` on phantom ibrain is what left `helm-ibrain-memory_mcp` idle vs a later manual close (timing consistent, not proven exclusive).
- Whether in-flight sonnet5 branch has partner re-verdict brief changes not yet visible in the working tree I read (panel brief at `:474-475` still “emit then stop”).
- Adaptive planning path (`adaptivePlanning: true`) — not exercised by runs 31/32; not fully traced.
- Live behavior of S10 handoff end-to-end on this project (`discovery_handoffs` table not present / empty in this DB snapshot).

---

## RESTRUCTURING SKETCH (not a patch list)

1. **One entry:** confirmed handoff only for cycles with Discovery docs; delete rediscovery on Start Planning.
2. **Engine rounds:** artifact-ready → spawn/review → collect verdicts → if BROKEN and round&lt;cap: revise (engine waits for new plan hash) → respawn/renudge partners → else BLOCKED. Cap = integer rounds.
3. **Unique seat identity on disk and in transport** (role or brief path includes seat id).
4. **Terminal policy:** planning failure ≠ cycle complete ≠ topology freeze ≠ ibrain finalize.
5. **PLAN-READY ≠ agreed;** only engine emits agreement/ingest permission.
6. **Tests that burn no tokens:** convene-before-artifacts, BROKEN→revise→CLEAN, partner1 CLEAN + partner2 BROKEN, partner-2 silent until timeout, legacy path refuses when NS exists, ibrain row count unchanged on planning block.

Until (2)+(4)+(1) land, further brief-only fixes will keep producing “fixed, proven on run N, died on run N+1.”

---

PANEL-DONE grok45
