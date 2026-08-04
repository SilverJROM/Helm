# [driver] implementer brief — slice D2 (run plancore-orchestrator-redesign)

## Scope (do ONLY this)
**Blind isolation, OS-enforced (R2.6):** wire round-1 draft spawns through the existing process-level sandbox — `src/security/landlock-sandbox.ts:28-69,157-198`, `src/services/real-transport.ts:169-238` (`strictReadAllow` param, confirmed wired at :185/:233), `src/services/fake-transport.ts:10-53` — so a co-drafting seat's own tmux process cannot `cat`/`ls` the other seat's draft path, not merely "the brief omits it." A drafting seat's allowlist covers only its own draft dir + read-only context inputs; the other seat's dir is outside the allowlist entirely until the engine marks round-1 committed. Test: compiled sandbox proves seat A's process cannot read/list seat B's draft; overlapping/widening allowlist requests typed-BLOCK before any tmux side effect; engine (outside the sandbox) reads both via `publishDraft(seatId)` once committed.

## ACs
R2.6
## Focused tests
`npx vitest run src/services/seat-draft-store-isolation.test.ts --minWorkers=1 --maxWorkers=4`
- test cmd: **use the `tests` command from YOUR slice row above, exactly as written** — it is the authority. Do NOT substitute a build/test command the project does not have: if the row's command is a plain `node -e ...` one-liner, run that and nothing else. Only run `npm run build` / `npm ci` if the row asks for it or the repo demonstrably has that script. A missing script you were never asked to run is NOT a blocker.
- IF (and only if) your row's command is vitest: `npx vitest run <the focused spec> --minWorkers=1 --maxWorkers=4` — the pool-agnostic worker cap is MANDATORY on EVERY vitest run (incl. any full-suite check); uncapped Vitest thrashes/OOMs this box and kills every tmux session including live runs.
- E2E/UI/browser commands (Playwright etc.): ALWAYS wrap them as `timeout --signal=TERM --kill-after=15s 180s <command>` — a webServer/browser teardown can hang forever and freeze this seat; TERM alone may not kill an unresponsive child, so --kill-after SIGKILLs it. ANY nonzero exit (124 timeout, 137 killed, OR a real test failure) is a **FAIL, never a PASS** — fail closed; never infer a pass from partial output. If you pipe through `tee`, set `-o pipefail` (or read `${PIPESTATUS[0]}`) so the pipe cannot mask the failure.

## Emit protocol (MANDATORY)
Build it, run the focused tests, commit atomically. Then append ONE line to /home/agjrom/websites/Helm/plan/plancore-orchestrator-redesign/callbacks.md:
`[projcore callback] implementer D2 STATUS: DONE — commit <sha> <=100-char note>`
If blocked: `[projcore callback] implementer D2 STATUS: BLOCKED — <reason>`. Do not widen scope.
