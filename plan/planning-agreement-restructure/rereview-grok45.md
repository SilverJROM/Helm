# rereview-grok45 — isolate-then-integrate, then parallelise

**Seat:** grok45 · **Against:** `plan/planning-agreement-restructure/plan.md` (35 slices, ~870 min serial)  
**Read:** plan.md, plan-grok45.md, og-requirements.md, north-star.md, topology.yaml · **No other seats' rereviews**  
**Constraint:** nothing implemented; `src/` still `0a0c883`

---

## VERDICT on the synthesis (adopt-with-changes)

**Adopt-with-changes.**

**Keep without argument**
- Spine and mechanism precision (opus5): A0 pin → P0 E5 teardown → P1 fail-closed → P2 round core → **C8 last** → P3 cleanup.
- Ordering laws: P1 before P2; C8 last of P2 core; A0 first; A5→A6 as single terminal owner.
- Grafts: sol's try/finally terminal owner + transactional ingest; brief-path / separator / fail-open index guards as first-class slices.
- AC coverage 23/23, 8024452 survival, no janitor, no main merge.

**Reject as written (structure, not substance)**
1. **Single-parent dep chain** (34/35) forces ~14h30m **wall** of pure serial work. That is an artefact of the table shape, not of the physics of the code. Many slices share **no file** and only a **band** constraint (P0 before P1, etc.).
2. **Integration is folded into every slice.** Each row is “edit engine + prove behaviour,” so nothing can land until the previous engine edit is done. That is the opposite of JROM’s isolate-then-integrate goal.
3. **`planning-phase-service.ts` is treated as one mutable blob for ~15 slices.** Without extracting pure modules / a dedicated round-machine file, **no amount of seat concurrency helps** — one file serialises the effort.
4. **P0 is over-serialised.** A1/A4 (`run-orchestrator-service.ts`), A2/A3 (`worker-runtime-finalize.ts`), A5/A6 (`planning-phase-service.ts`) are three **independent file tracks**. Synthesis chains A0→A1→A2→A3→A4→A5→A6 as if they were one mechanism; only **within-file** order is mandatory.
5. **P3 is over-serialised.** D2 (`index.ts`), D3 (`app.js`), D6 (`discovery-handoff-ingress.ts`), D5 (`planning-provenance-service.ts`), C10 (`plan-parser-service.ts`), C1 (`real-transport.ts`) can build in parallel once contracts are pure; synthesis makes them a daisy chain through D1…D12.

**Change thesis:** keep the same 35 behaviours, re-cut **build vs integration**, re-cut **deps to file ownership + band laws**, extract pure seams (B1 is the model — expand that pattern). Wall-clock becomes dominated by (1) concurrent isolated unit-tested builds and (2) a **small** number of named integration waves — not by 35 serial merges.

---

## WAVE PLAN — build waves and integration waves kept SEPARATE

**Practical concurrency:** 3–4 execution seats (topology). **Rule:** no two slices in the same **build** wave write the same production file. Test files may land in parallel with their owner.

**Band laws (never broken for speed)**
1. No P2 **wiring** of convergence before P1 **gate pure logic** is green (B5 pure, then I-P1).
2. **C8 (remove honest fail-fast) is the last build slice of the P2 core** that mutates gate short-circuit behaviour — only after C3–C7 pure+wire exist.
3. **A0 first** — pin `8024452` before any edit near the gate.
4. Within P0 tracks: A1 before A4 (same file); A2 before A3 (same file); A5 before A6 (same file). Tracks may run **in parallel**.

**Extracts introduced by this rereview (not new product scope — testability seams)**

| New pure / seam module | Absorbs logic from | Why |
|---|---|---|
| `src/services/plan-revision.ts` | B1 (already in plan) | Model pure module |
| `src/services/agreement-verdict-parse.ts` | B3, B4 | Grammar + newest-line fail-closed without engine |
| `src/services/agreement-gate.ts` | B5 | `{verdict, planSha}[]` + currentSha → Accept/Reject |
| `src/services/artifact-publication.ts` | C3 | plan.md + og-requirements exist/non-empty/parseable |
| `src/services/planning-review-round.ts` | C2–C8 body | Round loop lives **out of** `planning-phase-service.ts` so the god-file is not a 15-slice queue |

`planning-phase-service.ts` becomes a **thin host** after I-P2: spawn plancore, call round machine, ingest on Accept. That is the single biggest wall-clock lever.

---

### BUILD wave 0 — pin only
| slice | exclusive write |
|---|---|
| **A0** | `src/**/plan-race-guard*.test.ts` (or adjacent existing planning test file only). **No production code.** |

`build_parallel_min = 20` (1 seat)

---

### BUILD wave 1 — three P0 tracks in parallel (3 seats)
| slice | exclusive write |
|---|---|
| **A1** | `run-orchestrator-service.ts` — capture pre-terminal state; skip `assertImplementationBrainComplete` when execution never started |
| **A2** | `worker-runtime-finalize.ts` — `finalizeBrainSessionRow` update-only; delete register-if-missing + unknown defaults |
| **A5** | `planning-phase-service.ts` — retain spawn handles; `await transport.reap` **before** DB finalize (transport-first on existing paths only; full try/finally is A6) |

`build_parallel_min = max(26,24,28) = 28`

---

### BUILD wave 2 — finish P0 tracks (3 seats)
| slice | exclusive write |
|---|---|
| **A4** | `run-orchestrator-service.ts` — planning failure must not `terminalizeCycleAtRunEnd` / freeze |
| **A3** | `worker-runtime-finalize.ts` — `assertRegistryIdle` bound to run-owned runtime id, not bare name |
| **A6** | `planning-phase-service.ts` — single transport-first `try/finally` terminal owner for success/blocked/throw |

`build_parallel_min = max(28,28,26) = 28`

**P0 build wall so far:** 20+28+28 = **76 min** (serial plan had ~180 min for A0–A6).

---

### INTEGRATION wave I-P0 — P0 end-to-end (serial, one seat)
**Wire nothing new** — prove the three tracks together against a fake planning-block:

- Temp DB + fake transport: force planning `agreed:false`.
- Assert: no new ibrain row; live `helm-ibrain-*` not idled; cycle not `complete` / no freeze stamp; transport.reap observed before DB terminal states; no leaked running worker rows.

`integration_serial_min = 25`  
**Gate:** elite red-team on the three-file P0 surface (one panel, not per-slice thrash).

---

### BUILD wave 3 — pure P1 modules + independent file owners (3–4 seats)
| slice | exclusive write |
|---|---|
| **B1** | `src/services/plan-revision.ts` (**new**, pure) |
| **B3′** | `src/services/agreement-verdict-parse.ts` (**new**) — widen separators; `plan=<sha12>` field; **newest-line fail-closed** (absorbs B3+B4 pure logic) |
| **B5′** | `src/services/agreement-gate.ts` (**new**, pure) — Accept only if every seat CLEAN **and** planSha === currentSha |
| **B2** | `brief-writer-service.ts` — absolute canonical plan.md + og-requirements paths + expected SHA in panel brief |

(If only 3 seats: run B1∥B3′∥B2, then B5′ alone — still cheap.)

`build_parallel_min = max(15, 26, 28, 22) ≈ 28` at 4 seats; **~28+15 = 43** at 3 seats if B5′ queues.

**Note:** B3 and B4 from synthesis become **one pure module slice B3′** (still ≤28 min) so we do not double-pay two sequential pure-parser slices. B5′ is pure gate only — no `waitForAgreement` edit yet.

---

### BUILD wave 4 — more pure / file-isolated (parallel with leftover from wave 3)
| slice | exclusive write |
|---|---|
| **C1** | `real-transport.ts` — brief path includes seat/attempt/round id (no role collision) |
| **C10** | `plan-parser-service.ts` — normalize fully, then **one transaction** persist (sol graft) |
| **C9** | `brief-writer-service.ts` — PLAN-READY ≠ agreement; kill `plan agreed with deliberation` literals |
| **D6** | `discovery-handoff-ingress.ts` — snapshot NS + conversation-log bytes + SHA at readiness |

C9 does **not** remove the fail-fast (C8 does). Brief text can land early; engine grant stays sole.  
C10 is AC16 and does not depend on the round machine — only on not ingesting mid-gate (integration later).

`build_parallel_min = max(22,28,26,26) = 28` at 4 seats; **~28** at 3 seats (C1∥C10∥C9, D6 next tick +26 → wall **54** if strict 3-seat and no spill — schedule D6 into wave 5 if needed).

**Recommended 3-seat packing:** wave 4 = C1∥C10∥C9 (`28`); wave 4b = D6 (`26`) → +26.

---

### INTEGRATION wave I-P1 — fail-closed gate into the engine (serial)
**Wire** `plan-revision` + `agreement-verdict-parse` + `agreement-gate` into `waitForAgreement` / callback scan in `planning-phase-service.ts` (this is synthesis **B3–B6 wiring**, one owned integration slice — call it **B6-wire**).

Proof (token-free, fake callbacks + temp files):
1. Stale CLEAN@R1 + CLEAN@R2 current → **reject**
2. Newest malformed after older CLEAN → **reject** (fail-closed stale side)
3. Non-convergence returns typed blockedReason, no throw (B6 behaviour)
4. `grep -c planMdPathForRaceGuard …` still **3**; A0 tests still green

`integration_serial_min = 30` (single L3 seat; elite red-team)

**After I-P1 the system is safe-while-still-broken.** Stop condition for any half-ship.

---

### BUILD wave 5 — round machine file (serial **within file**, but isolated from other files)
All of these write **only** `src/services/planning-review-round.ts` (new).  
`planning-phase-service.ts` is **not** edited in this wave except maybe a temporary unused export — prefer zero host edits until I-P2.

| slice | what lands in `planning-review-round.ts` only |
|---|---|
| **C2** | Extract `runReviewRound` API (behaviour-preserving vs current single-shot collect); unit-tested with fake transport |
| **C3** | Artifact-publication gate before spawn (uses pure `artifact-publication` if extracted in wave 3/4) |
| **C4** | Integer `roundCap` loop + per-round deadline (delete wall-clock mult *semantics* here) |
| **C5** | Keystone: reap prior reviewers; spawn **FRESH** seats; round-scoped batch ids |
| **C6** | Revise actuator: fresh plancore revise turn; wait **new plan hash** before re-review |
| **C7** | Reviewer first-callback / submit watchdog (generalize from existing pure wait helpers if extracted) |
| **C8** | **LAST:** typed result; remove honest BROKEN fail-fast short-circuit in favour of round loop |

`build_parallel_min = sum = 28+24+26+28+28+28+24 = 186` — **honest serial** on one file.  
**Do not pretend C2–C8 parallelise.** That is the remaining serial spine of P2.

Optional 4th seat during this wave: **D2** (`index.ts` fail-closed guards), **D5** (`planning-provenance-service.ts` fatal pin API pure-ish), **D11** (adaptive refuse early at entry), **D12 skeleton** (test index that XFAIL/skip until modes exist) — **none write `planning-review-round.ts`**.

With 1 seat on C2–C8 and 2–3 seats on side D work:
- Side: D2(18)∥D11(18)∥D12-skel(15) then D5(26)∥… → side wall ~40–50
- Critical still **186** for round machine

---

### BUILD wave 5-side (concurrent with wave 5) — P3 file-isolated builds
| slice | exclusive write | may start once |
|---|---|---|
| **D2** | `src/index.ts` | I-P0 done (safe guards) |
| **D11** | `planning-phase-service.ts` **only if** wave 5 is not using it — **conflict**. So D11 lands either (a) as pure flag check in a **new** `adaptive-planning-gate.ts` + I-P2 wire, or (b) **after** I-P2. Prefer **(a)** pure refuse helper in wave 4/5-side. |
| **D12** | `planning-regression-index.test.ts` only | anytime after A0; fill assertions as modes land |
| **D5′ pure** | `planning-provenance-service.ts` API: bind to passed SHA (not re-read) | after B1 |
| **D3** | `app.js` | after D2 contract frozen (can start on written contract before D2 merges if contract doc locked) |

**D1, D4, D7–D10, D8** stay for later waves (file conflicts / need I-P2).

`build_parallel_min (side) ≈ max(18,18,25,26,22) ≈ 26–40` fully hidden under the 186.

---

### INTEGRATION wave I-P2 — round machine into host (serial, the expensive gate)
1. `planning-phase-service.ts` calls `planning-review-round` after plancore first-callback; partners no longer spawned at old `:498-562` site.
2. Preserve A5/A6 terminal owner; preserve A0 race-guard refs.
3. Wire C1 unique roles into spawn args.
4. Engine-only agreement → ingest via C10 transaction using accepted buffer/SHA (prep for D4).

Proof (token-free, fake transport):
- convene-before-artifacts (partners not spawned until published)
- BROKEN→revise→new hash→FRESH seats→CLEAN@newHash → Accept
- partner1 CLEAN + partner2 BROKEN → not Accept
- partner-2 silent → blockedReason names seat; unique brief paths on disk
- fail-fast removed only inside round loop (C8); no silent bare-CLEAN pass

`integration_serial_min = 35`  
Elite red-team mandatory.

---

### BUILD wave 6 — remaining P3 (file ownership, 3 seats)
| slice | exclusive write | deps |
|---|---|---|
| **D1** | `run-orchestrator-service.ts` — delete rediscovery interview branch | I-P2 |
| **D7** | `discovery-handoff-owner-bridge.ts` — confirm consumes frozen bytes | D6 + I-P1 |
| **D4** | `planning-phase-service.ts` — `PlanningResult` carries accepted buffer+SHA | I-P2 |
| **D3** | `app.js` — single entry UI | D2 |

`build_parallel_min = max(26,24,20,22) = 26`

---

### BUILD wave 7 — P3 finish (3 seats where possible)
| slice | exclusive write |
|---|---|
| **D8** | `run-orchestrator-service.ts` — never persist `executing` without driver |
| **D9** | `discovery-handoff-owner-bridge.ts` — pending→starting + run id **one** idempotent transaction |
| **D5** | `planning-provenance-service.ts` + call sites that only pass SHA (if call sites conflict with D4, do call-site pass in I-P3) |

D9 before D10 (same file). D8 after D1 (same file).

`build_parallel_min = max(26,24,26) = 26` for D8∥D9∥D5 if D5 call sites not in run-orch; else D5 after.

---

### BUILD wave 8 — terminal owner on handoff (serial on owner-bridge)
| slice | exclusive write |
|---|---|
| **D10** | `discovery-handoff-owner-bridge.ts` — background body `try/finally` transport-first terminal owner |

`build_parallel_min = 26`

---

### BUILD wave 9 — adaptive refuse wire + AC23 index completion
| slice | exclusive write |
|---|---|
| **D11** | wire pure adaptive refuse at `planning-phase-service.ts:338-344` |
| **D12** | complete `planning-regression-index.test.ts` — fail if any of 7 modes unrepresented |

`build_parallel_min = max(18,25) = 25` if D11/D12 no file clash (D12 test-only → parallel).

---

### INTEGRATION wave I-P3 — one entry + provenance + handoff (serial)
End-to-end token-free + optional `:3110` only for D3 UI claim:
- legacy Start Planning refuses when NS exists; NS bytes unchanged
- provenance pins **ingested** SHA; mismatch fatal both paths
- owner confirm freeze mismatch rejects
- autonomous handoff never leaves driverless `executing`
- starting handoff crash → no permanent wedge; workers reaped
- adaptive flag → refuse or shared gate
- D12 index all seven AC23 modes green

`integration_serial_min = 30`

---

### Critical path

```
A0(20)
 → max(A1→A4, A2→A3, A5→A6) = 54
 → I-P0(25)
 → max(B pure wave ~28–43)
 → I-P1(30)
 → C2…C8 serial on planning-review-round.ts (186)   [side P3 builds hide under this]
 → I-P2(35)
 → D1/D4/D7/D3 wave (26)
 → D8/D9/D5 wave (26)
 → D10 (26)
 → D11/D12 (25)
 → I-P3(30)
```

**Critical path sum (3–4 seats, C-core serial):**  
20 + 54 + 25 + 43 + 30 + 186 + 35 + 26 + 26 + 26 + 25 + 30  
≈ **526 min ≈ 8.8 h** estimate-wall  

vs synthesis serial **~870 min ≈ 14.5 h** estimate-wall  
≈ **40% wall reduction** without cutting scope; at project 2× pace: **~18 h** vs 24–30 h.

The irreducible serial core is **C2–C8 (~186 min est / ~6 h at 2×)** on one round-machine file. Everything else is made concurrent or pure.

---

### Wall-clock at concurrency

| seats | build_parallel wall (est) | integration_serial | total est wall | @2× pace |
|------:|--------------------------:|-------------------:|---------------:|---------:|
| **3** | ~441 (P0 76 + P1 43 + C 186 + D 103) | 25+30+35+30 = **120** | **~561 min ≈ 9.4 h** | **~19 h** |
| **4** | ~420 (extra seat hides D6/D2/D12 under C-core) | **120** | **~540 min ≈ 9.0 h** | **~18 h** |

**Split (use these numbers in scheduling)**  
- **total build_parallel_min ≈ 420–450** (effort still ~870, wall lower)  
- **total integration_serial_min = 120** (I-P0 + I-P1 + I-P2 + I-P3)

JROM target shape: **main time = unit tests on concurrent builds + four integration gates.** Met.

---

## PER-SLICE ISOLATED UNIT TEST

| slice | isolated unit test (no live run) | integration proof (deferrable) | extractable pure fn? |
|---|---|---|---|
| **A0** | Fixture callbacks + temp missing/present `plan.md`; assert BROKEN non-dispositive then dispositive; `planMdPathForRaceGuard` count == 3 via source grep test | Survives after every later PR (CI always) | yes — guard predicate already local |
| **A1** | Unit: helper `shouldAssertImplementationBrain(runPhase, taskCount)` false when never executed; orchestrator method with mock DB: blocked planning → assert **not** called | I-P0 full planning-block | yes — predicate extract |
| **A2** | Direct `finalizeBrainSessionRow` with no prior row → no INSERT; with existing non-terminal → terminalize; never `unknown/unknown` insert | I-P0 live session | yes — function is already a unit |
| **A3** | `assertRegistryIdle` / finalize path: runtime id points at run-owned session only; name collision with other run’s live ibrain **not** idled | I-P0 | partially — registry hook injectable |
| **A4** | Mock cycleService: planning-block transition → `setCyclePhase('complete')` **not** called; freeze not written | I-P0 retryable phase | yes — `shouldTerminalizeCycleOnRunEnd(kind, runPhase)` |
| **A5** | Fake transport recording order: `reap` timestamps before `finalizeWorkerRuntimeRow` | I-P0 + I-P2 multi-seat | order assertion with fakes |
| **A6** | Throw mid-planning → finally still reaps; success and blocked share same owner | I-P0, I-P2 | structure test + fakes |
| **B1** | Exhaustive sha fixtures (empty, unicode, large) | used by I-P1/I-P2 | **yes — pure** |
| **B2** | `generatePanelBrief` string contains absolute plan.md + og-requirements paths + sha token | live partner read path | pure string |
| **B3/B4 → B3′** | Table-driven lines: em-dash, en-dash, colon, mangled, missing sha; newest unparseable does not yield older CLEAN | I-P1 | **yes — pure parse** |
| **B5 → B5′** | Panel scenario A CLEAN@R1 / B CLEAN@R2 / current=R2 → Reject; all CLEAN@current → Accept | I-P1 | **yes — pure gate** |
| **B6** | `!agreed` path returns typed reason without throw when plan missing (host partial mock) | I-P1 | partially |
| **C1** | Two spawns same role family → two distinct brief file paths under temp runDir | I-P2 both partners verdict | path builder pure |
| **C2** | `runReviewRound` single-shot matches prior collect semantics under fake transport | I-P2 | seam module |
| **C3** | Pure publication check on temp dir matrix | I-P2 convene | **yes** |
| **C4** | Round counter exhausts at cap without sleeping cap×timeout | I-P2 | pure loop policy |
| **C5** | After round boundary, new batch ids; reap called for prior handles; new spawn count | I-P2 keystone e2e | fake transport |
| **C6** | On BROKEN aggregate, revise spawn once; gate waits until sha changes before spawn reviewers | I-P2 BROKEN→CLEAN | fake + temp files |
| **C7** | No first callback → retry/resubmit invoked; blockedReason contains batchId | I-P2 partner-2 silent | fake inspect/resubmit |
| **C8** | BROKEN no longer instant global false outside round result type; round loop owns disposition | I-P2; must not ship alone | typed result pure-ish |
| **C9** | Brief fixtures: no “plan agreed with deliberation”; PLAN-READY = artifacts only | attended run signal | pure string |
| **C10** | Mid-ingest forced DB error → zero tasks/queue rows | I-P2 success ingest | transaction test |
| **D1** | With NS present, interview branch not entered (spy spawn discovery = 0) | I-P3 | branch predicate |
| **D2** | Guards return fail-closed errors on missing handoff / active run (invoke handlers with mocks) | I-P3 | yes |
| **D3** | Static/string tests: no “interview + planning” rerun copy for cycles with docs; optional node parse of action map | `:3110` screenshot only if claimed | limited without browser |
| **D4** | `PlanningResult` type/shape carries buffer+sha from fake Accept | I-P3 provenance | DTO |
| **D5** | record with passed sha; file mutated after → assert fatal; no non-fatal swallow | I-P3 | mostly pure + temp fs |
| **D6** | readiness stores exact bytes+sha in temp DB | I-P3 | yes |
| **D7** | confirm with drifted file → reject | I-P3 | yes |
| **D8** | autonomous confirmed path never leaves `executing` without driver flag/loop install | I-P3 | state machine assert |
| **D9** | crash between CAS and link simulated → no permanent starting without run id / reclaim path | I-P3 | transaction test |
| **D10** | throw after spawn → finally reaps; handoff failed consistently | I-P3 | fake transport |
| **D11** | `adaptive_planning=1` → refuse before spawn (or shared gate mock) | I-P3 | pure refuse helper |
| **D12** | Index imports/requires the seven named tests; fails if any missing | always-on CI | meta-test |

---

## SLICES THAT CANNOT BE UNIT-TESTED IN ISOLATION (and why)

| item | why | what to do instead |
|---|---|---|
| **Full multi-seat CLI re-engage** | There is no `transport.send`; real partner re-prompt is impossible by design | Never test re-prompt. Test **fresh spawn** (C5) with fake transport only. |
| **D3 visual layout on :3110** | Needs browser + live app | Isolated: string/action presence in `app.js`. Integration: playwright.cap on :3110 only if UI is claimed. |
| **True model token paths** | Burn tokens; forbidden for AC23 | Always fake transport + fixture callbacks. |
| **C8 “safe in production” alone** | Removing fail-fast without C3–C7 is the 04:00 failure mode | Unit-test typed result; **integration ban**: C8 not mergeable until C3–C7 unit green + I-P2. |
| **E5 janitor actually reaping** | Janitor stays **0**; do not enable to prove AC3 | Prove **no idle mark** (A3) with registry assert; never end-to-end reap. |

Everything else in the 35 has a credible fake-transport / temp-DB / pure-function unit test. If a slice “needs the world,” the plan is wrong — extract a pure fn (B1 pattern).

---

## WHERE PARALLELISM IS UNSAFE (and why serial wins)

1. **C2→C3→C4→C5→C6→C7→C8 on the round-machine file** — one semantic state machine; parallel edits = merge conflict + fail-open half-states. **Serial only.** C8 last.
2. **A2 then A3** on `worker-runtime-finalize.ts` — A3 assumes update-only finalize; parallel risks reintroducing register-if-missing.
3. **A1 then A4** on `run-orchestrator-service.ts` — both touch blocked/terminal paths; easy to double-call or skip cycle policy wrong.
4. **A5 then A6** on planning terminal owner — A6 owns A5’s cleanup; parallel reverts order bugs.
5. **I-P1 before any C-core that grants ingest on multi-round CLEAN** — fail-open gate + convergence = silent bad plan (lesson 04:00).
6. **D9 then D10** on owner-bridge — transaction then try/finally; reverse order leaves wedge paths.
7. **Two seats on `app.js`** — never. 560 KB hand-written, silent blank page on bad merge. D3 alone.
8. **Two seats on `planning-phase-service.ts` after I-P2 starts** — thin host only; still one owner per wave.
9. **Enabling HELM_SESSION_JANITOR to “test” A3** — forbidden; false confidence / real reaps.

**Safe parallelism summary:** P0 three tracks; all pure modules; C1/C9/C10/D2/D6/D5 API/D12 beside C-core; never parallelise the round-machine chain or same-file P0 pairs.

---

## ANY SLICE I WOULD ADD, SPLIT, MERGE OR DROP

| action | detail |
|---|---|
| **ADD** | `agreement-verdict-parse.ts` (B3+B4 pure) |
| **ADD** | `agreement-gate.ts` (B5 pure) |
| **ADD** | `artifact-publication.ts` (C3 pure) |
| **ADD** | `planning-review-round.ts` host of C2–C8 (critical for parallel side work) |
| **ADD** | Named integration slices **I-P0, I-P1, I-P2, I-P3** with explicit proofs (not hidden inside last feature slice) |
| **MERGE** | B3+B4 → one pure parse module slice (still ≤28 min; avoids pure-serial tax) |
| **SPLIT** | Synthesis “B3–B6” into **pure build** + **B6-wire integration** (I-P1) |
| **SPLIT** | C2: do **not** only extract a method inside `planning-phase-service.ts` — extract to **new file** or the serial god-file remains |
| **RELAX deps** | A5 no longer depends on A4; A1/A2/A5 start together after A0 |
| **RELAX deps** | C9, C10, C1, D6 may start before C8 (not before I-P1 for anything that **ingests** or **declares agreement**) |
| **REORDER soft** | C9 (brief agreement language) may ship in BUILD wave 4; does not remove fail-fast |
| **KEEP** | A0 first; C8 last of P2 core; P1 gate pure+I-P1 before I-P2 |
| **DROP** | Nothing of product scope. Drop only the **false deps** that serialise unrelated files |
| **DO NOT DROP** | D12 index — anti-recurrence enforcer; can start as skeleton early |
| **ESTIMATE note** | Plan header “870 min” vs brief “859” — immaterial; wall is the metric. After restructure **~9 h est wall / ~18 h @2×** |

### What I would tell projcore in one paragraph

Execute **build waves 0–2 + I-P0** first (P0 safe). Then pure P1 modules + **I-P1** (fail-closed). Then **only one seat** owns `planning-review-round.ts` through C8 while other seats farm C1/C9/C10/D2/D6/D12. Then **I-P2**, then P3 file waves + **I-P3**. Never open a second editor on the round-machine file. Never ship C8 without C3–C7 green. Never parallelise A2/A3 or A5/A6.

---

## Numbers recap (for synthesis)

| metric | synthesis plan.md | this rereview |
|---|---|---|
| Scope / ACs | 35 slices, 23/23 | same behaviours + pure seams |
| Dep shape | ~serial single-parent | file-ownership waves + 4 integration gates |
| Est effort | ~870 min | ~870 min (effort ≠ wall) |
| Est wall @3–4 seats | ~14.5 h | **~9–9.5 h** |
| @2× historical | 24–30 h | **~18–19 h** |
| Integration serial | folded into every slice | **120 min** explicit |
| Dominant serial block | entire chain | **C2–C8 only (~186 min est)** |

---

REREVIEW-DONE grok45
