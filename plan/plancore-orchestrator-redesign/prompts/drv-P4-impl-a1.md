# [projcore DIRECTION for this retry — apply this first]
P4 parked: validator FAIL defect_class=FOCUSED_SPEC_MISSING, then claude-escalation budget exhausted (no a2 correction seat). Product rolled back to 5236c4af7f; orphan a67f8de + parked-patches/P4.patch remain.

Process direction (not a code taste call — gate named a missing plan-row deliverable):
1. Re-apply P4 scope pin (R7.25): runPlanningPhase early-returns when adaptivePlanning truthy BEFORE any new draft/signature code; short comment at that branch citing R7/deferred backlog; no behavioral change to adaptive-planning-phase.*; backlog note under plan/plancore-orchestrator-redesign/decisions/ (backburner already drafted in prior attempt — restore if needed).
2. REQUIRED: create and land the plan-row focused spec src/services/planning-phase-adaptive-scope-pin.test.ts — a1 only ran adaptive-planning-foundation.test.ts because the pin file was absent from tree/index. Assert adaptive truthy early-return ordering / pin comment presence as appropriate without widening into adaptive co-author rewrite.
3. Focused acceptance command must execute BOTH paths: npx vitest run src/services/planning-phase-adaptive-scope-pin.test.ts src/services/adaptive-planning-foundation.test.ts --minWorkers=1 --maxWorkers=4
4. Prefer re-apply product hunk from a67f8de / P4.patch then add the missing test. Do not restore queue.md from the parked patch.
5. Do not widen scope. Safety: HELM_SESSION_JANITOR=0, no merge main, hands off A1-A6 / worker-runtime-finalize.ts / E5 session path.

Note: X1 deps include P4 — unblocking P4 unblocks the final regression-index slice once R7/P4 DRIVE.

# [driver] implementer brief — slice P4 (run plancore-orchestrator-redesign)

## Scope (do ONLY this)
**R7 explicit scope pin — adaptive untouched.** Assert `runPlanningPhase` still early-returns at `:356–365` when `adaptivePlanning` truthy **before** any new draft/signature code. Add a short code comment at that branch citing R7 / deferred backlog. No behavioral change to `adaptive-planning-phase.js`. File backlog note under `plan/plancore-orchestrator-redesign/decisions/` or effort decisions: reconcile adaptive co-author contract later.

## ACs
R7.25
## Focused tests
`npx vitest run src/services/planning-phase-adaptive-scope-pin.test.ts src/services/adaptive-planning-foundation.test.ts --minWorkers=1 --maxWorkers=4`
- test cmd: **use the `tests` command from YOUR slice row above, exactly as written** — it is the authority. Do NOT substitute a build/test command the project does not have: if the row's command is a plain `node -e ...` one-liner, run that and nothing else. Only run `npm run build` / `npm ci` if the row asks for it or the repo demonstrably has that script. A missing script you were never asked to run is NOT a blocker.
- IF (and only if) your row's command is vitest: `npx vitest run <the focused spec> --minWorkers=1 --maxWorkers=4` — the pool-agnostic worker cap is MANDATORY on EVERY vitest run (incl. any full-suite check); uncapped Vitest thrashes/OOMs this box and kills every tmux session including live runs.
- E2E/UI/browser commands (Playwright etc.): ALWAYS wrap them as `timeout --signal=TERM --kill-after=15s 180s <command>` — a webServer/browser teardown can hang forever and freeze this seat; TERM alone may not kill an unresponsive child, so --kill-after SIGKILLs it. ANY nonzero exit (124 timeout, 137 killed, OR a real test failure) is a **FAIL, never a PASS** — fail closed; never infer a pass from partial output. If you pipe through `tee`, set `-o pipefail` (or read `${PIPESTATUS[0]}`) so the pipe cannot mask the failure.

## Emit protocol (MANDATORY)
Build it, run the focused tests, commit atomically. Then append ONE line to /home/agjrom/websites/Helm/plan/plancore-orchestrator-redesign/callbacks.md:
`[projcore callback] implementer P4 STATUS: DONE — commit <sha> <=100-char note>`
If blocked: `[projcore callback] implementer P4 STATUS: BLOCKED — <reason>`. Do not widen scope.
