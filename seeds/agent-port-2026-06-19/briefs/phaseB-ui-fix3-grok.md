# Correction brief (iter 3, mechanical) — Phase B-UI. grok-build. Verifier ≠ fixer; paste REAL output.

The CORE override-authority bug is ALREADY FIXED by the coordinator (commit e061e8a:
rowToAgentJoined uses the real agent.id). DO NOT touch resolveProjectRole / rowToAgentJoined /
agent-assignment-service.ts binding queries — build ON TOP. Fix only these 3 residual gaps codex
named + add the regression test. INCIDENT GUARD: HELM_DB_PATH temp; never touch live data/helm.db;
prove mtime unchanged.

## FIX A — red-team fallback bypass (run-orchestrator-service.ts)
The red-team fallback inline SQL (the `m.model_id as model` via `a.default_model_id` LEFT JOIN,
the multi-row red-team path used when no team is bound) must apply per-agent project overrides:
LEFT JOIN project_agents pa ON pa.project_id=? AND pa.agent_id=a.id, and use
COALESCE(override model_id, a.default_model_id) -> models.model_id. So a per-project model override
on a red-team agent wins here too. Keep multi-row support.

## FIX B — team roster toolkit anchor (worker-service.ts)
When building the synthetic agent from a team roster seat (currently id:-1), resolve the real role
agent id (getProjectBinding / role default for that role) and use THAT id for composeToolkits;
keep provider + model (model_id) from the roster seat. No id -1.

## FIX C — resolver error swallowing (run-orchestrator-service.ts)
Any try/catch around the role-resolution calls that silently swallows errors must be narrowed/
removed so a genuine resolver error surfaces (don't fall back to a default on a real error).

## TEST — regression guard
Add a vitest test (HELM_DB_PATH temp) that PROVES: with role_bindings.id != agents.id, a
project_agents model override makes resolveProjectRole return the override model_id (mirror the
coordinator's probe: create agent so its id != the binding row id, set project_agents override,
assert resolved agent.model === override model_id). Also assert a team-bound deliberation/red-team
role resolves to the full roster.

## Verify
1. npm run build clean. 2. Full suite (HELM_DB_PATH temp): only pre-existing emit-status fail.
3. data/helm.db mtime unchanged. 4. Commit each, append changes.md, end DONE/BLOCKED.
Scope: run-orchestrator-service.ts + worker-service.ts + tests ONLY. Branch feat/helm-agent-port.
