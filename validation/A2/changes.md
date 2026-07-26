# A2 changes — Remove promote-tmux flow (R-04A)

## Summary

Gutted the deprecated `promote-open-tmux-session → project` flow end-to-end. Register-by-directory is now the only project creation path. run-orchestrator reads `projcore_session` (unchanged).

## Files changed

### `src/services/project-service.ts`
- Removed `RuntimeStatus` and `OpenTmuxSession` interfaces
- Removed `TmuxService` import and constructor parameter (no longer needed)
- Renamed `promoteProject()` → `createProject()`: drops `tmux_session` param and DB write; auto-generates `projcore_session` slug unchanged
- Removed `listOpenTmuxSessions()`, `detectRuntime()`, `flagMismatch()`, `listProjectsWithStatus()`
- Kept `Project` interface with `tmux_session` field (column is vestigial; not dropped)

### `src/index.ts`
- `GET /api/projects` → plain sync `projectService.listProjects()` (dropped `await` + `listProjectsWithStatus`)
- Removed `GET /api/projects/open-sessions` route
- `POST /api/projects` → calls `projectService.createProject()`
- `PUT /api/projects/:id` → removed `body.tmux_session` compat write path (stop writing to vestigial column)
- `new ProjectService(db)` — dropped tmux arg
- `FakeTmuxService.listPanes()` removed (no longer referenced after clean-up)

### `src/web/public/app.js`
- Removed `promoteForm`, `promoteErr`, `openSessions` state
- Removed `loadOpenSessions()` function and its useEffect call
- Removed `statusChip()` mismatch chip renderer
- Removed `+ Promote session` button, `Runtime` column header, runtime cell, mismatch Fix button
- Removed `promote-form` card (the full "Promote open tmux session → project" form)
- Changed `p.projcore_session || p.tmux_session` → `p.projcore_session` (two occurrences)
- Updated colspan 7 → 6 and empty-state text

### `src/project-service.test.ts`
- DELETED: "promote requires name+directory..." test
- DELETED: "autodetect mismatch..." test
- DELETED: "listOpenTmuxSessions + listWithStatus..." test
- Converted: "get/delete..." test to use `createProject()` (no tmux params)
- Removed `makeFakeTmux` from C1 + C4 describes; `new ProjectService(dbs)` (no tmux arg)
- Updated describe title

### `src/services/run-orchestrator-service.test.ts`
- Removed `StubTmux` class and its comment
- `new ProjectService(db)` (no tmux arg)
- Converted all 7 `promoteProject(...)` → `createProject({ name, directory })`
- Removed `expect(proj.tmux_session).toBe('helm_cards')` assertion
- Updated first test description

### `e2e/studio.spec.ts`
- DELETED: C1 promote test ("promote from open tmux, table renders, mismatch ⚠ chip...") entirely
- C2 test: replaced promote form setup with `page.request.post('/api/projects', { data: { name, directory } })` API call; removed stale USE_FAKE_TMUX skip
- C4 test: same — replaced promote form setup with API-direct create; removed stale USE_FAKE_TMUX skip

### `e2e/polish.spec.ts`
- Removed `GET /api/projects/open-sessions` fetch (two occurrences)
- Removed `tmux_session` from POST `/api/projects` payloads
- Deleted `promote-form` visibility assertion
- Updated comments

## Kept untouched
- `GET /api/memory/promote` route (memory promote, not tmux promote)
- `register-by-dir` form and `POST /api/projects` happy path
- `projects.tmux_session` column (vestigial, nullable; no migration)
- All run/master/worker/orchestrator machinery
- `projcore_session` auto-slug logic (unchanged)
