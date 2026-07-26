# Implementer brief — harden tests vs LIVE data/helm.db (incident fix). grok-build.

Repo: /home/agjrom/TGBOTS/Helm, branch feat/helm-agent-port. Verifier ≠ fixer; paste REAL output.

## Why (incident)
Running the full vitest suite under concurrent access corrupted/emptied the LIVE `data/helm.db`
because some tests open/copy it directly. Make it IMPOSSIBLE for tests to touch the live DB.

## Tasks (atomic; commit each)

### T1 — global test DB isolation
- Ensure EVERY test run uses a per-run TEMP db, never the live one. In the vitest setup
  (vitest.config.* `setupFiles`, or add one) set `process.env.HELM_DB_PATH` to a unique temp path
  (e.g. `os.tmpdir()/helm-test-<pid>-<rand>.db`) BEFORE any config/db load, so `loadConfig().dbPath`
  is never `data/helm.db` during tests. Clean it up after.
- Commit: `test(infra): isolate all tests to a temp HELM_DB_PATH (never live db)`

### T2 — plumbing-watcher migration test: consistent snapshot, never touch live WAL
- `src/services/plumbing-watcher.test.ts` ~line 161 copies the live `data/helm.db` with
  `fs.copyFileSync` then unlinks `-wal`. Replace with a CONSISTENT snapshot that cannot lose WAL
  data and cannot affect the live files: use better-sqlite3 `db.backup(dest)` (open live READONLY)
  or `VACUUM INTO`, into a temp path. NEVER unlink/modify the live `data/helm.db*`. Keep the
  existing fresh-temp fallback. Update assertions to the current schema (v26) — additive checks
  only (afterAgents >= beforeAgents, plumbing_* present).
- Commit: `test(plumbing): consistent readonly snapshot for live-db migration test`

### T3 — p1-3 test: no live read-write open
- `src/p1-3.test.ts` ~line 65 does `new DatabaseService(config.dbPath)` (live, read-write, runs
  migrations). Point it at the temp HELM_DB_PATH from T1 (or a temp copy), or remove if `helmDb`
  is unused. The AGJAssist readonly open (agjDbTest) is fine — leave it readonly.
- Commit: `test(p1-3): use temp db, never open live helm.db read-write`

## Verify (paste REAL output) — DO NOT run the full suite against the live DB
1. Record `stat -c %Y data/helm.db` BEFORE.
2. `npm run build` clean.
3. Run the affected files ONLY: `npx vitest run src/p1-3.test.ts src/services/plumbing-watcher.test.ts`
   — must pass.
4. Record `stat -c %Y data/helm.db` AFTER — MUST be unchanged (prove the live DB was untouched).
5. Append `seeds/agent-port-2026-06-19/changes.md`. Report DONE with before/after mtime + counts.

Scope: ONLY these test/infra files + vitest config. No schema/engine changes. Branch
feat/helm-agent-port. End with DONE or BLOCKED.
