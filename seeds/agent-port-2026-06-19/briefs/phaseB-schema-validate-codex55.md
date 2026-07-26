# Validator brief — codex-5.5. Phase B-schema. Verifier ≠ fixer: report, do NOT fix.

Repo: /home/agjrom/TGBOTS/Helm (cwd), branch feat/helm-agent-port. Validate grok's Phase B-schema
(commits 5b4598e..b62a535) against seeds/agent-port-2026-06-19/briefs/phaseB-schema-grok.md and
the build-plan Phase B (B1/B2/B4/B5). Read the diff (`git show`/`git diff 9bff528..HEAD`), schema.ts,
task-queue-service.ts, run-orchestrator-service.ts, and changes.md.

## Check (mechanism-level)
1. **B1** `teams` + `team_members`: columns/FK/CHECK/indexes correct; SCHEMA_VERSION bumped; default
   rosters seeded with REAL model ids (deliberation = opus/codex-5.5/sonnet/spark; red-team =
   codex-5.5/sonnet/spark); missing-model members skipped cleanly. Re-run/idempotent.
2. **B2** `role_team_bindings` (or chosen contract): deliberation/red-team can bind a TEAM; no
   agent-FK delete-409 regression; the choice is sound.
3. **B4** `run_tasks.status` allows failed+deferred; `markFailed`/`markDeferred` persist (not
   in-memory only); deferred/failed do NOT block the queue drain of independent ready tasks.
4. **B5** artifact-root helper builds `<project>/helm_tasks/<tasklist>/<task>/`; `artifacts.task_id`
   present; no migration of old artifacts.
5. **Build + tests:** run `npm run build` and `npx vitest run` yourself; the pre-existing
   `projcore-emit-status.sh` failure is allowed — everything else must pass. Note real counts.
6. Any regression / migration / idempotency risk; anything claimed-but-not-true.

## Output
Write findings to seeds/agent-port-2026-06-19/validation/phaseB-schema-codex55.md and END your
reply with exactly: `STATUS: PASS` or `STATUS: FAIL — <numbered gaps>`.
