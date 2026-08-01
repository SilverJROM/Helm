# R2 validator red-team a2

Scope: validate slice R2 against R2.5, R2.6, R2.7, R6.20, R6.24 at commit
`3a00ea520988c2b439fadbd41c52a081d5c8011d`.

Focused test:

`npx vitest run src/services/planning-review-round-blind-draft.test.ts --minWorkers=1 --maxWorkers=4`

Result: PASS, 12/12 tests passed. Output captured in
`plan/plancore-orchestrator-redesign/validation/R2/focused-vitest-a2.txt`.

AC verification:

- R2.5 PASS: blind round 1 uses `purpose:'plan-draft'`, seat-scoped draft paths, and the focused
  fixture verifies no canonical `plan.md` or `og-requirements.md` write.
- R2.6 PASS: each draft seat receives a strict read allowlist scoped to its own draft dir plus context
  inputs; peer draft dirs are excluded, and a widening allow entry fails before spawn.
- R2.7 PASS: `DRAFT-SUBMITTED` is treated as a publication signal only; the engine recomputes the
  draft hash from disk and ignores a false callback claim.
- R6.20 PASS: round-1 blind draft spawns fresh configured co-planner seats through `spawnRoundSeats`;
  the legacy non-blind path remains unaffected when `blindDraftRound1` is omitted.
- R6.24 PASS: `blind-draft-isolation` is now registered in
  `src/services/planning-regression-modes.ts`, surfaced by `src/planning-regression-index.test.ts`,
  and resolves to an active on-disk behavioral spec with named proving tests and no disarming marker.

Adversarial lenses:

- Hash spoofing: survived; callback hash claims are not authoritative.
- Canonical write leakage: survived; R2 does not publish canonical artifacts.
- Cross-seat read exposure: survived at R2 wiring level; D2 owns the process-level sandbox proof.
- Silent/malformed completion: survived; typed timeout and file-commit fallback are covered.
- Regression registration: survived; a prose-only registration is no longer possible for R2, and the
  resolver reports missing specs, skipped specs, and renamed/gutted proving tests.
- Scope containment: survived; `planning-review-round.ts` behavior was unchanged by the a2 fix, which
  only adds the R6.24 registry/index proof.

Verdict: PASS.
