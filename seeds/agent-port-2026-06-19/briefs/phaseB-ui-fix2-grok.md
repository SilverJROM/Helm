# Correction brief (iter 2) — Phase B-UI. grok-build. Verifier ≠ fixer; paste REAL output.

Two independent validators (codex-5.5 + a code review) agree: the per-project overrides + team
rosters are NOT authoritative at run time, and the resolver returns model NAMES not model IDs.
Root cause: `RunOrchestratorService` resolves roles with its OWN inline SQL using
`a.default_model_id` → `m.name as model`, bypassing `resolveProjectRole` (which already applies
project_agents overrides + team rosters). Fix below. INCIDENT GUARD: HELM_DB_PATH temp for tests;
never touch live data/helm.db; prove mtime unchanged.

## FIX 1 (BLOCKER) — single resolver + model_id everywhere
- `agent-assignment-service.ts resolveProjectRole`:
  - Override query: return `m.model_id as ov_model` (NOT `m.name`); set `baseAgent.model = pa.ov_model`.
  - Roster query: `m.model_id as model` (NOT `m.name`); keep `model_id` field. So resolveProjectRole
    ALWAYS returns the provider model_id string (e.g. `gpt-5.5`, `gpt-5.3-codex-spark`,
    `claude-sonnet-4-6`), never the friendly name.
- `run-orchestrator-service.ts`: REPLACE the per-role inline SQL (the `m.name as model` /
  `a.default_model_id` blocks for implementer, validator, projcore, partner, red-team, deliberation)
  with calls to `this.assignment.resolveProjectRole(projectId, role)`. Use the returned
  agent.model (now model_id) + provider. Keep `input.roleBindings` as an explicit override ONLY when
  passed; otherwise the resolver (with project_agents overrides) is authoritative.
- Net: project_agents model/Dynamic overrides + team bindings actually drive run-time spawn, and
  the spawn no longer throws "Unknown model" (model_id matches the PROVIDERS registry).

## FIX 2 (BLOCKER) — full deliberation roster
- `run-orchestrator-service.ts` deliberation path currently takes `LIMIT 1` from the team roster.
  Pass the FULL roster (ordered members, each with model_id + lens) to `conveneDeliberationPanel`
  (mirror how `redTeamAgents` passes the full array). Deliberation must be multi-model, not seat-0.

## FIX 3 (MAJOR) — toolkits for team seats
- `worker-service.ts`: when building the synthetic agent from a roster seat (currently `id:-1`),
  resolve the real role agent id (via getProjectBinding / role default) and use THAT id for
  `composeToolkits`; keep provider + model_id from the roster seat. No more id -1 (which silently
  composes no toolkits).

## FIX 4 (MAJOR) — error propagation + dead code
- `index.ts` ~719-722: remove the inner `try{...}catch{}` around `setProjectTeamBinding` so its
  errors propagate to the outer transaction catch (atomic rollback + 400), like agent bindings.
- `agent-assignment-service.ts` ~211: remove the unreachable `if (tb && tb.team)` branch; add a
  guard: team bound but roster empty → throw a clear error (don't fall through silently).

## FIX 5 (MINOR — batch)
- `setAgentEscalations`: whitelist `trigger ∈ {on-fail, plan-summon, projcore}` (else throw).
- `index.ts` escalations PUT: distinguish `rungs: []` (explicit clear) from missing
  (`body.rungs !== undefined ? body.rungs : []`).
- `app.js` team-member add form: add `lens` (text) + `position` (number) inputs; include in POST.

## Verify (paste REAL output)
1. `npm run build` clean.
2. ADD tests proving (HELM_DB_PATH temp): (a) a project_agents model override makes
   resolveProjectRole return the OVERRIDE model_id (beats Studio default); (b) a deliberation/
   red-team team binding resolves to the FULL roster with model_id per seat; (c) escalation trigger
   whitelist rejects a bad value.
3. Full suite (HELM_DB_PATH temp): only the pre-existing emit-status fail.
4. `stat -c %Y data/helm.db` before/after unchanged.
5. Commit each fix; append changes.md. End DONE or BLOCKED.

Scope: resolver + run-orchestrator + worker-service + index routes + app.js + tests. No schema
migrations. Branch feat/helm-agent-port.
