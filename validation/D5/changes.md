# D5 — Block in_development agents from project assignment (R-02E gating) — changes.md

**Batch:** D5 · **Req:** R-02E (gating half; D1 added the flag + UI toggle) · **Branch:** main
**Complexity:** medium · **HEAD at dispatch:** 7fd4623 · No schema/migration/new files.

## Files changed (3)

### `src/services/project-agent-service.ts`
- **`addAgent`** — existence check now selects `in_development` and rejects flagged agents:
  `if (agent.in_development === 1) throw new Error('agent is in development and cannot be assigned to a project')`
  (placed after the unknown-agent check, before the unknown-project check). 404/409 mapping upstream unchanged.
- **`addAllAgents`** — the agent SELECT now filters out flagged agents:
  `SELECT id FROM agents WHERE in_development = 0 OR in_development IS NULL` (was `SELECT id FROM agents`).
  Idempotent add-all stays safe; in_development agents are simply skipped.

### `src/web/public/app.js`
- **`avail` filter** (project-agents add path) now hides flagged agents:
  `(agentsList || []).filter((a) => !a.in_development && !(projectAgents||[]).some(pa => pa.agent_id === a.id))`.

### `src/project-service.test.ts`
- Added 2 tests at the end of `describe('C2 ProjectAgentService …')`:
  1. **`D5: addAgent rejects agent with in_development=1`** — seeds an in_development agent, asserts
     `addAgent` throws `/in.development/` and the agent is absent from `listProjectAgents`.
  2. **`D5: addAllAgents skips in_development agents`** — seeds an in_development agent, asserts `addAllAgents`
     adds the ready aid1/aid2 but not the flagged one.

## Test counts
- **Before:** 292 passed, 3 skipped, 0 failed.
- **After:** **294 passed, 3 skipped, 0 failed** (+2 D5 tests).

## Gates (all PASS)
- `node --check src/web/public/app.js` → exit 0
- `npx tsc --noEmit` → clean
- `npx vitest run` → 294 passed / 0 failed

## Notes
- Existing `addAllAgents` tests are unaffected: the C2 `beforeEach` seeds agents without the
  `in_development` column (defaults to 0), so the new filter doesn't change their behavior.
- Brief line refs and code matched the actual source exactly — no drift this batch.
