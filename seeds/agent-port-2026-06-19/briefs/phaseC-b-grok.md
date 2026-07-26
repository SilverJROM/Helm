# Implementer brief — Phase C-b (validation pipeline). grok-build. Verifier ≠ fixer; paste REAL output.

Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Builds on Phase B+C-a. INCIDENT GUARD:
HELM_DB_PATH=/tmp/helm-<rand>.db for ALL tests; never touch live data/helm.db; prove `stat -c %Y
data/helm.db` unchanged. VERIFY WITH BOTH `npm run build` (tsc) AND vitest — vitest does NOT
type-check, so a clean build must be proven by `npm run build`.

## Read first
build-plan.md Phase C (C2, C3, C4). src/services/orchestrator-loop.ts (runTask: the deterministic
test-gate path ~line 484-500, the issue REPRO gate ~437-462, performRolePhase, performFinalRunValidation),
run-orchestrator-service.ts (startRun drain + completion summary), brief-writer-service.ts,
the validator/reviewer agent definition_md (in DB; the prompts live in seeds/agent-port-2026-06-19/prompts/).

## Tasks (atomic; commit each) — SCOPE = C2 + C3 + C4 ONLY

### C2 — requirements-aware validator on the REAL feature path (G2)
- Today the real path = deterministic `npm test` gate ONLY (agent-validator is a no-op for feature
  tasks). Change the feature path to: deterministic gate PASS -> spawn the **validator** agent
  (requirements-aware) -> then **reviewer** (C4) -> existing red-team/advisory.
- The validator brief MUST include the CONTRACT: the run's requirements/north-star (runs.north_star_ref
  / the run prompt + the task's atomic_work + validation_criteria) + the diff/behavior. It judges
  whether the requirement is OBSERVABLY closed (not just tests pass). Returns PASS / FAIL-with-gaps.
- Run the validator only on requirement-bearing tasks (gate-first as a cheap filter; skip pure
  refactor/no-criteria tasks). A validator FAIL routes back as a correction (feeds the existing ladder).
- Commit: feat(validator): requirements-aware validator after gate on real feature path

### C3 — issue repro retry/defer + raise-at-end (G7)
- Issue tasks already do validator-REPRO-first (no repro -> no implementer). Add: on REPRO-FAILED,
  RETRY repro up to X attempts (X configurable, default 2; escalate effort across attempts, e.g.
  stronger validator/red-team assist). On exhausting X without repro: mark the task **deferred**
  (run_tasks.status='deferred', NOT-REPRODUCIBLE; uses the B4 markDeferred), CONTINUE the queue (do
  not halt, do not block independent tasks).
- At run completion, the summary MUST list ALL deferred/not-reproducible issues raised to the operator
  (the single place they surface). Wire this into the completion summary in run-orchestrator-service.
- Commit: feat(issues): repro retry X then defer (not-reproducible) + raise deferred at run end

### C4 — reviewer pass on code-bearing tasks (G2)
- After the validator PASS, run the **reviewer** agent on code-bearing tasks: diff vs intent,
  reject symptom-fixes (demand mechanism root cause), check regressions, hardening-module rules.
  Verifier != fixer. Persist reviewer evidence separately from validator evidence (validations table
  or a distinct note). A reviewer REJECT/REVISE routes back as a correction.
- Commit: feat(reviewer): code-soundness reviewer after validator on code tasks

## Verify (paste REAL)
1. `npm run build` clean (tsc — REQUIRED, not just vitest). 2. Add tests (HELM_DB_PATH temp):
   feature task runs gate->validator->reviewer; a validator FAIL routes back; an issue that never
   repros after X attempts becomes deferred + appears in the completion summary; queue continues past
   a deferred issue. 3. Full suite (HELM_DB_PATH temp): only pre-existing emit-status fail.
4. data/helm.db mtime unchanged. 5. Commit each; append changes.md. End DONE or BLOCKED.

Scope fence: orchestrator-loop + run-orchestrator + brief-writer + tests. Do NOT change the resolver
(Phase B) or the C-a wiring. Branch feat/helm-agent-port.
