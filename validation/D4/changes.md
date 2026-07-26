# D4 — Live test-chat as collapsible section in agent detail (R-02D) — changes.md

**Batch:** D4 · **Requirement:** R-02D · **Branch:** main · **Pure app.js restructure**
**Lifecycle:** pre-live (Deferral OFF, ZERO-FAILING-TESTS) · **Escalation:** complexity:medium
No backend changes (C1 transport + C1b panel already exist).

## What & why
Fold the test-chat (previously a separate `card` below the agent detail card, added in C1b) **into**
the agent detail card as a collapsible **"Test chat"** section — sitting after the Escalation ladder
and before the Save/Cancel/Delete buttons. Expanded by default (`chat:false`), consistent with the
D3 collapsible pattern.

## File changed (1) — `src/web/public/app.js`

1. **State:** `collapsedSections` gains a `chat` key defaulting to `false` (expanded):
   `{skills:true, bindings:true, escalation:true, chat:false}`.

2. **New collapsible Test chat section** inside the agent detail card (gated on `selectedAgentId`):
   - Clickable header `data-testid="agent-section-chat"` with the **live/connecting chips moved here**
     (from the old card-header) + `▶ expand`/`▼ collapse` indicator.
   - Body `${!collapsedSections.chat ? html`<div data-testid="chat-panel">…</div>` : null}` containing
     the exact chat controls: `chat-start-btn` / `chat-end-btn` / `chat-pane` / `chat-input` /
     `chat-send-btn` / `chat-err`. (End button moved into a right-aligned row inside the panel.)

3. **Removed the old separate chat card** (the `<div class="card" … data-testid="chat-panel">` with the
   "Test Chat" card-header that sat below the agent card) — no duplicate `chat-panel`.

4. **Untouched:** Identity, Side skills / bindings / escalation sections, and the Save/Cancel/Delete
   row (still present, now directly after the chat section).

## Notes
- `chat-pane` appears twice in app.js, but the second (`:2030`, `cc-col-body cc-chat-scroll`) is the
  **pre-existing Command Center** chat — unrelated. The agent test-chat pane is the single one in the
  agents detail.
- No e2e changes (per brief): all chat testids preserved; the D3 B2/B4 expand fixes are unaffected
  (chat section is expanded by default, so no expand-click needed for it).
