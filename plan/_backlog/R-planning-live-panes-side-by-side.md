# R — Planning: side-by-side live seat terminals + fix the scroll

**Raised by JROM, 2026-07-30 05:2x PHT** (verbatim):
> "i want to see the plancore working as seen on the tmux session show side by side here on the
> screenshot on planning section, similar to how its showing here on implementation, i want to see
> plancore/planner1/2/etc. and fix the scroll issue on the planning section as well
> (park and defer this until we get a chance)"

**Status: PARKED / DEFERRED at JROM's explicit instruction. Do NOT build until he asks.**
Raised while planning run 32 was mid-flight and working — this is polish, not a defect blocking use.

---

## What already exists (do not rebuild it)

`renderPlanPanes()` in `src/web/public/app.js` **already renders one live pane per planning seat** —
titled `role · model`, streaming real tmux content via `GET /api/cycles/:id/seats/:runtimeId`
(`loadSeatPaneCapture`), with `live` / `historical` chips. **Watch live** (`ccPlanWatchLiveOpen`,
default `true`) toggles the block. Historical seats are deliberately skipped for capture
(`if (!seat.live) return;` — no capture spam on reaped sessions).

Confirmed live on run 32: `plancore grok-4.5`, `deliberation claude-opus-5`, `deliberation gpt-5.6-sol`
all `running` with `live` chips.

**So the ask is LAYOUT, not plumbing.**

## The actual gap — Implementation's layout is richer

Implementation (`Workers` row) has, and Planning does not:

| Implementation feature | Planning today |
|---|---|
| `Auto-focus: On` toggle — streaming worker grows to ~68%, idle shrinks to ~32% but stays readable (`ccImplAutoFocus`) | none |
| `Show both` — force equal 50/50 | none |
| per-pane collapse-to-rail (`ccImplCollapsedPane`) | none |
| side-by-side sized panes | panes render, but not in the Implementation side-by-side treatment |

Planning also needs **N panes, not 2** — plancore + planner1 (lead) + planner2, and more when
`planning_panel_size` grows. Implementation's two-pane auto-focus math is hardcoded for
`implementer | validator`, so it does not port directly — it needs an N-seat generalisation
(likely flex-basis per seat with the streaming seat weighted).

## The scroll issue

JROM reports scroll misbehaving on the Planning section. Not yet diagnosed. Note the existing
scroll machinery is `SESSION_PANE_CLASSES.scrollOwner` + `captureStickIntent`/`applyStick`
(bottom-stick: capture intent before content write, apply after paint) — the same pattern
Implementation uses. Suspect the Planning tab has a competing scroll owner or the doc cards
(`cc-plan-layout` / `cc-plan-docs`) fight the pane block for the scroll container.
**Diagnose before changing** — `B3 bottom-stick on four scroll sites` already touched this area.

## Two extra defects observed in his screenshot (same area, worth folding in)

1. **Contradictory status text.** Header read `Planning not started` while the chip beside it read
   `Run in progress` and three seats were `running`. The progress line and the run-state chip are
   derived from different sources.
2. **Historical seats clutter the list.** Seven seat rows rendered: four `historical` from the failed
   run 31 (`plancore #1`, `deliberation #2/#3`, `ibrain` failed) plus the three live ones. Prior-run
   seats should collapse/hide by default, or group under a "previous attempts" disclosure — otherwise
   the live seats are buried and `≠ preview` badges from a dead run read as current problems.

## Constraints when this is built

- `app.js` is hand-written browser ESM, **560KB, no build step** — `node --check` after ANY edit, then
  `npm run build` (the tree ships two copies: `src/web/public` + `dist/web/public`).
- UI proof targets `:3110` via `playwright.cap.config.ts` — never the default config (`:3111`, fake
  tmux, scratch DB). Extend `e2e/S14.live.spec.ts` rather than adding a parallel spec.
- Do not change the capture endpoint or the historical-skip rule; both are load-protective.

## Related

- `R-ui-font-size-control.md` — also Planning/UI, also parked; batch them if both are picked up
- `R-last-sent-strip-invert.md` — parked UI work
- `../discovery-planning-handoff/decisions/D-03-new-cycles-over-old-cycles.md`
