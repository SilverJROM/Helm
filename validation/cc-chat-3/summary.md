# CC-CHAT-3 (F3) — R1 interstitial interceptor + R2 CLI preflight + R8 codex submit watchdog

Date: 2026-07-02 · Branch: feat/helm-projcore-port · Server: PM2 helm :3110 (DEV/beta)

## R1 — Reactive CLI-prompt interceptor
- Shared table: `src/services/cli-interstitials.ts` (ordered `{id, provider?, test, keys|keys(pane), note, blocked?}` + pure `matchInterstitial` + distinct `InterstitialBlockedError`).
- Seeds: codex update nag → resolves the "Skip until next version" menu number from the pane (fallback 3; NEVER "Update now"); claude trust dialog → logged safety no-op (pre-accepted via ensureClaudeTrust); auth/login-expired (any provider, tightened so "Logged in as …" boot banners never false-BLOCK) → InterstitialBlockedError → spawn fails DISTINCTLY as `cli spawn BLOCKED: …` (never a silent hang).
- Consulted on EVERY poll, BEFORE the ready marker, in BOTH services:
  - `real-transport.ts`: new `waitForReadyIntercepting` (generic probe; marker detection still delegated to tmux.waitForReady in slices) + `waitForGrok/Claude/CodexComposerReady`.
  - `master-runtime-service.ts`: `waitForReady` + `waitForClaude/CodexComposerReady`; launchMaster maps the blocked error to gate reason `cli-interstitial-blocked` + failed row.
- Re-send guard: per-spawn `handled` Set (entry answered at most once).
- Evidence: `b1-unit-tests-interstitials-watchdog.txt` (12 tests: update menu → ['3','Enter'], renumbered menu resolution, ANSI-split match, handled-set guard, provider filter, trust no-op, 4 auth shapes → BLOCKED, "Logged in as" regression, happy-path inert).

## R2 — CLI freshness preflight
- `src/services/cli-preflight.ts`, fired-and-forgotten AFTER `app.listen` in `src/index.ts` (never blocks/fails boot; try/catch on every step; `HELM_SKIP_CLI_PREFLIGHT=1` skips; version logged).
- Evidence: `r2-preflight-boot-log.txt` — pm2 boot shows `[cli-preflight] codex update (best-effort): … Update ran successfully!` + `[cli-preflight] codex version: codex-cli 0.142.5`, and the skip-guard line when the env is set.

## R8 — Codex submit watchdog (variable Enter-drop window)
- Primitive: `TmuxService.composerHoldsText/paneHoldsUnsubmittedText` (EXACT same held-heuristic as sendAndSubmit's verification: ANSI-strip, head+tail chunk, paste/plan-nudge indicators) + `RealTransport.resubmitIfComposerHeld` (Esc-dismisses the codex "Create a plan?" nudge, then ONE Enter — never a re-paste).
- Wired (kloo-nudge probe shape: throttled, bounded, loud console.warn):
  - `orchestrator-loop.waitForCallback` — every dispatch wait (performRolePhase incl. all task dispatches, brain-decision wait, final-validation wait) probes on a ~30s cadence (HELM_SUBMIT_WD_MS), max 10 presses (~5min, HELM_SUBMIT_WD_MAX); first not-held observation disables it.
  - `planning-phase-service.waitForFirstCallback` — projcore planning spawn (handle+brief threaded).
  - `master-runtime-service.submitMasterFeed` — after the sendAndSubmit backoff fails, ANY provider now gets the bounded 30s×10 Enter watchdog (claude keeps its fast 1s×20 loop first).
- LIVE proof (`a3-watchdog-drill-live-codex.txt`): on the real codex (gpt-5.5) session from (a), the run-80 failure shape was reproduced (brief pasted, Enter dropped → composer holds it) and the REAL shipped dist code (`OrchestratorLoop.waitForCallback` + `RealTransport.resubmitIfComposerHeld`) detected it:
  - `[orchestrator-loop] submit-watchdog … composer still holds the implementer brief → re-pressed Enter (1/10)`
  - `[orchestrator-loop] submit-watchdog … composer clear after 1 re-press(es) — implementer brief submitted`
  - pane after: codex processed the message and replied `• ACK` (composer cleared).
  Note: in pm2 logs these same warn-lines appear whenever a run's dispatch hits a held composer; on a healthy submit the watchdog is silent BY DESIGN (first probe sees composer clear and disarms).

## Real spawn proof (deliverable a)
- `a1-codex-spawn-response.json`: POST /api/projects/1/agent-chat/8 (model_id gpt-5.5 → codex CLI) → session `helm-chat-p1-projcore-db7518` fenced to /home/agjrom/websites/cards.
- `a2-codex-pane-after-bootstrap.txt`: bootstrap SUBMITTED — composer clear (bare › placeholder + gpt-5.5 footer) and the model already answered with its ⟦HELM_REPLY⟧ intake block.
- Session ended via DELETE (ok:true); no stray helm-chat sessions. (`helm-projcore-EHR` ghost re-spawned post-restart with master_runtimes=0 — the KNOWN pre-existing F4 issue per context-handoff, out of F3 scope.)

## Gates
- `npm run build` exit 0.
- `npx vitest run`: 42 files, 539 passed / 3 skipped (baseline 518 + 21 new: 12 interstitial-table + 9 composer-watchdog) — `c1-vitest-full-suite.txt`.
- No non-terminal runs before restart; plain `pm2 restart helm`; `DELETE FROM master_runtimes` (count 0).
