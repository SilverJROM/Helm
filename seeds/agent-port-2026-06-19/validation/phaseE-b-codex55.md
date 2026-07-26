# Phase E-b Validation - codex55

Date: 2026-06-19
Validator: codex55
Verdict: PASS

## Scope

Validated `seeds/agent-port-2026-06-19/briefs/phaseE-b-validate-codex55.md` for Phase E-b:

- E-b1/G12: Documents scoped to the selected project's `helm_tasks/` tree, grouped by task list and task folder, excluding `node_modules` and `vendor`.
- E-b2/G13: project memory split short-term/long-term, per-project, reviewable on Projects page; `memories.horizon` migration and query work.
- `npm run build`.
- Full suite with temp `HELM_DB_PATH`; only the known emit-status failure allowed.
- Never touched live `data/helm.db`; prove mtime unchanged.

Validated commits:

- `e783482 feat(docs): Documents tab scoped to helm_tasks grouped per project/tasklist/task`
- `256c521 feat(memory): project short/long-term memory reviewable on Projects page`

## Commands Run

- Route/service probe with temp Helm DB and temp AGJAssist auth DB:
  `HELM_DB_PATH=/tmp/helm-phaseE-b-probe2-*/helm.db AGJASSIST_DB_PATH=/tmp/helm-phaseE-b-probe2-*/agj.db HELM_PORT=43118 USE_FAKE_TMUX=1 NODE_ENV=test node --import tsx src/index.ts`
- Build:
  `HELM_DB_PATH=/tmp/helm-phaseE-b-build-*.db npm run build`
- Full suite:
  `HELM_DB_PATH=/tmp/helm-phaseE-b-full-*.db npx vitest run`

Live DB mtime proof:

- Probe: `before=1781867927 after=1781867927 unchanged=yes`
- Build: `before=1781867927 after=1781867927 unchanged=yes`
- Full suite: `before=1781867927 after=1781867927 unchanged=yes`

## E-b1 Documents

PASS.

Probe setup:

- Project 101 directory had:
  - `helm_tasks/listA/taskOne/changes.md`
  - `helm_tasks/listA/taskOne/prompts/implementer.brief.md`
  - `helm_tasks/listA/taskTwo/final.md`
  - `helm_tasks/listB/taskThree/evidence.md`
  - noise under `helm_tasks/listA/taskOne/node_modules/...`
  - noise under `helm_tasks/listA/taskOne/vendor/...`
  - root `README.md`
  - root `node_modules/...`
- Project 202 had its own `helm_tasks/otherList/otherTask/other.md`.

Actual route probed:

- `GET /api/projects/101/docs?tree=1&scope=helm_tasks`

Observed route output:

```json
{
  "docsTreeFlag": true,
  "rels": [
    "helm_tasks/listA/taskOne/changes.md",
    "helm_tasks/listA/taskOne/prompts/implementer.brief.md",
    "helm_tasks/listA/taskTwo/final.md",
    "helm_tasks/listB/taskThree/evidence.md"
  ],
  "bad": [],
  "hasRootReadme": false,
  "groupedShape": true
}
```

This proves:

- Route output is scoped to the selected project's `helm_tasks/` root.
- Paths retain tasklist -> task folder grouping.
- `node_modules` and `vendor` are excluded.
- Root project docs and other project docs do not leak into the scoped view.

Static support:

- `src/index.ts:612` checks tree requests and `src/index.ts:614` selects `scope=helm_tasks`.
- `src/index.ts:616` calls `listProjectHelmTasksMdTree`.
- `src/services/project-docs-service.ts:160` starts at `<project>/helm_tasks`.
- `src/services/project-docs-service.ts:175` excludes `node_modules` and `vendor`.
- `src/web/public/app.js:896` has the Documents UI call `GET /api/projects/${pid}/docs?tree=1&scope=helm_tasks`.
- `src/web/public/app.js:1849` labels the Documents tab as project/tasklist/task `helm_tasks` grouping with vendor exclusions.

## E-b2 Project Memory

PASS.

Probe setup inserted:

- Project 101 short memory: `short p101`
- Project 101 long memory: `long p101`
- Project 202 short memory: `short p202`
- App short memory: `app short`

Direct schema/service proof:

```json
{
  "horizonColumn": true,
  "memorySplit": {
    "short": ["short p101"],
    "long": ["long p101"]
  }
}
```

Route proof:

```json
{
  "shortTitles": ["short p101"],
  "longTitles": ["long p101"],
  "otherShortTitles": ["short p202"]
}
```

This proves:

- `memories.horizon` exists on the temp fresh schema.
- `MemoryService.listProjectMemoriesByHorizon(101)` returns only project 101 short/long rows.
- `GET /api/memory?scope=project&project_id=101&horizon=short` returns only project 101 short rows.
- `GET /api/memory?scope=project&project_id=101&horizon=long` returns only project 101 long rows.
- Project filtering is real; project 202 short memory is isolated to project 202.

Static support:

- `src/db/schema.ts:419` defines `memories.horizon`.
- `src/db/database.ts:61` adds a defensive migration guard for older DBs missing `horizon`.
- `src/services/memory-service.ts:45` filters by `horizon`.
- `src/services/memory-service.ts:213` implements the explicit per-project short/long split query.
- `src/index.ts:1088` exposes `/api/memory`, and `src/index.ts:1095` passes `scope`, `project_id`, and `horizon` into `MemoryService.listMemories`.
- `src/web/public/app.js:225` loads short/long project memory via `/api/memory?scope=project&project_id=...&horizon=...`.
- `src/web/public/app.js:1548` renders the Projects page read-only project memory review card.

## Build and Suite

Build: PASS.

- `npm run build` exited `0`.
- Existing C compiler warning remains:
  `tools/helm-sandbox.c:208:56: warning: "/*" within comment`.

Full suite: acceptable expected result.

- Summary: `1 failed | 20 passed`; `253 passed | 3 skipped`.
- Only failure:
  `src/services/orchestrator-loop.test.ts > projcore-emit-status.sh accepts red-team VERDICT-READY and validator PASS (d)`.
- Relevant E-b tests passed:
  - `src/project-service.test.ts` reported 18 tests, including the new Documents scoped tree coverage.
  - `src/memory-service.test.ts` reported 6 tests, including the horizon split coverage.

## Verdict

PASS.

Both E-b requirements are validated by route/service probes, static code review, build, and the full temp-DB suite with only the known emit-status failure.
