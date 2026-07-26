# Validator brief — codex-5.5. Phase E-b (Documents helm_tasks grouping + project memory UI). Verifier ≠ fixer.
Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Validate E-b commits e783482 + 256c521.
INCIDENT GUARD: HELM_DB_PATH temp; never touch live data/helm.db; prove mtime unchanged. Probes + npm run build.
Check (file:line):
1. E-b1 (G12): the Documents route/UI returns a view SCOPED to the selected project's helm_tasks/ tree,
   grouped per task list -> per-task folder, and EXCLUDES node_modules/vendor. Probe the route output.
2. E-b2 (G13): project memory split short-term/long-term, per-project, reviewable on Projects page;
   memories.horizon migration present + per-project short/long query works. Probe.
3. npm run build clean; full suite HELM_DB_PATH temp only emit-status; data/helm.db mtime unchanged.
Output: seeds/agent-port-2026-06-19/validation/phaseE-b-codex55.md; END STATUS: PASS or FAIL — <gaps>.
