# Implementer brief — Phase B-schema (Helm foundation). grok-build.

Repo: /home/agjrom/TGBOTS/Helm (cwd). Branch: **feat/helm-agent-port** — STAY on it, do NOT create
a new branch. Verifier ≠ fixer: do NOT self-certify; codex-5.5 validates + I verify independently.
Paste REAL command output for every claim.

## Read first
- seeds/agent-port-2026-06-19/plan/build-plan.md → Phase B. Your scope = **B1, B2, B4, B5 ONLY**.
  Do NOT do B3/B6 (UI) — that is the next batch. Do NOT touch app.js or any UI.
- src/db/schema.ts (current SCHEMA_VERSION, table + migration + seed patterns).
- src/services/task-queue-service.ts + src/services/run-orchestrator-service.ts (markComplete /
  in-memory failedTasks).

## Tasks (atomic; commit each)

### B1 — `teams` + `team_members` tables
- `teams`(id PK, name TEXT UNIQUE NOT NULL, type TEXT CHECK(type IN('deliberation','red-team','generic')) NOT NULL, consensus_rule TEXT, created_at, updated_at).
- `team_members`(id PK, team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, model_id INTEGER NOT NULL REFERENCES models(id), lens TEXT, position INTEGER NOT NULL DEFAULT 0, context_meta TEXT, UNIQUE(team_id, model_id)). Index idx on team_id.
- Bump SCHEMA_VERSION; migration in the existing style. Seed two default teams (resolve model ids from `models` by name; skip a member if its model is absent):
  - `deliberation-team` (type deliberation): opus, codex-5.5, sonnet, spark.
  - `red-team` (type red-team): codex-5.5, sonnet, spark (standard tier).
- Commit: `feat(teams): teams + team_members tables + default rosters`

### B2 — role→team binding contract
- Let roles `deliberation` / `red-team` bind to a TEAM (not only an agent). Pick the LOWER-RISK
  option given current role_bindings usage and document the choice + why in changes.md:
  (a) add nullable `team_id` to role_bindings with agent_id XOR team_id, OR (b) a `role_team_bindings`
  table. Binding a team must NOT trigger the agent-FK delete-409 path.
- Commit: `feat(teams): bind deliberation/red-team roles to a team`

### B4 — persist failed + deferred task states (G5; MUST land before G7)
- Migrate `run_tasks.status` CHECK to allow `failed` and `deferred` (plus pending/working/complete).
- TaskQueueService: add `markFailed` (persist run_tasks.status='failed') + `markDeferred`
  (status='deferred' — distinct from failed; deferred = not-reproducible issue). Wire
  run-orchestrator to PERSIST these (today failed is in-memory only).
- failed/deferred must NOT block the queue drain of independent ready tasks.
- Commit: `feat(run): persist failed + deferred run_task states`

### B5 — artifact-root contract
- Add a helper that builds the task artifact root `<project_dir>/helm_tasks/<tasklist>/<task>/`
  from project dir + run/batch id + task id, and record run/task ids on `artifacts` rows (add
  columns if needed). NEW runs only; do NOT migrate old artifacts. (Full writer wiring is C/E —
  here: the path contract + helper + any DB columns + a unit test for the helper.)
- Commit: `feat(artifacts): helm_tasks/<tasklist>/<task> artifact-root contract`

## Verify (paste REAL output)
1. `npm run build` (tsc) clean.
2. `npx vitest run` — note pass/fail; the pre-existing `projcore-emit-status.sh` test failure is
   NOT yours, everything else must pass.
3. `sqlite3 data/helm.db '.schema teams' '.schema team_members'`; print the run_tasks CHECK; print
   the seeded team rows + members.
4. Append `seeds/agent-port-2026-06-19/changes.md` (what/why/files+lines/migration notes/B2 choice
   rationale). Report DONE with build + test counts.

## Scope fence
ONLY B1,B2,B4,B5 + their migrations/seeds/tests. Do NOT touch app.js / UI, do NOT change the
orchestrator validation path (Phase C), do NOT spawn agents. Branch feat/helm-agent-port only.
