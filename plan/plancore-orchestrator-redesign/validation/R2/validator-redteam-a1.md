# R2 validator red-team a1

Scope: validate slice R2 against R2.5, R2.6, R2.7, R6.20, R6.24 at commit
`d565793013721ada2cad76a81d57c2c575f187bd`.

Focused test:

`npx vitest run src/services/planning-review-round-blind-draft.test.ts --minWorkers=1 --maxWorkers=4`

Result: PASS, 8/8 tests passed. Output captured in
`plan/plancore-orchestrator-redesign/validation/R2/focused-vitest-a1.txt`.

AC verification:

- R2.5 PASS: blind round 1 uses `purpose:'plan-draft'`, seat-scoped draft paths, and does not write
  canonical `plan.md` or `og-requirements.md` in the focused fixture.
- R2.6 PASS: each draft seat gets a strict read allowlist for its own draft dir plus context inputs,
  peer draft dirs are excluded, and widening into `planning-drafts/` fails before spawn.
- R2.7 PASS: `DRAFT-SUBMITTED` is accepted only as publication existence; the engine recomputes the
  draft hash from disk and ignores a false callback claim.
- R6.20 PASS for this slice: round-1 blind draft spawns fresh configured co-planner seats through
  `spawnRoundSeats`; the legacy path remains unaffected when `blindDraftRound1` is omitted.
- R6.24 FAIL: R2 explicitly requires registering regression mode `blind-draft-isolation`. The only
  source occurrence is in the focused spec comment; `src/planning-regression-index.test.ts` still
  contains only the seven historical skeleton entries with `it.skip`, and does not include
  `blind-draft-isolation`.

Adversarial lenses:

- Hash spoofing: covered by the focused test; callback `plan=<sha12>` is not trusted.
- Canonical write leakage: covered by the focused test; no canonical files appear in the R2 fixture.
- Cross-seat read exposure: covered at spawn wiring level; D2 owns the compiled sandbox proof.
- Silent/malformed draft completion: covered by timeout and first-callback + file-commit fallback tests.
- Regression sweep registration: failed. A comment in a focused test is not a registered sweep mode.

Verdict: FAIL for R6.24 regression-mode registration gap.
