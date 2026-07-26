# Phase B-schema Validation — codex-5.5

## Verdict: FAIL

Grok's Phase B-schema implementation is mostly on target and the requested gates are clean except
for the allowed `projcore-emit-status.sh` failure, but I found two blocking schema-contract issues:

1. `role_team_bindings.role` accepts every agent role, not just the TEAM roles `deliberation` and
   `red-team`. The Phase B brief/build-plan contract is specifically "deliberation/red-team can
   bind a TEAM"; allowing `projcore`, `implementer`, `validator`, etc. to bind to a team creates an
   invalid state C1/UI code will have to defend against later. Current schema:
   `src/db/schema.ts:363-370`, migration mirror `src/db/database.ts:663-672`.
   Live proof:
   ```sh
   sqlite3 data/helm.db "BEGIN; INSERT OR IGNORE INTO role_team_bindings(project_id, role, team_id) SELECT 999, 'projcore', id FROM teams WHERE name='red-team'; SELECT project_id, role, team_id FROM role_team_bindings WHERE project_id=999; ROLLBACK;"
   ```
   Output:
   ```text
   999|projcore|2
   ```

2. Fresh schema and migrated schema diverge for `artifacts.task_id`. Fresh `SCHEMA_SQL` declares
   `task_id INTEGER REFERENCES run_tasks(id) ON DELETE SET NULL` (`src/db/schema.ts:220-230`), but
   the v26 migration adds `task_id INTEGER REFERENCES run_tasks(id)` without `ON DELETE SET NULL`
   (`src/db/database.ts:701-709`). On an upgraded DB with `PRAGMA foreign_keys=ON`, deleting a
   referenced task fails instead of nulling the artifact task pointer. That is a migration/data
   integrity risk for the artifact-root contract.
   Live proof:
   ```sh
   sqlite3 data/helm.db "PRAGMA foreign_keys=ON; BEGIN; INSERT INTO runs(batch_id,status,phase) VALUES('codex-check','active','planning'); INSERT INTO run_tasks(run_id, task_key, label, status) VALUES(last_insert_rowid(),'TCHK','check','pending'); INSERT INTO artifacts(run_id, task_id, type, path) VALUES((SELECT max(id) FROM runs), (SELECT max(id) FROM run_tasks), 'check', 'x'); DELETE FROM run_tasks WHERE id=(SELECT max(task_id) FROM artifacts WHERE type='check'); SELECT 'delete-ok'; ROLLBACK;"
   ```
   Output:
   ```text
   Error: stepping, FOREIGN KEY constraint failed (19)
   ```

## Coverage Check

- **B1 teams + team_members:** PASS. `teams` and `team_members` exist with PKs, uniqueness,
  FK to teams, type CHECK, and `idx_team_members_team` (`src/db/schema.ts:339-358`). Seed function
  resolves real model names and skips absent models (`src/db/schema.ts:892-924`). Live DB has:
  deliberation-team = `claude-opus`, `codex-5.5`, `claude-sonnet`, `spark`; red-team =
  `codex-5.5`, `claude-sonnet`, `spark`.
- **B2 team binding:** FAIL. Separate table is the lower-risk choice for avoiding agent-FK
  delete-409, but the role CHECK is too broad and permits non-team roles.
- **B4 failed/deferred task states:** PASS. `run_tasks.status` allows `failed` and `deferred`
  (`src/db/schema.ts:163-174`); migration rebuilds the CHECK (`src/db/database.ts:676-697`);
  `markFailed`/`markDeferred` persist to DB and independent siblings continue draining because
  `getNextReady` skips failed/deferred and continues scanning (`src/services/task-queue-service.ts:35-55`,
  `src/services/task-queue-service.ts:76-105`). Active orchestrator failure paths call
  `markFailed` (`src/services/run-orchestrator-service.ts:258-270`).
- **B5 artifact-root helper:** FAIL on migration consistency only. Helper builds
  `<project>/helm_tasks/<tasklist>/<task>/` (`src/services/run-artifact-service.ts:75-83`), and
  `recordArtifact` records `task_id` (`src/services/run-artifact-service.ts:63-68`). Live upgraded
  DB has `task_id` and `idx_artifacts_task`, but the FK action differs from fresh schema.

## Build + Tests

- `npm run build`: PASS, exit 0. Output included only the existing C warning in
  `tools/helm-sandbox.c:208`.
- `npx vitest run`: expected non-zero due to the allowed pre-existing script failure.
  Final counts:
  ```text
  Test Files  1 failed | 19 passed (20)
       Tests  1 failed | 229 passed | 1 skipped (231)
  ```
  The only failure was:
  `src/services/orchestrator-loop.test.ts > projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)`,
  from `~/.claude/agents/lib/projcore-emit-status.sh red-team bfoo VERDICT-READY "CLEAN"`.
  This is the allowed pre-existing failure from the validation brief.

## SQLite Evidence

Command run:
```sh
sqlite3 data/helm.db '.schema teams' '.schema team_members' '.schema role_team_bindings' "SELECT sql FROM sqlite_master WHERE name='run_tasks';" "SELECT sql FROM sqlite_master WHERE name='artifacts';" "SELECT t.name,t.type,t.consensus_rule,m.name,tm.position FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id LEFT JOIN models m ON m.id=tm.model_id WHERE t.name IN ('deliberation-team','red-team') ORDER BY t.name, tm.position;"
```

Key output:
```text
CREATE TABLE teams (... type TEXT NOT NULL CHECK(type IN('deliberation','red-team','generic')) ...)
CREATE TABLE team_members (... team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE, model_id INTEGER NOT NULL REFERENCES models(id), ... UNIQUE(team_id, model_id))
CREATE INDEX idx_team_members_team ON team_members(team_id);
CREATE TABLE role_team_bindings (... role TEXT NOT NULL CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')), team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE RESTRICT, ...)
CREATE TABLE "run_tasks" (... status TEXT NOT NULL CHECK(status IN ('pending','working','complete','failed','deferred')) DEFAULT 'pending', ...)
CREATE TABLE artifacts (..., task_id INTEGER REFERENCES run_tasks(id))
deliberation-team|deliberation|...|claude-opus|1
deliberation-team|deliberation|...|codex-5.5|2
deliberation-team|deliberation|...|claude-sonnet|3
deliberation-team|deliberation|...|spark|4
red-team|red-team|...|codex-5.5|1
red-team|red-team|...|claude-sonnet|2
red-team|red-team|...|spark|3
```

## Notes

- Scope fence held for schema/services/tests. No `src/web/public/app.js` changes in the Phase B-schema diff.
- Worktree note: before validation, `src/services/run-orchestrator-service.test.ts` was already dirty with an expectation update, and the validation brief was untracked. I did not modify that test.

---

STATUS: FAIL — 1) role_team_bindings accepts non-team roles like projcore; 2) upgraded artifacts.task_id FK lacks ON DELETE SET NULL and diverges from fresh schema.

---

# Re-validation — fd746b4 + c0ce078

## Verdict: FAIL

The two targeted Phase B-schema fixes are correct in source and in isolated SQLite proofs, but the
requested full `npx vitest run` gate now has additional non-excluded failures tied to the current
live `data/helm.db` fixture (`disk I/O error` / missing `agents`). Because the brief only excludes
the pre-existing `projcore-emit-status.sh` failure, I cannot mark the full re-validation PASS.

## Fix Confirmation

1. **role_team_bindings CHECK restricted:** PASS.
   - Source diff: `fd746b4` changes both fresh schema and migration to:
     `role TEXT NOT NULL CHECK(role IN ('deliberation','red-team'))`
     in `src/db/schema.ts` and `src/db/database.ts`.
   - Throwaway SQLite proof:
     ```text
     projcore rejected: CHECK constraint failed: role IN ('deliberation','red-team')
     red-team accepted: red-team
     ```

2. **artifacts.task_id ON DELETE SET NULL fresh + ALTER path:** PASS.
   - Fresh schema has `task_id INTEGER REFERENCES run_tasks(id) ON DELETE SET NULL`.
   - `c0ce078` changes the migration ALTER to the same FK action:
     `ALTER TABLE artifacts ADD COLUMN task_id INTEGER REFERENCES run_tasks(id) ON DELETE SET NULL;`
   - Throwaway SQLite proof:
     ```text
     fresh-style task_id after delete: null
     alter-path task_id after delete: null
     artifact SQL: CREATE TABLE artifacts(... task_id INTEGER REFERENCES run_tasks(id) ON DELETE SET NULL)
     ```

## B1/B4/B5 Regression Check

- B1 team schema/seed code remains intact: teams/team_members definitions, team member index, and
  default roster seed function unchanged by the fix commits.
- B4 failed/deferred status path remains intact: `run_tasks.status` still includes
  `failed`/`deferred`, and `TaskQueueService.markFailed` / `markDeferred` still persist statuses.
- B5 artifact helper and `recordArtifact(..., taskId)` remain intact; the FK action is now aligned
  between fresh schema and ALTER migration path.

## Build + Tests

- `npm run build`: PASS, exit 0. Same existing C warning from `tools/helm-sandbox.c:208`.
- `npx vitest run`: FAIL with additional non-excluded live DB fixture failures.
  ```text
  Test Files  3 failed | 17 passed (20)
       Tests  2 failed | 223 passed | 6 skipped (231)
  ```
  Failures:
  - Allowed/pre-existing: `src/services/orchestrator-loop.test.ts` emit-status script failure.
  - Non-excluded: `src/p1-3.test.ts` suite failed opening `new DatabaseService(config.dbPath)`:
    `SqliteError: disk I/O error`.
  - Non-excluded: `src/services/plumbing-watcher.test.ts` live `data/helm.db` copy test failed:
    `SqliteError: no such table: agents`.

## Live DB Note

Direct `sqlite3 data/helm.db 'PRAGMA integrity_check;'` also returned:
```text
Error: in prepare, disk I/O error (10)
```
The main `data/helm.db` file is currently 4096 bytes with stale shm/wal files present. I did not
repair, replace, or mutate it during this re-validation.

---

STATUS: FAIL — 1) targeted schema fixes pass, but full vitest has non-excluded live data/helm.db failures: p1-3 disk I/O error and plumbing-watcher missing agents table.
