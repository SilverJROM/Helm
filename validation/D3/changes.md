# D3 — Full-screen Agents page + compact collapsible detail (R-02B/C/H) — changes.md

**Batch:** D3 · **Requirements:** R-02B + R-02C + R-02H · **Branch:** main · **Pure frontend/CSS**
**Lifecycle:** pre-live (Deferral OFF, ZERO-FAILING-TESTS) · **Escalation:** complexity:high

## What & why
Make the Agents studio full-screen (R-02B: 0 outer padding, wider 280px list, full-bleed 2-col
that stacks under 768px) and the detail pane compact (R-02C: Side skills / App-managed bindings /
Escalation ladder are collapsible, all collapsed by default; Identity stays always visible). R-02H:
responsive mobile stacking. No routes, no schema, no `.ts` service files.

## Files changed (3)

### `src/web/public/index.html`
- Added `@media (max-width:768px)` block: `.agents-studio-layout` stacks to column; `.agents-list-col`
  goes full-width with a max-height + bottom border (after the existing 480px blocks).

### `src/web/public/app.js`
- **State:** `collapsedSections` useState `{skills:true, bindings:true, escalation:true}` — persists
  across agent selection (component-level state, not reset by `selectAgent`).
- **Full-screen:** outer content wrapper `padding:0` when `currentSlug==='02-studio-agents'` (else
  `16px 20px`); agents content div gets `class="agents-studio-layout"`; list column 220→**280px**
  (min 260) + `class="agents-list-col"`; detail pane padding `14px 16px`→`12px 14px`.
- **Collapsible sections:** Side skills / App-managed bindings / Escalation ladder each wrapped with a
  clickable header (`▶ expand` / `▼ collapse`) toggling its `collapsedSections` key; content rendered
  only when expanded (`${!collapsed ? html`…` : null}`). Added stable testids
  `agent-section-{skills,bindings,escalation}` on the headers. **Exact existing content preserved**
  inside each section (toolkit list/select, 4 binding rows, rung 1/2 selects).
- **Untouched:** Identity (name + identity prompt), Save/Cancel/Delete actions, and the **chat panel**
  (`data-testid="chat-panel"`) — left exactly as-is.

### `e2e/studio.spec.ts`
- Added `test.describe('D3 R-02B/C layout')` with 2 `.skip` stubs (full-width layout class + collapsible
  toggle), per brief.
- **Scope-expanded (coordinator-approved):** fixed the 2 ungated e2e tests that drive the now-collapsed
  pickers, with the minimal expand-before-interact click:
  - **B4** (`:300`,`:314`) — expand `agent-section-bindings` then `agent-section-escalation` before
    reading the default/backup/escalation pickers.
  - **B2** (`:369`) — expand `agent-section-bindings` once (persists) before the bindings picker flow.

## Why the e2e fix was needed (surfaced via NEEDS-INFO before expanding scope)
The default `test` command is `vitest run` (e2e is a separate Playwright suite, not gated), so the
vitest gate stayed green. But collapse-by-default hid the bindings/escalation pickers, breaking the
ungated B2 + B4 Playwright tests. Coordinator approved the minimal expand-click fix in the in-scope
`e2e/studio.spec.ts`. (Note: `hasText:'grok-build'` in B2 still matches the **implementer** row via its
model display, so D2's agent purge did not affect B2's row lookups.)

## Caveat
e2e runs require a built server + Playwright + USE_FAKE_TMUX; not runnable in this environment, so the
B2/B4 fixes are validated by construction (stable `agent-section-*` testids) + `tsc` compile, not by a
live Playwright run. Recommend the validator confirm e2e green when the server harness is available.
