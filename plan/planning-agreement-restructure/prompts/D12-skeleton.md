<!-- PROJCORE-STATUS-CONTRACT v2 -->
Batch D12-skeleton: Seed the historical regression sweep

Batch ID: D12-skeleton
Plan: /home/agjrom/websites/Helm/plan/planning-agreement-restructure/plan.md
Branch: fix/planning-agreement-restructure
Requirements assigned: AC23
Lifecycle: pre-live — Deferral policy: OFF.

Estimated duration: SHORT — 25min
Convergence budget:
  max_fix_cycles: 3
  max_wallclock_min: 30
  token_budget: null
  absolute_deadline: 2026-07-30T01:10:00Z
  progress_lease: 10min
  new_class_rounds_to_stall: 2
  on_burn: pull_in_coplanner_then_north

Effort tier: L1 / routine. Implementer route: spark. Validator: codex55.

Context:
Wave 0 zero-collision work: new sweep test only. D1-D11 are deferred, but D12 remains in this run.
This is a skeleton/index only; it must not require future modes to pass before those modes exist.

Requirements section:
"23. Tests that burn no model tokens, covering each historical failure: convene-before-artifacts; BROKEN->revise->CLEAN; partner1 CLEAN + partner2 BROKEN; partner-2 silent until timeout; legacy path refuses when north-star exists; ibrain row count unchanged on planning block; stale-CLEAN rejected across revisions."

Observed:
No single AC23 regression index currently names all seven historical failure modes for this effort.

Expected acceptance criteria:
- Add one new dedicated unit-test file for the D12 sweep, for example `src/planning-regression-index.test.ts`.
- The skeleton names all seven historical failure modes in executable assertions or explicit pending/skipped cases with TODO-free wording.
- It must fail if a named mode is accidentally removed from the index.
- It must not import the integration-owned capstone tests (`b9-gate-atomic`, `a15-worker-finalize`, `cycle-terminal-on-run-complete`).
- Do not edit production code.
- Run `HELM_DB_PATH=/tmp/helm-d12-$$.db npx vitest run <your-new-test-file>`.

Likely files:
- New test file only.

Standing rules:
- Never invent a schema version.
- Never edit `src/index.ts` in a build slice.
- Cross-stream type changes are ADDITIVE and OPTIONAL only.
- Never edit a file another stream owns, even trivially.
- Your gate is your OWN NEW unit-test file.
- A deliverable that only says "the agent is now told to..." is wrong; the invariant must live in code/tests.

Required artifacts:
- `plan/planning-agreement-restructure/batch-D12-skeleton/changes.md`
- `plan/planning-agreement-restructure/batch-D12-skeleton/test-report.md`
- `plan/planning-agreement-restructure/batch-D12-skeleton/review.md`

Plan handshake protocol:
1. Read this brief and the listed plan docs.
2. Reply with PROPOSED: mechanism-level diagnosis, planned files, risks, estimate confirmation.
3. Wait for APPROVED-PLAN before writing code.
4. When green, emit DONE.

Streaming-order mandate: Your first tool call MUST be the callback helper below, BEFORE any prose tokens. The callback line template is: [projcore callback] <role> <batch-id> STATUS:

Callback emission:
PROJCORE_CALLBACKS_FILE=<abs-path-to-callbacks.md> \
  ~/.codex/skills/projcore/lib/projcore-emit-status.sh implementer D12-skeleton PROPOSED "read brief; proposing D12 skeleton plan"

implementer states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO
validator states:   WORKING | REPRO-CONFIRMED | REPRO-FAILED | REPRO-CLEARED-ON-LOCAL | REPRO-STILL-PRESENT | BLOCKED | NEEDS-INFO
