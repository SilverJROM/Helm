# B15 Red-team Standard — sol

**Tip reviewed:** `ede9faf6dc494e6df98ff84352c75588e7ce11d4`  
**Base:** `e170ec5cf96371d5ce4f44afe589e9c9f394b2d0`  
**Verdict:** **CLEAN**

## Critical-class audit

| Defined CRITICAL class | Result | Evidence |
|---|---|---|
| Owner nullable on either track | Not found | Fresh DDL declares `owner TEXT NOT NULL` (`src/db/schema.ts:491`). The v108 rebuild does the same (`src/db/database.ts:3565`). Fresh and migrated `PRAGMA table_info(helm_sessions)` both returned `owner.notnull = 1`. |
| Rebuild drops/reassigns row IDs or silently orphans FKs | Not found | The rebuild explicitly copies `id` (`src/db/database.ts:3573-3575`) with FK enforcement disabled before `BEGIN`, then checks FKs before commit. An independent sparse-ID probe preserved IDs `7`, `4096`, `900000`, and `1000001`; three `housekeeper_investigations.helm_session_id` values stayed attached. The post-rebuild FK still named `helm_sessions` with `ON DELETE SET NULL`, and deleting a disposable parent nulled its child as expected. |
| Residual null owners not backfilled before NOT NULL | Not found | The migration selects all `owner IS NULL` rows and applies `deriveSessionOwner(name, kind)` before starting the rebuild (`src/db/database.ts:3540-3556`). The independent probe backfilled representative rows to `helm`, `human`, and `legacy:unknown` without rewriting a pre-owned `human` row. |
| Null insert still succeeds after migration | Not found | Direct null inserts were rejected on both a fresh database and a migrated v108 database. The committed migration test also asserts rejection (`src/services/session-registry-service.test.ts:543-548`). |
| Live production DB mtime changed by tests | Not found | Before/after nanosecond mtime, size, and inode were identical for `data/helm.db`, `data/helm.db-wal`, and `data/helm.db-shm`. All test and probe databases were under unique `/tmp/helm-b15-*` directories. |

## Verification

- `HELM_SESSION_JANITOR=0 HELM_DB_PATH=/tmp/... npx vitest run src/services/session-registry-service.test.ts -t 'B15 owner NOT NULL' --poolOptions.forks.maxForks=1`
  - PASS: 1 file; 2 passed; 66 skipped.
- Independent `npx tsx -e` v107→v108 probe on a disposable database:
  - fresh/migrated `notnull=1`;
  - fresh/migrated null inserts rejected;
  - four sparse IDs preserved;
  - all residual null-owner classes backfilled;
  - three FK dependents preserved;
  - `PRAGMA foreign_key_check` empty;
  - reopen at v108 idempotent;
  - post-rebuild `ON DELETE SET NULL` behavior intact.
- `HELM_SESSION_JANITOR=0 npx tsc -p tsconfig.json --noEmit` — PASS.
- `git diff --check e170ec5..ede9faf` — PASS.

## Non-critical note

The success path always sets `foreign_keys = ON` instead of restoring `fkWasOn`. `DatabaseService`
itself enables foreign keys before migration, so the observed service contract starts and ends with
enforcement on; this does not meet a defined B15 CRITICAL class.

No product files were edited during this review.

[projcore callback] redteam-sol B15 STATUS: DONE — CLEAN
