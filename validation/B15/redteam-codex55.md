# B15 Redteam Standard — codex55

Tip: `ede9faf6dc494e6df98ff84352c75588e7ce11d4`

Brief: `plan/janitor-audit-remediation/prompts/B15-redteam-brief.md`

Verdict: DONE — CLEAN

## Scope Checked

- Fresh schema track: `src/db/schema.ts` now sets `SCHEMA_VERSION = 108` and defines `helm_sessions.owner TEXT NOT NULL CHECK(owner IN ('helm','human','legacy:unknown'))`.
- Migration track: `src/db/database.ts` v108 rebuilds `helm_sessions` with `owner NOT NULL`, preserving explicit `id` values via `INSERT INTO helm_sessions_new (id, ...) SELECT id, ... FROM helm_sessions`.
- Residual nullable data: v108 re-runs the existing `deriveSessionOwner(name, kind)` backfill for `owner IS NULL` rows before the NOT NULL rebuild.
- FK hazard: v108 disables `foreign_keys` before the transaction, rebuilds the FK target table, runs `PRAGMA foreign_key_check`, and filters for `helm_sessions` parent/table problems before committing.
- Tests: B15 coverage in `src/services/session-registry-service.test.ts` uses synthetic/temp DBs only and asserts live `data/helm.db` mtime stability.

## Redteam Results

No CRITICAL found.

- Owner nullable on either track: not found. Fresh `PRAGMA table_info(helm_sessions)` reports `owner.notnull = 1`; the v107->v108 test asserts the migrated table also reports `notnull = 1`.
- Rebuild drops/reassigns row ids: not found. The rebuild copies `id` explicitly; the B15 fixture keeps `helm_sessions.id = 1` and verifies `housekeeper_investigations.helm_session_id = 1` still joins after migration.
- Residual null owners not backfilled: not found. The B15 fixture inserts a residual NULL owner and verifies it is backfilled to `helm`.
- Null insert still succeeds: not found. The B15 fixture attempts `INSERT ... owner NULL` after migration and expects rejection.
- Live production DB mtime changed by tests: not found in my run. I checked `data/helm.db`, `data/helm.db-wal`, `data/helm.db-shm`, `data/cards2-ibrain.db`, `data/cards2-ibrain.db-wal`, and `data/cards2-ibrain.db-shm` immediately before and after the targeted test run; mtimes were unchanged.

## Verification Run

Command:

```sh
HELM_SESSION_JANITOR=0 npx vitest run src/services/session-registry-service.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       68 passed (68)
```

Mtime evidence before and after the run was identical:

```text
data/helm.db             1785248382143.1382
data/helm.db-wal         1785267361301.9333
data/helm.db-shm         1785267361301.9333
data/cards2-ibrain.db    1785186321372.0613
data/cards2-ibrain.db-wal 1785194180100.43
data/cards2-ibrain.db-shm 1785267464537.896
```

## Notes

The migration restores `foreign_keys = ON` after success rather than restoring the previous setting. `DatabaseService` constructors already force `foreign_keys = ON`, so this is not a B15 CRITICAL under the current service contract, but it is worth keeping in mind if future tests intentionally instantiate the service with FK enforcement off.

Callback: redteam-codex55 B15 STATUS: DONE — CLEAN
