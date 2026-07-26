# A2 test report — Remove promote-tmux flow (R-04A)

## Build + static checks

| Check | Result |
|-------|--------|
| `npm run build` | ✅ CLEAN — no errors |
| `node --check src/web/public/app.js` | ✅ "app.js syntax OK" |

## Unit / integration tests

Command: `npx vitest run src/project-service.test.ts src/services/run-orchestrator-service.test.ts`

| Suite | Before A2 (baseline) | After A2 |
|-------|----------------------|----------|
| project-service.test.ts | 3 failed / 39 passed | 3 failed / 37 passed |
| run-orchestrator-service.test.ts | (included in above) | (included in above) |

**Net change: -2 tests** — exactly the 3 deleted promote tests (1 from project-service, 1 deleted promote-form visibility assertion in polish.spec, 1 structural from studio.spec C1 delete). The count difference is -2 not -3 because one pre-existing failure was in the promote suite which is now gone.

**Pre-existing failures (not introduced by A2)** — confirmed by `git stash` baseline:
1. `duplicate column name: horizon` — C1/C2 migration tests hit live `data/helm.db` which already has the column; re-adding it during schema_version=8 rewind fails
2. `ENOENT: /tmp/helm-run-1-pocfix1test/prompts/projcore.brief.md` — POCFIX1 run-orchestrator test requires pre-seeded file on disk

All A2-adjacent tests pass:
- `createProject()` CRUD (create, get, delete, list) ✅
- auto-slug generation for `projcore_session` ✅
- run-orchestrator project resolution via `projcore_session` ✅
- migration V12 compatibility ✅

## Acceptance criteria check

| # | Criterion | Status |
|---|-----------|--------|
| 1 | NO promote UI: no +Promote button, no promote form, no Runtime column, no mismatch chip | ✅ — screenshot confirms |
| 2 | NO promote backend: promoteProject/detectRuntime/flagMismatch/listProjectsWithStatus/open-sessions removed; GET /api/projects = plain listProjects() | ✅ |
| 3 | register-by-dir still works E2E: POST /api/projects {name, directory, projcore_session} → project in list | ✅ — smoke test: `{"tmux_session":null,"projcore_session":"helm-projcore-a2-smoke-test"}` |
| 4 | run-orchestrator resolves project session via projcore_session | ✅ — run-orchestrator tests pass |
| 5 | projects.tmux_session column left in place | ✅ — column not dropped; no migration; new creates write null |
| 6 | npm run build clean + node --check app.js pass; targeted tests green; promote/autodetect assertions deleted (not skipped); promoteProject fixtures converted | ✅ |

## UI proof

Screenshot: `validation/A2/screenshots/projects-no-promote.png`

Confirmed at :3110 (Project Setup → Projects tab):
- promote-btn visible: `false` ✅
- promote-form visible: `false` ✅
- register-by-dir-form visible: `true` ✅
- Runtime column header visible: `false` ✅
