# Phase D-b Validation — codex55

Date: 2026-06-19
Repo: `/home/agjrom/TGBOTS/Helm`
Branch: `feat/helm-agent-port`
Scope: D-b interview phase before planning, autonomous gate, and per-task plan model/effort.

Result: FAIL

## Live DB Guard

- Live DB: `data/helm.db`
- Live DB mtime before/after runtime probes, build, targeted tests, and full suite: `1781838325`
- Result: unchanged

All runtime probes and verification commands used temp `HELM_DB_PATH` values under `/tmp`.

## Commands Run

```bash
HELM_DB_PATH=/tmp/helm-phaseD-b-probe-*.db USE_FAKE_TMUX=1 NODE_ENV=test npx tsx --input-type=module <runtime probe>
HELM_DB_PATH=/tmp/helm-phaseD-b-build-*.db npm run build
HELM_DB_PATH=/tmp/helm-phaseD-b-targeted-*.db USE_FAKE_TMUX=1 npx vitest run src/services/run-orchestrator-service.test.ts src/services/planning-phase-service.test.ts src/services/plan-parser-service.test.ts
HELM_DB_PATH=/tmp/helm-phaseD-b-full-*.db npx vitest run
```

## D-b1 Interview Before Planning: PASS With Lifecycle Gap

Static mechanism:

- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:157) detects missing `plan.json` and enters the interview path.
- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:200) creates the run before planning.
- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:201) sets `runs.phase='interview'`.
- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:238) waits for `NORTH-STAR-READY`.
- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:245) transitions to `planning`.
- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:266) passes the interview-created `runId` into planning so planning ingests onto that run.

Runtime probe evidence:

```json
{
  "gatedBeforeNs": {
    "run": { "id": 1, "phase": "interview" },
    "taskCount": { "n": 0 },
    "spawns": [
      {
        "role": "projcore",
        "model": "claude-opus-4-8",
        "sessionName": "helm-projcore-d-b-interview"
      }
    ]
  },
  "gatedBeforePlan": {
    "run": { "id": 1, "phase": "planning" },
    "taskCount": { "n": 0 },
    "implementerSpawns": 0,
    "projcoreSpawnCount": 2
  },
  "finalRow": {
    "id": 1,
    "phase": "complete",
    "status": "complete"
  },
  "taskRows": [
    {
      "task_key": "DB1",
      "label": "Interview-driven implementation slice",
      "status": "complete"
    }
  ],
  "decisionsFile": "Captured model/effort policy during interview."
}
```

This proves the autonomous loop did not start before north-star readiness and plan authoring: before `NORTH-STAR-READY`, there were no tasks; after `NORTH-STAR-READY` but before `PLAN-READY`, the run was in `planning`, still with no implementer spawns.

## D-b2 Per-Task Model/Effort End-To-End: PASS

Static mechanism:

- [src/services/plan-parser-service.ts](/home/agjrom/TGBOTS/Helm/src/services/plan-parser-service.ts:18) accepts `model` as a per-task alias.
- [src/services/plan-parser-service.ts](/home/agjrom/TGBOTS/Helm/src/services/plan-parser-service.ts:70) normalizes `model` to `recommended_model`.
- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:311) reads per-task `model || recommended_model` and `effort` from `plan.json`.
- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:346) passes those into `loop.runTask`.
- [src/services/orchestrator-loop.ts](/home/agjrom/TGBOTS/Helm/src/services/orchestrator-loop.ts:288) uses per-task model as the rung-0 implementer dispatch model.
- [src/services/orchestrator-loop.ts](/home/agjrom/TGBOTS/Helm/src/services/orchestrator-loop.ts:303) passes the model and effort into transport spawn.

Runtime probe evidence:

```json
{
  "planTask": {
    "task_key": "DB1",
    "model": "codex-5.5",
    "recommended_model": "codex-5.5",
    "effort": "high"
  },
  "implementerDispatch": {
    "model": "codex-5.5",
    "effort": "high",
    "rung": 0,
    "provider": "codex"
  }
}
```

The pre-authored skip-path probe also dispatched its implementer with `model='grok-build'` and `effort='low'` from `plan.json`.

## Remaining Gap

### Pre-authored skip/autonomous path leaves duplicate active run: FAIL

The existing autonomous skip path completes one run but leaves another run row active in `planning` for the same batch.

Runtime probe evidence:

```json
{
  "preauthoredSkip": {
    "runId": 3,
    "runRows": [
      { "id": 3, "phase": "complete", "status": "complete" },
      { "id": 4, "phase": "planning", "status": "active" }
    ],
    "projcoreBriefHasInterviewProtocol": false,
    "implementerDispatch": {
      "model": "grok-build",
      "effort": "low"
    }
  }
}
```

Mechanism:

- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:287) constructs `OrchestratorLoop` without seeding the authoritative `runId`.
- [src/services/orchestrator-loop.ts](/home/agjrom/TGBOTS/Helm/src/services/orchestrator-loop.ts:384) sees `artifactService` but no `this.runId`.
- [src/services/orchestrator-loop.ts](/home/agjrom/TGBOTS/Helm/src/services/orchestrator-loop.ts:385) creates a second run row with the same batch.

This means the pre-authored path is not cleanly lifecycle-safe: the returned run can be complete while the latest/extra row remains active in `planning`, which can confuse Command Center run status and violates the intent of one autonomous run progressing through the lifecycle.

## Build And Tests

### `npm run build`: PASS

- `tsc` completed successfully.
- `cc` completed successfully.
- Only observed compiler warning was the existing `tools/helm-sandbox.c:208` comment warning.
- Live DB mtime unchanged: `1781838325`.

### Targeted D-b Tests: PASS

- `src/services/run-orchestrator-service.test.ts`: 18 tests passed.
- `src/services/planning-phase-service.test.ts`: 8 tests passed.
- `src/services/plan-parser-service.test.ts`: 4 tests passed.
- Total: 30 tests passed.
- Live DB mtime unchanged: `1781838325`.

Note: the D-b unit test verifies gating and model/effort dispatch, but it does not assert that no duplicate active `runs` row remains.

### Full Suite: ALLOWED FAILURE ONLY

- 20 test files passed, 1 failed.
- 245 tests passed, 1 failed, 3 skipped.
- The only failing test was the allowed pre-existing emit-status path:
  `src/services/orchestrator-loop.test.ts > orchestrator-loop B8 escalation ladder (USE_FAKE_TMUX) > projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)`.
- Live DB mtime unchanged: `1781838325`.

## Verdict

D-b's main mechanisms are present: interview gates planning/execution, the no-plan path waits for north-star readiness, the pre-authored path skips the interview brief, and per-task model/effort reaches implementer dispatch.

Phase D-b is not complete because the pre-authored/autonomous path leaves a duplicate active `planning` run row for the same batch.

STATUS: FAIL — pre-authored/autonomous skip path completes one run but leaves a duplicate active planning run row because OrchestratorLoop creates a second run when RunOrchestratorService does not seed its runId.

---

# Phase D-b Re-validation — duplicate-run fix

Date: 2026-06-19
Commit checked: `3c21fa3 fix(d-b): seed runId into OrchestratorLoop on skip path (single run row; interview unaffected) + test`

Result: PASS

## Live DB Guard

- Live DB: `data/helm.db`
- Live DB mtime before/after runtime probe, build, and full suite: `1781838325`
- Result: unchanged

All commands used temp `HELM_DB_PATH` values under `/tmp`.

## Static Mechanism

- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:287) constructs `OrchestratorLoop` with the authoritative `runId`.
- [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:296) passes `runId` into the loop constructor.
- [src/services/orchestrator-loop.ts](/home/agjrom/TGBOTS/Helm/src/services/orchestrator-loop.ts:78) accepts `runId` in constructor options.
- [src/services/orchestrator-loop.ts](/home/agjrom/TGBOTS/Helm/src/services/orchestrator-loop.ts:85) seeds `this.runId` from the caller, so [src/services/orchestrator-loop.ts](/home/agjrom/TGBOTS/Helm/src/services/orchestrator-loop.ts:387) does not create a second run row during `runTask`.

## Runtime Probe

### Pre-authored/autonomous skip path: PASS

Probe used a pre-existing `plan.json` and no interview. Result:

```json
{
  "skipPath": {
    "returnedRunId": 1,
    "runRows": [
      {
        "id": 1,
        "phase": "complete",
        "status": "complete"
      }
    ],
    "runRowCount": 1,
    "activeRunRows": [],
    "tasks": [
      {
        "run_id": 1,
        "task_key": "SK1",
        "status": "complete"
      }
    ],
    "implementerDispatch": {
      "model": "grok-build",
      "effort": "low"
    }
  }
}
```

This closes the prior duplicate-run gap: exactly one run row exists for the batch, and there is no active stale `planning` row.

### Interview path: PASS

Probe forced the no-plan interview path and drove `NORTH-STAR-READY`, then `PLAN-READY`, then implementer/validator callbacks. Result:

```json
{
  "interviewPath": {
    "returnedRunId": 2,
    "beforeNs": {
      "run": {
        "id": 2,
        "phase": "interview",
        "status": "active"
      },
      "runRows": [
        {
          "id": 2,
          "phase": "interview",
          "status": "active"
        }
      ],
      "taskCount": {
        "n": 0
      },
      "implSpawns": 0
    },
    "beforePlan": {
      "run": {
        "id": 2,
        "phase": "planning",
        "status": "active"
      },
      "runRows": [
        {
          "id": 2,
          "phase": "planning",
          "status": "active"
        }
      ],
      "taskCount": {
        "n": 0
      },
      "implSpawns": 0
    },
    "runRows": [
      {
        "id": 2,
        "phase": "complete",
        "status": "complete"
      }
    ],
    "runRowCount": 1,
    "activeRunRows": [],
    "tasks": [
      {
        "run_id": 2,
        "task_key": "IV1",
        "status": "complete"
      }
    ],
    "implementerDispatch": {
      "model": "codex-5.5",
      "effort": "high"
    }
  }
}
```

This confirms interview gating still works and remains single-row: before north-star readiness no tasks/implementer spawn existed; before plan readiness it was in `planning` with no autonomous work; final state had exactly one complete run row.

## Build And Tests

### `npm run build`: PASS

- `tsc` completed successfully.
- `cc` completed successfully.
- Only observed compiler warning was the existing `tools/helm-sandbox.c:208` comment warning.
- Live DB mtime unchanged: `1781838325`.

### Full suite: ALLOWED FAILURE ONLY

- Command: `HELM_DB_PATH=/tmp/helm-phaseD-b-reval-full-*.db npx vitest run`
- Result: exit 1 due to the allowed emit-status failure only.
- 20 test files passed, 1 failed.
- 245 tests passed, 1 failed, 3 skipped.
- Only failing test:
  `src/services/orchestrator-loop.test.ts > orchestrator-loop B8 escalation ladder (USE_FAKE_TMUX) > projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)`.
- `src/services/run-orchestrator-service.test.ts` passed in the full suite, including the D-b interview and duplicate-run regression tests.
- Live DB mtime unchanged: `1781838325`.

## Verdict

The D-b duplicate-run fix is validated. The pre-authored/autonomous skip path leaves exactly one complete run row and no duplicate active `planning` row. The interview path still phases through `interview -> planning -> complete`, gates autonomous work until north-star and plan readiness, and remains single-row.

STATUS: PASS
