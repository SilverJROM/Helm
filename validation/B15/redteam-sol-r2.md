# B15 R2 Red-team — sol

**Tip reviewed:** `9b038e0c0412eaa394164f00723b079dc8fd881a`  
**Scope:** validator §7.2 WAL-aware live-DB mtime guard  
**Verdict:** **CLEAN**

## Adversarial result

No CRITICAL finding.

- R2 is test-only: the commit changes only `src/services/session-registry-service.test.ts`; the B15 product schema and migration are untouched.
- `liveDbMtimes()` snapshots `data/helm.db`, `data/helm.db-wal`, and `data/helm.db-shm`. Missing sidecars are represented as `null`, so creation or deletion is detectable as well as mtime movement.
- All three affected suites (S04, S07, and B15) compare the complete `{ main, wal, shm }` snapshot in `afterEach`.
- The guard reads filesystem metadata only. It never opens the live database through SQLite or `DatabaseService`.

## WAL discrimination proof

An independent disposable-DB probe held one WAL connection open, then committed 500 inserts through a second connection:

```text
main before = 1785268891900.6643
main after  = 1785268891900.6643
wal before  = 1785268891902.6643
wal after   = 1785268891907.6643
mainMoved: false
changed: ["wal"]
helperWouldDetect: true
```

This reproduces §7.2's exact blind spot: the old main-only guard remains green, while the R2 triplet comparison goes red.

## Verification

- `HELM_SESSION_JANITOR=0 HELM_DB_PATH=/tmp/helm-b15-r2-sol.pdpox6/helm.db npx vitest run src/services/session-registry-service.test.ts --poolOptions.forks.maxForks=1`
  - PASS: 1 file, 68/68 tests.
- `HELM_SESSION_JANITOR=0 HELM_DB_PATH=/tmp/helm-b15-r2-sol.pdpox6/typecheck.db npx tsc -p tsconfig.json --noEmit`
  - PASS.
- `git diff --check 9b038e0^ 9b038e0`
  - PASS.
- Before/after the focused suite, live `data/helm.db`, `-wal`, and `-shm` had identical nanosecond mtimes, sizes, and inodes.

This CLEAN verdict is limited to R2's §7.2 test guard; it does not disposition the separate §7.1 operational incident.

redteam-sol B15 R2 STATUS: DONE — CLEAN
