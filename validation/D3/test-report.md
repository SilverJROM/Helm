# D3 — test-report.md

**Batch:** D3 (R-02B/C/H) · **Date:** 2026-06-21 · **Branch:** main · **Pure UI**

## Gate checklist (all PASS)

| # | Gate | Command | Result |
|---|------|---------|--------|
| 1 | app.js syntax | `node --check src/web/public/app.js` | ✅ OK |
| 2 | TS compile (incl. e2e) | `npx tsc --noEmit` | ✅ clean |
| 3 | full suite (vitest) | `npx vitest run` | ✅ **292 passed \| 3 skipped \| 0 failed** |
| 4 | scope | only app.js, index.html, e2e/studio.spec.ts | ✅ |
| 5 | data-testids preserved | agent-row, agent-name-input, agent-save-btn, chat-panel, chat-start-btn, agent-toolkit-select, agent-default-model, agent-in-dev-toggle | ✅ all present (1 each) |
| 6 | collapse defaults | skills/bindings/escalation collapsed on load | ✅ `{skills:true,bindings:true,escalation:true}` |
| 7 | Identity always visible | name + identity prompt NOT wrapped | ✅ |
| 8 | list column 280px | rendered width | ✅ `width:280px;min-width:260px` |
| 9 | outer wrapper 0 padding on agents tab | conditional padding | ✅ `currentSlug==='02-studio-agents'?'0':'16px 20px'` |
| 10 | chat panel untouched | `data-testid="chat-panel"` unchanged | ✅ |

## D3 e2e stubs added (skipped, `/* D3 */`)
- ⏭️ Agents tab uses full-width `agents-studio-layout` class.
- ⏭️ Collapsible bindings: collapsed by default, expands on header click.

## e2e tests fixed (coordinator-approved scope expansion; expand-before-interact)
- B4 (`studio.spec.ts:300,314`) — expand bindings + escalation before the valid-only picker checks.
- B2 (`:369`) — expand bindings once (state persists) before the bindings picker flow.

## Notes
- vitest does NOT run the e2e suite (`vitest.config.ts` include = `src/**/*.test.ts`); e2e is a separate
  Playwright run (`playwright.config.ts`, needs a built server). The B2/B4 fixes are correct by
  construction (stable `agent-section-*` testids) + tsc-validated; a live Playwright run was not possible
  in this environment.
- Collapse-by-default is intentional (R-02C); `collapsedSections` is component-level so it persists
  across agent selection (one expand click covers a whole test flow).
