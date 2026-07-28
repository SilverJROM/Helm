# S09 changes — last_used_at on agent output (AC19)

## Root cause / objective
E5 / AC19: `last_used_at` only refreshed on Helm **input** (`touchSession` from sendAndSubmit/sendCommand/sendEnter/sendKeys). `capturePane` intentionally did not touch (high-freq poll must not immortalize idle seats), so agent streaming output never bumped the TTL clock — a session could freeze ~2s after create while the agent was still writing.

## Mechanism
1. **Prior pane snapshot map** on `TmuxService` (`lastPaneSnapshots: Map<sessionName, strippedContent>`).
2. **`observeAgentOutput(target, content)`** after a successful `capturePane`:
   - ANSI-stripped compare (`stripAnsiForMatch`) so TUI colour flicker is not activity.
   - First non-empty snapshot = **baseline only** (no touch).
   - Identical subsequent content = **no touch** (no polling inflation).
   - Real content delta = **`touchSession`** once → existing `onUse` → `sessionRegistry.touch`.
   - Empty/failed captures invent no activity and do not reset the baseline.
3. **`terminateSession`** deletes the prior snapshot so a recreated same-name session re-baselines.
4. **Reaped never resurrected** — unchanged `SessionRegistryService.touch` (`WHERE status != 'reaped'`); proven end-to-end via onUse wiring in tests.
5. **Helm input still touches** — existing send-path `touchSession` unchanged.

## Code changes
- `src/tmux/tmux-service.ts` — `lastPaneSnapshots`, `observeAgentOutput`, hook in `capturePane`, clear on terminate; comment update on `touchSession`
- `src/tmux/tmux-helm-child-tag.test.ts` — 7 S09 fake-pane / synthetic-registry tests
- No `index.ts` rewire required (`onUse → touch` already present)

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged in `.env` and `ecosystem.config.cjs`
- Fake-exec / synthetic DB only; no live tmux; no live `data/helm.db` mutation from this suite
- No S10 observation helper, no reaper decision changes, no flag flip

## Out of scope
- S10 `max(last_used_at, session_activity)` / attached exclusion
- Janitor enable / shadow mode
- Reaper decision wiring (S11/S12)

## Test status
- `npx tsc --noEmit -p tsconfig.json` → **exit 0**
- `HELM_SESSION_JANITOR=0 npx vitest run src/tmux/ --poolOptions.forks.maxForks=2` → **55 passed** (24 in tmux-helm-child-tag including 7 new S09 cases)
