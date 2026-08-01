# [driver] implementer brief — slice R3 (run plancore-orchestrator-redesign)

## Scope (do ONLY this)
**Divergence → asymmetric proposer/signer (not dual reconcile).** On round-1 hash mismatch: call D3 designate; log rule; fresh-spawn proposer with `plan-reconcile` + **both** drafts; fresh-spawn signer with `plan-signature` + **only** candidate (R3.10). On round-1 hash **match**: engine may set candidate = that byte content without a model reconcile, still requiring a signature round **or** document auto-agree only when both drafts’ engine hashes are equal (prefer **signature still required** for one uniform promotion path — implement auto-agree only if tests prove no loss of R3.11). Remove any path that asks both seats to each author a new full draft.

## ACs
R3.9,R3.10,R3.11
## Focused tests
`npx vitest run src/services/planning-review-round-proposer-signer.test.ts --minWorkers=1 --maxWorkers=4`
- test cmd: **use the `tests` command from YOUR slice row above, exactly as written** — it is the authority. Do NOT substitute a build/test command the project does not have: if the row's command is a plain `node -e ...` one-liner, run that and nothing else. Only run `npm run build` / `npm ci` if the row asks for it or the repo demonstrably has that script. A missing script you were never asked to run is NOT a blocker.
- IF (and only if) your row's command is vitest: `npx vitest run <the focused spec> --minWorkers=1 --maxWorkers=4` — the pool-agnostic worker cap is MANDATORY on EVERY vitest run (incl. any full-suite check); uncapped Vitest thrashes/OOMs this box and kills every tmux session including live runs.
- E2E/UI/browser commands (Playwright etc.): ALWAYS wrap them as `timeout --signal=TERM --kill-after=15s 180s <command>` — a webServer/browser teardown can hang forever and freeze this seat; TERM alone may not kill an unresponsive child, so --kill-after SIGKILLs it. ANY nonzero exit (124 timeout, 137 killed, OR a real test failure) is a **FAIL, never a PASS** — fail closed; never infer a pass from partial output. If you pipe through `tee`, set `-o pipefail` (or read `${PIPESTATUS[0]}`) so the pipe cannot mask the failure.

## Emit protocol (MANDATORY)
Build it, run the focused tests, commit atomically. Then append ONE line to /home/agjrom/websites/Helm/plan/plancore-orchestrator-redesign/callbacks.md:
`[projcore callback] implementer R3 STATUS: DONE — commit <sha> <=100-char note>`
If blocked: `[projcore callback] implementer R3 STATUS: BLOCKED — <reason>`. Do not widen scope.
