# Implementer brief — Phase E-b (Documents helm_tasks grouping + project memory UI). grok-build. FINAL batch.
Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. INCIDENT GUARD: HELM_DB_PATH temp for ALL
tests; never touch live data/helm.db; prove mtime unchanged. VERIFY BUILD with `npm run build` (tsc).
Builds on all prior phases. E-a already writes artifacts under <project>/helm_tasks/<tasklist>/<task>/.

## Read first
src/web/public/app.js (Project Setup -> Documents tab `06-setup-project-prefs`; Projects tab
`04-setup-projects`; Memory tab). src/index.ts (documents/file-tree route, memories routes).
schema.ts (memories table — add a horizon/short-long dimension if not present).

## Tasks (atomic; commit each) — SCOPE = E-b UI/docs/memory ONLY

### E-b1 — Documents grouped per project + per task list (G12)
- Documents tab: a project dropdown FILTER; selecting a project shows its `helm_tasks/` tree grouped
  by task list (run) -> per-task folder -> files (the dirs E-a writes). EXCLUDE node_modules / vendor
  from the tree. The current flat recursive tree (incl. node_modules) is replaced by this scoped view.
  Back it with a route that lists the project's helm_tasks/ tree (server-side, scoped).
- Commit: feat(docs): Documents tab scoped to helm_tasks grouped per project/tasklist/task

### E-b2 — Project memory short-term / long-term, reviewable on Projects (G13)
- Surface project-related memory split SHORT-TERM and LONG-TERM on the Project Setup -> Projects page
  (or a clearly-linked project memory view), reviewable by the operator. Use the `memories` table; add
  a `horizon` column (short|long) if not present (migration) + the per-project query + the UI
  (two sections). Read-only review is enough.
- Commit: feat(memory): project short/long-term memory reviewable on Projects page

## Verify (paste REAL)
1. npm run build clean (tsc). 2. Tests (HELM_DB_PATH temp): documents route returns the scoped
   helm_tasks tree (grouped, node_modules excluded); memories horizon migration + per-project
   short/long query. 3. Full suite (HELM_DB_PATH temp): only emit-status. 4. data/helm.db mtime
   unchanged. 5. Commit each; append changes.md. End DONE or BLOCKED.
Scope fence: app.js + index routes + schema (memories.horizon) + a small project-service/memory query
+ tests. Branch feat/helm-agent-port.
