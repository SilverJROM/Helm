# E1 — KEY-E1: propose→approve substrate (agent definition changes) — changes.md

**Batch:** E1 · **Req:** KEY-E1 · **Complexity:** high [DELIB] · **Branch:** main · **Schema:** v32→**v33**
**Lifecycle:** pre-live (Deferral OFF, ZERO-FAILING-TESTS) · **HEAD at dispatch:** 7fd4623

## Design (co-planner codex-5.5, settled in brief §0)
Agent POSTs a proposed `definition_md` to a loopback ingest route → stored in `agent_proposals`
(status `pending`) → owner approves (applies via `updateAgent`) or rejects, from a new "Proposals"
collapsible section in the agent detail card.

## Files changed (6)

1. **`src/db/schema.ts`** — `SCHEMA_VERSION` 32→33; added `agent_proposals` table to SCHEMA_SQL
   (after the `memories` indexes): id, agent_id (FK → agents ON DELETE CASCADE), chat_session_id,
   proposed_definition_md, status CHECK(pending|approved|rejected) default pending, created_at, resolved_at.

2. **`src/db/database.ts`** — v33 migration block (`CREATE TABLE IF NOT EXISTS agent_proposals` +
   `UPDATE schema_version SET version=33`), placed at the **end of the runner after my D2 v32 block**.
   No `hasTable` guard needed: `CREATE TABLE` with a forward FK to `agents` is legal even on the
   agents-less synthetic fixtures (SQLite enforces FK at DML time, not CREATE time) — verified by the
   v29→v30 models-only fixture test staying green.

3. **`src/services/agent-proposal-service.ts`** (NEW) — `AgentProposalService`:
   `createProposal` (validates agent + non-empty md), `listProposals` ({agent_id?, status?} filters,
   newest-first), `approveProposal` (guards pending, applies `agentService.updateAgent({definition_md})`,
   marks approved), `rejectProposal` (guards pending, marks rejected). `ProposalRow` typed mapper.

4. **`src/index.ts`** — import + `const agentProposalService = new AgentProposalService(db, assignmentService)`
   (after memoryService) + 4 routes in the ingest section (after memory-query):
   - `POST /api/ingest/agent-propose` (loopback only, `requireLocalLaunchPre`; 400/404)
   - `GET  /api/proposals` (owner; `?agent_id=&status=` filters)
   - `POST /api/proposals/:id/approve` (owner + local; 404/400)
   - `POST /api/proposals/:id/reject` (owner; 404/400)

5. **`src/web/public/app.js`** — `collapsedSections` gains `proposals:true` (collapsed default);
   `agentProposals` state; helpers `loadAgentProposals`/`approveProposal`/`rejectProposal`;
   `selectAgent` loads proposals, `startNewAgent` clears them; new **PROPOSALS** collapsible section
   (5th, after Chat, before Save/Cancel/Delete) with `agent-section-proposals` header (pending-count
   chip), `proposals-panel`, and per-proposal `proposal-row-<id>` / `approve-proposal-<id>` /
   `reject-proposal-<id>`.

6. **`src/services/agent-proposal-service.test.ts`** (NEW) — 4 tests: create+list, approve (writes
   definition_md + double-approve throws), reject (definition_md unchanged + double-reject throws),
   unknown-agent throws + empty list.

## Test counts
- **Before:** 294 passed, 3 skipped, 0 failed.
- **After:** **298 passed, 3 skipped, 0 failed** (+4 E1 tests; 24 test files).

## Gates (all PASS)
- `node --check src/web/public/app.js` → exit 0
- `npx tsc --noEmit` → clean
- `npx vitest run` → 298 passed / 0 failed

## Notes
- Migration-preservation + version-assertion tests use the imported `SCHEMA_VERSION` constant, so they
  track 33 automatically; v33 is purely additive (no agent/row impact).
- Live `data/helm.db` (gitignored, at v32 from D2) will migrate 32→33 on next server start — proven by
  the live-db-copy migration tests in the suite. Not pre-applied (no gate item required it).
