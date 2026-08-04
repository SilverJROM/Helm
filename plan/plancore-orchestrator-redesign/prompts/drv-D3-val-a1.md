# [driver] validator brief — slice D3 (run plancore-orchestrator-redesign)

## Scope (do ONLY this)
**NEW pure** `src/services/proposer-role.ts`: `designateRound2Proposer({seatA, shaA, seatB, shaB})` → lower full `sha256` (not short12) wins proposer for round 2; tie-break: lexicographically lower `seatId` (document + test). `rolesForRound(round, round2ProposerSeat, seatA, seatB)` → round 2 as designated; round 3 **swaps**; round 4 swaps again. `formatProposerLog(...)` returns auditable string including both shas + rule name `lower-sha256-of-round1-drafts`. No I/O.

## ACs
R3.9,R3.12
## Focused tests
`npx vitest run src/services/proposer-role.test.ts --minWorkers=1 --maxWorkers=4`
- test cmd: **use the `tests` command from YOUR slice row above, exactly as written** — it is the authority. Do NOT substitute a build/test command the project does not have: if the row's command is a plain `node -e ...` one-liner, run that and nothing else. Only run `npm run build` / `npm ci` if the row asks for it or the repo demonstrably has that script. A missing script you were never asked to run is NOT a blocker.
- IF (and only if) your row's command is vitest: `npx vitest run <the focused spec> --minWorkers=1 --maxWorkers=4` — the pool-agnostic worker cap is MANDATORY on EVERY vitest run (incl. any full-suite check); uncapped Vitest thrashes/OOMs this box and kills every tmux session including live runs.
- E2E/UI/browser commands (Playwright etc.): ALWAYS wrap them as `timeout --signal=TERM --kill-after=15s 180s <command>` — a webServer/browser teardown can hang forever and freeze this seat; TERM alone may not kill an unresponsive child, so --kill-after SIGKILLs it. ANY nonzero exit (124 timeout, 137 killed, OR a real test failure) is a **FAIL, never a PASS** — fail closed; never infer a pass from partial output. If you pipe through `tee`, set `-o pipefail` (or read `${PIPESTATUS[0]}`) so the pipe cannot mask the failure.

## Emit protocol (MANDATORY — verifier≠fixer, write NO product code)
Validate D3 independently against its ACs; run the focused tests. ALSO perform a elite-tier RED-TEAM adversarial pass over the diff (distinct lenses); PASS only if it survives. Verify each evidence file EXISTS on disk before PASS. Then append to /home/agjrom/websites/Helm/plan/plancore-orchestrator-redesign/callbacks.md:
`[projcore callback] validator D3 STATUS: DONE — <PASS|FAIL> <=100-char note>`
then on the NEXT line (plain shell append, NOT emit-status):
`[VERDICT-V1] run=plancore-orchestrator-redesign batch=D3 attempt=1 marker=DRV-D3-21 verdict=<PASS|FAIL> req=<ids> defect_class=<none|CLASS> gate=<none|Gx> commit=<HEAD sha> redteam=elite-clean evidence=<path:sha256,...>`
## ⚠ EVIDENCE HASHES — GENERATE, NEVER HAND-TYPE (mandatory)
A hand-typed 64-char sha256 gets garbled and fails the gate. Build the `evidence=` value with a SHELL command and paste its EXACT output, e.g.:
`sha256sum <file1> <file2> ... | awk '{print $2":"$1}' | paste -sd,`
Paths are relative to the REPO ROOT for code (`tests/...`, `src/...`) or run-dir-relative for validation artifacts (`plan/.../validation/...`). Do NOT type any hash by hand. For a user-visible req, evidence MUST include a screenshot + a DOM/aria file under `validation/`.
