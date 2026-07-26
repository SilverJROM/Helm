# Validator brief — codex-5.5. Phase B-UI (B3+B6). Verifier ≠ fixer: report, do NOT fix.

Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Validate grok's Phase B-UI (the
commits after the B-schema signoff). INCIDENT GUARD: set HELM_DB_PATH=/tmp/helm-<rand>.db for any
test; NEVER open/copy the live data/helm.db; prove `stat -c %Y data/helm.db` unchanged before/after.

Read the diff (`git log --oneline -12`, `git diff` of the B-UI commits), src/index.ts (new routes),
the new TeamService, src/web/public/app.js (Studio + Project Setup changes),
agent-assignment-service.ts / the resolver, schema.ts (teams/team_members/role_team_bindings/
agent_escalations/project_agents).

## Check (mechanism-level)
1. **B6a Teams CRUD API + TeamService:** GET/POST/PUT/DELETE /api/teams, GET /api/teams/:id, member
   add/remove. Validates model_id ∈ models + team type enum. Auth preHandlers match existing routes.
2. **B6b agent_escalations CRUD:** GET/PUT/DELETE /api/agents/:id/escalations; rung-1/rung-2 model +
   trigger; auth.
3. **B6c/B6d Studio UI (app.js):** escalation-ladder editor in the agent form; team editor
   (create/edit team; add/remove model members w/ lens + order). Wired to the APIs (no obvious
   broken handlers/testids). The 2 seeded default teams render.
4. **B3 project overrides (THE key one — must be AUTHORITATIVE):** Project agents lists all agents
   + teams; per-project model override ([Agent default]/specific/Dynamic) + team-roster override;
   team bound to deliberation/red-team via role_team_bindings. CONFIRM the resolver
   (resolveProjectRole / run resolution) actually honors: project override > Studio default, and a
   team role resolves to the bound team (+ per-project roster override). This is the requirement —
   verify it in code, not just that the UI writes the rows.
5. **Build + scoped tests:** `npm run build` clean; run the new B-UI test files with HELM_DB_PATH
   temp — must pass. Confirm live data/helm.db mtime unchanged.
6. Security on new routes (owner/loopback as appropriate), regressions, anything claimed-not-true.

## Output
Write to seeds/agent-port-2026-06-19/validation/phaseB-ui-codex55.md. END with exactly:
`STATUS: PASS` or `STATUS: FAIL — <numbered gaps>`.
