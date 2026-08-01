# R8 validator red-team report

Validator: drv-R8-val-a1
Commit: 60114deca651cc7bce77aa1dde7899b8b19ecc26
Verdict: PASS

## Focused tests

Command run:

```sh
npx vitest run src/services/planning-review-round-c6.test.ts src/services/planning-review-round-no-plancore-revise.test.ts --minWorkers=1 --maxWorkers=4
```

Result: PASS, 2 files, 10 tests. Full output is in `focused-vitest.log`.

## AC validation

- R1.2: PASS. The retired mid-round plancore rewrite actuator no longer has a helper or production call shape in `src/`. Static sweep found no production `generatePlanRoundReviseBrief` call/definition shape.
- R3.10: PASS. The live reconcile path uses `purpose: 'plan-reconcile'` for the proposer with both round-1 draft paths and `purpose: 'plan-signature'` for the signer with only the candidate path.
- R3.14: PASS. Proposer/signer spawns use the co-planner `partner` role; static sweep found no `role: brainRole`, `role: 'plancore'`, or `planningBrainModel` residue in `planning-review-round.ts`.
- R6.20: PASS. R8 registers `proposer-signer-role-integrity` in the regression-mode registry with active proving tests in `planning-review-round-no-plancore-revise.test.ts`.

## Adversarial lenses

- Residual actuator lens: searched for helper/call syntax and revise-shaped spawn/write residues. Only `-revise` references found in targeted tests are negative assertions.
- Wrong-role lens: inspected proposer/signer spawns and static-searched for plancore role leakage. Spawns use `role: partner` and partner model/provider fields, not `brainRole` or `planningBrainModel`.
- Classification lens: same-current-plan BROKEN evidence is retained as final diagnostic classification for the legacy reviewer path and does not trigger a rewrite. Signature refusals are typed as signer objections or signature mismatch, with objection monotonicity handled by R6.
- Sweep registration lens: `proposer-signer-role-integrity` points to an active behavioral spec and lists concrete proving test titles, not a skipped skeleton.
- Cleanup lens: focused tests assert no phantom revise handle/runtime id is appended beyond actual round-scoped reviewer seats.

No blocking defect found.
