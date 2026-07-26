# C1 — test-report.md

**Batch:** C1 (KEY-C1) · **Date:** 2026-06-21 · **Branch:** main

## Gate checks (all PASS)

| # | Gate | Command | Result |
|---|------|---------|--------|
| 1 | app.js syntax (unchanged) | `node --check src/web/public/app.js` | ✅ OK |
| 2 | build | `npm run build` | ✅ tsc clean (only pre-existing helm-sandbox.c `-Wcomment` warning, non-fatal) |
| 3 | target test | `HELM_DB_PATH=… npx vitest run src/services/chat-session-service.test.ts` | ✅ 3/3 pass |
| 4 | full suite | `HELM_DB_PATH=… npx vitest run` | ✅ 287 passed \| 3 skipped \| 0 failed (23 files) |

## Target test detail (`chat-session-service.test.ts`, no real tmux)
- ✅ `create()` spawns tmux session and returns session_id (session name matches `helm-testchat-1-`, stored).
- ✅ `sendMessage()` delivers text to pane via `sendAndSubmit`.
- ✅ `terminate()` kills tmux session and removes from store.

## Full suite
`Test Files 23 passed (23) · Tests 287 passed | 3 skipped (290)` — duration ~187s.
Pre-existing tmux stderr lines in `p1-6a.test.ts` (real round-trip cleanup: `can't find session …`)
are expected teardown noise; that file reports 6/6 pass. **Zero failing tests** (north-star satisfied).

## Not covered by unit tests (documented, deferred to C1b/integration)
- The SSE stream route (`reply.hijack` + interval polling) and live tmux spawn are exercised at
  integration time with a real agent; unit tests cover the service logic with injectable fakes
  per the brief (no real tmux in unit tests). The route handlers reuse the proven
  `/api/projects/:id/activity` SSE pattern (writeHead → `:ok` → hijack → synchronous close teardown).
