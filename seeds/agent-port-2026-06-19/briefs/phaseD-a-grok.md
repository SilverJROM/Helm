# Implementer brief — Phase D-a (ephemeral projcore lifecycle + session-name + chat controls). grok-build.
Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. INCIDENT GUARD: HELM_DB_PATH temp for ALL
tests; never touch live data/helm.db; prove mtime unchanged. VERIFY BUILD with `npm run build` (tsc) +
vitest. Builds on B+C.

## Context (JROM decisions — decisions/2026-06-19-project-setup-and-lifecycle.md G11)
projcore must be EPHEMERAL: spawned when a Command Center conversation/task list starts; NOT a
persistent promoted master; NO auto-respawn for run-owned sessions. On completion, ASK JROM whether
to close (not silent reap). A chat "force close" button (with confirm) can kill it anytime. The
projcore tmux session name is operator-defined, default `helm-projcore-<project>`, editable on
Project Setup -> Projects.

## Read first
src/services/master-runtime-service.ts (launchMaster + the supervisor/respawn loop ~496-557),
plumbing-watcher-service.ts (recovery/relaunch of stuck masters), src/index.ts (chat-send route +
/launch-master + projects config routes), src/web/public/app.js (Command Center chat + Project
Setup Projects tab), schema.ts (master_runtimes, projects).

## Tasks (atomic; commit each) — SCOPE = D-a lifecycle/UI ONLY (NOT the interview/plan-authoring; that is D-b)

### D-a1 — projcore session name field (default helm-projcore-<project>, editable)
- Add a per-project projcore session name (column on projects or a settings row), default
  `helm-projcore-<directory_name|slug>`. Surface + edit on Project Setup -> Projects (app.js + a
  PUT route). launchMaster uses this name when spawning projcore.
- Commit: feat(project): editable projcore session name (default helm-projcore-<project>)

### D-a2 — no auto-respawn for run-owned / completed projcore
- Guard the master supervisor (master-runtime-service + plumbing-watcher): do NOT auto-respawn a
  projcore session that is run-owned and has completed or been intentionally closed. Distinguish a
  crash-during-active-run (may relaunch per existing policy) from completed/closed (do NOT relaunch).
  Add a master_runtimes state or flag for intentional-close / run-complete.
- Commit: feat(lifecycle): stop auto-respawning completed/closed run-owned projcore

### D-a3 — close-on-confirm at completion + force-close button
- On run completion, do NOT silently reap projcore; set a state that surfaces a "close projcore
  session?" confirmation to the operator. Add an endpoint POST /api/projects/:id/master/close (owner
  + loopback) that tears down the projcore session (with the existing teardown), used by:
  (a) the completion confirm, (b) a chat "force close" button (data-testid="force-close-master-btn",
  with a confirm) in Command Center. 409 if no master / already closed.
- Commit: feat(cc): close-on-confirm at completion + force-close button (POST master/close)

## Verify (paste REAL)
1. npm run build clean (tsc). 2. Tests (HELM_DB_PATH temp): session-name default + override used at
   launch; a completed/closed run-owned projcore is NOT auto-respawned; force-close endpoint tears
   down + 409 when none. 3. Full suite (HELM_DB_PATH temp): only emit-status. 4. data/helm.db mtime
   unchanged. 5. Commit each; append changes.md. End DONE or BLOCKED.
Scope fence: master-runtime-service + plumbing-watcher + index routes + app.js + schema (small
column/flag) + tests. Do NOT build the interview/plan-authoring flow (D-b). Branch feat/helm-agent-port.
