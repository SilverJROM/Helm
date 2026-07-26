# Validator brief — codex-5.5. Phase D-b (interview phase + plan per-task fields). Verifier ≠ fixer.
Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Validate the D-b commits. INCIDENT GUARD:
HELM_DB_PATH temp; never touch live data/helm.db; prove mtime unchanged. Runtime probes + npm run build.
Check (mechanism-level, file:line):
1. D-b1: an `interview` phase exists BEFORE `planning` in the run lifecycle. On a Command-Center task
   list, projcore writes north_star.md + decisions/ from the interview and signals readiness; the
   AUTONOMOUS run/loop does NOT start before north-star is ready AND the plan is authored. Probe the
   phase ordering (runs.phase: interview -> planning -> executing). Confirm the existing autonomous
   path still works when a pre-authored north_star/prompt lets it skip the interview.
2. D-b2: plan authoring emits per-task model/effort in plan.json; PlanParser consumes them and the run
   honors them end-to-end (a plan.json with per-task model/effort dispatches that model). 
3. npm run build clean; full suite HELM_DB_PATH temp only emit-status; data/helm.db mtime unchanged.
Output: seeds/agent-port-2026-06-19/validation/phaseD-b-codex55.md; END STATUS: PASS or FAIL — <gaps>.
