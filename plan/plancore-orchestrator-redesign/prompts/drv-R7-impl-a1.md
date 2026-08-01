# [projcore DIRECTION for this retry — apply this first]
FRESH PROCESS unpark — terminal_drain=True; prior SKIP (a2) held R7 to avoid same-process no-progress thrash. _no_progress is now empty on resume.

History (do not re-park on product wording):
- c1 false park: STATUS: DONE commit fc7c025 but note contained substring BLOCKED (R3.15 product wording). Driver parks if 'BLOCKED' appears anywhere in the callback line.
- c2 no-progress after a1 unpark in same process. Queue PENDING + no advance-R7.marker is correct; product never advanced.

Implement R7 (R3.15) on CURRENT HEAD (5236c4a post-P3; R8/P1/P2/P3 already landed without R7):
1. Re-apply non-convergence final-positions diff: blockedReason carries operator-legible textual/hunk summary (final candidate vs signer last draft/objections), not bare hash pairs; durable report under planning-drafts (or plan-row path). Extend RoundBlockedReasonKind if needed.
2. Prefer adapt orphan fc7c025 / product hunks from parked-patches/R7.patch onto current tree — expect merge with R8+P3 edits in planning-review-round.ts. Do not restore queue.md from that patch.
3. Focused test must exist and pass: npx vitest run src/services/planning-review-round-block-diff.test.ts --minWorkers=1 --maxWorkers=4
4. CRITICAL callback hygiene: DONE note must NOT contain the literal substring BLOCKED. Safe: 'commit <sha> non-conv final-positions diff (R3.15)'.
5. Do not widen scope. Safety: HELM_SESSION_JANITOR=0, no merge main, hands off A1-A6 / worker-runtime-finalize.ts / E5 session path.

# [driver] implementer brief — slice R7 (run plancore-orchestrator-redesign)

## Scope (do ONLY this)
**Non-convergence = visible BLOCKED + diff, not bare hash pairs (R3.15).** On cap exhaustion / monotone fail: `blockedReason` includes a **textual diff** (or structured hunk summary) between final candidate and signer’s last objection set / last draft positions — operator-legible. Extend `RoundBlockedReasonKind` if needed. `[DB]`-shaped fields remain on `PlanningResult`.

## ACs
R3.15
## Focused tests
`npx vitest run src/services/planning-review-round-block-diff.test.ts --minWorkers=1 --maxWorkers=4`
- test cmd: **use the `tests` command from YOUR slice row above, exactly as written** — it is the authority. Do NOT substitute a build/test command the project does not have: if the row's command is a plain `node -e ...` one-liner, run that and nothing else. Only run `npm run build` / `npm ci` if the row asks for it or the repo demonstrably has that script. A missing script you were never asked to run is NOT a blocker.
- IF (and only if) your row's command is vitest: `npx vitest run <the focused spec> --minWorkers=1 --maxWorkers=4` — the pool-agnostic worker cap is MANDATORY on EVERY vitest run (incl. any full-suite check); uncapped Vitest thrashes/OOMs this box and kills every tmux session including live runs.
- E2E/UI/browser commands (Playwright etc.): ALWAYS wrap them as `timeout --signal=TERM --kill-after=15s 180s <command>` — a webServer/browser teardown can hang forever and freeze this seat; TERM alone may not kill an unresponsive child, so --kill-after SIGKILLs it. ANY nonzero exit (124 timeout, 137 killed, OR a real test failure) is a **FAIL, never a PASS** — fail closed; never infer a pass from partial output. If you pipe through `tee`, set `-o pipefail` (or read `${PIPESTATUS[0]}`) so the pipe cannot mask the failure.

## Emit protocol (MANDATORY)
Build it, run the focused tests, commit atomically. Then append ONE line to /home/agjrom/websites/Helm/plan/plancore-orchestrator-redesign/callbacks.md:
`[projcore callback] implementer R7 STATUS: DONE — commit <sha> <=100-char note>`
If blocked: `[projcore callback] implementer R7 STATUS: BLOCKED — <reason>`. Do not widen scope.
