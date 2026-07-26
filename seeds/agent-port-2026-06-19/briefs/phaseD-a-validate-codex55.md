# Validator brief — codex-5.5. Phase D-a (ephemeral projcore lifecycle). Verifier ≠ fixer.
Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Validate D-a commits (1e25f50 no-respawn,
7c1fa02 close-on-confirm+force-close, the D-a1 session-name commit, 53ffad4 naming consistency fix).
INCIDENT GUARD: HELM_DB_PATH temp; never touch live data/helm.db; prove mtime unchanged. Runtime probes + npm run build.

Check (mechanism-level, file:line):
1. D-a1: launchMaster uses the projcore session name (default helm-projcore-<slug>, editable via
   projcore_session); the Project Setup Projects page + a route persist/edit it; launch uses it
   consistently (no helm-<slug> vs helm-projcore-<slug> mismatch). p1-5a REAL launch passes.
2. D-a2: a completed/closed run-owned projcore is NOT auto-respawned by the supervisor/plumbing-watcher
   (probe: set the completed/closed state -> supervisor tick does NOT relaunch). A genuine
   crash-during-active-run may still relaunch per existing policy — confirm the distinction.
3. D-a3: POST /api/projects/:id/master/close (owner+loopback) tears down the projcore session + returns
   409 when none/already-closed; the chat force-close button (data-testid=force-close-master-btn) is wired;
   run completion sets a close-confirm state (not a silent reap).
4. npm run build clean; full suite HELM_DB_PATH temp only emit-status; data/helm.db mtime unchanged.
Output: seeds/agent-port-2026-06-19/validation/phaseD-a-codex55.md; END STATUS: PASS or FAIL — <gaps>.
