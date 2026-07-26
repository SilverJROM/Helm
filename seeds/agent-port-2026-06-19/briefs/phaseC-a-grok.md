# Implementer brief — Phase C-a (run wiring). grok-build. Verifier ≠ fixer; paste REAL output.

Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Builds on Phase B (teams + resolver
already done; resolveProjectRole returns model_id + full roster + applies project overrides — DO
NOT change it). INCIDENT GUARD: HELM_DB_PATH=/tmp/helm-<rand>.db for ALL test runs; never open/copy
the live data/helm.db; prove `stat -c %Y data/helm.db` unchanged before/after.

## Read first
seeds/agent-port-2026-06-19/plan/build-plan.md (Phase C: C1, C5, C6). src/services/
run-orchestrator-service.ts, orchestrator-loop.ts, panel-service.ts, escalation-service.ts,
usage-gateway-service.ts, plan-parser-service.ts, agent-assignment-service.ts (resolveProjectRole).

## Tasks (atomic; commit each) — SCOPE = C1 + C6 + C5 ONLY (run wiring; NOT validator/reviewer/issue-defer)

### C1 — panels spawn from the team roster (G3 runtime)
- conveneDeliberationPanel + conveneRedTeamPanel must spawn PER-SEAT models from the resolved team
  roster (each member's model_id + lens), not a single hardcoded model / not brittle role-binding
  rows. run-orchestrator already resolves the roster via resolveProjectRole — pass the FULL roster
  (ordered, per-seat model_id+lens) into the panels and have each seat spawn with its own model.
- Commit: feat(panels): deliberation/red-team spawn per-seat models from team roster

### C6 — per-task model + effort through the run path (G9)
- PlanParser: accept per-task `model` (or `recommended_model`) + `effort` from plan.json (optional).
- RunOrchestratorService.startRun: read per-task detail; pass `explicitModel` + `effort` into
  OrchestratorLoop.runTask. OrchestratorLoop: use them as the task BASE worker model/effort
  (overriding the default binding for that task) and pass effort to the transport spawn.
- Precedence (document + test): project override/default -> per-task base (plan) -> escalation rung
  on top. Escalation stays agent-level.
- Commit: feat(run): per-task model + effort from plan honored at dispatch

### C5 — token-budget escalation trigger (G8b)
- Add a `low-budget` escalation trigger: before/at dispatch, if the bound model's remaining budget
  (via usage-gateway-service / a fake gateway in tests) is below a configurable threshold X, swap to
  the next escalation rung / a model with headroom. Worker escalation stays agent-level + compatible
  with the per-task base from C6. For the master (projcore) this is the existing hot-swap path.
- Mirror the existing fake-gateway test pattern (see p1-6b auto-model-fallback). Make threshold
  configurable (env or plumbing config).
- Commit: feat(escalation): low-budget trigger swaps to next rung/headroom model

## Verify (paste REAL)
1. npm run build clean. 2. Add tests (HELM_DB_PATH temp): per-task model+effort changes the spawned
   worker; deliberation/red-team spawn N per-seat roster models; low-budget trigger fires a swap.
3. Full suite (HELM_DB_PATH temp): only pre-existing emit-status fail. 4. data/helm.db mtime unchanged.
5. Commit each; append changes.md. End DONE or BLOCKED.

Scope fence: run-orchestrator + orchestrator-loop + panel-service + escalation-service +
plan-parser + tests. Do NOT do the validator-real-path / reviewer / issue-defer (that's Phase C-b).
Do NOT change resolveProjectRole. Branch feat/helm-agent-port.
