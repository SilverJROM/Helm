# review.md — C9 (implementer self-review)

## Scope check

| Rule | Status |
|------|--------|
| Only `brief-writer-service.ts` + own new C9 test file | PASS |
| No `planning-review-round.ts` edit | PASS (untouched; pre-existing on branch from another stream) |
| No `planning-phase-service.ts` edit | PASS (untouched; pre-existing on branch from another stream) |
| No `plan-parser-service.ts` edit | PASS (untouched; pre-existing on branch from another stream) |
| No schema file edit / schema version invention | PASS |
| No `src/index.ts` edit | PASS |
| Gate = own new unit-test file | PASS (6/6) |
| B2 rerun (shared-file requirement) | PASS (2/2, unaffected — different method) |

## Correctness

- `generatePlanningBrief`'s four sites that previously conflated `PLAN-READY` with
  whole-plan agreement (`scope` field, §5 job bullet, §7, and the literal callback template)
  are all rewritten so `PLAN-READY` means only "artifacts are ready for engine review."
- Each rewritten site now explicitly states the engine (helm-algo), not plancore, judges
  agreement and grants ingest permission — directly satisfying "Only the engine declares
  agreement and grants ingest permission" from the plan row.
- The literal `"plan agreed with ${params.mode || 'planner'}"` callback-note text is gone;
  replaced with `"artifacts ready for engine review: og-requirements.md + plan.md written"`
  — no mode-dependent agreement claim remains.
- §7's dropped sentence ("A BROKEN/negative partner verdict fails the gate — do not force
  PLAN-READY past it") removed an instruction that implied plancore inspects partner
  verdicts before its own PLAN-READY emission; under the corrected model plancore emits
  PLAN-READY purely on artifact-readiness and never sees or judges partner verdicts itself.
- AC12 "preserve the og-requirements.md/plan.md write contract; do not tell it to author
  plan.json" is untouched — §§1-4 (derive-order, the two artifact paths, the full plan.md
  schema, and the explicit "plan.json — DO NOT author" instruction) were not edited, and the
  new C9 test's last case (`still preserves the og-requirements.md + plan.md write
  contract...`) asserts this directly against the generated brief text.
- This is a real invariant change in the generated prompt text sent to the LLM worker (not
  merely a comment or doc claiming behavior changed) — satisfies the standing rule that "a
  deliverable that only says 'the agent is now told to...' is wrong; the invariant must live
  in code/tests." The invariant here *is* the code (the brief-generation template) plus a
  test asserting on its literal output.

## Residual risk

- This closes the *instruction text* sent to plancore. It does not by itself change engine
  code that consumes the `PLAN-READY` callback (`planning-phase-service.ts`,
  `planning-review-round.ts`) — those files are out of C9's scope by brief instruction and
  were not touched. If engine-side code currently treats a bare `PLAN-READY` callback as
  sufficient for agreement (rather than running its own gate), that would be a separate,
  already-in-flight concern on this branch (C2/B-stream territory), not something this batch
  could or should fix.
- The rewritten §5 bullet still says "using your PLAN-READY artifacts as the review input" —
  this is intentional: it tells plancore *why* PLAN-READY matters to the engine (it's the
  input the engine's agreement gate consumes) without implying plancore itself achieves or
  declares that agreement.

## Verdict

**READY FOR VALIDATOR** — AC12 PLAN-READY/agreement wording split complete.
