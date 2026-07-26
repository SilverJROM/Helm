# Validator brief — codex-5.5. Phase C-a (C1/C6/C5). Verifier ≠ fixer; report, do NOT fix.
Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Validate grok's C-a commits
(ae950ad panels-per-seat, C6 per-task model/effort, 4f8cdaf low-budget). INCIDENT GUARD: HELM_DB_PATH
temp; never touch live data/helm.db; prove mtime unchanged. Use RUNTIME PROBES, not just unit tests.

Check (mechanism-level, file:line):
1. C1: conveneDeliberationPanel + conveneRedTeamPanel actually spawn PER-SEAT models from the
   resolved team roster (each seat uses its member's model_id + lens) — not a single model. Trace the
   spawn loop. Probe: a team with 3 distinct models → 3 distinct spawn models.
2. C6 (G9): per-task `model` + `effort` from plan.json are honored at dispatch — PlanParser reads
   them, startRun passes explicitModel+effort into runTask, loop uses them as the task base + passes
   effort to the transport spawn. Precedence: project override/default > per-task base > escalation
   rung. Probe: a task with model X spawns worker with X (model_id), not the default.
3. C5: low-budget escalation trigger actually swaps to the next rung / headroom model when remaining
   budget < threshold (fake gateway). Verify it doesn't break the on-fail ladder or per-task base.
4. npm run build clean; full suite (HELM_DB_PATH temp) only emit-status fails; data/helm.db mtime
   unchanged.
Output: write seeds/agent-port-2026-06-19/validation/phaseC-a-codex55.md; END with STATUS: PASS or
STATUS: FAIL — <numbered gaps>.
