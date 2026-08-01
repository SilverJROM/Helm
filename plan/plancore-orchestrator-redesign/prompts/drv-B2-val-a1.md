# [driver] validator brief — slice B2 (run plancore-orchestrator-redesign)

## Scope (do ONLY this)
**Purpose `plan-draft`:** move the **schema / R-XX / task-JSON contract** currently living in `generatePlanningBrief` (`brief-writer-service.ts:308–328`, also og-requirements order `:308–312`) into the draft brief. Instruct: write **only** seat-scoped paths from params (never canonical `plan.md` / `og-requirements.md`); emit `DRAFT-SUBMITTED plan=<sha12>` after atomic self-hash (non-authoritative). Context injection: absolute paths to north-star.md, conversation-log.md, decisions/ only. No “agree with partner,” no verdict grammar.

## ACs
R2.8,R2.5,R2.7,R1.1
## Focused tests
`npx vitest run src/services/brief-writer-plan-draft-purpose.test.ts --minWorkers=1 --maxWorkers=4`
- test cmd: **use the `tests` command from YOUR slice row above, exactly as written** — it is the authority. Do NOT substitute a build/test command the project does not have: if the row's command is a plain `node -e ...` one-liner, run that and nothing else. Only run `npm run build` / `npm ci` if the row asks for it or the repo demonstrably has that script. A missing script you were never asked to run is NOT a blocker.
- IF (and only if) your row's command is vitest: `npx vitest run <the focused spec> --minWorkers=1 --maxWorkers=4` — the pool-agnostic worker cap is MANDATORY on EVERY vitest run (incl. any full-suite check); uncapped Vitest thrashes/OOMs this box and kills every tmux session including live runs.
- E2E/UI/browser commands (Playwright etc.): ALWAYS wrap them as `timeout --signal=TERM --kill-after=15s 180s <command>` — a webServer/browser teardown can hang forever and freeze this seat; TERM alone may not kill an unresponsive child, so --kill-after SIGKILLs it. ANY nonzero exit (124 timeout, 137 killed, OR a real test failure) is a **FAIL, never a PASS** — fail closed; never infer a pass from partial output. If you pipe through `tee`, set `-o pipefail` (or read `${PIPESTATUS[0]}`) so the pipe cannot mask the failure.

## Emit protocol (MANDATORY — verifier≠fixer, write NO product code)
Validate B2 independently against its ACs; run the focused tests. ALSO perform a elite-tier RED-TEAM adversarial pass over the diff (distinct lenses); PASS only if it survives. Verify each evidence file EXISTS on disk before PASS. Then append to /home/agjrom/websites/Helm/plan/plancore-orchestrator-redesign/callbacks.md:
`[projcore callback] validator B2 STATUS: DONE — <PASS|FAIL> <=100-char note>`
then on the NEXT line (plain shell append, NOT emit-status):
`[VERDICT-V1] run=plancore-orchestrator-redesign batch=B2 attempt=1 marker=DRV-B2-21 verdict=<PASS|FAIL> req=<ids> defect_class=<none|CLASS> gate=<none|Gx> commit=<HEAD sha> redteam=elite-clean evidence=<path:sha256,...>`
## ⚠ EVIDENCE HASHES — GENERATE, NEVER HAND-TYPE (mandatory)
A hand-typed 64-char sha256 gets garbled and fails the gate. Build the `evidence=` value with a SHELL command and paste its EXACT output, e.g.:
`sha256sum <file1> <file2> ... | awk '{print $2":"$1}' | paste -sd,`
Paths are relative to the REPO ROOT for code (`tests/...`, `src/...`) or run-dir-relative for validation artifacts (`plan/.../validation/...`). Do NOT type any hash by hand. For a user-visible req, evidence MUST include a screenshot + a DOM/aria file under `validation/`.
