# B15 R2 Redteam — codex55

Tip: `9b038e0c0412eaa394164f00723b079dc8fd881a`

Prior R1: CLEAN on AC20 product.

Verdict: DONE — CLEAN

## Scope Checked

- R2 is test-only: the committed diff touches only `src/services/session-registry-service.test.ts`.
- §7.2 target: close the live-DB isolation guard weakness where only `data/helm.db` main-file mtime was checked even though the live service runs SQLite in WAL mode.
- Product AC20 owner NOT NULL code from R1 was not changed.

## Redteam Results

No CRITICAL found.

- Main-only guard remains: not found. `liveDbMtimes()` snapshots `data/helm.db`, `data/helm.db-wal`, and `data/helm.db-shm` as `{ main, wal, shm }` using only `fs.existsSync` and `fs.statSync`.
- WAL/SHM mutation could pass unnoticed: not found. The S04, S07, and B15 afterEach guards now compare the full triplet with `toEqual(liveMtimesBefore)`, so WAL creation, deletion, or mtime movement fails the guard.
- Live DB opened by the guard: not found. The helper never instantiates SQLite or `DatabaseService` against `data/helm.db`; it reads filesystem metadata only.
- Product regression from the R2 patch: not found. No production source, schema, migration, or runtime file was edited.

## Evidence

Relevant changed locations:

- `src/services/session-registry-service.test.ts:30` defines `LIVE_DB_PATH`.
- `src/services/session-registry-service.test.ts:37` defines `liveDbMtimes()` over main + wal + shm.
- `src/services/session-registry-service.test.ts:161`, `:282`, and `:436` assert the full triplet after test cleanup.

Verification command:

```sh
HELM_SESSION_JANITOR=0 HELM_DB_PATH=/tmp/helm-b15-r2-codex55-$$.db npx vitest run src/services/session-registry-service.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       68 passed (68)
```

Live DB metadata after the run:

```text
data/helm.db     1785248382 2224128 9599810
data/helm.db-wal 1785267361 123632 9585539
data/helm.db-shm 1785267361 32768 9585543
```

## Notes

The guard is conditional on `data/helm.db` existing, matching the live-DB isolation contract. When it exists, all three WAL-relevant files are part of the equality assertion, with missing sidecars represented as `null`.

Callback: redteam-codex55 B15 R2 STATUS: DONE — CLEAN
