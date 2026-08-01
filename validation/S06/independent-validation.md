# S06 Independent Validation

Validator: L2 independent
HEAD: `630c49f2f1c9ead812ffa1dc4241561540cbccad`
Scope: AC 19, 21, 25-26
Cycle: 13
Redteam: N=2 CLEAN
Verdict: PASS

## Test Command

```bash
HELM_SESSION_JANITOR=0 npx vitest run src/s06-core-seats.test.ts
```

Result: PASS

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

## Acceptance Criteria Check

- AC19: PASS. Core planning now consumes configured co-planner seat identities through `coPlannerSeats`; the focused test proves two configured partner seats spawn with their distinct Claude/Codex models and do not fall back to the deliberately wrong legacy `partnerModel`.
- AC21: PASS. Plancore remains the separate planning brain while the two co-planners are separate partner seats. The test exercises `planningBrainModel`/`planningBrainProvider` independently from `coPlannerSeats`.
- AC25: PASS. Partner runtime spawn uses each configured seat's exact model/provider/effort, and the S05 manifest mapper exposes the ordered roster to the core planning inputs.
- AC26: PASS. The agreement gate requires PLAN-READY plus CLEAN verdicts from every configured partner. The focused test covers both the happy path and two blocking cases: one missing partner CLEAN, and one BROKEN second partner at the round cap with no task ingest.

## Evidence

- `src/services/planning-staffing-service.ts:133` defines ordered `CoPlannerSeatSpec`; `src/services/planning-staffing-service.ts:165` maps the S05 manifest to core planning args with `coPlannerSeats`.
- `src/services/run-orchestrator-service.ts:1138` and `src/services/run-orchestrator-service.ts:1268` pass total panel size; `src/services/run-orchestrator-service.ts:1140` and `src/services/run-orchestrator-service.ts:1270` thread ordered co-planner identities into `runPlanningPhase`.
- `src/services/planning-phase-service.ts:125` documents `coPlannerSeats` as exact per-seat identities, with legacy `partnerModel` only for the absent/empty path.
- `src/services/planning-phase-service.ts:489` switches partner count and model/provider/effort source to `coPlannerSeats` when present.
- `src/services/planning-phase-service.ts:519` spawns each partner with the selected seat's exact model/provider/effort, and `src/services/planning-phase-service.ts:533` records each partner runtime with that exact identity.
- `src/services/planning-phase-service.ts:557` waits for agreement using all partner batch IDs, so a partial CLEAN set cannot pass.
- `src/s06-core-seats.test.ts:64` verifies plancore plus two distinct configured co-planner spawns; `src/s06-core-seats.test.ts:108` verifies one CLEAN is insufficient; `src/s06-core-seats.test.ts:136` verifies a BROKEN second partner blocks without ingest; `src/s06-core-seats.test.ts:166` verifies ordered manifest exposure.

## Conclusion

S06 passes independent validation at HEAD `630c49f`: the requested focused Vitest suite is green with `HELM_SESSION_JANITOR=0`, and the code/test evidence covers AC 19, 21, and 25-26 without requiring implementation changes.
