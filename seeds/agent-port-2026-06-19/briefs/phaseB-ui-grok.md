# Implementer brief — Phase B-UI (Studio + Project Setup). grok-build.

Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Verifier ≠ fixer; paste REAL output.
Scope = **B3 + B6 ONLY** (build-plan Phase B). Schema (teams/team_members/role_team_bindings,
agent_escalations) already exists from B-schema — build the API + UI on top.

## INCIDENT GUARD (mandatory)
NEVER run the full vitest suite against the live DB. For ANY test run, set
`HELM_DB_PATH=/tmp/helm-<rand>.db`. Before/after every test run, prove `stat -c %Y data/helm.db`
is UNCHANGED. Do not open/copy/migrate the live `data/helm.db` read-write anywhere.

## Read first
- build-plan Phase B (B3, B6). src/index.ts (existing /api/agents, /api/toolkits, /api/models,
  /api/projects/:id/bindings + config routes — mirror their style + auth preHandlers).
- src/web/public/app.js (Agent Studio tab `02-studio-agents`; Project Setup `05-setup-project-agents`).
- schema.ts: teams, team_members, role_team_bindings, agent_escalations, project_agents,
  role_capabilities. agent-assignment-service.ts (resolveProjectRole), escalation-service.ts.

## Tasks (atomic; commit each)

### B6a — Teams CRUD API + service
- `GET/POST/PUT/DELETE /api/teams`, `GET /api/teams/:id`, and member ops
  `POST /api/teams/:id/members` {model_id, lens?, position?}, `DELETE /api/teams/:id/members/:mid`.
  New TeamService (mirror toolkit-service.ts). Validate model_id ∈ models; team type enum.
- Commit: `feat(teams): teams + team_members CRUD API + service`

### B6b — agent_escalations CRUD API
- `GET /api/agents/:id/escalations`, `PUT /api/agents/:id/escalations` (set rung-1/rung-2 model_id +
  trigger), `DELETE` a rung. Mirror existing agent routes + auth.
- Commit: `feat(escalation): agent_escalations CRUD API`

### B6c — Agent Studio: escalation-ladder editor
- In the agent edit form (app.js), add an "Escalation ladder" section: rung-1 + rung-2 model
  selects (from modelsList) + trigger, wired to B6b. Show for all agents (esp. implementer,
  validator, projcore).
- Commit: `feat(studio): escalation-ladder editor in agent form`

### B6d — Agent Studio: team editor
- New Studio section/tab to create/edit teams: name, type (deliberation|red-team|generic),
  consensus_rule, and an editable member list (add/remove model rows with lens + order). Wired to
  B6a. Show the 2 seeded default teams.
- Commit: `feat(studio): team editor (add/remove model members)`

### B3 — Project agents: full roster + per-project overrides (incl. team rosters)
- Project Setup "Project agents" tab: list ALL usable agents AND teams for the selected project
  ("Add all" + "+ Add agent"/team). Per-project model override per agent: [Agent default] /
  specific model / Dynamic (project_agents.model_id + use_dynamic). Allow a per-project TEAM
  ROSTER override (which models are in deliberation/red-team for THIS project). Bind a team to the
  deliberation/red-team role via role_team_bindings.
- Make these overrides AUTHORITATIVE for run resolution: extend resolveProjectRole / the resolver
  so project override > Studio default; team role resolves to the bound team (+ per-project roster
  override if set).
- API: extend `/api/projects/:id/config` + bindings to read/write team bindings + project team
  roster overrides.
- Commit: `feat(project): per-project agent model + team roster overrides (authoritative)`

## Verify (paste REAL output)
1. `stat -c %Y data/helm.db` BEFORE.
2. `npm run build` clean.
3. Add minimal unit tests for TeamService + escalation CRUD + the resolver override precedence;
   run with `HELM_DB_PATH=/tmp/helm-<rand>.db npx vitest run <those files>` — must pass.
4. `stat -c %Y data/helm.db` AFTER — unchanged (prove live untouched).
5. API smoke against a temp DB instance if feasible (note results).
6. Append changes.md. Report DONE with build + test counts + before/after mtime.

Scope fence: ONLY B3 + B6 (API + service + app.js UI + resolver). No schema migrations (exists),
no orchestrator/validation-path changes (Phase C). Branch feat/helm-agent-port. End DONE/BLOCKED.
