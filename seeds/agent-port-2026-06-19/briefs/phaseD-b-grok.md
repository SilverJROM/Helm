# Implementer brief — Phase D-b (Command-Center interview + plan per-task fields). grok-build.
Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. INCIDENT GUARD: HELM_DB_PATH temp for ALL
tests; never touch live data/helm.db; prove mtime unchanged. VERIFY BUILD with `npm run build` (tsc).
Builds on B+C+D-a. projcore's persona already instructs it to interview (its definition_md); this adds
the ENGINE support so the interview happens in Command Center BEFORE the autonomous run.

## Goal (JROM: "talk to projcore -> it creates the task list -> Helm executes to completion")
When the operator starts a task list in Command Center, projcore first runs a north-star INTERVIEW
(asks clarifying questions incl. the per-task model/effort policy, scope, test authority,
deliberation/red-team candidates), captures answers, then authors the plan; the run executes only
after the plan is ready. Do NOT auto-start the autonomous run before the interview/plan is complete.

## Read first
src/services/planning-phase-service.ts (projcore spawn -> PLAN-READY -> plan.json),
run-orchestrator-service.ts (startRun: north_star writing ~line 161, phase transitions),
plan-parser-service.ts (per-task fields — recommended_model/model + effort already parsed in C6),
src/index.ts (chat-send + run start routes), schema.ts (runs.phase).

## Tasks (atomic; commit each) — SCOPE = D-b only

### D-b1 — INTERVIEW phase before PLANNING
- Add an `interview` phase to the run lifecycle BEFORE `planning`. When a Command Center
  conversation starts a task list, projcore is spawned (D-a) and conducts the interview in chat:
  it writes `north_star.md` + `decisions/` in the run dir from the operator's answers, and signals
  readiness (e.g. a NORTH-STAR-READY callback) before planning begins. The autonomous run/loop must
  NOT start until north-star is ready AND the plan is authored/approved.
- Persist the interview phase in runs.phase; chat during interview routes to projcore (uses D-a
  projcore session). Keep the existing autonomous path working when no interview is needed
  (e.g. an explicit pre-authored north_star/prompt can skip straight to planning).
- Commit: feat(interview): north-star interview phase in Command Center before planning

### D-b2 — plan.json carries per-task model + effort (G9 authoring)
- Ensure plan authoring emits per-task `model` (or recommended_model) + `effort` in plan.json, fed
  by the interview's per-task model/effort policy; PlanParser already consumes them (C6) and the run
  honors them (C-a). Add a test that a plan.json with per-task model/effort flows end-to-end.
- Commit: feat(plan): plan.json per-task model + effort from interview policy

## Verify (paste REAL)
1. npm run build clean (tsc). 2. Tests (HELM_DB_PATH temp): a run goes interview -> (north-star
   written) -> planning -> execute; the autonomous loop does not start before north-star ready;
   plan.json per-task model/effort flow end-to-end. 3. Full suite (HELM_DB_PATH temp): only
   emit-status. 4. data/helm.db mtime unchanged. 5. Commit each; append changes.md. End DONE/BLOCKED.
Scope fence: planning-phase + run-orchestrator + index routes + plan-parser + schema(phase) + tests.
Branch feat/helm-agent-port.
