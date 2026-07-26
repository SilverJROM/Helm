# CC-CHAT-4 (F4) — R5 zombie run loop + sanctioned stop + EHR ghost root-cause

Date: 2026-07-02 · Branch: feat/helm-projcore-port · Base: 45bbc50

## A. R5a — loop abort on terminal DB state

Mechanism (no polling thread; one SELECT per boundary + in-memory registry):
- src/services/run-abort-registry.ts (NEW): process-local Map<runId, {reason, at}> flipped by the stop endpoint.
- src/services/orchestrator-loop.ts:
  - RunAbortedError + TERMINAL_RUN_PHASES/STATUSES exported.
  - runTerminalDetail() — registry check + `SELECT phase, status FROM runs WHERE id=?`.
  - assertRunActive(boundary) — called at every attempt boundary (legacy + B8 ladder loops), BEFORE every dispatch (performRolePhase head, consultProjcoreBrain head). On terminal: logs `[orchestrator-loop] aborted: run terminal in DB (...)`, reaps live run workers via transport (reapLiveRunWorkers), marks their worker_runtimes rows reaped/run-aborted, throws.
  - waitForCallback poll loop consults the registry EVERY cycle (~1s real / 12ms fake) → sanctioned stop lands mid-wait within one cycle; performRolePhase's catch reaps the in-flight session.
  - RunAbortedError exempted from the agent-fail→FAIL-ladder conversion; rethrown from runQueuedTasks.
- src/services/run-orchestrator-service.ts:
  - assertRunActive(runId, boundary) at post-interview, pre-execution, task-boundary (before EVERY task dispatch — the run-74 zombie scenario).
  - All phase-advance UPDATEs guarded `AND phase NOT IN ('complete','failed','blocked')` (terminal runs can never be advanced/resurrected).
  - startRun wraps startRunInner; RunAbortedError → clean warn ("orchestration stopped cleanly") + normal return (detached failure path does not fire for a sanctioned stop).
  - waitForNorthStarReady exits within one poll cycle on a registry stop.

## B. R5b — sanctioned stop

- RunOrchestratorService.stopRun(runId, reason): flips the abort flag FIRST, marks run terminal (runs.status CHECK only allows complete|failed → 'failed'; stop_reason recorded as an agent_events row — type status, state STOPPED, correlation run-stop:<id>:<ts>), reaps live worker_runtimes sessions + rows, and in pre-executing phases (starting/interview/planning) also reaps the run's projcore coordinator session (D-a naming). Idempotent (alreadyTerminal).
- POST /api/runs/:id/stop in src/index.ts (owner + local-launch guarded): 200 / 200-alreadyTerminal / 404.
- CC UI: "■ Stop" button (data-testid="cc-run-stop", confirm dialog) in the run panel header next to phase/status chips; hidden when terminal. index.html ?v= bumped 20260702b → 20260702c.

## C. EHR ghost — ROOT CAUSE (file:line)

helm-projcore-EHR was spawned by the VITEST SUITE ITSELF, not any Helm runtime service:
- src/p1-6a.test.ts (also p1-6b, p1-5b, p1-5a) builds MasterRuntimeService with the REAL TmuxService and calls runtimeService.launchMaster(realPid) where realPid = first active project of the shared AGJAssist DB → id 1, directory_name 'EHR'.
- src/services/master-runtime-service.ts:81-87 resolves the slug from the AGJ DB ('EHR'); :133-136 D-a1 naming falls back to `helm-projcore-${slug}` when the helm projects row has NO projcore_session; :139-142 creates the REAL tmux session + launches the grok TUI (cwd = the test-seeded /tmp/helm-test-pid-1 — observed in the live ghost pane).
- The leak: the suites' cleanup killed the WRONG name — `helm-${realSlug}` (helm-EHR) — old p1-6a.test.ts:62/139, p1-6b.test.ts:70 etc. — so helm-projcore-EHR survived every full-suite run. Cadence: each batch-gate vitest run (~30-60min during active projcore work) re-created it — exactly the observed respawn pattern. This also explains why HELM_DISABLE_MASTER_SUPERVISOR=1 was irrelevant (different process: vitest, not pm2) and why master_runtimes was EMPTY (tests write to their own temp DBs /tmp/helm-p6a-*.db).
- Deterministic repro (pre-fix): killed the session at 11:43:44 → `npx vitest run src/p1-6a.test.ts` at 11:43:53 → helm-projcore-EHR re-created at 11:43:53 (the suite's start second).

### The guard (semantically correct: test-owned session identity)
- p1-5a/p1-5b/p1-6a/p1-6b fixtures now seed a TEST-SCOPED projects.projcore_session (helm-p5a/p5b/p6a/p6b-test-<nonce>) — launchMaster honors the column (D-a1), so the AGJ-slug ghost name can never be derived — and cleanup reaps the ACTUAL launched session (+ legacy names swept).
- src/services/ehr-ghost-guard.test.ts (NEW, 3 tests): (1) launchMaster with projcore_session set creates THAT session, never helm-projcore-EHR (fake tmux, records createSession names); (2) documents the NULL-fallback deriving exactly helm-projcore-EHR (why fixtures MUST set the column); (3) fixture-lint pinning all four suites to the seeded-session + reap contract.

### Non-return proof
- Pre-fix repro: ghost re-appeared at suite-start second (deterministic spawner identification).
- Post-fix cycle 1: p1-5b + p1-6a + p1-6b (48 passed) → no ghost / no leaked test sessions.
- Post-fix cycle 2: full suite → no ghost (v-final-vitest.txt).
- Wall-clock watch ≥10 min after final kill: iii-ghost-watch.txt.

## Gate

- Build exit 0 (node --check app.js + tsc + sandbox cc).
- Vitest: full suite green — 539 baseline + 10 new (run-abort.test.ts ×7: loop-abort A/A2, mid-wait stop B, stopRun C/C2/C3, HTTP contract D; ehr-ghost-guard.test.ts ×3). Final tail: v-final-vitest.txt.
- No non-terminal runs before restart; plain pm2 restart helm; DELETE FROM master_runtimes (0 rows after).

## Live verification

(i) Stop (files i1–i4):
- Run 86 via POST /api/projects/1/runs → interview, helm-pm-cards spawned (tmux before/after captured).
- Stopped via the CC Stop button (confirm dialog auto-accepted) — UI round-trip 458ms; run 86 → phase/status failed + ended_at; agent_events stop row with stop_reason; helm-pm-cards REAPED; pm2 log chain: "STOP requested" → "[run-orchestrator] aborted: run terminal in DB (run=86 boundary=post-interview stop requested via registry ...)" → "orchestration stopped cleanly".
- Run 87: direct curl stop → 1.3s incl. tmux reap; idempotent second stop alreadyTerminal:true; 404 unknown run; session gone.
- Executing-phase loop abort (spawning stops within one cycle, worker sessions reaped, worker_runtimes rows marked) pinned deterministically by run-abort tests A2/B.

(ii) CC Stop button: ii1-stop-button-visible.png (Run #86 · interview · active · red ■ Stop) and ii2-after-stop-terminal.png (failed/failed, button hidden).

(iii) Ghost: root cause + guard above; repro/watch transcripts in this directory.

Cards repo: untouched by this batch — runs 86/87 (rmr3gh6v5/rmr3gnbq8) stopped in interview, zero writes; the only helm_tasks/ dir there is rmr35wdod from pre-existing run 81.
