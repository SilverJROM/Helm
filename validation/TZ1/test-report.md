# TZ1 test report — Zero failures + A2 red-team cleanups

## Build + static checks

| Check | Result |
|-------|--------|
| `npm run build` | ✅ CLEAN |
| `node --check src/web/public/app.js` | ✅ "app.js syntax OK" |

## Full suite run

Command: `HELM_DB_PATH=/tmp/helm-tz1-test-<ts>.db npx vitest run`

```
Test Files  21 passed (21)
     Tests  252 passed | 3 skipped (255)
  Start at  02:20:55
  Duration  193.74s
```

**0 failed. 252 passed. 3 skipped (pre-existing intentional skips, unchanged).**

## Items fixed

| # | Test / Site | Before | After |
|---|------------|--------|-------|
| 1 | C1 migration test (project-service.test.ts ~78) | FAIL: duplicate column name: horizon | ✅ PASS — synthetic v8 fixture |
| 2 | C2 migration test (project-service.test.ts ~215) | FAIL: duplicate column name: horizon | ✅ PASS — synthetic v8 fixture |
| 3 | B8 projcore-emit-status.sh test (orchestrator-loop.test.ts ~591) | FAIL: ~/.claude/agents/lib/... not found | ✅ PASS — repo-local stub |
| 4 | POCFIX1 ENOENT (run-orchestrator-service.test.ts ~368) | FAIL: ENOENT prompts/projcore.brief.md | ✅ PASS — writeBrief outside isPlanner guard |
| 5 | Status column | Visible in Projects table (static green "ok") | ✅ Gone — header + cell removed, colspan 5 |
| 6 | Stale tmux_session comments (5 sites) | Referenced project.tmux_session / helm_cards | ✅ Updated to projcore_session |

## Acceptance criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `HELM_DB_PATH=/tmp/... npx vitest run` → 0 failed | ✅ 252 passed, 3 pre-existing skips unchanged |
| 2 | `npm run build` clean + `node --check app.js` pass | ✅ |
| 3 | Migration tests pass via synthetic fixture (robust to live db evolution) | ✅ makeV8FixtureDb builds from real v8 DDL |
| 4 | B8 no longer depends on external `~/.claude/agents/` script | ✅ repo-local stub at src/test-fixtures/projcore-emit-status.sh |
| 5 | Projects table has NO Status column; verified on :3110 | ✅ headers: ["Project","Directory","projcore session","Primary driver",""] |
| 6 | No stale tmux_session comments (grep clean) | ✅ 0 matches for `tmux_session.*e\.g\|from projects\.tmux_session\|configurable projcore tmux_session` |

## UI proof

Screenshot: `validation/TZ1/screenshots/projects-no-status-col.png`

Confirmed table headers at :3110: `["Project","Directory","projcore session","Primary driver",""]` — no "Status" column.
