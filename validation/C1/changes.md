# C1 — Agent test-chat transport (SSE+POST) — changes.md

**Batch:** C1 · **Requirement:** KEY-C1 (interactive agent-chat transport — keystone for D4/E2/F3)
**Branch:** main · **Lifecycle:** pre-live (Deferral OFF, ZERO-FAILING-TESTS)
**Transport:** SSE+POST (DELIB consensus codex-5.5 + claude-sonnet, 2026-06-21)

## What & why

Helm Agent Studio needs an "agent test-chat" — talk to an agent directly to set it up
before deploying it to a project. C1 is the **transport layer only** (no UI; C1b wires the
panel). The backend must poll the tmux pane either way (no push from tmux), so SSE+POST wins:
it reuses the existing `/api/projects/:id/activity` SSE pattern, EventSource auto-reconnects,
POST is explicit/debuggable, and `@fastify/websocket` stays unused (no benefit here).

## Files

### New — `src/services/chat-session-service.ts`
`ChatSessionService` with an in-memory `Map<sessionId, ChatSession>` (ephemeral; not persisted
to DB — server restart kills all sessions, acceptable for test-chat).
- `create(agentId)` — resolves agent → spawn (provider, model); if `default_model_id` is set,
  prefers that model but **409s if it is not `valid`** ("agent model is not validated — run
  validation first"). Resolves launch cmd via `resolverService.resolveAgentLaunchSpec({…, mode:'tui'})`,
  creates a tmux session under the sandbox fence, launches, waits for the provider's ready probe.
  On boot failure it tears down the half-created pane (no leak). Returns `{ sessionId, tmuxSession }`.
- `sendMessage(sid, text)` — `tmux.sendAndSubmit`; throws on delivery failure.
- `capturePane(sid)` — `tmux.capturePane(target, 200)`.
- `terminate(sid)` — idempotent; deletes from store + `tmux.terminateSession` (best-effort).
- `hasSession` / `getSession` / `sessionIds` — store accessors (`sessionIds` drives shutdown sweep).

### New — `src/services/chat-session-service.test.ts`
3 tests with injectable fakes (no real tmux): `create()` spawns + returns id, `sendMessage()`
delivers via `sendAndSubmit`, `terminate()` kills + removes. (Fixed the brief's fake
self-reference: the fake object now references itself via a named `fake` const, not a
forward reference to an unassigned binding.)

### Modified — `src/index.ts`
- Import `ChatSessionService`.
- Instantiate `chatSessionService` after `workerService`, reusing the shared
  `tmuxService / modelService / assignmentService / resolverService`. `fenceDir =
  process.env.HELM_FENCE_DIR || process.cwd()`.
- 4 routes (after the model `:id/validate` route, before the projects routes):
  - `POST /api/agents/:agentId/chat-session` — 404 unknown agent, 409 model-not-validated, 500 else.
  - `POST /api/agents/:agentId/chat-session/:sid/message` — 404 unknown session, 400 empty / >2000 chars.
  - `GET  /api/agents/:agentId/chat-session/:sid/stream` — SSE; `sseAuthPre`; hijack;
    poll `capturePane` @500ms emitting `{type:'pane',content}` diffs; 15s heartbeat;
    synchronous `request.raw.on('close')` teardown clearing **both** intervals; on capture
    error emits `{type:'error'}`, clears both intervals, ends.
  - `DELETE /api/agents/:agentId/chat-session/:sid` — idempotent cleanup.
- Shutdown teardown added to **both** `onClose` and `shutdown()`: sweep `sessionIds()` and
  terminate each (leak-safe on server stop).

## 3 API-fidelity fixes vs the brief's pseudocode (all approved, no scope change)
1. **`TmuxService.waitForReady(target, signal='❯', timeoutMs)` takes a STRING ready-probe
   signal, not an `AbortSignal`.** Dropped the brief's `AbortController`/`ctrl.signal`; use the
   provider's `PROVIDERS[provider].readyProbe.signal` (grok `❯`, codex `›`, claude `>`), default `❯`.
2. **`config.fenceDir` does not exist** (config has `HELM_SANDBOX_BIN`, `dbPath`, …). Used the
   verified `RealTransport` pattern `process.env.HELM_FENCE_DIR || process.cwd()`.
3. **Reused the existing `resolverService`** (`index.ts:160`) instead of `new ProviderResolverService()`.

Plus: shutdown teardown wired into **both** lifecycle hooks (not just `onClose`); added a public
`sessionIds()` so the sweep avoids reaching into the private `sessions` map.

## Scope honored
2 files new, 1 modified (index.ts). No app.js change (UI = C1b). No schema change. No changes to
tmux-service / real-transport / model-validation. Session ids = `randomBytes(8).hex`, not persisted.
