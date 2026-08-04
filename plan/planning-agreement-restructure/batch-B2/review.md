# review.md — B2 (implementer self-review)

## Scope check

| Rule | Status |
|------|--------|
| Only `brief-writer-service.ts` + own new B2 test file | PASS |
| No `planning-phase-service.ts` edit | PASS |
| No `src/index.ts` edit | PASS |
| No schema file / schema version invention | PASS |
| No importer call site edited (`panel-service.ts`, `planning-phase-service.ts` untouched) | PASS |
| Reused B1's `readPlanRevision` — no duplicated hashing logic | PASS |
| Gate = own new unit-test file | PASS (2/2) |

## Correctness

- `generatePanelBrief` no longer passes `planPath: 'plan.json'` / `runDir: '.'`; it derives
  an absolute root from `canonicalArtifactRoot` (new optional param, unused by current
  callers) → `dirname(callbacksFile)` → `projectDir` → `.`, then resolves `plan.md` and
  `og-requirements.md` against it.
- The base template's `Plan: ${planPath}` line now reflects the real absolute `plan.md`
  path — the literal lying `Plan: plan.json` string is gone from every panel/red-team/
  deliberation brief.
- `readPlanRevision` (B1) is called once against the derived path; its `null` return
  (missing/unreadable) drives a distinct fail-closed contract line rather than silently
  omitting revision info.
- AC6 (bind agreement to the exact plan revision reviewed): satisfied by stating
  `sha256=<full> short12=<12>` and instructing the seat to stop on a hash mismatch rather
  than review, when the plan is readable.
- AC14 (partners told explicitly where the canonical plan is): satisfied by stating both
  absolute paths unconditionally, even in the fail-closed branch, so a partner always knows
  where to look even before plancore finishes writing.

## Residual risk

- The `dirname(callbacksFile)` fallback recovers the true canonical root only when it equals
  `runDir` (today's default in `planning-phase-service.ts`: `canonicalArtifactRoot =
  inputs.canonicalArtifactRoot || runDir`). A future cycle-backed run where those diverge
  would need its call site updated to pass the new `canonicalArtifactRoot` param explicitly
  — that call-site change is out of B2's scope by brief instruction and is not silently
  patched around here.
- `generateBrainBrief` / `generatePlanReviseBrief` still hardcode `planPath: 'plan.json'` —
  explicitly out of scope per the plan row (B2 = panel brief only).

## Verdict

**READY FOR VALIDATOR** — AC6/AC14 canonical panel-brief plan contract complete.
