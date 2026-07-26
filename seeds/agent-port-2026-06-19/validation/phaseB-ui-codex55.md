# Phase B-UI Validation — codex-5.5

## Verdict: FAIL

Phase B-UI does not satisfy the key B3 requirement: per-project overrides and team bindings are not
authoritative in the resolver/run path. The build also fails TypeScript.

## Incident Guard

- Live DB mtime before validation: `1781838325`
- All validation commands that used a DB were run with `HELM_DB_PATH=/tmp/helm-...db`.
- Live DB mtime after build/tests/probes: `1781838325`
- Result: live `data/helm.db` mtime unchanged.

## Findings

1. **Project model overrides are not authoritative in `resolveProjectRole`.**
   `ProjectAgentService` can store/list `project_agents.model_id` and `use_dynamic`, but
   `AgentAssignmentService.resolveProjectRole` never reads `project_agents`. It returns the
   role-bound/default agent row unchanged, so worker/master/run resolution still sees the Studio
   agent model, not the per-project override.

   Source refs:
   - `src/services/project-agent-service.ts:39` resolves project-agent display rows only.
   - `src/services/agent-assignment-service.ts:190` checks team binding, then `role_bindings`,
     then role defaults; it does not query `project_agents`.
   - `src/services/worker-service.ts:36` consumes `resolveProjectRole` directly for runtime spawn.
   - `src/services/run-orchestrator-service.ts:57` still resolves run models from `role_bindings`
     joins to `agents.default_model_id`, not `project_agents`.

   Temp-DB proof via source (`HELM_DB_PATH=/tmp/... npx tsx --eval ...`):
   ```text
   {"projectModelOverride":"codex-5.5","resolvedAgentModel":"grok-build","resolvedDefaultModelId":null,"projectOverrideModelId":4}
   ```
   Expected: resolved role should use the project override `codex-5.5`.
   Actual: resolved runtime model remains `grok-build`.

2. **Team binding resolution is not authoritative for roster execution.**
   `resolveProjectRole` returns `{ source: 'project-team-binding', team }`, but only the team
   metadata is returned. It does not return team members, model roster, member context, or any
   per-project roster override. There is no project-specific team roster table/API beyond binding a
   global team ID. The run path still reads red-team/panel agents from `role_bindings`, not
   `role_team_bindings` or `team_members`.

   Source refs:
   - `src/services/agent-assignment-service.ts:190-195` returns only `team`.
   - `src/services/agent-assignment-service.ts:302-313` lists team bindings without members.
   - `src/services/run-orchestrator-service.ts:57-74` reads red-team/panelist from `role_bindings`.

   Temp-DB proof via source:
   ```text
   {"source":"project-team-binding","team":{"id":2,"name":"red-team","type":"red-team","consensus_rule":"N-consecutive-CLEAN over N distinct lenses (standard)"}}
   hasMembersField= false
   ```
   Expected: resolver/run resolution can consume the bound team's roster (+ project override).
   Actual: no roster is resolved.

3. **`npm run build` fails.**
   Command:
   ```sh
   HELM_DB_PATH=/tmp/helm-phaseB-ui-validate-XXXXXX.db npm run build
   ```
   Output:
   ```text
   src/services/worker-service.ts(94,22): error TS7053: Element implicitly has an 'any' type because expression of type 'any' can't be used to index type ...
   ```
   This appears caused by the resolver return type being widened to `any`, making `agent.provider`
   unsafe when indexing `PROVIDERS`.

4. **Scoped test coverage is too thin for the claim.**
   Only one new B-UI test file exists: `src/team-service.test.ts`.
   It passes under a temp DB:
   ```text
   Test Files  1 passed (1)
        Tests  2 passed (2)
   ```
   But it does not test escalation CRUD API, project model override precedence, run resolution,
   or team roster resolution. The resolver test only checks `source === 'project-team-binding'`.

## Passing / Partial Checks

- **B6a TeamService:** partial pass. Service exists, validates team type and model IDs, and member
  add/list/remove behavior is covered by `src/team-service.test.ts`.
- **B6b escalation CRUD:** partial pass by source inspection. Routes exist in `src/index.ts` with
  owner read and owner+local mutation preHandlers; service methods validate agent/model existence.
  No scoped test found.
- **B6c/B6d Studio UI:** partial pass by source inspection. Agent escalation ladder UI and Teams tab
  are wired to the new APIs, with visible test IDs for core fields/buttons.
- **B3 UI surface:** partial only. Project Setup can bind a team via `role_team_bindings`, but it
  does not implement an actual per-project team roster override, and the runtime resolver does not
  honor project model overrides.

## Command Evidence

- `npm run build`: FAIL, TypeScript error above.
- `HELM_DB_PATH=/tmp/helm-phaseB-ui-test-XXXXXX.db npx vitest run src/team-service.test.ts`: PASS,
  2 tests.
- Temp resolver proof for project model override: FAIL, override ignored.
- Temp resolver proof for team roster: FAIL, no members/roster returned.
- Live DB mtime remained `1781838325` before/after all DB-backed checks.

---

STATUS: FAIL — 1) project_agents model/dynamic overrides are not authoritative in resolveProjectRole/run resolution; 2) team binding resolution returns only team metadata, not a runnable roster or project roster override; 3) npm run build fails with TS7053 in worker-service.ts; 4) scoped tests do not cover escalation CRUD or override precedence.

---

## Re-validation — latest commits f753fb6 / 3b72f08 / 98d4929 / 61f97ae / 164fddd

## Verdict: FAIL

Live DB guard held throughout this pass.

- Live DB mtime before validation: `1781838325`
- Live DB mtime after build, full tests, scoped tests, and temp probes: `1781838325`
- All DB-backed commands used `HELM_DB_PATH=/tmp/helm-phaseB-ui-...db`.
- I did not copy, migrate, or write `data/helm.db`.

## Checks

1. **Project overrides authoritative in resolver/run path: FAIL.**

   `resolveProjectRole` now attempts to read `project_agents` and apply `use_dynamic` / `model_id`
   over the base role agent. However, joined role/default agent rows are still mapped through
   `rowToAgent(r)`, and `rowToAgent` reads `row.id`. For role bindings, `row.id` is the
   `role_bindings.id`, not `agents.id`; the query aliases the real agent id as `agent_id_join`
   but `rowToAgent` ignores it. In non-coincidental rows, the project override lookup uses the
   wrong agent id and misses the override.

   Source refs:
   - `src/services/agent-assignment-service.ts:83-96` maps `id: Number(row.id)`.
   - `src/services/agent-assignment-service.ts:146-155` selects `rb.*` plus `a.id as agent_id_join`,
     then calls `rowToAgent(r)`.
   - `src/services/agent-assignment-service.ts:226-231` looks up `project_agents` using
     `baseAgent.id`, which can be the binding id.
   - `src/services/run-orchestrator-service.ts:57-190` still has direct SQL fallback paths joining
     `role_bindings` to `agents.default_model_id` rather than using the authoritative resolver for
     projcore/partner/implementer/validator/red-team agent roles.

   Temp runtime probe:
   ```text
   {
     "projectOverride": "codex-5.5",
     "resolverModel": "grok-build",
     "runSpawnModel": "grok-build",
     "runSpawnProvider": "grok"
   }
   ```
   Expected: resolver and run spawn use `codex-5.5`.
   Actual: both remain on `grok-build`.

2. **Team-role binding resolves to runnable roster: PARTIAL PASS.**

   `resolveProjectRole` now returns `roster` for deliberation/red-team team bindings, ordered by
   `team_members.position`, with per-seat `{position,lens,model,provider,model_id}`. Worker spawn can
   choose the first roster seat, and run orchestration maps bound red-team rosters into panel seats.
   The scoped tests cover resolved roster ordering.

   Remaining caveat: I did not find a separate per-project roster-member override table/API; the
   implementation treats the per-project role-to-team binding as the roster override.

3. **Build clean: PASS.**

   Command:
   ```sh
   HELM_DB_PATH=/tmp/helm-phaseB-ui-revalidate-build-IT1dAb.db npm run build
   ```
   Result: PASS. The previous TS7053 error is gone. Only the existing C compiler comment warning
   from `tools/helm-sandbox.c` remains.

4. **Tests cover escalation CRUD + override precedence: PARTIAL / INSUFFICIENT.**

   `src/team-service.test.ts` now has four tests and passes:
   ```text
   Test Files  1 passed (1)
        Tests  4 passed (4)
   ```

   It includes `agent_escalations` service CRUD and a project override precedence assertion. But
   the precedence test does not catch the joined-row id bug above, and it does not exercise the API
   CRUD routes (`GET/PUT/DELETE /api/agents/:id/escalations`). Full `npx vitest run` still fails on
   the pre-existing emit-status test:
   ```text
   FAIL src/services/orchestrator-loop.test.ts > projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)
   Command failed: ~/.claude/agents/lib/projcore-emit-status.sh red-team bfoo VERDICT-READY "CLEAN"
   Test Files  1 failed | 20 passed (21)
   Tests       1 failed | 233 passed | 1 skipped (235)
   ```

## Command Evidence

- `HELM_DB_PATH=/tmp/helm-phaseB-ui-revalidate-build-IT1dAb.db npm run build`: PASS.
- `HELM_DB_PATH=/tmp/helm-phaseB-ui-revalidate-vitest-cX0yyn.db npx vitest run`: FAIL only on
  the known `projcore-emit-status.sh` test; mtime unchanged.
- `HELM_DB_PATH=/tmp/helm-phaseB-ui-revalidate-scoped-vy1E7r.db npx vitest run src/team-service.test.ts`:
  PASS, 4 tests.
- `HELM_DB_PATH=/tmp/helm-phaseB-ui-runprobe-GUFkkZ.db USE_FAKE_TMUX=1 NODE_ENV=test npx tsx --eval ...`:
  FAIL for override authority; resolver/run spawn stayed on `grok-build`.

STATUS: FAIL — project_agents model/Dynamic overrides are still not authoritative in resolver/run resolution: joined role bindings can map `agent.id` from `role_bindings.id`, causing override misses, and RunOrchestratorService still bypasses resolveProjectRole with direct default_model_id SQL fallbacks; tests added but are insufficient to catch this.

---

## Re-validation iter2 — latest commits 07ecdfe / 641eaaa / 4b49ae6 / 0c0d10a / 6d393cc / f4f56a9

## Verdict: FAIL

Live DB guard held throughout this pass.

- Live DB mtime before validation: `1781838325`
- Live DB mtime after build, scoped tests, full tests, and temp probes: `1781838325`
- All DB-backed commands used `HELM_DB_PATH=/tmp/helm-phaseB-ui-iter2-...db`.
- I did not copy, migrate, or write `data/helm.db`.

## Checks

1. **Run-time role resolution routes through `resolveProjectRole`: FAIL.**

   Main projcore/partner/implementer/validator paths now call `assignmentService.resolveProjectRole`.
   However `RunOrchestratorService` still contains an inline `role_bindings` -> `agents.default_model_id`
   SQL fallback for red-team/panelist when `resolveProjectRole(projectId, 'red-team')` returns no
   roster. That violates the "no inline default_model_id SQL bypass" requirement.

   Source refs:
   - `src/services/run-orchestrator-service.ts:63-65` uses resolver for red-team roster.
   - `src/services/run-orchestrator-service.ts:67-77` still bypasses resolver with
     `LEFT JOIN models m ON a.default_model_id = m.id`.
   - `src/services/run-orchestrator-service.ts:102-148` uses resolver for projcore, partner,
     implementer, and validator.

2. **Project override changes spawned model and avoids Unknown-model: FAIL.**

   `resolveProjectRole` now reads `models.model_id` rather than display `models.name`, which fixes
   the name-vs-model-id shape for cases that reach the override. But the prior joined-row id bug is
   still present: `rowToAgent` reads `row.id`, while joined binding/default rows alias the real
   agent id as `agent_id_join`. When `role_bindings.id !== agents.id`, the project override lookup
   searches `project_agents` with the binding id, misses the override, and the run still spawns the
   Studio/default model.

   Source refs:
   - `src/services/agent-assignment-service.ts:83-96` maps `id: Number(row.id)`.
   - `src/services/agent-assignment-service.ts:146-155` selects `rb.*`, `a.id as agent_id_join`,
     then calls `rowToAgent(r)`.
   - `src/services/agent-assignment-service.ts:228-233` queries `project_agents` using
     `baseAgent.id`.

   Temp runtime probe:
   ```text
   {
     "binding": { "id": 2, "agent_id": 14 },
     "implId": 14,
     "projectOverrideName": "codex-5.5",
     "projectOverrideModelId": "gpt-5.5",
     "resolverAgentId": 2,
     "resolverModel": "grok-build",
     "runSpawnModel": "grok-build",
     "runSpawnProvider": "grok"
   }
   ```
   Expected: resolver and run spawn use `gpt-5.5`.
   Actual: resolver and run spawn stay on `grok-build`.

3. **Deliberation/red-team team binding resolves full roster: PASS / partial.**

   `resolveProjectRole` now returns all `team_members` ordered by `position`, with per-seat
   `{position,lens,model,provider,model_id}` and no `LIMIT 1`. `RunOrchestratorService` carries the
   full deliberation roster into `OrchestratorLoop` via `deliberationRoster`.

   Caveat: the run service still chooses the first deliberation roster member for the planning
   partner model (`partnerModel = paRes.roster[0].model`) while also passing the full roster for
   deliberation panel use. This is acceptable only if the partner spawn remains intentionally single
   seat.

4. **Team seats get toolkits, no `id: -1`: FAIL.**

   `WorkerService` still fabricates a team roster seat with `id: realId || -1`. For a team-bound
   role, calling `resolveProjectRole(projectId, role)` again returns the same roster result, not an
   `agent`, so `realId` remains `-1`. The roster does not include an agent id, and panel team seats
   do not compose toolkits at all.

   Source refs:
   - `src/services/worker-service.ts:39-44` can still create `{ id: -1, name: 'team-roster-seat', ... }`.
   - `src/services/agent-assignment-service.ts:202-208` roster seats include model/provider but no
     `agent_id` or toolkit anchor.
   - No focused test found proving toolkit composition for team seats with a non-`-1` id.

5. **Trigger whitelist + error propagation: PARTIAL / FAIL.**

   Trigger whitelist exists:
   - `src/services/agent-assignment-service.ts:335-338` allows only `on-fail`, `plan-summon`,
     and `projcore`.
   - `src/team-service.test.ts:137-150` verifies a bad trigger is rejected.

   Error propagation is still incomplete:
   - `src/services/run-orchestrator-service.ts:62-79`, `100-117`, and `136-148` swallow resolver
     errors with empty `catch {}` blocks. For example, an empty team roster throws from
     `resolveProjectRole`, but run startup silently ignores it rather than surfacing the invalid
     project binding.

## Test Evidence

- `HELM_DB_PATH=/tmp/helm-phaseB-ui-iter2-build-2liR1z.db npm run build`: PASS.
  The previous TS7053 is gone; only the existing `tools/helm-sandbox.c` comment warning remains.
- `HELM_DB_PATH=/tmp/helm-phaseB-ui-iter2-scoped-KbNjca.db npx vitest run src/team-service.test.ts src/services/run-orchestrator-service.test.ts`:
  PASS, 2 files / 22 tests.
- `HELM_DB_PATH=/tmp/helm-phaseB-ui-iter2-full-HU9Ruh.db npx vitest run`: FAIL on the known
  `projcore-emit-status.sh` test; 20 files passed, 1 failed; 236 passed, 1 failed, 1 skipped.
- `HELM_DB_PATH=/tmp/helm-phaseB-ui-iter2-probe-eoY5tO.db USE_FAKE_TMUX=1 NODE_ENV=test npx tsx --eval ...`:
  FAIL for override authority; resolver/run spawn stayed on `grok-build`.

STATUS: FAIL — project_agents overrides are still not authoritative when role_bindings.id differs from agents.id; RunOrchestratorService still has an inline default_model_id SQL bypass for red-team fallback; team roster seats can still use id -1/no toolkit anchor; resolver errors are still swallowed in run resolution catch blocks.

---

## Final Validation — Phase B-UI Complete Fixes

## Verdict: PASS

Validated latest commits through `6fdd428`:

- `e061e8a` fixes joined role/default rows with `rowToAgentJoined`, so `agent.id` is the real
  `agents.id`, not `role_bindings.id`.
- `2ce6eb0` applies `project_agents` overrides in the red-team legacy fallback path.
- `b840be8` resolves a real role agent/default id for team-seat toolkit composition.
- `6fdd428` / `a8a4343` add regression coverage for id mismatch + full roster.

Live DB guard held throughout:

- Live DB mtime before validation: `1781838325`
- Live DB mtime after runtime probes, build, full suite, and reruns: `1781838325`
- All DB-backed commands used `HELM_DB_PATH=/tmp/helm-phaseB-ui-final-...db`.
- I did not copy, migrate, or write `data/helm.db`.

## Runtime Probe Evidence

Command:
```sh
USE_FAKE_TMUX=1 NODE_ENV=test HELM_DB_PATH=/tmp/helm-phaseB-ui-final-probe-Mf7jVI.db npx tsx --eval ...
```

Key output:
```text
{
  "binding": { "id": 2, "agent_id": 14 },
  "implId": 14,
  "resolvedImplAgentId": 14,
  "resolvedImplModel": "gpt-5.5",
  "implSpawnModel": "gpt-5.5",
  "implSpawnProvider": "grok",
  "redFallbackAgents": [
    { "role": "red-team", "agent_id": 15, "model": "gpt-5.5", "provider": "grok" }
  ],
  "rosterLength": 2,
  "rosterModels": ["grok-build", "gpt-5.5"],
  "rosterProviders": ["grok", "codex"],
  "toolkitIds": [16],
  "workerModel": "grok-build",
  "workerProvider": "grok",
  "workerBriefHadToolkit": true,
  "emptyRosterErrorPropagated": true,
  "emptyRosterError": "team bound for role but roster empty"
}
```

This proves:

1. **Project override is authoritative with `role_bindings.id != agents.id`: PASS.**
   The binding row id was `2`, the actual agent id was `14`, `resolveProjectRole` returned
   `resolvedImplAgentId: 14`, and the actual implementer spawn used `gpt-5.5`.

2. **Red-team fallback applies project override: PASS.**
   With no red-team team binding, the legacy red-team role binding fallback produced
   `model: "gpt-5.5"` from `project_agents`, not the Studio/default `grok-build`.

3. **Deliberation/red-team resolve to full roster with `model_id` per seat: PASS.**
   The bound deliberation team returned two ordered roster seats with provider strings and model IDs
   (`grok-build`, `gpt-5.5`).

4. **Team seats get toolkits / no `id: -1` anchor: PASS.**
   Worker team-seat composition called toolkit compose with real agent id `16`, and the fed worker
   brief contained both `TOOLKIT_BODY` and the worker task brief.

5. **Resolver errors are not swallowed: PASS.**
   A red-team role bound to an empty team caused `startRun` to throw
   `team bound for role but roster empty`; the error propagated out instead of falling through.

## Source Checks

- `src/services/agent-assignment-service.ts:99-115` defines `rowToAgentJoined`.
- `src/services/agent-assignment-service.ts:150-175` and `198-206` use `rowToAgentJoined` for
  binding/default joins.
- `src/services/run-orchestrator-service.ts:62-79` uses resolver first for red-team and applies
  `project_agents` override in the fallback via `COALESCE(pa.model_id, a.default_model_id)`.
- `src/services/run-orchestrator-service.ts:100-145` no longer swallows resolver errors in empty
  catches for projcore/partner/implementer/validator.
- `src/services/worker-service.ts:41-51` resolves a role binding/default agent id for team roster
  toolkit composition.

## Test Evidence

- `HELM_DB_PATH=/tmp/helm-phaseB-ui-final-build-vKsEut.db npm run build`: PASS.
  Only the existing `tools/helm-sandbox.c` comment warning appears.
- `HELM_DB_PATH=/tmp/helm-phaseB-ui-final-full-Rew0Sy.db npx vitest run`: full run completed with
  two failures: the known allowed `projcore-emit-status.sh` failure and one `p1-6b` version-skew
  assertion.
- Follow-up targeted rerun:
  `HELM_DB_PATH=/tmp/helm-phaseB-ui-final-p16b-4zjwjE.db npx vitest run src/p1-6b.test.ts`: PASS,
  34 passed / 1 skipped. This makes the extra full-run `p1-6b` failure transient; the remaining
  reproducible full-suite failure is the pre-existing/allowed emit-status test.
- `src/services/run-orchestrator-service.test.ts` includes the id-mismatch regression test and
  passed during the full run.
- `src/team-service.test.ts` passed during the full run.

STATUS: PASS
