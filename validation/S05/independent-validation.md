# S05 Independent Validation

Validator: L2 independent re-gate
HEAD: `ec27ecb284cb074e7d1b99b0fe6a27421ca80213`
Branch: `fix/discovery-handoff-S05-staffing-resolver`
Scope: AC 19-22, 24; fix1 after prior core-path wiring FAIL
Verdict: PASS

## Test Command

```bash
HELM_SESSION_JANITOR=0 npx vitest run src/planning-staffing-service.test.ts
```

Result: PASS

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

## Acceptance Criteria Check

- AC19: PASS for S05/fix1. `RunOrchestratorService` now imports `PlanningStaffingService` and calls `resolveCorePlanningStaffing()` before both core planning entry branches, including when `adaptive_planning=0`. Configured panel seats are resolved through `project_planner_panel`; the bridge test proves a configured Opus member is not replaced by a generic `planner` binding.
- AC20: PASS for S05/fix1. `planning_panel_size` is treated as N configured co-planners, and the bridge converts it to the existing `runPlanningPhase()` total-seat input as `N + 1` (`plancore + N co-planners`). The focused test covers two co-planners mapping to `panelSizeTotal = 3`.
- AC21: PASS at the S05 resolver/wiring boundary. Plancore is resolved separately from the configured co-planner panel and threaded into the planning call as the planning brain. The exact distinct `plancore + Opus5 + Codex56Sol` runtime roster remains explicitly assigned to S06 in `plan/discovery-planning-handoff/plan.md`.
- AC22: PASS at the S05 resolver boundary. `PlanningStaffingService` preserves ordered provider/model/effort plus configured backup/block reasons and returns `blockReasons`; the orchestrator now blocks before planning when those reasons are present. UI preview and exact runtime roster visibility remain S07/S12/S14 scope.
- AC24: PASS at the S05 resolver boundary. The staffing manifest has a stable digest and the core bridge carries it in `CorePlanningStaffingArgs`. Confirmation binding/revalidation before owner-start is deliberately assigned to S08/S10/S11/S12 in the plan.

## Evidence

- `src/services/run-orchestrator-service.ts:45` imports `PlanningStaffingService` and the core bridge helpers.
- `src/services/run-orchestrator-service.ts:229` defines `resolveCorePlanningStaffing()` using `PlanningStaffingService.resolveManifest()`.
- `src/services/run-orchestrator-service.ts:1101` and `src/services/run-orchestrator-service.ts:1230` call the resolver before the two planning entry branches.
- `src/services/run-orchestrator-service.ts:1138` and `src/services/run-orchestrator-service.ts:1264` pass `panelSize: coreStaffing.panelSizeTotal`.
- `src/services/planning-staffing-service.ts:153` maps the manifest into core planning args without consulting generic `planner` when a configured panel exists.
- `src/planning-staffing-service.test.ts:212` adds the fix1 core wiring bridge test; the suite now has 4 passing tests.
- `plan/discovery-planning-handoff/plan.md` assigns exact ordered per-seat spawn/register/gate behavior to S06 ("Core Planning consumes the exact manifest"), so the remaining single `partnerModel/provider` API is not re-opened as an S05 failure.

## Conclusion

The prior independent FAIL was specifically that the core planning path did not consume `PlanningStaffingService` and still used old count semantics. At `ec27ecb`, that blocker is fixed and the requested focused Vitest suite passes 4/4. S05 passes with the planned boundary that exact ordered multi-seat runtime consumption continues in S06.
