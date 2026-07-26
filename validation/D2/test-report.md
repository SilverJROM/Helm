# D2 — test-report.md

**Batch:** D2 (R-02A) · **Date:** 2026-06-21 · **Branch:** main · **Schema:** v32

## Gate checklist (all PASS)

| # | Gate | Command | Result |
|---|------|---------|--------|
| 1 | app.js syntax (unchanged) | `node --check src/web/public/app.js` | ✅ OK |
| 2 | TS compile | `npx tsc --noEmit` | ✅ clean |
| 3 | D2 tests + affected files | `npx vitest run model-service.test.ts run-orchestrator-service.test.ts` | ✅ 45/45 |
| 4 | full suite | `npx vitest run` | ✅ **292 passed \| 3 skipped \| 0 failed** (23 files) |
| 5 | live DB stub agents | `sqlite3 data/helm.db "SELECT COUNT(*) … IN (4 stubs)"` | ✅ **0** |
| 6 | live DB role_defaults | `sqlite3 data/helm.db "SELECT COUNT(*) FROM role_defaults"` | ✅ **9** |
| 7 | commit | conventional, atomic, Co-Authored-By | ✅ (see git log) |

## New D2 tests (`src/model-service.test.ts`)
- ✅ Test 1: fresh DB seeds NO model-named stub agents (9 real agents).
- ✅ Test 2: v31→v32 migration removes 4 stubs + their role_bindings; role_defaults=9, real agents intact.
- ✅ Test 3 (REDTEAM): v21→v32 does NOT resurrect stubs — purge wins over the v22 re-seed.

## Updated tests (post-D2 state, no longer assert stubs present)
- ✅ `model-service.test.ts` — live-mig test now asserts stubs purged (models retained); B3 test 9 agents.
- ✅ `run-orchestrator-service.test.ts` — "agents selectable" → real role agents present, stubs absent.
- ✅ `p2-1.test.ts` (×2) — migration-preservation now allows the intended ≤4-stub purge; def_md sample picks a survivor.
- ✅ `plumbing-watcher.test.ts` — same ≤4-stub purge allowance.

## Caught during implementation (and fixed)
- v32 block initially queried `agents` unconditionally → `no such table: agents` on the v29→v30
  synthetic fixture (models-only DB). Fixed with `hasTable('agents')`/`hasTable('role_bindings')` guards.

## Live DB migration (data/helm.db, gitignored — re-runs on server start)
Applied 30→32 once and verified: version 32, 0 stub agents, 9 role_defaults, 11 agents (real only),
0 dangling role_bindings, 3 stub models retained. Backup taken, verified, removed.

## Full suite tail
`Test Files 23 passed (23) · Tests 292 passed | 3 skipped (295)` — ~187s.
