# Phase E-a Validation - codex55

Date: 2026-06-19
Validator: codex55
Verdict: FAIL

## Scope

Validated `seeds/agent-port-2026-06-19/briefs/phaseE-a-validate-codex55.md` against the current tree using temp `HELM_DB_PATH` only. Live DB `data/helm.db` was not intentionally opened or written by the probes/build/suite, and its mtime stayed unchanged during each command.

Live DB mtime proof:

- Runtime probes: `before=1781867927 after=1781867927 unchanged=yes`
- `npm run build`: `before=1781867927 after=1781867927 unchanged=yes`
- Full suite: `before=1781867927 after=1781867927 unchanged=yes`

## Commands Run

- `HELM_DB_PATH=/tmp/helm-phaseE-a-probe-*.db USE_FAKE_TMUX=1 NODE_ENV=test node ...`
- `HELM_DB_PATH=/tmp/helm-phaseE-a-build-*.db npm run build`
- `HELM_DB_PATH=/tmp/helm-phaseE-a-full-*.db npx vitest run`

Build result: PASS.

Full suite result: expected non-zero only for the pre-existing allowed emit-status failure:

- `src/services/orchestrator-loop.test.ts > projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)`
- Summary: `1 failed | 20 passed`; `249 passed | 3 skipped`

## Runtime Probe Results

### E1 mid-run inject drained at task boundary

PASS.

Probe created an active run with one in-flight task, injected `TINJ`, verified `getNextReady()` returned `null` before the boundary while the first task was in flight, then completed the first task and verified the injected task was the next drained task.

Observed row:

- Before boundary: `{ id: 2, task_key: "TINJ", label: "injected at mid-run boundary", status: "pending" }`
- After boundary drain: task id `2`

Static support:

- `TaskQueueService.enqueueTask()` records and enqueues injected tasks.
- `TaskQueueService.getNextReady()` blocks while `inFlight` is set.
- `markComplete()` clears `inFlight`, allowing the injected task to drain at the next boundary.

### E2 stale check-in -> persisted failed

FAIL end-to-end.

The stale check-in path works only when the `worker_runtimes` row is already manually linked to a run:

- Worker row became `state='reaped'`, `exit_reason='checkin-missed'`, `run_id=2`.
- Linked `run_tasks` row became `status='failed'`.

However, ordinary worker spawn is not wired to persist `run_id`, so the real spawned-worker path cannot map a stale worker back to `run_tasks`.

Evidence:

- `src/services/worker-service.ts:88` inserts `worker_runtimes (project_id, role, provider, model, task_brief, correlation_id, state, spawned_by, started_at)` with no `run_id`.
- `src/services/worker-service.ts:179` calls `markRunTaskFailedForWorker(row, reason)` on reap.
- `src/services/worker-service.ts:275` immediately returns when `!worker.run_id`.

This satisfies a manually linked unit path, but not the requested runtime contract that a spawned worker missing check-in becomes a persisted failed run task.

### E3 artifacts under helm_tasks

PARTIAL.

A new run did write run-level and task-level artifacts under `<project_dir>/helm_tasks/<tasklist>/...`.

Observed files:

- `helm_tasks/phaseEaRun/run/completion-summary.md`
- `helm_tasks/phaseEaRun/run/north_star.md`
- `helm_tasks/phaseEaRun/run/prompts/prompt.brief.md`
- `helm_tasks/phaseEaRun/task4/prompts/implementer.brief.md`
- `helm_tasks/phaseEaRun/task4/prompts/validator.brief.md`
- `helm_tasks/phaseEaRun/task5/changes.md`
- `helm_tasks/phaseEaRun/task5/final.json`
- `helm_tasks/phaseEaRun/task5/prompts/validator.brief.md`

Gap: per-task writers use task-id fallback directories (`task4`, `task5`), not task keys (`FAIL1`, `DEF1`). `orchestrator-loop.ts` passes `taskKey` as `null` when mirroring briefs/final state:

- `src/services/orchestrator-loop.ts:284` calls `writeBriefToHelmRoot(..., this.taskId, null, role, brief)`.
- `src/services/orchestrator-loop.ts:902` calls `getTaskArtifactRoot(..., this.taskId, null)`.

The failed task also had prompts only under `task4`; no `final.json` or `changes.md` was written for that failed task in the observed run.

### E5 completion summary failed + deferred + evidence + links

FAIL due broken links.

The completion summary correctly included:

- Run status `failed`.
- Failed task `FAIL1`.
- Deferred issue `DEF1`.
- Validator evidence lines.
- A Helm task artifacts section.
- Preserved task statuses: `FAIL1=failed`, `DEF1=deferred`; it did not overwrite them as generic complete.

But the failed task link is wrong:

- Summary link: `helm_tasks/phaseEaRun/FAIL1/`
- Actual artifact directory: `helm_tasks/phaseEaRun/task4/`

Cause:

- `src/services/run-orchestrator-service.ts:467` builds failed-task links from `task_key`.
- The artifact writers use `taskId` fallback because `taskKey` is passed as `null` in `src/services/orchestrator-loop.ts:284` and `src/services/orchestrator-loop.ts:902`.

This means the required summary links are not reliable evidence links.

## Verdict

FAIL.

Blocking gaps:

1. E2 is not end-to-end for actual spawned workers because `spawnWorker()` does not persist `run_id`; stale check-in can only mark `run_tasks.status='failed'` for manually linked worker rows.
2. E3/E5 artifact/link contract is inconsistent: writers create `helm_tasks/<tasklist>/task<id>/...`, while completion summary links to `helm_tasks/<tasklist>/<task_key>/...`; the observed `FAIL1` link is broken, and the failed task lacked mirrored `final.json`/`changes.md`.

---

# Re-validation - latest Phase E-a fixes

Date: 2026-06-19
Validator: codex55
Verdict: FAIL

## Scope

Re-validated latest commits:

- `176f7ef fix(E2): persist run_id + run_task linkage on WorkerService.spawnWorker so stale check-in can map to + mark run_tasks failed`
- `b2d49eb fix(E3/E5): use getTaskArtifactRoot as single source for writer dirs + summary links (no more taskKey vs taskId disagreement)`
- `f36f99f fix(test): add run_id to c3-writefence hand-rolled worker_runtimes schema (E2 spawn now persists run_id)`

Required checks:

1. Stale/missed-checkin worker becomes persisted `run_tasks.status='failed'` mapped to the right run-linked task.
2. Completion-summary evidence links resolve to the actual written `helm_tasks/<tasklist>/<task>` directory.
3. `npm run build` clean.
4. Full suite with temp `HELM_DB_PATH`, only emit-status allowed.
5. `data/helm.db` mtime unchanged.

## Commands Run

- Runtime probes: `HELM_DB_PATH=/tmp/helm-phaseE-a-reprobe-*.db USE_FAKE_TMUX=1 NODE_ENV=test ... node --import tsx --input-type=module`
- Build: `HELM_DB_PATH=/tmp/helm-phaseE-a-build-*.db npm run build`
- Full suite: `HELM_DB_PATH=/tmp/helm-phaseE-a-full-*.db npx vitest run`

Live DB mtime proof:

- Runtime probes: `before=1781867927 after=1781867927 unchanged=yes`
- Build: `before=1781867927 after=1781867927 unchanged=yes`
- Full suite: `before=1781867927 after=1781867927 unchanged=yes`

## Results

### E2 run-linked stale check-in

PASS.

Runtime probe used normal `WorkerService.spawnWorker({ projectId: 4201, role: 'implementer', runId })`, not a manually inserted linked worker row. The spawned worker persisted `run_id=1`; after forcing `started_at` stale and running `_reapTick`, the worker became `state='reaped'`, `exit_reason='checkin-missed'`, and the correct linked task became `status='failed'`.

Observed:

```json
{
  "spawnedRunId": 1,
  "workerRow": { "id": 1, "run_id": 1, "state": "reaped", "exit_reason": "checkin-missed" },
  "taskRows": [
    { "id": 1, "task_key": "E2TASK", "status": "failed" },
    { "id": 2, "task_key": "E2DONE", "status": "complete" }
  ]
}
```

Static support:

- `src/services/worker-service.ts:34` accepts `runId`.
- `src/services/worker-service.ts:89` inserts `worker_runtimes.run_id`.
- `src/services/worker-service.ts:232` reaps stale check-ins as `checkin-missed`.
- `src/services/worker-service.ts:280` maps the worker run to the active `run_tasks` row and `src/services/worker-service.ts:282` persists `status='failed'`.

### E3/E5 summary links to actual artifacts

FAIL.

The writer side now creates the actual task-key directory and writes task artifacts there:

Observed actual files:

- `helm_tasks/phaseEaReprobe/FAIL1/changes.md`
- `helm_tasks/phaseEaReprobe/FAIL1/final.json`
- `helm_tasks/phaseEaReprobe/FAIL1/prompts/implementer.brief.md`
- `helm_tasks/phaseEaReprobe/run/completion-summary.md`
- `helm_tasks/phaseEaReprobe/run/north_star.md`
- `helm_tasks/phaseEaReprobe/run/prompts/prompt.brief.md`

But the generated completion summary link still does not resolve:

- Summary link: `helm_tasks/phaseEaReprobe/phaseEaReprobe/FAIL1/`
- Actual directory: `helm_tasks/phaseEaReprobe/FAIL1/`
- Probe resolution: `linkExists=false`

Observed summary excerpt:

```text
## FAILED Tasks
- FAIL1: intentionally fail validation for E5 links  → helm_tasks/phaseEaReprobe/phaseEaReprobe/FAIL1/
## Helm Task Artifacts
Per-task artifacts written under: helm_tasks/phaseEaReprobe/<task>/ (prompts/, final.json, changes.md, ...)
```

Cause: `src/services/run-orchestrator-service.ts:470` computes `full = getTaskArtifactRoot('/_b', runId, batchId, f.id, f.task_key || null)`, so `sub` already includes `<tasklist>/<task>`. `src/services/run-orchestrator-service.ts:472` then prepends `linkBase = helm_tasks/<tasklist>`, duplicating the tasklist segment.

The new unit test did not catch this because it derives `taskPart` from `sub.split('/').pop()` before forming the expected link, while production code uses the full `sub`.

### Build and Suite

Build: PASS.

- `npm run build` exited `0`.
- Existing C compiler warning remains: `tools/helm-sandbox.c:208:56: warning: "/*" within comment`.

Full suite: expected non-zero only for the allowed emit-status failure.

- `src/services/run-orchestrator-service.test.ts`: PASS, including the new E2 unit test.
- Full suite summary: `1 failed | 20 passed`; `251 passed | 3 skipped`.
- Only failure: `src/services/orchestrator-loop.test.ts > projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)`.

## Verdict

FAIL.

Closed:

- E2 run-linked stale/missed-checkin worker persistence is now closed by runtime probe.

Still open:

- E3/E5 completion summary links still do not resolve to the actual artifact directory. The writer creates `helm_tasks/<tasklist>/<task>/`, but production summary currently links to `helm_tasks/<tasklist>/<tasklist>/<task>/`.

---

# Final Re-validation - E5 summary link fix

Date: 2026-06-19
Validator: codex55
Verdict: PASS

## Scope

Validated commit:

- `aec4a63 fix(E5): completion-summary link no longer duplicates tasklist segment (helm_tasks/<list>/<task>)`

Required confirmations:

1. Completion-summary evidence links resolve exactly to the actual written `helm_tasks/<tasklist>/<task>` directory.
2. Stale/missed-checkin worker still becomes a persisted failed `run_tasks` row mapped to the right run-linked task.
3. `npm run build` succeeds.
4. Full suite uses temp `HELM_DB_PATH`; only emit-status may fail.
5. `data/helm.db` mtime unchanged.

## Commands Run

- Runtime probe: `HELM_DB_PATH=/tmp/helm-phaseE-a-final-*.db USE_FAKE_TMUX=1 NODE_ENV=test node --import tsx --input-type=module ...`
- Build: `HELM_DB_PATH=/tmp/helm-phaseE-a-build-final-*.db npm run build`
- Full suite: `HELM_DB_PATH=/tmp/helm-phaseE-a-full-final-*.db npx vitest run`

Live DB mtime proof:

- Runtime probe: `before=1781867927 after=1781867927 unchanged=yes`
- Build: `before=1781867927 after=1781867927 unchanged=yes`
- Full suite: `before=1781867927 after=1781867927 unchanged=yes`

## Runtime Probe Evidence

### E2 stale check-in -> persisted failed run_task

PASS.

Normal `WorkerService.spawnWorker({ runId })` persisted `worker_runtimes.run_id`; after forcing the worker stale and running `_reapTick`, the worker reaped with `exit_reason='checkin-missed'` and the correct linked working task became failed.

Observed:

```json
{
  "spawnedRunId": 1,
  "workerRow": { "id": 1, "run_id": 1, "state": "reaped", "exit_reason": "checkin-missed" },
  "taskRows": [
    { "id": 1, "task_key": "E2TASK", "status": "failed" },
    { "id": 2, "task_key": "E2DONE", "status": "complete" }
  ]
}
```

### E5 completion-summary link resolves exactly

PASS.

Actual failed-run summary link:

- `helm_tasks/phaseEaFinal/FAIL1/`

Resolved link:

- `/tmp/helm-e3e5-final-Blt91D/helm_tasks/phaseEaFinal/FAIL1`

Actual written directory:

- `/tmp/helm-e3e5-final-Blt91D/helm_tasks/phaseEaFinal/FAIL1`

Probe result:

- `linkExists=true`
- `exactMatch=true`

Observed files under the project:

- `helm_tasks/phaseEaFinal/FAIL1/changes.md`
- `helm_tasks/phaseEaFinal/FAIL1/final.json`
- `helm_tasks/phaseEaFinal/FAIL1/prompts/implementer.brief.md`
- `helm_tasks/phaseEaFinal/run/completion-summary.md`
- `helm_tasks/phaseEaFinal/run/north_star.md`
- `helm_tasks/phaseEaFinal/run/prompts/prompt.brief.md`

Summary excerpt:

```text
## FAILED Tasks
- FAIL1: intentionally fail validation for E5 links  → helm_tasks/phaseEaFinal/FAIL1/
## Helm Task Artifacts
Per-task artifacts written under: helm_tasks/phaseEaFinal/<task>/ (prompts/, final.json, changes.md, ...)
```

Static support:

- `src/services/run-orchestrator-service.ts:470` computes the artifact path through `getTaskArtifactRoot`.
- `src/services/run-orchestrator-service.ts:471` treats the helper output after `helm_tasks/` as already containing `<tasklist>/<task>`.
- `src/services/run-orchestrator-service.ts:474` prefixes only `helm_tasks/`, avoiding the previous duplicated tasklist segment.

## Build and Suite

Build: PASS.

- `npm run build` exited `0`.
- Existing compiler warning remains in `tools/helm-sandbox.c:208` for `"/*" within comment`; no TypeScript/build failure.

Full suite: acceptable expected result.

- Summary: `1 failed | 20 passed`; `251 passed | 3 skipped`.
- Only failure: `src/services/orchestrator-loop.test.ts > projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)`.

## Verdict

PASS.

Both prior gaps are closed by runtime probe:

- E2: run-linked stale/missed-checkin worker persists the correct `run_tasks.status='failed'`.
- E5: completion-summary evidence link resolves exactly to the actual written `helm_tasks/<tasklist>/<task>` directory, with no duplicated tasklist segment.
