# plan-grok45 — Planning agreement restructure

**Planner seat:** grok45 (effort planning phase, `[north]` helm-97)  
**Authored:** 2026-07-30  
**Sources of truth:** `north-star.md`, `og-requirements.md` (23 ACs), `PANEL-SYNTHESIS.md`, `topology.yaml`, panel findings  
**Base commit constraint:** `8024452` convene-race fix **must survive** — `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` stays `3`  
**Out of scope:** merge to `main` (SD10); enable `HELM_SESSION_JANITOR`; mutate cycle 13 data; Tiller before a clean attended Helm run

---

## Governing invariants (engine, not briefs)

1. **Agreement is engine state.** A seat may claim CLEAN; only the engine, with hash-scoped unanimity, grants ingest.
2. **No `transport.send`.** Partner re-engagement is impossible after CLI turn end. Each review round **spawns a FRESH seat** against the **current plan hash**.
3. **Fail-closed before capability.** P0 → P1 → P2 → P3. Never build the round machine on a fail-OPEN gate.
4. **A brief is not a protocol.** Every invariant below lands in TypeScript + token-free tests.

### Keystone (do not re-litigate)

`planning-phase-service.ts` exposes only `spawn` / `reap` / `inspectSeat`. `inspectSeat` / `resubmitIfComposerHeld` runs **only for `brainRole`** (`:461`). Comment at `:520-522` already records that a seat that emitted VERDICT-READY does not re-emit. Round reuse of a partner seat is **architecturally dead**.

---

## Mechanism map (panel archaeology — cite, do not re-dig)

| Area | File:line (current) | Defect / AC |
|------|---------------------|-------------|
| Phantom ibrain assert | `run-orchestrator-service.ts:390-414`, `:406-412`, `:492`, `:559-589` | AC1; C3; grok F4; sol #6; opus F6 |
| Register-if-missing + unknown defaults | `worker-runtime-finalize.ts:168-260`, `:209-210`, `:237-253` | AC2 |
| Registry idle by session **name** | `worker-runtime-finalize.ts:48-67` → markIdle; consumer `session-reconcile-decision.ts:85-92`; reap `worker-service.ts:494-547` | AC3 (E5-class) |
| Cycle complete on planning fail | `run-orchestrator-service.ts:392-393`, `:601-616` → `cycle-service.ts:370-400` FREEZE_ON_OR_AFTER includes `complete` | AC4; C4 |
| DB finalize before transport cleanup | `planning-phase-service.ts:665-687` (DB reaped, no transport reap); outer `worker-runtime-finalize.ts:127-155` skips already-terminal | AC5; sol #4 |
| Verdict bare enum, no plan SHA | `planning-phase-service.ts:1012-1041`, parse `:844` | AC6–8; C1 |
| Stale CLEAN counts | gate `:1041` every partner CLEAN + PLAN-READY; no revision pin | AC7 |
| Parse fail-open on stale | reversed scan `:1010-1018`; unparseable newest leaves prior CLEAN | AC8; opus F9 |
| Throw vs return on non-convergence | plan read catch `:619-661` before soft exit `:665-687` | AC9; opus F10 |
| roundCap = wall-clock mult | `planning-phase-service.ts:367-368` | AC10; C2 |
| Partners spawn before artifacts | `:498-562` immediately after plancore first cb | AC11; convene race; **8024452 guard only** at `:580` / `:995` / `:1033` |
| waitForAgreement passive poll | `:984-1048`, 20 ms loop | AC11 |
| PLAN-READY as social agreement | plancore brief history; gate still needs engine sole grant | AC12 |
| Shared role `deliberation` | spawn `role: partner` where partner=`'deliberation'` `:536-537`; `real-transport.ts:240` writes `prompts/${role}.brief.md` | AC13; grok F3 |
| Panel brief no plan path | `brief-writer-service.ts:432-471` hardcodes `planPath: 'plan.json'`, `runDir: '.'` | AC14; opus F3 |
| Partner no first-cb watchdog | plancore `:439-476` + `waitForFirstCallback:731-836`; partners `:536-561` none | AC15; opus F4 |
| Non-transactional ingest | `plan-parser-service.ts:169-197`, `:211-237` | AC16; sol #14 |
| Legacy rediscovery | `run-orchestrator-service.ts:1530-1562`; UI Start Planning still dual-path | AC17; C5 |
| Provenance re-reads mutable file, non-fatal | `planning-provenance-service.ts:145-185`; swallow at `run-orchestrator-service.ts:1001-1017` | AC18; C6 |
| Owner confirm staffing only | `discovery-handoff-ingress.ts:55-95`, `:206-239`; owner-bridge `:244-300` | AC19; sol #8 |
| Autonomous handoff → executing, no loop | `run-orchestrator-service.ts:1026-1036` vs legacy loop `:1709-1734` | AC20; sol #2 |
| Handoff crash gaps | `discovery-handoff-owner-bridge.ts:193-216`, `:303-395` | AC21; sol #9 |
| Adaptive second planner | `planning-phase-service.ts:334-343` → `adaptive-planning-phase.ts:1532-1561` | AC22; sol #13 |

**8024452 survival rule for every P2 edit of `waitForAgreement` / convene path:** keep the three `planMdPathForRaceGuard` references (param, call site, fs.stat). Extend the gate; do not delete the race guard.

---

## Ordering rationale

| Band | Job | Why first |
|------|-----|-----------|
| **P0** | Stop corruption on every failed planning run **today** | Phantom ibrain + cycle complete are live |
| **P1** | Fail-CLOSED agreement gate | Safe-while-broken; blocks silent unreviewed ingest |
| **P2** | Engine round machine + fresh seats | Makes convergence real; depends on P1 hash gate |
| **P3** | One entry, provenance, handoff, adaptive | Cleanup after the protocol is enforced |

Deps in the table encode this. **No P2 slice depends only on P0; every P2+ slice lists a P1 gate slice (or a P1 ancestor).**

---

## AC coverage matrix

| AC | Slice(s) | Notes |
|----|----------|--------|
| 1 | S01 | Skip ibrain assert when execution never started |
| 2 | S02 | No register-if-missing / no unknown synthesis |
| 3 | S03 | Live session not idled; no name-inferred registry poison |
| 4 | S04 | Failed planning ≠ cycle complete / freeze |
| 5 | S05 | Transport reap before DB terminalize |
| 6 | S06 | Verdict carries plan SHA-256 |
| 7 | S07 | Gate: all CLEAN for **current** hash only |
| 8 | S08 | Unparseable/mangled ≠ CLEAN; no stale promote |
| 9 | S09 | Non-convergence returns blockedReason, never throws |
| 10 | S10 | round_cap = integer rounds |
| 11 | S11, S12 | Artifact-ready spawn + revise/respawn loop |
| 12 | S13 | PLAN-READY ≠ agreed; engine sole grant |
| 13 | S14 | Unique seat identity on disk + transport |
| 14 | S15 | Absolute canonical plan path in partner brief |
| 15 | S16 | Partner first-callback / submit watchdog |
| 16 | S17 | Transactional ingest |
| 17 | S18 | One entry; refuse rediscovery when NS exists |
| 18 | S19 | Provenance = ingested bytes; mismatch fatal |
| 19 | S20 | Owner confirm freezes discovery bytes |
| 20 | S21 | No orphan `executing` without driver |
| 21 | S22 | Handoff starting wedge + leak closed |
| 22 | S23 | Adaptive shares gate or hard-refuse |
| 23 | **spread** | See tests column on S01–S03, S07–S08, S11–S12, S14, S16, S18 |

---

## Slice table

Legend: `impl_tier` / `val_tier` per `topology.yaml`. P0/P1: **never L1**; redteam **elite**.  
`deliberation`: approach panel before impl (`none` | `settle`).  
`redteam`: post-diff panel (`none` | `budget` | `standard` | `elite`).  
`budget`: suggested agent-call cap for the slice (tight atomic).  
`deps`: slice ids that must PASS first.

| id | scope | acs | tests | est_min | deps | impl_tier | val_tier | deliberation | redteam | budget |
|----|-------|-----|-------|---------|------|-----------|----------|--------------|---------|--------|
| S01 | **P0** Gate `assertImplementationBrainComplete`: call only when this run already has a non-phantom ibrain `worker_runtimes` row (execution started). Planning `transitionRunToBlocked` / detached-fail paths that never spawned ibrain skip assert. Touch `run-orchestrator-service.ts:390-414`, `:406-412`, `:492`, `:559-589`. Do **not** invent a session name and finalize. | 1, 23 | Token-free: planning-block failure path → **ibrain row count unchanged** for `run_id` (AC23). Assert no new `role=ibrain` row with `spawned_by='brain-phase-end'`. | 20 | — | L2 | L2 | none | elite | 6 |
| S02 | **P0** `finalizeBrainSessionRow` chokepoint: **never register-if-missing**; **never** default provider/model to `unknown` to synthesize (`worker-runtime-finalize.ts:209-210`, `:224-253`). If no existing run+session non-terminal row → no-op `false`. Defense in depth if any caller still invokes assert. | 2, 23 | Token-free: `finalizeBrainSessionRow` with missing runtime → no INSERT; row count stable; no `unknown/unknown` ibrain row. | 15 | — | L2 | L2 | none | elite | 6 |
| S03 | **P0** Prove AC3 E5 path closed: planning failure must not `markIdle` a live `helm-ibrain-<slug>` via name join (`worker-runtime-finalize.ts:48-67` → `session-reconcile-decision.ts:85-92`). Prefer fixing at write source (S01/S02); only tighten registry assert if residual name-only idle remains. **Do not enable janitor.** | 3, 23 | Token-free: seed live `helm_sessions` `helm-ibrain-*` status=`active` (or non-idle); run planning-block finalize; **status unchanged**. | 20 | S01, S02 | L2 | L2 | none | elite | 6 |
| S04 | **P0** Failed planning is **not** cycle success. `transitionRunToBlocked(..., 'failure')` for planning-not-agreed / planning-blocked must **not** call `terminalizeCycleAtRunEnd` → `setCyclePhase(..., 'complete')` (`run-orchestrator-service.ts:392-393`, `:601-616`). Leave cycle in retryable `planning` (or prior phase); **no** topology freeze via `FREEZE_ON_OR_AFTER` (`cycle-service.ts:22`, `:400`). True implementation/success terminals keep complete. | 4 | Token-free [DB]: planning fail → `cycles.phase` ≠ `complete`; no new `cycle_topology_freezes` row for that failure timestamp path. Handoff/retry still possible without manual SQL. | 25 | — | L2 | L2 | none | elite | 6 |
| S05 | **P0** Planning workers: **transport cleanup before DB terminalize**. On agreed:false and agreed:true, `reap` seats via transport first, then `finalizeWorkerRuntime` (`planning-phase-service.ts:665-687`, success `:711-713`). Confirmed-handoff path must not leave panes alive while ledger says reaped (sol #4). Outer finalizer already skips terminal rows (`worker-runtime-finalize.ts:127-155`) — order flip is the fix. | 5 | Token-free: mock transport — on not-agreed, `reap` called **before** finalize row state; no “DB reaped, transport still live” sequence. | 20 | — | L2 | L2 | none | elite | 6 |
| S06 | **P1** Partner VERDICT-READY contract: every verdict carries **SHA-256 of exact `plan.md` bytes reviewed**. Engine parse extracts hash (`parseAgreementCallbackLine` / note grammar at `planning-phase-service.ts:844`, scan `:1010-1018`). Missing hash ⇒ not a CLEAN (pairs with S08). Brief text may document format; **parse enforcement is the protocol.** | 6 | Unit: sample callback lines with/without `plan_sha256=<hex>`; parser returns hash or rejects CLEAN. | 25 | S01,S02,S03,S04,S05 | L2 | L2 | none | elite | 8 |
| S07 | **P1** Fail-CLOSED agreement gate (C1). `waitForAgreement` stores per-seat `{verdict, planSha}` not bare enum (`:1003-1041`). Accept **only** when every configured seat is CLEAN **and** each CLEAN’s sha equals **current** on-disk plan.md sha. Panel scenario: A CLEAN@R1, plancore writes R2, B CLEAN@R2 → **refuse**. Preserve `planMdPathForRaceGuard` (`:995`, call `:580`, guard `:1033-1039`) — extend, do not remove (8024452). | 7, 23 | Token-free: **stale-CLEAN rejected across revisions** (AC23). Fixture callbacks + two plan file revisions; gate false. Also partner1 CLEAN + partner2 BROKEN stays false. | 25 | S06 | L3 | L2 | settle | elite | 8 |
| S08 | **P1** Verdict parse fail-closed on stale side (opus F9). Newest unparseable / separator-mangled VERDICT-READY must **not** leave an older CLEAN as “latest.” Only accept CLEAN when note matches strict grammar including hash (S06). Docstring at `:980-981` must match behaviour. | 8, 23 | Token-free: mangled newest line after CLEAN → gate does not treat as CLEAN; no silent promote of prior CLEAN. | 20 | S06 | L2 | L2 | none | elite | 6 |
| S09 | **P1** Non-convergence **returns** mechanism blockedReason; never throws past cleanup (opus F10). When `waitForAgreement` false, path must still finalize workers, advance fence, set `blockedReason` (`:665-687`) even if canonical plan missing — do not throw `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` (`:660-661`) **before** soft exit. Prefer single exit shape: `agreed:false` + reason. | 9 | Unit: force !agreed + missing plan.md → result `{agreed:false, blockedReason}` no throw; runtimes finalized. | 20 | S05 | L2 | L2 | none | elite | 6 |
| S10 | **P2** `planning_round_cap` = **integer rounds**, not `PLANNING_TIMEOUT_MS * roundCap` as “rounds” (`:367-368`). Introduce explicit `round` counter 1..cap; per-round wall budget stays a **separate** timeout (may still use PLANNING_TIMEOUT_MS **per round**). Exhausted rounds → BLOCKED with round number in reason. | 10 | Unit: roundCap=2 → at most 2 review collections; does not require 2× wall sleep to exhaust. | 20 | S07,S08,S09 | L2 | L2 | none | elite | 6 |
| S11 | **P2** Engine: **artifact-ready before partner spawn**. Do not spawn partners at `:498-562` while plan is absent. After plancore first-callback (keep existing brain watchdog `:439-476`), **wait** for non-empty `plan.md` + `og-requirements.md` under `canonicalArtifactRoot`, **then** spawn FRESH partner seats for round 1. Convene race becomes engine fact; brief wait text is no longer the primary protocol. **Keep** race-guard hash path as backstop (8024452). | 11, 23 | Token-free: **convene-before-artifacts** — partners not spawned until files exist; no VERDICT before plan bytes. | 25 | S10 | L3 | L2 | settle | elite | 8 |
| S12 | **P2** Engine round machine (keystone). Loop: collect verdicts under S07 gate → if all CLEAN@currentHash → agree → ingest path; else if any BROKEN and `round < cap`: (1) engine instructs plancore to revise (spawn/nudge plancore or existing brain path **only** via mechanisms that exist — no fake `send` to dead partners), (2) **wait for new plan hash** ≠ prior, (3) **reap old partner seats**, (4) **spawn FRESH partner seats** with unique ids + current hash in brief, (5) `round++`. Else BLOCKED. Never “emit then hope.” No partner seat reuse across rounds. | 11, 23 | Token-free: **BROKEN→revise→CLEAN** happy path with fake transport: R1 BROKEN, new hash, R2 fresh seats CLEAN@newHash → agreed. partner1 CLEAN + partner2 BROKEN → revise path not silent pass. | 25 | S11,S07,S14 | L3 | L3 | settle | elite | 10 |
| S13 | **P2** `PLAN-READY` is **not** agreement. Only engine sets `agreed:true` / grants ingest. Plancore brief (`brief-writer-service.ts` planning path ~`:274-351`) must **not** instruct “plan agreed with deliberation” before verdicts; PLAN-READY = artifacts written only. Optional engine log line `PLAN-AGREED` only after S07 pass. | 12 | Unit/string contract: planning brief never claims agreement pre-verdict; engine returns agreed only from gate. | 15 | S10 | L2 | L2 | none | elite | 4 |
| S14 | **P2** Unique seat identity on disk + transport. Stop all partners sharing `role: deliberation` so `real-transport.ts:240` overwrites `prompts/deliberation.brief.md`. Use distinct role or brief filename including seat id (e.g. `deliberation-partner`, `deliberation-partner-2` / `prompts/${role}-${seat}.brief.md` with transport change). Align `artifacts.writeBrief` (`:535`) with transport path. Fixes structural partner-2 silence (grok F3). | 13, 23 | Token-free: two partner spawns → **two brief files** on disk; second does not clobber first. **partner-2 silent** regression: both seats receive distinct brief content. | 20 | S10 | L2 | L2 | none | elite | 6 |
| S15 | **P2** Partners told absolute canonical plan path (opus F3). Extend `generatePanelBrief` (`brief-writer-service.ts:432-471`) with `canonicalArtifactRoot` / absolute `plan.md` + `og-requirements.md` paths; call site `planning-phase-service.ts:509-534` passes real root (same root used at `:585-587`). Remove hardcode `planPath: 'plan.json'`, `runDir: '.'` for planning partners. | 14 | Unit: brief body contains absolute plan.md path for fixture root. | 15 | S11 | L2 | L2 | none | elite | 4 |
| S16 | **P2** Partner first-callback / submit watchdog (opus F4). Reuse `waitForFirstCallback` (`:731-836`) + `resubmitIfComposerHeld` for each partner spawn (mirror brain `:461`), with mute partner named in blockedReason. Round-scoped: apply to each FRESH seat. | 15, 23 | Token-free: **partner-2 silent until timeout** — mock no callback → blockedReason names mute batchId; watchdog invoked for partners. | 25 | S14,S11 | L2 | L2 | none | elite | 8 |
| S17 | **P2** Transactional plan ingestion (sol #14). `ingestExecutionPlan` / `ingestPlan` (`plan-parser-service.ts:169-197`, `:211-237`): single DB transaction for task inserts + enqueue; on failure roll back so run is not partially executable. FS `plan.json` write either after commit or compensated. | 16 | Unit: forced mid-ingest failure → zero orphan tasks / empty queue for run. | 25 | S12 | L2 | L2 | none | standard | 6 |
| S18 | **P3** One entry (C5). For cycles that already have Discovery docs (`north-star.md` present), **refuse** legacy rediscovery / Start Planning interview branch (`run-orchestrator-service.ts:1530-1562`). Confirmed handoff only. Delete or hard-gate UI legacy Start/Re-run that re-authors NS. Do not rewrite cycle 13. | 17, 23 | Token-free: **legacy path refuses when north-star exists** — start attempt returns structured error; NS bytes unchanged. | 25 | S12 | L2 | L1 | none | standard | 6 |
| S19 | **P3** Provenance pins **bytes actually ingested** after agreement; mismatch **fatal** (C6). Pass sha from gate/ingest into `recordProvenanceAfterAgreement` (`planning-provenance-service.ts:145-185`); do not re-hash a later mutable file as sole truth. Swallow-and-continue at `run-orchestrator-service.ts:1001-1017` → fail run if provenance cannot pin. `assertPlanningProvenanceForImplementation` already compares file sha — keep; ensure pin equals ingest bytes. **Do not weaken AC28.** | 18 | Unit: ingest sha A, mutate file to B before record → fatal; implementation gate rejects drift. | 25 | S17,S07 | L2 | L2 | none | standard | 6 |
| S20 | **P3** Owner confirmation freezes **discovery bytes** (sol #8), not staffing alone. Ingress/confirm (`discovery-handoff-ingress.ts:55-95`, `:206-239`; `discovery-handoff-owner-bridge.ts:244-300`) store content digests for NS + conversation-log; planning refuses if files drifted. | 19 | Unit [DB]: confirm stores digests; mutate NS after confirm → planning/start fails closed. | 20 | S18 | L2 | L1 | none | budget | 4 |
| S21 | **P3** Confirmed handoff on **autonomous** cycle must not leave `phase=executing` with no `OrchestratorLoop` (sol #2). `startPlanningFromConfirmedHandoff` `:1026-1036` either parks (pause_after_planning), starts the real driver, or stays in a non-executing terminal that UI can advance — never fake executing. | 20 | Unit: autonomous + agreed → not stuck executing-without-loop; or park path asserted. | 20 | S18 | L2 | L1 | none | budget | 4 |
| S22 | **P3** Handoff acquisition/background crash gaps (sol #9). Close `starting` without `planning_run_id` wedge (`discovery-handoff-owner-bridge.ts:193-216`, `:303-362`); background catch must run worker finalize + cycle-safe terminal (not half-update `:373-395`). try/finally around planning so exceptions after spawn still cleanup. | 21 | Unit: crash between CAS and run id → recoverable or explicit reclaim; no permanent starting wedge; no leaked planning workers. | 25 | S05,S18 | L2 | L2 | none | standard | 6 |
| S23 | **P3** Adaptive planning (`adaptive_planning=1`): **share** S07 agreement semantics **or** hard-refuse with clear error at `planning-phase-service.ts:334-343`. No second planner with `agreed:true` from structural validation alone (`adaptive-planning-phase.ts:1532-1561`). Prefer refuse until parity if wiring >30min — then a follow-on slice, but AC22 must not remain silent dual path. | 22 | Unit: adaptive flag on → either same gate mocks pass/fail as core, or start throws/refuses with reason. | 20 | S07,S12 | L1 | L1 | none | budget | 4 |

**Total est:** ~465 min pure impl slices (~7.75 hr single-threaded). Parallelism: S01∥S02∥S04∥S05 within P0 after S03 waits S01+S02; P1 serial on S06→S07/S08; P2 fan-out S13∥S14 after S10; S12 last in P2 core.

---

## Slice notes (mechanism-level, implementer-ready)

### P0 — Stop active corruption

**S01–S03 (ibrain E5 cluster).**  
Today: any planning `agreed:false` → `transitionRunToBlocked` → `assertImplementationBrainComplete` without provider/model → session `helm-ibrain-${slug}` → `finalizeBrainSessionRow` INSERT unknown/unknown → `markIdle` on global name. Runs 31/32 rows prove it. Fix at call site **and** chokepoint; test both row count and live session status.

**S04.**  
`terminalizeCycleAtRunEnd` comment claims “true run completion” but planning failure is not cycle success. Split policy: planning-blocked ≠ `complete`. Freeze stamp on fail is durable poison (`UNIQUE(cycle_id)`).

**S05.**  
sol #4: planning marks runtimes terminal in DB, outer reap skips them, panes leak, fence can absorb late callbacks. Order: transport first.

### P1 — Fail-closed gate

**S06–S08.**  
Without SHA on verdicts, multi-revision CLEAN is combinable (C1). Implement hash **before** any respawn machine so S12 cannot ship unreviewed bytes.

**S09.**  
Two failure shapes today confuse operators and skip cleanup. One soft exit.

### P2 — Round machine (keystone)

**S10–S12.**  
Replace passive `while (Date.now() - start < timeoutMs)` multi-timeout poll with explicit rounds. **Fresh seats every round** — no `transport.send` fantasy. Wait for **new plan hash** before spawning reviewers for round N+1.

**S13–S16.**  
Identity, paths, watchdogs: engine-owned ergonomics so partner-2 can actually exist as a seat.

**S17.**  
Ingest atomicity so agreement cannot produce half a task graph.

### P3 — Close divergent paths

**S18–S23.**  
One entry, byte-true provenance, handoff durability, no ghost executing phase, adaptive parity or refuse.

---

## AC23 regression map (token-free, not a single slice)

| Historical mode | Pins behaviour of |
|-----------------|-------------------|
| ibrain row count unchanged on planning block | S01, S02, S03 |
| stale-CLEAN rejected across revisions | S07 (+ S06/S08) |
| convene-before-artifacts | S11 (+ 8024452 guard remains) |
| BROKEN→revise→CLEAN | S12 |
| partner1 CLEAN + partner2 BROKEN | S07, S12 |
| partner-2 silent until timeout | S14, S16 |
| legacy path refuses when north-star exists | S18 |

All tests: vitest **file-by-file**, temp DB (`src/test-setup.ts`), **zero model tokens**, fake transport.

---

## Hard safety checklist (every batch)

1. `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` → **3**
2. `HELM_SESSION_JANITOR` stays **0**
3. Cycle 13 data untouched
4. No merge to `main`
5. Do not weaken AC28 provenance guard for fixtures
6. Known pre-existing test fails: leave unless touched (pause-after-planning-gate, finish-planning-production, b25-fix1-orphan-model, model-service, smoke)
7. app.js (if touched for S18): `node --check` then `npm run build`
8. UI proof only via `:3110` / `playwright.cap.config.ts` if UI claimed

---

## Explicit non-plans

- Brief-only partner “please re-verdict” text as the round protocol  
- Reusing a partner seat across rounds  
- Building S12 before S07  
- Enabling session janitor as a fix for AC3  
- Adaptive feature parity as a multi-hour rewrite inside one slice — **refuse** is valid for AC22 if parity exceeds budget  

---

## Handoff to projcore

On synthesis + JROM approval of the merged plan: execute **P0 first** (S01–S05), gate with elite redteam, then P1 (S06–S09), then P2 core (S10–S17), then P3 (S18–S23). Coordinator primary: codex55 per `topology.yaml`. Implementer P0/P1: **L2/L3 only**. Validator P0/P1: **L2 minimum**.

---

PLAN-DONE grok45
