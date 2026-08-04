# [driver] implementer brief — slice X1 (run plancore-orchestrator-redesign)

## Scope (do ONLY this)
**R6.24 regression sweep rewrite — not a skip skeleton.** Replace `src/planning-regression-index.test.ts` so every historical mode **and** new modes resolve to at least one **active** behavioral test (import or subprocess), not `it.skip`. Historical seven (from prior AC23): convene-before-artifacts; BROKEN→revise→CLEAN (now BROKEN→reconcile→SIGNED); partner1 CLEAN + partner2 BROKEN (re-point to dual-signer impossibility / dual-draft mismatch); partner silent until timeout; legacy path refuses when north-star exists; ibrain row count unchanged on planning block; stale-CLEAN/SIGNED rejected across revisions. **New modes:** blind-draft-isolation; proposer-signer-role-integrity; alternation; objection-monotonicity; atomic-candidate-promotion. Unresolved/skipped entry → **fail** the suite. Spread registration is done in R2/R4/R6/R8/P2; X1 only enforces.

## ACs
R6.24,R6.20,R6.21
## Focused tests
`npx vitest run src/planning-regression-index.test.ts --minWorkers=1 --maxWorkers=4`
- test cmd: **use the `tests` command from YOUR slice row above, exactly as written** — it is the authority. Do NOT substitute a build/test command the project does not have: if the row's command is a plain `node -e ...` one-liner, run that and nothing else. Only run `npm run build` / `npm ci` if the row asks for it or the repo demonstrably has that script. A missing script you were never asked to run is NOT a blocker.
- IF (and only if) your row's command is vitest: `npx vitest run <the focused spec> --minWorkers=1 --maxWorkers=4` — the pool-agnostic worker cap is MANDATORY on EVERY vitest run (incl. any full-suite check); uncapped Vitest thrashes/OOMs this box and kills every tmux session including live runs.
- E2E/UI/browser commands (Playwright etc.): ALWAYS wrap them as `timeout --signal=TERM --kill-after=15s 180s <command>` — a webServer/browser teardown can hang forever and freeze this seat; TERM alone may not kill an unresponsive child, so --kill-after SIGKILLs it. ANY nonzero exit (124 timeout, 137 killed, OR a real test failure) is a **FAIL, never a PASS** — fail closed; never infer a pass from partial output. If you pipe through `tee`, set `-o pipefail` (or read `${PIPESTATUS[0]}`) so the pipe cannot mask the failure.

## Emit protocol (MANDATORY)
Build it, run the focused tests, commit atomically. Then append ONE line to /home/agjrom/websites/Helm/plan/plancore-orchestrator-redesign/callbacks.md:
`[projcore callback] implementer X1 STATUS: DONE — commit <sha> <=100-char note>`
If blocked: `[projcore callback] implementer X1 STATUS: BLOCKED — <reason>`. Do not widen scope.
