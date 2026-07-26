# TZ1 changes — Drive full suite to zero failures + A2 red-team cleanups

## Summary

Fixed all 4 failing tests (migration fixture coupling, external script dependency, planning-phase brief write path) and 2 A2 red-team cleanups (Status column, 5 stale comments). Full suite: 252 passed | 3 skipped | 0 failed.

## Files changed

### `src/project-service.test.ts`

**C1 migration test** (item #1): Replaced live-db-copy approach with a `makeV8FixtureDb(path)` helper that builds a synthetic SQLite DB using the real v8 DDL (schema_version=8, agent_events+seq, agents+definition_md, role_bindings/role_defaults/project_master_models, master_runtimes+toolkits_sha, master_switches, worker_runtimes, toolkits, agent_toolkits). Seeds 1 agent row. Migration chain v8→SCHEMA_VERSION runs cleanly: models created by v9, projects by v12, project_agents by v13. Removed live-db copy fallback entirely.

**C2 migration test** (item #2): Same `makeV8FixtureDb` helper. Same fix — removed live-db copy. Assertions unchanged (agentsC > 0, modelsC > 0, hasPa = true, paCount >= 0).

Added `makeV8FixtureDb(dbPath)` helper function after `makeTempDb()`.

### `src/services/planning-phase-service.ts`

**Item #4 (POCFIX1 ENOENT)**: Moved `await this.artifacts.writeBrief(runDir, 'projcore', planningBrief)` from inside the `if (!isPlanner)` block to BEFORE it. Previously, when `selectCoPlannerMode` returned `'planner'` (the fast-path for non-cross-cutting north-stars), `prompts/projcore.brief.md` was never written to disk. The POCFIX1 test's north-star matched the 'planner' path → ENOENT when the test read the brief file. Now always persisted.

### `src/services/orchestrator-loop.test.ts`

**B8 test (item #3)**: Replaced `execSync('~/.claude/agents/lib/projcore-emit-status.sh ...')` with `execSync('bash "${stub}" ...')` where `stub` is a repo-local path resolved via `import.meta.url`. The stub at `src/test-fixtures/projcore-emit-status.sh` implements the identical callback contract. Changed temp file from fixed `/tmp/poc15-sh-cb.md` to `path.join(os.tmpdir(), 'poc15-sh-cb-${Date.now()}.md')` (collision-safe). Added `fss.unlink(cb)` cleanup.

### `src/test-fixtures/projcore-emit-status.sh` (new file)

Repo-local stub implementing the same emit-status contract:
- Accepts `<role> <batch-id> <state> [note]` args
- Reads `PROJCORE_CALLBACKS_FILE` from env (required)
- Appends `[projcore callback] <role> <batch-id> STATUS: <state> — <note>` to the file
- `set -euo pipefail`; fails fast on missing args or env var

### `src/web/public/app.js`

**Item #5**: Removed vestigial `<th>Status</th>` header and `<td><span class="chip chip-green">ok</span></td>` row cell. Updated `colspan="6"` → `colspan="5"` in the empty-state row. Projects table now shows: Project / Directory / projcore session / Primary driver / (actions).

**Item #6 (2 of 5 stale comments)**: Updated `app.js:347` (removed `sessionName=project.tmux_session e.g. 'helm_cards' for 'cards' project`) and `app.js:1554` (updated "configurable projcore tmux_session" → "projcore_session").

### `src/index.ts`

**Item #6 (2 of 5 stale comments)**: Updated `index.ts:196` (removed `per project.tmux_session e.g. helm_cards`) and `index.ts:810` (removed `project.tmux_session e.g. 'helm_cards' for cards project`).

### `src/services/real-transport.ts`

**Item #6 (1 of 5 stale comments)**: Updated `real-transport.ts:97` (removed `e.g. 'helm_cards' from projects.tmux_session`).

## Root causes resolved

| # | Root cause | Fix |
|---|-----------|-----|
| C1/C2 migration | Live db at v29 already has `horizon` col; v8→v19 migration adds it unconditionally → "duplicate column name" | Synthetic v8 fixture: no memories table at v8, horizon block skips, memories created clean at v16 |
| B8 external script | `~/.claude/agents/lib/projcore-emit-status.sh` not in repo → fails in any non-JROM env | Repo-local stub with identical contract at `src/test-fixtures/projcore-emit-status.sh` |
| POCFIX1 ENOENT | `writeBrief('projcore', ...)` was inside `if (!isPlanner)` → skipped on planner fast-path | Moved outside the guard; always persisted |
| Status column | Leftover static `<td>ok</td>` after A2 removed runtime detection | Removed header + cell, colspan 6→5 |
| Stale comments | 5 comments referenced `project.tmux_session e.g. helm_cards` after tmux removed | Updated to reference `projcore_session` |
