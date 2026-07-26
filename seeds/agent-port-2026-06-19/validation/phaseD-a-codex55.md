# Phase D-a Validation — codex55

Date: 2026-06-19
Repo: `/home/agjrom/TGBOTS/Helm`
Branch: `feat/helm-agent-port`
Scope: D-a ephemeral projcore lifecycle validation per `seeds/agent-port-2026-06-19/briefs/phaseD-a-validate-codex55.md`.

Result: FAIL

## Live DB Guard

- Live DB: `data/helm.db`
- Live DB mtime before probes/build/full suite: `1781838325`
- Live DB mtime after probes/build/full suite: `1781838325`
- Result: unchanged

All runtime probes and verification commands used temp `HELM_DB_PATH` values under `/tmp`. I did not run against live `data/helm.db`.

## Commands Run

```bash
HELM_DB_PATH=/tmp/helm-phaseD-a-build-*.db npm run build
HELM_DB_PATH=/tmp/helm-phaseD-a-p15a-*.db npx vitest run src/p1-5a.test.ts
HELM_DB_PATH=/tmp/helm-phaseD-a-full-*.db npx vitest run
```

Additional runtime probes used temp `HELM_DB_PATH` and fake/probed tmux transports to exercise project promotion defaults, master supervisor behavior, close route semantics, UI wiring, and run-completion transport calls without touching the live DB.

## Findings

### D-a1 session name default/editable/launch consistency: FAIL

Passing parts:

- Blank project promotion defaults `projcore_session` to `helm-projcore-<slug>`.
- Explicit editable `projcore_session` persists.
- Project Setup UI has the session display/edit/register controls.
- `MasterRuntimeService.launchMaster` uses `project.projcore_session` or `helm-projcore-<slug>`, not the old `helm-<slug>` fallback.
- `src/p1-5a.test.ts` passes with the REAL launch proof using `helm-projcore-EHR`.

Gap:

- `ProjectService.promoteProject` still uses `tmux_session` as the default `projcore_session` when `projcore_session` is blank. Runtime probe created a project with `tmux_session='legacy-open-session'` and no `projcore_session`; stored `projcore_session` was `legacy-open-session`, but D-a1 expects the default `helm-projcore-legacy-app`.
- Mechanism: [src/services/project-service.ts](/home/agjrom/TGBOTS/Helm/src/services/project-service.ts:72) sets `projcore_session = tmux_session || helm-projcore-<slug>`.

Probe excerpt:

```json
{
  "pLegacy": {
    "tmux_session": "legacy-open-session",
    "projcore_session": "legacy-open-session",
    "expected": "helm-projcore-legacy-app"
  }
}
```

### D-a2 no auto-respawn for completed/closed run-owned projcore: PASS

- Supervisor/plumbing watcher paths include `closed_reason` and skip closed run-owned sessions.
- Runtime probe set a failed/completed row with `closed_reason='run-complete'`; supervisor did not relaunch it.
- Runtime probe set a failed active row with no `closed_reason`; supervisor did relaunch it.

Probe excerpt:

```json
{
  "closedLaunchCalls": 0,
  "activeLaunchCalls": 1,
  "closedRow": { "state": "failed", "closed_reason": "run-complete" },
  "activeRow": { "state": "failed", "closed_reason": null }
}
```

### D-a3 close route, force-close UI, close-on-confirm: FAIL

Passing parts:

- `POST /api/projects/:id/master/close` requires owner/local auth checks in the route path.
- Direct route-logic probe returns 409 when no master session exists.
- First close terminates the session best-effort, writes a closed `master_runtimes` row, and returns 200.
- Second close returns 409 already closed.
- UI contains `data-testid="force-close-master-btn"` and `data-testid="close-projcore-confirm-btn"`.

Probe excerpt:

```json
{
  "noSessionClose": { "code": 409, "body": { "error": "no master session for project" } },
  "closeFirst": { "code": 200, "body": { "ok": true, "closed": "close-projcore-session" } },
  "closeRow": {
    "state": "closed",
    "closed_reason": "manual-close",
    "tmux_session": "close-projcore-session"
  },
  "closeSecond": { "code": 409, "body": { "error": "already closed" } },
  "terminated": ["close-projcore-session"]
}
```

Gap:

- Run completion still silently reaps the projcore session instead of leaving closure to the close-on-confirm path.
- Mechanism: [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:330) calls `this.deps.transport.reap(sessionName)` after marking the run complete.

Runtime probe completed a run and captured this unwanted reap:

```json
{
  "runCompletion": {
    "runRow": { "phase": "complete", "status": "complete" },
    "reapCalls": [
      { "handle": "implementer-2", "reason": "done-received" },
      { "handle": "validator-3", "reason": "val-complete" },
      { "handle": "implementer-4", "reason": "done-received" },
      { "handle": "validator-5", "reason": "val-complete" },
      { "handle": "run-close-projcore", "reason": "complete" }
    ]
  }
}
```

## Build And Tests

### `npm run build`: PASS

- `tsc` completed successfully.
- `cc` completed successfully.
- Only observed compiler warning was the pre-existing `tools/helm-sandbox.c:208` comment warning.
- Live DB mtime unchanged: `1781838325`.

### `src/p1-5a.test.ts`: PASS

- 1 test file passed.
- 5 tests passed.
- REAL launch proof used `helm-projcore-EHR`.
- Live DB mtime unchanged: `1781838325`.

### Full suite: ALLOWED FAILURE ONLY

- Command exited 1.
- 20 test files passed, 1 failed.
- 244 tests passed, 1 failed, 3 skipped.
- The only failing test was the allowed pre-existing emit-status path:
  `src/services/orchestrator-loop.test.ts > orchestrator-loop B8 escalation ladder (USE_FAKE_TMUX) > projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)`.
- `p1-6b` passed in the full run.
- Live DB mtime unchanged: `1781838325`.

## Verdict

Phase D-a is not complete. D-a2 is good, close route/UI are mostly good, and build/full-suite status is within the brief's allowed exception. The remaining blockers are:

1. D-a1 legacy `tmux_session` still becomes `projcore_session` instead of defaulting to `helm-projcore-<slug>`.
2. D-a3 run completion still silently reaps the projcore session, so closure is not exclusively close-on-confirm/force-close.

STATUS: FAIL — D-a1 legacy tmux_session still becomes projcore_session instead of helm-projcore-<slug>; D-a3 run completion still silently reaps the projcore session instead of close-on-confirm only.

---

# Phase D-a Re-validation — latest 2 commits

Date: 2026-06-19
Commits checked:

- `a97af5c` — `fix(D-a1): projcore_session never backfilled from tmux_session; always helm-projcore-<slug> (project-service, run-orche, index)`
- `dc5e125` — `fix(D-a3): no silent reap on run complete; set close-confirm state instead (run-orchestrator + tests)`

Result: FAIL

## Live DB Guard

- Live DB: `data/helm.db`
- Live DB mtime before/after all completed probes and build: `1781838325`
- Result: unchanged

All completed runtime probes and verification commands used temp `HELM_DB_PATH` values under `/tmp`.

## Commands Run

```bash
HELM_DB_PATH=/tmp/helm-phaseD-a-build-*.db npm run build
HELM_DB_PATH=/tmp/helm-phaseD-a-targeted-*.db USE_FAKE_TMUX=1 npx vitest run src/project-service.test.ts src/services/run-orchestrator-service.test.ts
```

Runtime probes also used temp DBs under `/tmp` with fake tmux/test transports for:

- promoted project default `projcore_session`
- run-orchestrator projcore dispatch session
- run completion close-confirm state
- no projcore session reap on completion
- HTTP `POST /api/projects/:id/master/close`
- force-close/close-confirm UI testid wiring

## Closed Prior Gaps

### D-a1 promoted project default: PASS

- Mechanism: [src/services/project-service.ts](/home/agjrom/TGBOTS/Helm/src/services/project-service.ts:72) now always defaults blank `projcore_session` to `helm-projcore-<slug>` and explicitly does not backfill from legacy `tmux_session`.
- Runtime probe promoted `Legacy App` with `tmux_session='legacy-open-session'` and no `projcore_session`; persisted `projcore_session='helm-projcore-legacy-app'`.
- Runtime probe also confirmed explicit editable `projcore_session='custom-projcore-session'` is preserved.
- Run-orchestrator dispatch used `sessionName='helm-projcore-legacy-app'`, not `legacy-open-session`.

Probe excerpt:

```json
{
  "promotedLegacy": {
    "tmux_session": "legacy-open-session",
    "projcore_session": "helm-projcore-legacy-app",
    "expected": "helm-projcore-legacy-app"
  },
  "editable": {
    "projcore_session": "custom-projcore-session"
  },
  "projcoreSpawn": {
    "sessionName": "helm-projcore-legacy-app"
  }
}
```

### D-a3 no silent reap on run completion: PASS

- Mechanism: [src/services/run-orchestrator-service.ts](/home/agjrom/TGBOTS/Helm/src/services/run-orchestrator-service.ts:330) no longer calls `transport.reap(sessionName)` on run completion.
- Runtime probe completed a run; `projcoreReaps` was empty.
- Runtime probe confirmed close-confirm state is written as a `master_runtimes` row for the projcore session with `state='running'` and `closed_reason=NULL`, so the operator can be prompted.

Probe excerpt:

```json
{
  "runRow": {
    "phase": "complete",
    "status": "complete"
  },
  "projcoreReaps": [],
  "closeStateRow": {
    "tmux_session": "helm-projcore-legacy-app",
    "state": "running",
    "closed_reason": null
  }
}
```

### POST master/close + force-close UI: PASS

- HTTP probe created a project through the real API route with legacy `tmux_session='legacy-close-session'`; API persisted `projcore_session='helm-projcore-close-probe'`.
- `POST /api/projects/:id/master/close` returned 409 when no master session existed.
- After seeding a running `master_runtimes` row for `helm-projcore-close-probe`, the close route returned 200 and marked the row `state='closed'`, `closed_reason='manual-close'`.
- A second close returned 409 already closed.
- UI still contains `data-testid="force-close-master-btn"`, `data-testid="close-projcore-confirm-btn"`, and `data-testid="close-on-complete-banner"`.

HTTP probe excerpt:

```json
{
  "project": {
    "tmux_session": "legacy-close-session",
    "projcore_session": "helm-projcore-close-probe"
  },
  "noSession": {
    "code": 409,
    "body": { "error": "no master session for project" }
  },
  "closeFirst": {
    "code": 200,
    "body": { "ok": true, "closed": "helm-projcore-close-probe" }
  },
  "closeRow": {
    "tmux_session": "helm-projcore-close-probe",
    "state": "closed",
    "closed_reason": "manual-close"
  },
  "closeSecond": {
    "code": 409,
    "body": { "error": "already closed" }
  }
}
```

## Remaining Gap

### `index.ts` active-run chat path still falls back to `tmux_session`: FAIL

The user asked to confirm `run-orchestrator + index no longer fall back to tmux_session`. Run-orchestrator is fixed, and the close route's active-run branch now uses `projcore_session` only. However, `index.ts` still has a separate active-run chat forwarding fallback:

- [src/index.ts](/home/agjrom/TGBOTS/Helm/src/index.ts:831) detects an active non-terminal run.
- [src/index.ts](/home/agjrom/TGBOTS/Helm/src/index.ts:834) then selects `tmux_session` from `projects`.
- [src/index.ts](/home/agjrom/TGBOTS/Helm/src/index.ts:835) assigns that legacy value to `targetSession`.

That means owner chat during an active run can still target the legacy `projects.tmux_session` when no latest `master_runtimes` row is available. This violates the re-validation acceptance clause that `index` no longer falls back to `tmux_session`.

## Build And Tests

### `npm run build`: PASS

- `tsc` completed successfully.
- `cc` completed successfully.
- Only observed compiler warning was the existing `tools/helm-sandbox.c:208` comment warning.
- Live DB mtime unchanged: `1781838325`.

### Targeted regression tests: PASS

- `src/project-service.test.ts`: 17 tests passed.
- `src/services/run-orchestrator-service.test.ts`: 17 tests passed.
- Total: 34 tests passed.
- The D-a1/D-a3 orchestrator regression test passed and asserts:
  - promoted `tmux_session='helm_cards'` does not become `projcore_session`
  - projcore spawn uses `helm-projcore-cards`
  - no projcore reap on completion
  - close-confirm `master_runtimes` row remains open with `closed_reason=NULL`
- Live DB mtime unchanged: `1781838325`.

## Verdict

The two prior concrete gaps are closed: promoted projects no longer backfill `projcore_session` from `tmux_session`, and run completion no longer silently reaps the projcore session. `POST /master/close` and force-close UI still work.

The re-validation still fails because `index.ts` retains an active-run chat fallback to `projects.tmux_session`.

STATUS: FAIL — index.ts active-run chat forwarding still falls back to projects.tmux_session instead of projcore_session when no latest master_runtimes row is available.
