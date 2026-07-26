# Helm — project_specs.md

> Standalone agent-orchestration app. Helm is the source of truth for projects. Owner-only, loopback-guarded, port :3110, SQLite. Bootstrapped by projcore 2026-06-21 from `package.json` / `ecosystem.config.cjs` / `og-requirements-v2.md`. Authoritative for build/test/deploy commands the projcore gate depends on.

## Stack
- Backend: Node + TypeScript (ESM), Fastify 5 (+cors, static, websocket), `better-sqlite3`. Human auth is hybrid: AGJAssist's readonly users/sessions DB verifies existing AGJ JWTs, while Helm issues instance-local JWTs with a separate secret. Entry `src/index.ts`.
- Frontend: single hand-written **vanilla** `src/web/public/app.js` (htm/preact-style, NO build step, NO TS annotations — `node --check` must pass).
- Sandbox: C launcher `tools/helm-sandbox.c` (Landlock LSM write-fence), compiled in build.
- DB: SQLite at `data/helm.db` (schema `src/db/schema.ts`, migrations `src/db/database.ts`). 31+ tables, `schema_version`.

## Build
```
npm run build
# = node --check src/web/public/app.js && tsc -p tsconfig.json && cc tools/helm-sandbox.c -o tools/helm-sandbox && cp -r src/web dist/
```
- `npm run check:webjs` — `node --check src/web/public/app.js` (run after ANY app.js edit; app.js is vanilla JS, TS annotations there = blank-page regression).

## Test
- Unit/integration: `npx vitest run` (config `vitest.config.ts`). **Always set `HELM_DB_PATH=/tmp/helm-test-$$.db`** so `data/helm.db` is never mutated by tests.
  - Targeted: `HELM_DB_PATH=/tmp/helm-test.db npx vitest run src/<file>.test.ts`
- E2E: `npx playwright test` (config `playwright.config.ts`, base :3110). Capstone only.
- Known-pre-existing: a `projcore-emit-status.sh` shell test may fail independently of app changes — not a regression signal.

## Run / Deploy
- Dev (foreground): `npm run dev` (tsx src/index.ts).
- Prod/DEV serve: `npm start` (node dist/index.js) under pm2 app name **helm** (`ecosystem.config.cjs`).
- **DEV deploy (autonomous-OK):** `npm run build && pm2 restart helm` → verify `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3110/` = 200. There is no QA/PROD.
- Env (`.env`): `HELM_PORT=3110`, `HELM_HOST`, `HELM_DB_PATH`, Helm-only `JWT_SECRET`, `AGJASSIST_DB_PATH`, and separate `AGJASSIST_JWT_SECRET`. Project identity/tracking/ingest are native Helm-only; AGJAssist is consulted only for human users and session validity.
- **Hybrid OVM release:** do not execute the O7.2 native-only cutover script. Parallel `:3112` validation uses a copied Helm DB, a distinct Helm JWT secret/process name, fake tmux, disabled supervisor/fallback/janitor, and no file-mutating routes against live project directories.

## §14 Stack & Specialty > [projcore]
- **Per-module test pattern:** one module's tests = one atomic gated task. Run `HELM_DB_PATH=/tmp/... npx vitest run <specific test file>`; never the full suite per-batch. Full vitest + Playwright e2e = capstone only (§2.10a).
- **UI-PROOF (validator):** every user-visible req validated on the rendered app at **http://127.0.0.1:3110** via Playwright/DOM + screenshot into `validation/`. API/code-read is never acceptance.
- **Gate build command:** `npm run build` must exit clean (tsc 0 errors; only the known sandbox.c `-Wextra` comment warning tolerated) AND `node --check src/web/public/app.js` passes.
- **DB safety:** tests must not touch `data/helm.db` (assert mtime unchanged on suspicion). Schema changes go through `src/db/schema.ts` (fresh) + a guarded migration block in `src/db/database.ts` (upgrades) — two-track.
- **Canonical coordinator session:** projcore runs in-tmux; child sessions `helm-<model>` (helm-grok, helm-codex55, helm-sonnet, helm-codex55-planner, helm-panel-*).
- **Spawn safety:** agents launched bypass-mode under the Landlock write-fence; briefs constrain destructive scope to the project dir.
