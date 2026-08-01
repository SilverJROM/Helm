# P1 validator red-team a1

Verdict: PASS

Scope checked:
- R1.2: no model call for plancore during initial whole-plan authoring.
- R1.3: keep `brainRole` / `plancore` label semantics for callbacks/logging/staffing; no role rename.

Evidence:
- Focused command passed: `npx vitest run src/services/planning-phase-no-plancore-author.test.ts src/services/planning-phase-service.test.ts --minWorkers=1 --maxWorkers=4`
- Result: 2 test files passed, 36 tests passed.
- Current implementation is commit `b4ff1e6c861910dbb99acdf5e7bc43cd0a1c4306`.

Adversarial lenses:

1. Residual authoring-model-call path
- `generatePlanningBrief` only appears in P1/B4 test commentary; no call remains in `src/services/planning-phase-service.ts`.
- `runPlanningPhase` initializes `plancoreHandle` / `plancoreRuntimeId` to null and does not assign them from a spawn.
- Initial whole-plan spawning is delegated to `runReviewRound`; observed spawn sites in `src/services/planning-review-round.ts` use the configured partner/proposer/signer roles, not the plancore brain role.

2. Authoring brief/write path
- `runPlanningPhase` passes a generic `writeBrief` callback into ROUND but no longer writes a `plancore` brief directly.
- P1 tests assert `prompts/plancore.brief.md` is never created and that no plancore worker runtime row is registered.

3. Context propagation replacement
- `runPlanningPhase` passes `contextInputPaths: [nsPath, convPath]` into `runReviewRound`.
- P1 tests capture ROUND options and assert the engine-resolved `north-star.md` and `conversation-log.md` paths are provided.
- Real-mode P1 test proves these engine-written context paths satisfy ROUND without a plancore-authored context copy.

4. Label/topology compatibility
- `brainRole = inputs.brainRole || 'plancore'` is preserved.
- `brainRole` remains used in wait/parse paths for PLAN-READY and task verdict attribution.
- Existing callback grammar still accepts `[helm callback] plancore ... STATUS: PLAN-READY`, preserving the label required by R1.3.

5. Terminal owner / A5-A6 cleanup regression
- `runPlanningTerminal` remains the single cleanup owner.
- It still reaps `plancoreHandle` (null no-op) and every handle in caller-owned `partnerHandles`, then finalizes `plancoreRuntimeId` (null no-op) and every `partnerRuntimeIds` entry.
- ROUND receives the same `partnerHandles` / `partnerRuntimeIds` arrays and mutates them in place.

Residual risk:
- Some comments and legacy error text still say "plancore" authors/flushed canonical plan documents. This is a wording drift, not a behavioral R1.2/R1.3 failure, because the label is intentionally retained and focused tests cover the removed spawn/brief/runtime behavior.
