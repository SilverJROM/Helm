# Re-review — sol seat

## VERDICT on the synthesis

**ADOPT WITH CHANGES.**

The synthesis has the right scope, mechanisms, safety ordering, fresh-seat keystone, and tiering. It
should not execute with its current dependency graph: 34 single-parent links serialize work that is
independent at the policy/module level. Recast each slice as an isolated build plus a deferred
integration proof, and replace incidental same-phase dependencies with the waves below.

Two corrections are required before dispatch:

1. The table rows sum to **859 minutes**, not the footer's 870.
2. B2 may pass absolute canonical paths in P1, but it cannot require an engine-known “expected SHA”
   before C3 moves reviewer dispatch behind artifact publication. In P1, the reviewer computes and
   emits the SHA and B5 compares it with current bytes. C3/C5 may add the expected SHA to dispatch once
   the engine has frozen a review revision.

The revised accounting preserves the synthesis's 859 minutes: **657 build minutes + 202 integration
minutes**. Parallelism reduces build wall-clock; it does not pretend integration is free.

## WAVE PLAN — build waves and integration waves kept SEPARATE

### Build waves

`build_parallel_min` is the wave makespan, shown as **4 seats / 3 seats**. Files listed for a slice are
exclusive to that slice for the entire wave, including its dedicated isolated test.

| wave | unlock | slices and exclusive file ownership | build_parallel_min |
|---|---|---|---:|
| W0 | immediate | **A0:** `src/a0-convene-race-regression.test.ts` only; pins `8024452` before production edits. | 20 / 20 |
| W1 | W0 | **A1:** `src/services/run-terminal-policy.ts`, `src/services/run-orchestrator-service.ts`, `src/services/run-terminal-policy.test.ts`. | 20 / 20 |
| W2 | W1 | **A2:** `src/services/worker-runtime-finalize.ts`, `src/services/worker-runtime-finalize.update-only.test.ts`. | 18 / 18 |
| W3 | W2 | **A3:** `src/services/worker-runtime-finalize.ts`, `src/services/worker-runtime-registry-link.test.ts`. | 22 / 22 |
| W4 | W3 | **A4:** `src/services/planning-cycle-terminal-policy.ts`, `src/services/run-orchestrator-service.ts`, `src/services/cycle-service.ts`, `src/services/planning-cycle-terminal-policy.test.ts`. | 22 / 22 |
| W5 | W4 | **A5:** `src/services/planning-phase-service.ts`, `src/services/planning-seat-cleanup.test.ts`. | 22 / 22 |
| W6 | W5 | **A6:** `src/services/planning-phase-service.ts`, `src/services/run-orchestrator-service.ts`, `src/services/planning-terminal-owner.test.ts`. | 22 / 22 |
| W7 | I0 | **B1:** `src/services/plan-revision.ts`, `src/services/plan-revision.test.ts`.<br>**B3:** new `src/services/planning-verdict-parser.ts`, `src/services/planning-verdict-parser.test.ts`; no `planning-phase-service.ts` wiring yet.<br>**B6:** new `src/services/planning-nonconvergence.ts`, `src/services/planning-nonconvergence.test.ts`; no call-site reorder yet. | 18 / 18 |
| W8 | W7 | **B2:** `src/services/brief-writer-service.ts`, `src/services/brief-writer-plan-path.test.ts`.<br>**B4:** new `src/services/planning-verdict-selection.ts`, `src/services/planning-verdict-selection.test.ts`.<br>**B5:** new `src/services/planning-agreement-gate.ts`, `src/services/planning-agreement-gate.test.ts`. | 22 / 22 |
| W9 | I1 | **C1:** `src/services/planning-seat-identity.ts`, `src/services/real-transport.ts`, `src/services/planning-seat-identity.test.ts`.<br>**C2:** new `src/services/planning-review-round.ts`, `src/services/planning-review-round.test.ts`.<br>**C3:** new `src/services/planning-artifact-publication.ts`, `src/services/planning-artifact-publication.test.ts`.<br>**C4:** new `src/services/planning-round-machine.ts`, `src/services/planning-round-machine.test.ts`. | 21 / 34 |
| W10 | W9 | **C5:** new `src/services/planning-round-seat-lifecycle.ts`, `src/services/planning-round-seat-lifecycle.test.ts`.<br>**C7:** new `src/services/seat-first-callback-watchdog.ts`, `src/services/seat-first-callback-watchdog.test.ts`.<br>**C9:** `src/services/brief-writer-service.ts`, `src/services/brief-writer-agreement-language.test.ts`; build only, activation waits for C8.<br>**C10:** `src/services/plan-parser-service.ts`, `src/services/plan-parser-transaction.test.ts`; build only, activation waits for C8. | 23 / 39 |
| W11 | W10 | **C6:** `src/services/planning-revision-actuator.ts`, `src/services/brief-writer-service.ts`, `src/services/planning-revision-actuator.test.ts`. | 22 / 22 |
| W12 | I2 | **C8:** new `src/services/planning-round-transition.ts` and `src/services/planning-round-transition.test.ts`. This builds the replacement transition only; the honest fail-fast is still present until I3. | 15 / 15 |
| W13 | I3 | **D1:** `src/services/run-orchestrator-service.ts`, `src/services/planning-entry-policy.test.ts`.<br>**D4:** `src/services/planning-phase-service.ts`, `src/services/planning-result-snapshot.test.ts`.<br>**D6:** `src/services/discovery-handoff-ingress.ts`, `src/services/discovery-input-manifest.test.ts`.<br>**D9:** `src/services/discovery-handoff-owner-bridge.ts`, `src/services/handoff-acquisition-transaction.test.ts`. | 20 / 33 |
| W14 | W13 | **D2:** `src/index.ts`, `src/start-planning-guards.test.ts`.<br>**D5:** `src/services/planning-provenance-service.ts`, `src/services/planning-provenance-exact-bytes.test.ts`; orchestration wiring waits for I4.<br>**D7:** `src/services/discovery-handoff-owner-bridge.ts`, `src/services/discovery-handoff-confirmation.test.ts`.<br>**D8:** new `src/services/post-planning-continuation.ts`, `src/services/post-planning-continuation.test.ts`; orchestration wiring waits for I4. | 20 / 32 |
| W15 | W14 | **D3:** `src/web/public/planning-action-policy.js`, `src/web/public/app.js`, `src/web/public/planning-action-policy.test.ts`.<br>**D10:** `src/services/discovery-handoff-owner-bridge.ts`, `src/services/handoff-terminal-owner.test.ts`.<br>**D11:** `src/services/adaptive-planning-policy.ts`, `src/services/planning-phase-service.ts`, `src/services/adaptive-planning-phase.ts`, `src/services/adaptive-planning-policy.test.ts`. | 20 / 20 |
| W16 | I4 | **D12:** `src/planning-regression-index.test.ts` and a declarative `src/planning-regression-index.ts`; it indexes the distributed AC23 tests and does not replace them. | 15 / 15 |

### Integration waves

Integration waves have one source owner and run serially. They are the only places where separately
tested pieces are wired together. Each named integration sub-slice is under 30 minutes; the wave total
may be larger because its sub-slices are deliberately serial.

| wave | prerequisite | wiring and end-to-end proof | integration_serial_min |
|---|---|---|---:|
| I0 | W6 | **I0a (18):** wire A1-A6 through the one terminal owner.<br>**I0b (16):** fake-transport + temporary-DB lifecycle proof covers planning block, thrown exit, successful cleanup, unchanged ibrain row count, live master session not idled, retryable cycle, and reap-before-finalize ordering. No real tmux. | 34 |
| I1 | W8 | **I1a (18):** single owner wires B1-B6 into `planning-phase-service.ts`.<br>**I1b (14):** token-free callback/file fixtures prove newest-line fail-closed parsing, exact SHA binding, all configured seats CLEAN for one current hash, R1-CLEAN/R2-CLEAN stale refusal, split CLEAN/BROKEN refusal, and typed non-convergence return. **P1 is not complete until I1b is green; no P2 build starts before it.** | 32 |
| I2 | W11 | **I2a (18):** wire C1-C4 into `planning-phase-service.ts` while retaining the honest BROKEN fail-fast.<br>**I2b (17):** wire C5-C7 and prove with fake transport that artifacts precede reviewers, identities/briefs are unique, every round gets fresh seats, BROKEN launches a fresh revision author, a new hash is required, and a silent seat hits the watchdog. `planMdPathForRaceGuard` remains exactly 3. | 35 |
| I3 | W12 | **I3a (16): C8 activation, deliberately last in the P2 core.** Remove the old BROKEN short-circuit only now and activate C9 engine-only agreement semantics.<br>**I3b (14):** activate C10 transactional ingest; token-free full-phase proof covers BROKEN→revise→CLEAN, cap=3 exactly, stale/late callbacks fenced, PLAN-READY alone denied, and injected rollback. | 30 |
| I4 | W15 | **I4a (22):** wire D1-D7 through entry, immutable discovery, exact-plan, and provenance boundaries.<br>**I4b (19):** wire D8-D11 through driver, acquisition, terminal-cleanup, and adaptive-policy boundaries. Temporary-DB + fake transport proves the whole handoff contract with no live cycle or live seat. | 41 |
| I5 | W16 | **I5a (14):** run the seven AC23 files individually and verify the meta-index.<br>**I5b (16):** the only live UI proof runs D3 through `playwright.cap.config.ts` on `:3110` after `node --check src/web/public/app.js` and `npm run build`. It never starts a model seat or mutates cycle 13. | 30 |

### Critical path and wall-clock

Critical path:

`W0→W1→W2→W3→W4→W5→W6→I0a→I0b→W7→W8→I1a→I1b→W9→W10→W11→I2a→I2b→W12(C8)→I3a→I3b→W13→W14→W15→I4a→I4b→W16→I5a→I5b`

- Wall-clock at **3 seats: 598 min = 9h58m**.
- Wall-clock at **4 seats: 544 min = 9h04m**.
- Split at 3 seats: `total build_parallel_min=396`; `total integration_serial_min=202`.
- Split at 4 seats: `total build_parallel_min=342`; `total integration_serial_min=202`.
- Effort accounting remains `657 build person-min + 202 integration person-min = 859 min`.

The fourth seat buys only 54 minutes because A0/A1-A6 and all integration waves are intentionally
serial. At the observed ~2× project pace, schedule roughly **18-20 hours**, not 24-30.

## PER-SLICE ISOLATED UNIT TEST

| slice | isolated unit test (no live run) | integration proof (deferrable) | extractable pure fn? |
|---|---|---|---|
| A0 | `a0-convene-race-regression.test.ts`: callback fixture proves absent-plan BROKEN is non-dispositive, present-plan BROKEN is dispositive, and source guard count is 3. | I2/I3 re-run it after round-machine wiring. | No production extraction; test existing seam. |
| A1 | `run-terminal-policy.test.ts`: table-test preterminal phase/task/runtime facts. | I0 proves planning failure never calls implementation finalization. | Yes: `shouldFinalizeImplementationBrain`. |
| A2 | `worker-runtime-finalize.update-only.test.ts`: temporary DB covers existing, missing, wrong-run, wrong-role, and terminal rows. | I0 proves planning block leaves ibrain row count unchanged. | No; isolate through repository seam. |
| A3 | `worker-runtime-registry-link.test.ts`: exact runtime/session linkage matrix; inferred-name-only input returns no target. | I0 proves a seeded live master registry row stays active. | Yes: `registryIdleTargetForRuntime`. |
| A4 | `planning-cycle-terminal-policy.test.ts`: planning failure, implementation failure, and successful completion decision table. | I0 proves retry acquisition and no topology freeze after planning failure. | Yes: `cycleTerminalAction`. |
| A5 | `planning-seat-cleanup.test.ts`: fake transport/DB spy asserts reap resolves before runtime finalization and retries are idempotent. | I0 covers every spawned planning handle on block and throw. | No; dependency-injected seam. |
| A6 | `planning-terminal-owner.test.ts`: fake success, blocked, and throw branches all traverse one terminal owner once. | I0 runs both orchestration entries through that owner. | No; dependency-injected seam. |
| B1 | `plan-revision.test.ts`: exhaustive byte fixtures, empty bytes, Unicode, one-byte drift, stable SHA/short12. | I1 compares callback SHA with a real temporary `plan.md`. | Yes: `planRevision`. |
| B2 | `brief-writer-plan-path.test.ts`: generated brief contains absolute canonical Markdown paths and no `plan.json`; SHA is optional before C3. | I2 proves post-publication dispatch includes the frozen expected SHA. | Yes: `panelArtifactReferences`. |
| B3 | `planning-verdict-parser.test.ts`: em dash, en dash, hyphen, colon, malformed hash, and unknown verdict grammar. | I1 parses real fenced callback lines. | Yes: `parsePlanningVerdict`. |
| B4 | `planning-verdict-selection.test.ts`: newest malformed line shadows every older CLEAN for that seat. | I1 proves mixed callback order cannot revive stale CLEAN. | Yes: `selectNewestSeatVerdict`. |
| B5 | `planning-agreement-gate.test.ts`: configured-seat/SHA matrices including exact R1/R2 stale scenario. | I1 proves denied cases perform zero ingest calls. | Yes: `evaluatePlanningAgreement`. |
| B6 | `planning-nonconvergence.test.ts`: typed reasons preserve timeout, silent seat, malformed verdict, and cap data without throwing. | I1 proves missing canonical plan returns the mechanism reason. | Yes: `nonConvergenceResult`. |
| C1 | `planning-seat-identity.test.ts`: attempts, rounds, seats, and SHA prefixes produce unique safe role/brief/session names; temp FS proves no overwrite. | I2 observes distinct fake transport handles and brief paths. | Yes: `planningSeatIdentity`. |
| C2 | `planning-review-round.test.ts`: fake artifact/verdict/transport ports prove one bounded round's input/output contract. | I2 invokes it from the real phase service with fail-fast retained. | No; dependency-injected seam. |
| C3 | `planning-artifact-publication.test.ts`: missing, empty, invalid, stale-attempt, and valid paired artifacts. | I2 proves zero reviewer spawn precedes publication. | Yes: `validatePublishedPlanningArtifacts`. |
| C4 | `planning-round-machine.test.ts`: fake clock/cap table proves integer rounds and one deadline per round. | I3 proves cap 3 spawns exactly three reviewer sets. | Yes: `nextPlanningRoundState`. |
| C5 | `planning-round-seat-lifecycle.test.ts`: fake transport proves prior seats reap and next hash gets entirely fresh descriptors. | I2/I3 prove no reviewer handle is reused across R1/R2. | Yes for descriptors; fake seam for lifecycle. |
| C6 | `planning-revision-actuator.test.ts`: BROKEN defect aggregation, fresh revision identity, unchanged hash refusal, new hash success. | I2 proves BROKEN drives a fresh plancore turn without `send`. | Yes: `revisionRequestFromVerdicts`; fake seam for spawn. |
| C7 | `seat-first-callback-watchdog.test.ts`: fake clock/session/composer covers ACK, resubmit, retry, dead seat, and named timeout. | I2 proves a silent partner blocks and cleans up exactly that handle. | No; dependency-injected clock/transport seam. |
| C8 | `planning-round-transition.test.ts`: BROKEN maps to REVISE below cap and BLOCKED at cap, never directly to agreement. | I3 is mandatory proof that the old source short-circuit is actually absent and the replacement is wired. | Yes: `transitionAfterReviewRound`. |
| C9 | `brief-writer-agreement-language.test.ts`: generated briefs define PLAN-READY as publication and contain no agent agreement claim. | I3 proves only the engine agreement event can call ingest. | Yes: deterministic brief render. |
| C10 | `plan-parser-transaction.test.ts`: temporary DB fault injection after each write boundary proves full rollback and SHA idempotency. | I3 proves agreement calls one transactional ingest and failed commit exposes no executable task. | No; isolated transaction seam. |
| D1 | `planning-entry-policy.test.ts`: existing discovery docs select confirmed handoff and make rediscovery unreachable. | I4 proves zero discovery spawn/write through the orchestration entry. | Yes: `selectPlanningEntry`. |
| D2 | `start-planning-guards.test.ts`: fake handoff/active-run stores cover success, absent state, and store exceptions; exceptions refuse. | I4 proves API cannot fall through to legacy start. | Yes: `startPlanningGuardDecision`. |
| D3 | `planning-action-policy.test.ts`: pure state→action model hides legacy interview/replan and emits confirmed-handoff request. | I5 proves actual `app.js` rendering/click behavior on `:3110`. | Yes: `planningActionsForCycle`. |
| D4 | `planning-result-snapshot.test.ts`: accepted bytes and SHA remain paired across one-byte disk mutation. | I4 proves ingestion and orchestration receive the same snapshot object. | Yes: `acceptedPlanSnapshot`. |
| D5 | `planning-provenance-exact-bytes.test.ts`: temporary DB covers exact attempt/SHA success, mismatch, wrong handoff, and write failure. | I4 proves mismatch/provenance failure blocks the whole handoff. | Yes for comparison; DB seam for persistence. |
| D6 | `discovery-input-manifest.test.ts`: exact North Star/conversation bytes produce stable hashes, sizes, paths, and staffing digest. | I4 proves stored manifest survives later file mutation. | Yes: `discoveryInputManifest`. |
| D7 | `discovery-handoff-confirmation.test.ts`: frozen/current byte matrices accept only exact identity. | I4 proves planners consume frozen bytes, not mutable paths. | Yes: `verifyFrozenDiscoveryManifest`. |
| D8 | `post-planning-continuation.test.ts`: fake driver covers install success/failure and pause-after-planning; no state reaches executing before ownership. | I4 proves an autonomous confirmed handoff has a live driver before DB `executing`. | Yes: `postPlanningTransition`; fake driver seam. |
| D9 | `handoff-acquisition-transaction.test.ts`: temporary DB crashes at CAS/create/link boundaries and checks rollback/idempotency. | I4 proves retry cannot observe a permanently unlinked `starting` handoff. | No; isolated transaction seam. |
| D10 | `handoff-terminal-owner.test.ts`: fake detached-task throws at each boundary and asserts reap→runtime→handoff→run→cycle ordering once. | I4 proves background failure leaves a retryable, leak-free state. | No; dependency-injected seam. |
| D11 | `adaptive-planning-policy.test.ts`: adaptive flag refuses before any supplied spawn/ingest port is called; core flag proceeds. | I4 proves existing canonical artifacts cannot bypass refusal. | Yes: `adaptivePlanningDecision`. |
| D12 | `planning-regression-index.test.ts`: exported required-ID set must resolve to seven distributed token-free regression tests. | I5 executes those seven files individually and checks all pass. | Yes: `requiredPlanningRegressionIds`. |

## SLICES THAT CANNOT BE UNIT-TESTED IN ISOLATION (and why)

No slice needs a total exemption after the extractions above, but five wiring claims cannot be
**fully** proven by their isolated test:

- **A6:** a unit seam proves terminal-owner behavior; only I0 proves both real callers use it.
- **C8:** the pure transition is testable; only I3 proves the obsolete fail-fast branch was removed.
- **D1:** entry policy is pure; only I4 proves no orchestration route still spawns discovery.
- **D3:** action policy is pure, but the 560 KB hand-written ESM wiring requires I5 on `:3110`.
- **D10:** terminal ordering is fakeable; only I4 proves the detached catch is routed through it.

These are reasons to retain explicit integration waves, not reasons to run live seats per slice.

## WHERE PARALLELISM IS UNSAFE (and why serial wins)

- **W0 then A1→A6 remains serial.** A1/A2/A3 progressively narrow the E5-class terminal target; A4
  changes cycle terminal policy; A5 retains exact handles; A6 becomes the sole terminal owner. Building
  A6 against any earlier lifecycle contract risks idling or reaping the wrong persistent session.
- **P1 integration precedes all P2 code.** I1 must demonstrate a same-hash fail-closed gate before W9.
- **`planning-phase-service.ts` gets one integration owner.** B/C pure modules may build in parallel,
  but I1, I2, and I3 are serial and never have concurrent writers.
- **C8 stays after I2.** Until C3-C7 are wired and green, the current honest BROKEN fail-fast remains.
  C9/C10 may be built early in isolation but cannot be activated before C8.
- **`worker-runtime-finalize.ts` A2 then A3 is serial.** Both change the same safety boundary and A3
  assumes A2's update-only identity.
- **`brief-writer-service.ts` B2, C9, C6 is wave-separated.** Their generated-contract changes are
  independently tested before the next owner edits the file.
- **`discovery-handoff-owner-bridge.ts` D9→D7→D10 is wave-separated.** Acquisition, immutable input
  consumption, and terminal cleanup must not be concurrently edited.
- **`run-orchestrator-service.ts` has a single I4 owner.** D4/D5/D7/D8 build adapters separately; their
  cross-path wiring is intentionally serial.
- **`app.js` is exclusive to D3.** No concurrent edit or mechanical merge is allowed; `node --check`
  and build precede I5.

## ANY SLICE I WOULD ADD, SPLIT, MERGE OR DROP

- **Add I0-I5 as explicit integration slices**, funded by minutes moved out of the existing rows; they
  add no AC scope and no extra effort.
- **Split source wiring from policy construction** in B3, B4, B5, B6, C1-C7, D3, D5, D8, and D11.
  Their build rows own pure modules or fakeable seams; integration owns high-collision services.
- **Change B2** as noted in the verdict: canonical paths land in P1, expected engine SHA becomes required
  only after C3 freezes artifacts.
- **Keep C9/C10 as early isolated builds but delay activation until I3**, after C8.
- **Keep D12 only as a meta-index.** It must not become one replacement AC23 test; the seven historical
  regressions remain distributed across A0/A2/B5/C5/C7/C8/D1-owned behavior.
- **Do not merge A1-A6 or C3-C8.** Their small serial boundaries are the safety proof.
- **Drop no acceptance slice.** All AC1-AC23 mappings in the synthesis remain valid.
- Correct the synthesis footer from `870 min` to `859 min` before coordinator ingestion.

REREVIEW-DONE sol
