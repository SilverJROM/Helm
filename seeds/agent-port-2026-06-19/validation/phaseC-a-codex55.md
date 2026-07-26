# Phase C-a Validation — codex-5.5

## Verdict: FAIL

Phase C-a is not complete. C1 panel per-seat roster dispatch works, and C5 low-budget escalation
swaps to the next rung in the runtime probe. C6 per-task effort is honored, but per-task model is
not honored at actual implementer dispatch.

## Incident Guard

- Live DB mtime before validation: `1781838325`
- Live DB mtime after runtime probes, build, and full test suite: `1781838325`
- All DB-backed commands used `HELM_DB_PATH=/tmp/helm-phaseC-a-...db`.
- I did not copy, migrate, or write `data/helm.db`.

## Findings

1. **C6 per-task model is parsed but not honored at dispatch.**

   Source path:
   - `src/services/plan-parser-service.ts:70-73` accepts `model` and normalizes it to
     `recommended_model`.
   - `src/services/run-orchestrator-service.ts:215-256` reads `taskDetail.model ||
     taskDetail.recommended_model` and passes `explicitModel` plus `effort` into `loop.runTask`.
   - `src/services/orchestrator-loop.ts:410-418` resolves `startModel` from `explicitModel`.
   - But `src/services/orchestrator-loop.ts:245-260` ignores `startModel` at spawn time and
     recomputes `dispatchModel` from `getModelForRung(role, currentRung)`.

   Runtime probe:
   ```text
   "parsedTask": {
     "model": "gpt-5.5",
     "effort": "high",
     "recommended_model": "gpt-5.5"
   },
   "perTaskExpectedModel": "gpt-5.5",
   "perTaskImplSpawn": {
     "model": "grok-build",
     "effort": "high",
     "rung": 0
   }
   ```

   Expected: implementer spawn uses `gpt-5.5`.
   Actual: implementer spawn uses default rung-0 `grok-build`. Effort `high` is honored.

2. **C1 panel per-seat roster dispatch: PASS.**

   Runtime probe passed three distinct deliberation seats and three red-team seats. Spawns used the
   provided per-seat model/provider values:
   ```text
   panelist: grok-build / grok
   panelist: gpt-5.5 / codex
   panelist: claude-opus-4-8 / claude
   red-team: grok-build / grok
   red-team: gpt-5.5 / codex
   red-team: claude-opus-4-8 / claude
   ```

   Source refs:
   - `src/services/panel-service.ts:58-78` passes each deliberation seat's `model` and `provider`
     into `transport.spawn`.
   - `src/services/panel-service.ts:111-137` cycles red-team agents and passes each seat's
     `model`/`provider` into `transport.spawn`.
   - `src/services/orchestrator-loop.ts:623-631` maps `deliberationRoster` seats into panel seats.

3. **C5 low-budget swap: PASS in direct runtime probe.**

   With fake gateway reporting depleted for `grok:grok-build`, the loop logged the trigger and the
   implementer dispatch used rung 1:
   ```text
   "lowBudget": {
     "finalStatus": "PASS",
     "transitions": ["dispatched", "low-budget-trigger", "..."],
     "implSpawn": {
       "model": "codex-5.5",
       "effort": "medium",
       "rung": 1
     }
   }
   ```

   This proves the low-budget trigger does not break the on-fail ladder path for this direct case.
   It does not rescue the C6 failure, because a non-default per-task model is still ignored when no
   low-budget swap fires.

4. **Full suite result fails the brief's test condition.**

   `npm run build` passed under a temp DB. The full suite did not satisfy "only emit-status fails":
   ```text
   Test Files  3 failed | 18 passed (21)
   Tests       3 failed | 238 passed | 1 skipped (242)
   ```

   Failures observed:
   - `src/services/orchestrator-loop.test.ts`: known `projcore-emit-status.sh` failure.
   - `src/p1-6b.test.ts`: tmux `helm-EHR` session missing during version-skew test.
   - `src/p1-5b.test.ts`: supervisor respawn assertion `expected false to be true`.

## Command Evidence

- `HELM_DB_PATH=/tmp/helm-phaseC-a-probes-tbOPhE.db USE_FAKE_TMUX=1 NODE_ENV=test npx tsx --eval ...`:
  C1 PASS, C5 PASS, C6 FAIL as shown above.
- `HELM_DB_PATH=/tmp/helm-phaseC-a-build-gtFLyY.db npm run build`: PASS; only existing
  `tools/helm-sandbox.c` comment warning.
- `HELM_DB_PATH=/tmp/helm-phaseC-a-full-1VQHX4.db npx vitest run`: FAIL; 3 failing tests above.
- Live `data/helm.db` mtime remained `1781838325` before/after every command.

STATUS: FAIL — 1) C6 per-task model is parsed/passed to runTask but ignored at actual implementer dispatch; 2) full suite has additional failures beyond allowed emit-status.

## Re-validation: C6 Fix Commit 992a41b

Date: 2026-06-19
Validator: codex55
Scope: Re-validate C6 per-task model dispatch fix at commit `992a41b` and confirm escalation/project-override behavior.

### Result

**STATUS: FAIL.**

The narrow C6 base-path fix is partially effective: a plan task with per-task model `gpt-5.5`
now spawns the implementer with dispatch model `gpt-5.5` at rung 0. However, project override
precedence is still wrong at actual dispatch, and the TypeScript build is not clean.

### Live DB Safety

- Live DB mtime before validation commands: `1781838325`
- Live DB mtime after validation commands: `1781838325`
- Result: unchanged
- All probes/build/tests used temp `HELM_DB_PATH` values under `/tmp`.

### Runtime Probe Findings

1. **Per-task implementer model dispatch: PASS.**

   Runtime probe created a plan task with `model: "gpt-5.5"` and `effort: "high"`.
   The actual implementer spawn used:
   ```text
   model: gpt-5.5
   provider: codex
   effort: high
   rung: 0
   ```

   This confirms the base rung-0 implementer path no longer falls back to the binding default.

2. **Escalation rung model: PASS.**

   Runtime probe forced a validator failure, escalation-brain `bump-rung`, and a resumed
   implementer dispatch. The rung-0 base dispatch used `grok-build`; the rung-1 dispatch used
   ladder model `codex-5.5`.

   This confirms `rung > 0` uses the ladder model rather than the per-task base model.

3. **Project override precedence at dispatch: FAIL.**

   Runtime probe configured a project override that resolves the implementer role to `grok-build`
   while the task requested `gpt-5.5`. `resolveProjectRole` returned the override model
   `grok-build`, but the actual implementer spawn used:
   ```text
   model: gpt-5.5
   provider: codex
   effort: high
   rung: 0
   ```

   Expected: project override beats the per-task base model at actual dispatch.
   Actual: per-task base model beats the project override.

### Build and Test Evidence

- `HELM_DB_PATH=/tmp/helm-phaseC-c6fix-build-GsvRnF.db npm run build`: FAIL
  ```text
  src/services/orchestrator-loop.ts(257,9): error TS2322:
  Type 'string | null' is not assignable to type 'string | undefined'.
  ```

- `HELM_DB_PATH=/tmp/helm-phaseC-c6fix-full-ZmRJWh.db npx vitest run`: FAIL, but only for
  the allowed emit-status test:
  ```text
  Test Files  1 failed | 20 passed (21)
  Tests       1 failed | 240 passed | 1 skipped (242)
  ```

  Failure:
  - `src/services/orchestrator-loop.test.ts`: known `projcore-emit-status.sh` failure.

  `src/p1-6b.test.ts` passed in the full run, so no rerun was needed.

STATUS: FAIL — 1) build fails TS2322 in src/services/orchestrator-loop.ts:257; 2) project override does not beat per-task base at actual implementer dispatch.

## Final Re-validation: Phase C-a Commits 62b7885 + Prior

Date: 2026-06-19
Validator: codex55
Scope: Final Phase C-a gate using locked precedence:
`escalation rung > per-task plan model > project override > Studio default`.

### Result

**STATUS: PASS.**

The prior TS2322 build break is fixed. The earlier project-override concern is no longer a gap
under the locked precedence: per-task plan model intentionally beats project override; project
override applies only when the task has no per-task model.

### Runtime Probe Evidence

1. **Per-task model at implementer dispatch: PASS.**

   A plan task with per-task model `gpt-5.5` and effort `high` spawned the implementer with:
   ```text
   model: gpt-5.5
   provider: codex
   effort: high
   rung: 0
   ```

2. **Project override when no per-task model: PASS.**

   With an implementer project binding/override to `claude-sonnet-4-6`, a plan task with no
   per-task model spawned the implementer with:
   ```text
   model: claude-sonnet-4-6
   provider: claude
   effort: medium
   rung: 0
   ```

3. **C1 panels per-seat roster: PASS.**

   Runtime probe captured actual panel dispatch models:
   ```text
   deliberation: grok-build / grok
   deliberation: codex-5.5 / codex
   deliberation: claude-opus / claude
   red-team: grok-build / grok
   red-team: codex-5.5 / codex
   ```

4. **C5 budget swap: PASS.**

   With base `grok-build` marked depleted, the actual implementer dispatch used rung 1:
   ```text
   model: codex-5.5
   provider: codex
   rung: 1
   effort: medium
   ```

   Transitions included `low-budget-trigger`, and the task completed `PASS`.

### Build and Suite Evidence

- `HELM_DB_PATH=/tmp/helm-phaseC-final-build-*.db npm run build`: PASS.
  Only the existing `tools/helm-sandbox.c` comment warning was emitted.

- `HELM_DB_PATH=/tmp/helm-phaseC-final-full-*.db npx vitest run`: expected FAIL only for
  the allowed emit-status test.
  ```text
  Test Files  1 failed | 20 passed (21)
  Tests       1 failed | 241 passed | 1 skipped (243)
  ```

  Sole failure:
  - `src/services/orchestrator-loop.test.ts`: known `projcore-emit-status.sh` failure.

  `src/p1-6b.test.ts` passed in the full run, so no rerun was needed.

### Live DB Safety

- `data/helm.db` mtime before validation: `1781838325`
- `data/helm.db` mtime after build/probes/full suite: `1781838325`
- Result: unchanged
- All validation commands used temp `HELM_DB_PATH` files under `/tmp`.

STATUS: PASS
