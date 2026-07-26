# Implementer brief — Phase E-a (mid-run consult + check-ins + helm_tasks writers + completion summary). grok-build.
Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. INCIDENT GUARD: HELM_DB_PATH temp for ALL
tests; never touch live data/helm.db; prove mtime unchanged. VERIFY BUILD with `npm run build` (tsc).
Builds on B+C+D.

## Read first
build-plan.md Phase E (E1,E2,E3 artifact-root,E5). run-orchestrator-service.ts (drain loop, completion
summary, north_star/artifact writing), orchestrator-loop.ts, plumbing-watcher-service.ts +
worker-service.ts (reaper/check-ins), schema.ts (run_tasks status incl failed/deferred from B4;
role_capabilities.checkin_ms; the B5 artifact-root helper getTaskArtifactRoot).

## Tasks (atomic; commit each) — SCOPE = E1 + E2 + E3-writers + E5 (backend; NOT the docs UI or memory UI = E-b)

### E1 — structured mid-run brain consult (inject / redirect / re-brief)
- Add a structured path for projcore (the brain) to INJECT new tasks, REDIRECT/re-brief an existing
  task, mid-run. Injected issues are queued and DRAINED only at safe task boundaries (never mid-task),
  and persisted in the run/task list (run_tasks). Expose via an API the master/owner can call
  (e.g. POST /api/runs/:id/inject {task...}) + the loop drains at boundaries. The run loop continues
  while the (dynamic) queue is non-empty.
- Commit: feat(run): mid-run task inject/redirect drained at task boundaries

### E2 — check-in enforcement + persisted stale->failed
- Enable check-in enforcement from role_capabilities.checkin_ms (seed sensible values). A worker that
  misses its check-in / goes stale becomes an OBSERVABLE persisted run_tasks.status='failed'
  (not hidden in-memory). Tie into the existing reaper/plumbing-watcher.
- Commit: feat(run): check-in enforcement; stale worker -> persisted failed

### E3-writers — artifact root under helm_tasks
- Wire the run/task artifact WRITERS to actually write under <project_dir>/helm_tasks/<tasklist>/<task>/
  using the B5 getTaskArtifactRoot helper (run dir, prompts, validation, changes, decisions per task).
  NEW runs write here. (The Documents UI that reads this is E-b.)
- Commit: feat(artifacts): write run/task artifacts under helm_tasks/<tasklist>/<task>

### E5 — completion summary
- The run completion summary must list: run status, verified requirements, FAILED tasks, DEFERRED
  (not-reproducible) issues, validator + reviewer evidence, and links into helm_tasks. Do NOT overwrite
  failed/deferred terminal signals with a generic complete.
- Commit: feat(run): completion summary (failed + deferred + evidence + helm_tasks links)

## Verify (paste REAL)
1. npm run build clean (tsc). 2. Tests (HELM_DB_PATH temp): inject a task mid-run -> drained at next
   boundary; a stale worker -> persisted failed; new run writes artifacts under helm_tasks/<tasklist>/
   <task>; completion summary includes failed + deferred + links. 3. Full suite (HELM_DB_PATH temp):
   only emit-status. 4. data/helm.db mtime unchanged. 5. Commit each; append changes.md. End DONE/BLOCKED.
Scope fence: run-orchestrator + orchestrator-loop + plumbing-watcher/worker + index routes + schema
(checkin seeds) + tests. NOT the Documents UI / project-memory UI (E-b). Branch feat/helm-agent-port.
