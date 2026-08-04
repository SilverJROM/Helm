# [driver] implementer brief — slice R6 (run plancore-orchestrator-redesign)

## Scope (do ONLY this)
**Objection monotonicity (R3.13).** Parse bounded numbered defect list from signer rejection; store count per round; if round N+1 defect count is **not strictly smaller** than round N’s against the revised candidate → typed BLOCK early (`blockedReasonKind: 'objection-not-monotone'`) without burning remaining cap. Register sweep mode `objection-monotonicity`.

## ACs
R3.13,R6.24
## Focused tests
`npx vitest run src/services/planning-review-round-objection-mono.test.ts --minWorkers=1 --maxWorkers=4`
- test cmd: **use the `tests` command from YOUR slice row above, exactly as written** — it is the authority. Do NOT substitute a build/test command the project does not have: if the row's command is a plain `node -e ...` one-liner, run that and nothing else. Only run `npm run build` / `npm ci` if the row asks for it or the repo demonstrably has that script. A missing script you were never asked to run is NOT a blocker.
- IF (and only if) your row's command is vitest: `npx vitest run <the focused spec> --minWorkers=1 --maxWorkers=4` — the pool-agnostic worker cap is MANDATORY on EVERY vitest run (incl. any full-suite check); uncapped Vitest thrashes/OOMs this box and kills every tmux session including live runs.
- E2E/UI/browser commands (Playwright etc.): ALWAYS wrap them as `timeout --signal=TERM --kill-after=15s 180s <command>` — a webServer/browser teardown can hang forever and freeze this seat; TERM alone may not kill an unresponsive child, so --kill-after SIGKILLs it. ANY nonzero exit (124 timeout, 137 killed, OR a real test failure) is a **FAIL, never a PASS** — fail closed; never infer a pass from partial output. If you pipe through `tee`, set `-o pipefail` (or read `${PIPESTATUS[0]}`) so the pipe cannot mask the failure.

## Emit protocol (MANDATORY)
Build it, run the focused tests, commit atomically. Then append ONE line to /home/agjrom/websites/Helm/plan/plancore-orchestrator-redesign/callbacks.md:
`[projcore callback] implementer R6 STATUS: DONE — commit <sha> <=100-char note>`
If blocked: `[projcore callback] implementer R6 STATUS: BLOCKED — <reason>`. Do not widen scope.
