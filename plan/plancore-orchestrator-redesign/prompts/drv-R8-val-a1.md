# [driver] validator brief — slice R8 (run plancore-orchestrator-redesign)

## Scope (do ONLY this)
**Retire plancore whole-plan revise actuator.** Delete/stop calling `generatePlanRoundReviseBrief` (`:311–354`) and the C6 spawn block (`:690–726`) that uses `brainRole` / `planningBrainModel` for mid-round plancore rewrite. Reconcile rounds **are** the revise path (proposer co-planner only). Preserve C8 same-plan-broken classification concepts where they still apply to signature refusals, or map them onto objection evidence. Update `planning-review-round-c6.test.ts` to expect proposer reconcile, not plancore. Register `role-integrity` sweep mode.

## ACs
R3.10,R3.14,R1.2,R6.20
## Focused tests
`npx vitest run src/services/planning-review-round-c6.test.ts src/services/planning-review-round-no-plancore-revise.test.ts --minWorkers=1 --maxWorkers=4`
- test cmd: **use the `tests` command from YOUR slice row above, exactly as written** — it is the authority. Do NOT substitute a build/test command the project does not have: if the row's command is a plain `node -e ...` one-liner, run that and nothing else. Only run `npm run build` / `npm ci` if the row asks for it or the repo demonstrably has that script. A missing script you were never asked to run is NOT a blocker.
- IF (and only if) your row's command is vitest: `npx vitest run <the focused spec> --minWorkers=1 --maxWorkers=4` — the pool-agnostic worker cap is MANDATORY on EVERY vitest run (incl. any full-suite check); uncapped Vitest thrashes/OOMs this box and kills every tmux session including live runs.
- E2E/UI/browser commands (Playwright etc.): ALWAYS wrap them as `timeout --signal=TERM --kill-after=15s 180s <command>` — a webServer/browser teardown can hang forever and freeze this seat; TERM alone may not kill an unresponsive child, so --kill-after SIGKILLs it. ANY nonzero exit (124 timeout, 137 killed, OR a real test failure) is a **FAIL, never a PASS** — fail closed; never infer a pass from partial output. If you pipe through `tee`, set `-o pipefail` (or read `${PIPESTATUS[0]}`) so the pipe cannot mask the failure.

## Emit protocol (MANDATORY — verifier≠fixer, write NO product code)
Validate R8 independently against its ACs; run the focused tests. ALSO perform a elite-tier RED-TEAM adversarial pass over the diff (distinct lenses); PASS only if it survives. Verify each evidence file EXISTS on disk before PASS. Then append to /home/agjrom/websites/Helm/plan/plancore-orchestrator-redesign/callbacks.md:
`[projcore callback] validator R8 STATUS: DONE — <PASS|FAIL> <=100-char note>`
then on the NEXT line (plain shell append, NOT emit-status):
`[VERDICT-V1] run=plancore-orchestrator-redesign batch=R8 attempt=1 marker=DRV-R8-21 verdict=<PASS|FAIL> req=<ids> defect_class=<none|CLASS> gate=<none|Gx> commit=<HEAD sha> redteam=elite-clean evidence=<path:sha256,...>`
## ⚠ EVIDENCE HASHES — GENERATE, NEVER HAND-TYPE (mandatory)
A hand-typed 64-char sha256 gets garbled and fails the gate. Build the `evidence=` value with a SHELL command and paste its EXACT output, e.g.:
`sha256sum <file1> <file2> ... | awk '{print $2":"$1}' | paste -sd,`
Paths are relative to the REPO ROOT for code (`tests/...`, `src/...`) or run-dir-relative for validation artifacts (`plan/.../validation/...`). Do NOT type any hash by hand. For a user-visible req, evidence MUST include a screenshot + a DOM/aria file under `validation/`.
