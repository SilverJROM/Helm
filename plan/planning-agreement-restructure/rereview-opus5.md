# rereview-opus5 — isolate-then-integrate, parallelised

**Seat:** `opus5` (claude-opus-5, xhigh) · **Re-reviewing:** `plan/planning-agreement-restructure/plan.md`
(35 slices, 870 min) · **Base:** `0a0c883`, `src/` clean · **Authored:** 2026-07-29 PHT
Worked alone; did not read the other seats' re-reviews.

---

## VERDICT on the synthesis

**ADOPT-WITH-CHANGES.**

The synthesis is right on everything that is hard: mechanism precision, the P0→P1→P2→P3 law, C8 last of
the round core, A0 first. All 23 ACs map. I found **one coverage gap** (below) and **no wrong slices**.

It is wrong on exactly one thing, and it is the thing this re-review is about: **it encodes runtime
sequence as authoring dependency.** 34 of 35 slices have a single parent because the terminal *executes*
A1→A6 in that order at runtime — but A1/A4 live in `run-orchestrator-service.ts`, A2/A3 in
`worker-runtime-finalize.ts`, and A5/A6 in `planning-phase-service.ts`. **Three different files, written
by three different seats, at the same time.** The chain is an artifact of how the plan was narrated, not
a constraint the code imposes.

**One correction to the brief's own numbers, because the whole wave plan turns on it.** The brief's table
says `planning-phase-service.ts` is touched by **5** slices. By my count it is **16 of 35**: A5, A6, B3,
B4, B5, B6, C1, C2, C3, C4, C5, C6, C7, C8, D4, D11. The table appears to count only slices whose
*primary named file* it is; every C-series slice edits it too. That is the real critical path — not the
dep graph, **the file**. Reordering deps cannot fix it. Only taking logic *out of the file* can.

So my recommendation is structural: **extract six pure modules first, in one fully-parallel pre-wave.**
Each is a new file (zero write conflict by construction), each is exhaustively unit-testable with string
and object fixtures and zero I/O, and each converts a same-file *logic* slice into a same-file *wiring*
slice of 12-26 minutes. That is `B1`'s pattern — the brief already names it the model — applied to the
other five decision surfaces instead of just plan hashing.

**Honest cost:** total effort rises from 870 to ~1066 min (**+~20%**) because extraction adds module
scaffolding and integration becomes explicit rather than smeared across slices. JROM's framing was
"total effort does not change" — it does, upward, and that is the price of the shape he asked for.
Wall-clock falls from 870 serial to **~330 min at 4 seats**. That trade is worth taking.

**Second correction the brief's table misses: test files collide too.** Four existing test files are
shared write targets — `planning-phase-service.test.ts` (973 L), `a15-worker-finalize.test.ts` (661 L),
`b9-gate-atomic.capstone.test.ts` (223 L), `cycle-terminal-on-run-complete.test.ts` (220 L). Two slices
in one wave both editing `planning-phase-service.test.ts` conflict exactly as badly as both editing the
service. File ownership below covers tests as first-class owned files. This is another argument for
new-file pure modules: they bring their own new test files.

---

## WAVE PLAN — build waves and integration waves kept SEPARATE

I express BUILD as **streams** rather than lockstep waves. A stream is a sequence of slices over one
owned file-set, run by one seat; streams run concurrently. This fits the codebase better than waves
because the constraint is file ownership, not readiness — and same-file slices assigned to the **same
seat in sequence** never conflict, which lockstep waves cannot express.

### BUILD wave 0 — PURE (all new files, zero conflict, maximally parallel)

Every slice here creates a **new module + its own new test file**. Nothing in wave 0 writes an existing
file. Any seat can take any of these; they can all run at once.

| slice | owns (new files) | absorbs | min |
|---|---|---|---|
| **A0** | `src/planning-race-guard.regression.test.ts` | A0 (unchanged) | 20 |
| **T1-p** | `src/services/planning-terminal-policy.ts` + `.test.ts` | decision logic of A1, A4, ADD-1 | 20 |
| **T2-p** | `src/services/registry-idle-policy.ts` + `.test.ts` | decision logic of A3 | 12 |
| **B1** | `src/services/plan-revision.ts` + `.test.ts` | B1 (unchanged) | 15 |
| **V1-p** | `src/services/agreement-verdict.ts` + `.test.ts` | grammar + newest-per-seat scan + gate predicate of B3, B4, B5 | 28 |
| **R1-p** | `src/services/planning-round-policy.ts` + `.test.ts` | round FSM decision of C4, C5, C8 | 24 |
| **S1-p** | `src/services/planning-seat-identity.ts` + `.test.ts` | naming half of C1, C5 | 12 |
| **P1-p** | `src/services/planning-artifact-readiness.ts` + `.test.ts` | predicate half of C3 | 12 |

`build_parallel_min` **= 143** · wall-clock at 4 seats ≈ **40 min**.

**A0 is the gate on everything else.** It is 20 min and it stands between a seat and silently deleting
`8024452`. No PPS-stream slice may start until A0 has landed.

### BUILD streams 1-N — concurrent, each owning a disjoint file-set

| stream | files owned EXCLUSIVELY (src + tests) | slices in order | min |
|---|---|---|---|
| **PPS** ← critical path | `planning-phase-service.ts`, `planning-phase-service.test.ts`, `b9-gate-atomic.capstone.test.ts` | A5 28 · A6 26 · **B-wire** 26 · B6 18 · C1-w 14 · C2 28 · C3-w 14 · **R-wire-a** 28 · **R-wire-b** 28 · **R-wire-c** 22 · C7 28 · D4 12 · D11 12 | **284** |
| **RO** | `run-orchestrator-service.ts`, `cycle-terminal-on-run-complete.test.ts` | A1 26 · A4 28 · **ADD-1** 25 · D1 26 · D5-ro 12 | 117 |
| **WRF** | `worker-runtime-finalize.ts`, `a15-worker-finalize.test.ts` | A2 24 · A3-w 12 | 36 |
| **BRIEF** | `brief-writer-service.ts` + its tests | B2 22 · C9 26 · C6-brief 20 | 68 |
| **TRANSPORT** | `real-transport.ts`, `fake-transport.ts` | C1-t 14 | 14 |
| **INGEST** | `plan-parser-service.ts` + test | C10 28 | 28 |
| **PROV** | `planning-provenance-service.ts` | D5-prov 20 | 20 |
| **HANDOFF** | `discovery-handoff-ingress.ts`, `discovery-handoff-owner-bridge.ts`, `db/database.ts`, `db/schema.ts` | D6 26 · D7 24 · D9 24 · D10 26 · D8 26 | 126 |
| **API/UI** | `src/index.ts`, `src/public/app.js` | D2 18 · D3 22 | 40 |
| **SWEEP** | new test file | D12 25 | 25 |

`build_parallel_min` **= 758**.

**Cross-stream ordering laws (the only ones that exist):**
- `A0` → every PPS slice.
- `C1-t` (TRANSPORT) → `C1-w` (PPS). 14 min gating a slice at t≈+112 — never binds.
- `B1`, `V1-p` (wave 0) → `B-wire` (PPS).
- `R1-p`, `S1-p`, `P1-p` (wave 0) → `C3-w`, `R-wire-a/b/c` (PPS).
- `C6-brief` (BRIEF, lands t≈+68) → `R-wire-b` (PPS, starts t≈+182). Never binds.
- `A6` (PPS, t≈+54) → `D10` (HANDOFF, t≈+100). Never binds.
- **`B5`/`B-wire` → `R-wire-c` (C8).** The one law that must never be relaxed for speed.

Note what is **not** a law: `A1→A2→A3→A4→A5→A6` as authored. `{A1,A4,ADD-1}`, `{A2,A3-w}` and `{A5,A6}`
are three independent chains on three files. The synthesis's 152-min serial P0 becomes 117 / 36 / 54 min
in parallel — **~98 min off the critical path from this one observation.**

### INTEGRATION waves — explicit, named, serial, few

| wave | what is wired | end-to-end proof (token-free unless noted) | min |
|---|---|---|---|
| **I1** | P0 terminal path: RO + WRF + PPS-A5/A6 + ADD-1 | One failed-planning run on a temp DB + FakeTransport asserting **all five P0 invariants at once**: ibrain row count unchanged · no `unknown` runtime · live `helm-ibrain-<slug>` still `active` · `cycles.phase` still `planning` and zero `cycle_topology_freezes` · every seat handle reaped before its row went terminal · handoff `failed` and re-confirmable. | 30 |
| **I2** | Fail-closed gate: PPS B-wire/B6 + BRIEF B2 + B1 | Real `generatePanelBrief` output → seats emit `plan=<sha12>` → the panel's exact stale-CLEAN scenario **refuses**; non-convergence **returns** a typed reason and does not throw. | 30 |
| **I3** | **The keystone.** Round machine: PPS C1-w…R-wire-c + C7 + BRIEF C6-brief/C9 | `BROKEN → revise → CLEAN` converges token-free with **fresh seats each round**; FakeTransport shows round-1 handles reaped before round-2 spawns; `roundCap=3` produces **three rounds**, not 30 minutes; a mute partner is named in `blockedReason`; `grep -c planMdPathForRaceGuard == 3`. | 40 |
| **I4** | One entry + provenance + handoff: RO D1 · API/UI D2/D3 · HANDOFF · PROV | Legacy Start Planning refuses when north-star exists (zero discovery spawns); provenance pins the ingested bytes fatally; no `executing` run without a driver. **Contains the effort's only non-token-free proof:** `node --check` + `npm run build` + Playwright on **:3110 via `playwright.cap.config.ts`**. | 40 |
| **I5** | Everything: D11 · C10 · D12 sweep | `planning-regression-index.test.ts` green — all seven historical failures pinned — plus a file-by-file suite pass. | 25 |

`integration_serial_min` **= 165**.

### Critical path

```
A0 (20)
  └─► PPS stream (284, strictly serial, one seat)
        A5 → A6 → B-wire → B6 → C1-w → C2 → C3-w → R-wire-a → R-wire-b → R-wire-c → C7 → D4 → D11
              └─► I5 (25)   [I1/I2/I3/I4 all absorb into other seats' idle time]
```

**Critical path = A0 + PPS + I5 = 329 min ≈ 5h29m.**

### Wall-clock

Seat packing at 4 (each seat's total ≤ the critical path):

| seat | assignment | min |
|---|---|---|
| 1 | *(waits 20 for A0)* → **PPS 284** | 304 |
| 2 | V1-p · R1-p · B1 · S1-p · P1-p (91) → BRIEF 68 → INGEST 28 → PROV 20 → I2 30 → I3 40 | 277 |
| 3 | **A0 20** → T1-p · T2-p (32) → TRANSPORT 14 → RO 117 → I1 30 → I4 40 | 253 |
| 4 | WRF 36 → HANDOFF 126 → API/UI 40 → SWEEP 25 | 227 |

**Wall-clock at 4 seats ≈ 329 min ≈ 5h30m.**
**Wall-clock at 3 seats ≈ 355-380 min ≈ 6h00m-6h20m** (bounded below by both the 329 critical path and
1066/3 = 355 of total work; the extra streams pack into seats 2-3 with little slack).

**Applying this project's historical ~2× multiplier, which the brief rightly insists on:
~11h at 4 seats · ~12-13h at 3 seats — against 24-30h for the serial synthesis.**

### Split

```
total build_parallel_min      = 901   (wave 0: 143  +  streams: 758)
total integration_serial_min  = 165   (I1 30 · I2 30 · I3 40 · I4 40 · I5 25)
total effort                  = 1066  (vs synthesis 870 — +~20%, paid for the shape)
wall-clock @4 seats           = 329   (vs 870 serial — 2.6× faster)
```

Where the remaining serial time actually goes: **284 of the 329 minutes are the PPS stream.** Not
integration — integration is only 25 min of the critical path (I5), because I1-I4 fit into other seats'
idle windows. **If you want this faster, the only lever is shrinking `planning-phase-service.ts`'s
stream further.** Everything else is already free.

---

## PER-SLICE ISOLATED UNIT TEST

Keyed by **synthesis id** so this maps back cleanly. "Isolated" = no live run, no real seat, no `:3110`;
FakeTransport, a temp DB and a temp dir are all permitted (the repo's established harness —
`planning-phase-service.test.ts:1` sets `USE_FAKE_TMUX=1`).

| slice | isolated unit test (no live run) | integration proof (deferrable) | extractable pure fn? |
|---|---|---|---|
| A0 | Synthetic `callbacks.md`: BROKEN with `plan.md` absent → non-dispositive; same BROKEN with `plan.md` present → dispositive. Plus two **source** assertions: `grep -c planMdPathForRaceGuard == 3` **and** the partner-brief wait-text at `planning-phase-service.ts:523-531` still present. | — (it *is* the net) | n/a — test-only |
| A1 | Pure `terminalDecision({phaseAtEntry:'planning',taskCount:0,agreed:false})` → `assertIbrain:false`. Wiring: temp DB, `worker_runtimes` ibrain count unchanged across a planning block. | I1 | **yes → `planning-terminal-policy.ts`** |
| A2 | `finalizeBrainSessionRow` on a temp DB with no matching row → returns `false`, zero INSERT, no `unknown/unknown` row. Harness exists: `a15-worker-finalize.test.ts`. | I1 | no (DB-shaped; temp DB suffices) |
| A3 | Pure `shouldAssertRegistryIdle({wrRunId:31, sessionRunId:null})` → false; `({31,31})` → true. Wiring: live `helm-ibrain-memory_mcp` (run_id NULL) stays `active` after a run-31 finalize. | I1 | **yes → `registry-idle-policy.ts`** |
| A4 | Pure `terminalDecision(...)` → `terminalizeCycle:false`. Wiring: failed-planning run leaves `cycles.phase='planning'`, zero `cycle_topology_freezes`. **Must invert assertion (b) at `cycle-terminal-on-run-complete.test.ts:22`** — it currently asserts the exact behaviour A4 removes. | I1 | yes (same module as A1) |
| ADD-1 | Temp DB: handoff `starting`, run not-agreed → handoff `failed`; a second confirm returns a **new** run id, not the dead one. | I1 | partly (`terminalDecision.failHandoff`) |
| A5 | `FakeTransport.reapCalls` contains every seat handle, and each reap timestamp **precedes** that row's `worker_runtimes.ended_at`. | I1 | no (ordering of side effects) |
| A6 | Force a throw between spawn and gate → the `finally` still reaped every handle and finalized every row. One test **per exit**: success · not-agreed · thrown. | I1 | no — see §"cannot be isolated" |
| B1 | Pure: known bytes → known sha; empty → null; absent → null; CRLF ≠ LF. | — | **already pure** |
| B2 | Pure render assertion: output contains the **absolute** `plan.md` and `og-requirements.md` paths and the `plan=<sha12>` token; contains **neither** `plan.json` as the plan path **nor** `/home/agjrom/TGBOTS/Helm` (`brief-writer-service.ts:444`, `:451`). | I2 | **yes — already a pure renderer** |
| B3 | Pure grammar table: {em-dash, en-dash, hyphen, colon} × {CLEAN, BROKEN, garbage} × {with `plan=`, without}. | I2 | **yes → `agreement-verdict.ts`** |
| B4 | Pure: seat whose **newest** line is unparseable and whose older line is CLEAN → `UNKNOWN`, never CLEAN. | I2 | yes (same module) |
| B5 | Pure `evaluateAgreement`: A CLEAN@sha1 + B CLEAN@sha2, current=sha2 → **not agreed**; both @sha2 → agreed; CLEAN with no sha → not agreed. | I2 | yes (same module) |
| B6 | Not-agreed + absent `plan.md` → resolves `{agreed:false, blockedReason}`, does **not** throw; both seat rows terminal; fence advanced. | I2 | no (control-flow order) |
| C1 | Pure `seatIdentity({batchId,seatIndex,round})` → distinct triple. Wiring: two partner spawns leave two **different** brief files on disk (today byte-identical on runs 31 and 32). | I3 | **yes → `planning-seat-identity.ts`** |
| C2 | **No new unit test — deliberately.** Proof is negative: `planning-phase-service.test.ts` (973 L) and `b9-gate-atomic.capstone.test.ts` pass **unmodified**. Any test edit means the refactor was not behaviour-preserving. | — | n/a — see §"cannot be isolated" |
| C3 | Pure `artifactsPublishable(planBytes, reqBytes)` → `{ok, missing[]}`, including a `plan.md` that exists but fails `validateExecutionPlan`. Wiring: zero partner spawns recorded until both files land. | I3 | **yes → `planning-artifact-readiness.ts`** |
| C4 | Pure `nextRoundAction({round:3,cap:3,BROKEN})` → `BLOCK`; `({1,3,BROKEN})` → `REQUEST_REVISE`. | I3 | **yes → `planning-round-policy.ts`** |
| C5 | Pure: round-2 seat ids ≠ round-1 seat ids. Wiring: FakeTransport shows N×rounds spawns, round-1 handles reaped **before** round-2 spawns. | I3 | yes (seat-identity + round-policy) |
| C6 | FakeTransport + temp dir: on BROKEN a plancore spawn is recorded whose brief carries that round's verdict notes; engine blocks until `plan.md` sha changes; unchanged sha in-window → `BLOCK` with a named reason. | I3 | partly (`planShaChanged` predicate is pure) |
| C7 | Monkey-patch `(transport as any).resubmitIfComposerHeld` — **established pattern**, `orchestrator-loop-idle-hang.test.ts:284`, so no `fake-transport.ts` write is needed. Assert a mute partner triggers respawn and `blockedReason` names the specific `partnerBatchId`. | I3 | no (seam, but fully fakeable) |
| C8 | Pure: `nextRoundAction` never returns `BLOCK` on BROKEN while `round < cap`. Wiring: a round-1 BROKEN advances instead of returning false. **Re-run A0's two assertions inside this slice.** | I3 | yes (round-policy) |
| C9 | Pure render: planning brief contains **no** `plan agreed with`, **no** `STOP COMPLETELY`, and states PLAN-READY = artifacts-written-awaiting-verdict (`brief-writer-service.ts:340`, `:345`, `:347`). | I3 | **yes — pure renderer** |
| C10 | Temp DB: inject an enqueue failure mid-ingest → **zero** `run_tasks` and no artifact row; success path unchanged. | I5 | no (transaction semantics) |
| D1 | Temp cycle dir with non-empty `north-star.md` → typed `REDISCOVERY_REFUSED` and `FakeTransport.spawnCalls` contains **zero** discovery spawns. | I4 | no (branch guard) |
| D2 | Stub a throwing handoff store → route returns 503, not 200 (`src/index.ts:2917-2929`). | I4 | no |
| D3 | **NONE.** Cannot be unit-tested in isolation — see below. | I4 only: `node --check` → `npm run build` → Playwright on **:3110 via `playwright.cap.config.ts`** | no |
| D4 | `PlanningResult.planSha256` === sha256 of the exact string handed to `ingestExecutionPlan` (spy the parser). | I4 | no (consumes B1) |
| D5 | Temp DB: a provenance write failure **blocks** the run rather than warning; a sha mismatch is fatal. | I4 | no |
| D6 | Temp dir + temp DB: readiness stores `docs_digest` over both files; mutate a file afterwards → stored digest unchanged (it is frozen). | I4 | partly (`docsDigest(nsBytes, logBytes)` pure) |
| D7 | Confirm with a mutated north-star → typed refusal; planning read with a mutated file → typed refusal. | I4 | yes (same digest fn) |
| D8 | No `runs.phase='executing'` persisted unless an **injected loop factory** was called. **Requires the slice to inject that factory** — see below. | I4 | no |
| D9 | Throw from a stubbed `createRun` between CAS and link → handoff reclaimable, not permanently `starting`. | I4 | no |
| D10 | Throw inside the detached body → handoff failed **and** run blocked **and** workers reaped **and** cycle untouched **and** notification sent — i.e. it went through A6's terminal owner. | I4 | no |
| D11 | `runPlanningPhase({adaptivePlanning:true})` throws `ADAPTIVE_PLANNING_REFUSED` with `FakeTransport.spawnCalls` **empty**. | I5 | no (trivial guard) |
| D12 | The index test itself. | I5 | n/a — test-only |

---

## SLICES THAT CANNOT BE UNIT-TESTED IN ISOLATION (and why)

**1. D3 (`app.js` UI) — genuinely untestable in isolation. Only slice in the effort with no unit test.**
`src/public/app.js` is 560 KB of hand-written browser ESM with **no build step**, and `vitest.config.ts:10`
scopes the suite to `src/**/*.test.ts` — TypeScript only. There is no JS test harness for it and adding
one is a separate effort. Its only honest proofs are `node --check`, `npm run build` (the tree ships two
copies), and a Playwright run on **:3110 via `playwright.cap.config.ts`**. I did not invent a unit test
for it. Schedule it in I4 and accept that it lands on an integration proof.

**2. C2 (the `runReviewRound` refactor) — no new behaviour, so no new unit test.**
Its correctness claim is *"nothing changed"*, which a new test cannot express. The proof is negative and
stronger than a new test: `planning-phase-service.test.ts` (973 L) and `b9-gate-atomic.capstone.test.ts`
(223 L) must pass **with zero edits**. Make "no test file was modified in this slice" part of acceptance —
if the refactor needs a test edit, it was not behaviour-preserving and must be redone.

**3. A6 (single terminal owner) — testable per-exit, not exhaustively.**
The *ordering* claim is isolated-provable (FakeTransport `reapCalls` vs `worker_runtimes.ended_at`, with
a forced throw). The *coverage* claim — "**no** exit path bypasses the finally" — is a property over all
exits, and a 4th exit added by a later slice escapes silently. Recommend the slice write one test per
exit (success · not-agreed · thrown) **and** add a comment-anchored enumeration the reviewer checks. Do
not claim exhaustiveness the test does not deliver.

**4. D8 (`executing` without a driver) — needs a seam the slice must create.**
`OrchestratorLoop` is constructed inline at `run-orchestrator-service.ts:1711`, so the honest isolated
assertion "a driver was installed" is impossible today; the fallback assertion "phase is not `executing`"
is weaker than AC20 actually requires. **Recommend D8 additionally inject a loop factory** so the test can
assert it was called. That is ~8 extra minutes and turns a proxy assertion into the real one.

---

## WHERE PARALLELISM IS UNSAFE (and why serial wins)

1. **The PPS stream — keep all 13 slices on ONE seat, strictly serial.** Do not split it by region.
   `waitForAgreement` alone is edited by B-wire, R-wire-a/b/c and C8; these are **overlapping**, not
   adjacent, edits to the same ~50 lines. Two seats "owning different functions" in this file will
   produce a merge that type-checks and is semantically wrong — the worst possible failure on a gate.

2. **C8 / R-wire-c stays last of the round core. Non-negotiable, no exceptions for an idle seat.**
   It removes the honest fail-fast. Before C3-C7 exist, that is precisely the 04:00 PHT mistake, and it
   is *worse* than the original bug because once convergence works the failure is **silent** — a green
   gate on a plan one seat reviewed. If a scheduler ever wants to pull it forward to fill a seat, the
   answer is no; give that seat a HANDOFF slice instead.

3. **A2 ∥ A3 — do not.** They are semantically independent and 100 lines apart in
   `worker-runtime-finalize.ts`, which makes "just let both seats edit it" tempting. It saves 12 minutes
   and risks the E5-class session path. I already cut A3's wiring to 12 min by extracting its policy;
   run them back-to-back on the WRF seat.

4. **D7 / D9 / D10 — serial, one seat, in that order.** All three rewrite overlapping control flow in
   `discovery-handoff-owner-bridge.ts` (472 L), and D10 wraps the whole body in a `try/finally` that
   D9's transaction must sit *inside*. Authored concurrently, they produce a nesting that is wrong in a
   way tests will not catch.

5. **A0 blocks the PPS stream absolutely.** 20 minutes gating 284. It is the only mechanical thing
   standing between a seat and quietly deleting `8024452`, which is proven on run 32 and which
   `git` will merge away without complaint.

6. **The four shared test files are owned, not shared.** `planning-phase-service.test.ts` → PPS stream.
   `a15-worker-finalize.test.ts` → WRF. `cycle-terminal-on-run-complete.test.ts` → RO.
   `b9-gate-atomic.capstone.test.ts` → PPS. No other stream may write them.

---

## ANY SLICE I WOULD ADD, SPLIT, MERGE OR DROP

### ADD — 1 slice (a real coverage gap, not a preference)

**ADD-1 · Handoff must not be marked `started` by a planning run that never agreed.** *(AC4, AC21 · 25 min · RO stream)*
AC4 requires *"a failed planning cycle lands in a retryable state with no manual SQL."* A4 fixes only the
cycle half. The handoff half is untouched: `run-orchestrator-service.ts:985-989` CASes `starting→started`
**before** the `agreed` check at `:991-998`, so a dead run keeps a `planning_run_id`, and
`discovery-handoff-owner-bridge.ts:194-207` then returns that dead run to every future confirm, forever.
**As synthesized, AC4 fails its own acceptance criterion.** Fix: move the CAS below the branch; on
`notAgreed` call `handoffs.fail(id, blockedReason, 'starting')` — the method already exists at `:354`.

### SPLIT — 4

**SPLIT-1 · Extract six pure modules into wave 0** (T1-p, T2-p, V1-p, R1-p, S1-p, P1-p, joining B1).
This is the whole re-review in one move: it converts 16 same-file logic slices into 13 same-file wiring
slices averaging 21 min, and it is what makes REQUIREMENT 1 achievable rather than aspirational. Every
extracted module is a pure function over strings/objects — the deepest defects in this effort (verdict
grammar, stale-CLEAN detection, round arithmetic, terminal policy) become exhaustively table-testable
with zero I/O.

**SPLIT-2 · C1 → C1-t + C1-w.** `C1` writes `real-transport.ts`, `fake-transport.ts` **and**
`planning-phase-service.ts`. Split at the interface: `C1-t` adds `briefFileName` to `ITransport`
(`fake-transport.ts:5-24`) + both implementations (14 min, TRANSPORT stream, wave 0-adjacent); `C1-w`
passes it from the planning call site (14 min, PPS stream).

**SPLIT-3 · D5 → D5-prov + D5-ro.** Provenance-service change vs orchestrator call sites are different
files in different streams; as one slice it forces PROV and RO to serialise for no reason.

**SPLIT-4 · D8 gains a loop-factory seam** (+8 min) so its unit test can assert the real AC instead of a
proxy. See §"cannot be isolated" item 4.

### MERGE — 2

**MERGE-1 · B3 + B4 + B5 wiring → one `B-wire` (26 min).** Once `agreement-verdict.ts` is pure and
tested, the PPS edit is a single replacement of the inline block at `planning-phase-service.ts:1000-1041`.
Visiting the same 40 lines three times is pure overhead and three merge risks. Saves ~20 min and two
context reloads. **The three *unit-test* concerns stay separate** — they live in the pure module's test
file, which is where they belong.

**MERGE-2 · C4 + C5 → `R-wire-a` (28 min).** The round loop and fresh-seat spawning are one edit to
`runReviewRound`'s caller. Splitting them means deliberately writing a loop that re-spawns **stale**
seats and then immediately rewriting it — a 20-minute detour through the exact bug C5 exists to prevent.

### DROP — none

All 35 synthesis slices survive. I reorganise; I remove nothing.

### RECLASSIFY — 1 (small, but it protects the one thing that works)

**C3's wording invites deleting half of `8024452`.** The synthesis describes it as *"removes the convene
race structurally rather than by brief."* The brief-side wait-text at `planning-phase-service.ts:523-531`
**is** the proven fix from run 32, and `grep -c planMdPathForRaceGuard == 3` does **not** cover it — the
guard variable and the brief text are separate artifacts of the same commit. A reasonable implementer
reading "rather than by brief" will delete the text as now-redundant, and the grep will still pass.
**Recommend:** reword C3 to *"adds an engine-side precondition **in addition to** the proven brief-side
wait"*, and add the brief-text presence assertion to A0 (already reflected in the A0 row above). Cheap,
and it closes the only path I can see by which this effort silently regresses the one thing that works.

---

REREVIEW-DONE opus5
