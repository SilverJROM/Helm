# Validator brief — codex-5.5. Phase C-b (C2/C3/C4). Verifier ≠ fixer; report, do NOT fix.
Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Validate grok C-b commits e23e389 (C2
validator), 24f390e (C3 issue defer), af69872 (C4 reviewer). INCIDENT GUARD: HELM_DB_PATH temp;
never touch live data/helm.db; prove mtime unchanged. Use RUNTIME PROBES + `npm run build` (tsc).

Check (mechanism-level, file:line):
1. C2: on the REAL feature path, after the deterministic npm gate PASSES, is the requirements-aware
   VALIDATOR agent actually spawned (not the old npm-only pass-through)? Does its brief include the
   CONTRACT (run requirements/north-star + task atomic_work/validation_criteria + diff)? Does a
   validator FAIL route back as a correction? Confirm it runs only on requirement-bearing tasks.
2. C3: issue REPRO retry — on REPRO-FAILED, does it retry up to X (default 2) then mark the task
   DEFERRED (run_tasks.status='deferred', not-reproducible), CONTINUE the queue (not halt/block
   independents), and does the run COMPLETION SUMMARY list all deferred issues? Probe the defer path.
3. C4: after validator PASS, is the REVIEWER spawned on code-bearing tasks (diff vs intent,
   symptom/regression/hardening)? Reviewer evidence persisted separately? Reviewer REJECT routes back?
4. `npm run build` clean (tsc); full suite HELM_DB_PATH temp only emit-status fails; mtime unchanged.
Output: write seeds/agent-port-2026-06-19/validation/phaseC-b-codex55.md; END STATUS: PASS or FAIL — <gaps>.
