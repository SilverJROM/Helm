# B15 R2 — Validator L3 (opus)

**Tip validated:** `9b038e0c0412eaa394164f00723b079dc8fd881a` (`fix(B15-fix1): WAL-aware live-DB isolation guard (test-only)`)
**Base:** `ede9faf` (B15 product commit, validated at R1)
**Branch:** `fix/janitor-audit-B15-owner-not-null`
**Scope:** closure of val §7.2 only. AC20 was adjudicated at R1 and is re-confirmed here by identity, not re-litigated.

## Verdict

**PASS.**

§7.2 is **closed**, and closed at the mechanism level rather than by inspection. The pre-fix guard was
proven blind and the shipped guard proven red **under the same injected write, in the same
configuration, running the actual committed code**. The fix is test-only: the B15 product blobs are
byte-identical to the R1-validated commit.

§7.1 remains **open** and untouched — operational, JROM's call. It is not a gate on this verdict.

---

## 1. What §7.2 required

R1 rejected the shipped isolation guard as *"structurally incapable of going red"*:
`session-registry-service.test.ts` asserted only `data/helm.db`'s **main-file** mtime. Under WAL with a
long-lived open connection — the live server's actual configuration — committed writes land in
`-wal`/`-shm` and the main file's mtime never moves. The guard looked green only because an isolated
test's `close()` checkpoints, which is not what production looks like.

Closure therefore could not be established by reading the diff. It required demonstrating that the new
guard **fails** where the old one **passed**, on the same stimulus.

## 2. Diff scope — test-only confirmed

`ede9faf..9b038e0` touches exactly one file: `src/services/session-registry-service.test.ts`
(+29 / −18).

Product blobs are identical across the fix, by git object hash:

| File | `ede9faf` | `9b038e0` |
|---|---|---|
| `src/db/schema.ts` | `620ab31b…` | `620ab31b…` |
| `src/db/database.ts` | `86b46358…` | `86b46358…` |
| `src/services/session-registry-service.ts` | `f2fa85e2…` | `f2fa85e2…` |

`git diff --stat ede9faf..9b038e0 -- src/db/ src/api/ src/services/session-registry-service.ts` is
empty. **R1's AC20 PASS carries forward unchanged** — the schema/migration surface it adjudicated was
not re-opened. `git diff --check` clean.

## 3. Guard-shape audit

All three `describe` blocks that carried the fragile guard now route through one helper:

| Block | Line | Guard |
|---|---|---|
| `S04 helm_sessions.owner (AC1)` | `:146` | `expect(liveDbMtimes()).toEqual(liveMtimesBefore)` |
| `S07 owner backfill v102 … (AC5)` | `:275` | same |
| `B15 owner NOT NULL (AC20)` | `:429` | same |

- `liveDbMtimes()` (`:37-45`) snapshots `main` + `-wal` + `-shm` into a `Record<…, number｜null>`.
- **Zero** single-file `mtimeMs` guards remain in the file (grep of every `mtimeMs`/`helm.db` site).
- The helper is **pure `fs`** — `existsSync`/`statSync` only. It never opens a SQLite connection to
  `LIVE_DB_PATH`. Every `new DatabaseService(…)` / `new Database(…)` in the file targets `dbPath`,
  `fixturePath`, or `t.dbPath` — all temp/synthetic.
- Null-transition coverage is sound in both directions: a `-wal` that appears after the snapshot flips
  `null → number` and a checkpointed-away `-wal` flips `number → null`; `toEqual` catches both.

## 4. Mechanism probe — the old guard's blindness reproduced (§7.2 3a)

Disposable WAL DB under `/tmp/helm-b15r2-*`; a second connection held open across the write, which is
the live-server case. 500 committed rows, then both predicates evaluated:

```
rows committed and visible: 501 (seed + 500)

--- main-file mtime (the PRE-fix guard) ---
before = 1785269513722.4104
after  = 1785269513722.4104
OLD GUARD DETECTS THE WRITE: false   <-- FALSE NEGATIVE (val §7.2)

--- main + -wal + -shm (the SHIPPED fix1 guard) ---
before = {"main":1785269513722.4104,"wal":1785269513725.4104,"shm":1785269513725.4104}
after  = {"main":1785269513722.4104,"wal":1785269513729.4104,"shm":1785269513729.4104}
NEW GUARD DETECTS THE WRITE: true

RESULT: PASS — old guard blind, new guard red
```

R1's finding is reproduced exactly, and the shipped predicate inverts it.

## 5. Fault injection on the committed code — the decisive A/B (§7.2 3b)

Throwaway worktree at `9b038e0`, `node_modules` symlinked, and a **fake** `data/helm.db{,-wal,-shm}`
triplet created inside the worktree so `LIVE_DB_PATH = process.cwd()/data/helm.db` resolves to the
stand-in. The real `data/` was never in scope of any run. Injection is one line inside a **test body** —
an append to the fake `-wal` only, leaving the main file untouched: precisely the write §7.2 named.

| Run | Code | Injection | Result | Meaning |
|---|---|---|---|---|
| **A** | `9b038e0` | none | **2 passed** | no false positive; guard armed (`main != null`) |
| **B** | `9b038e0` | `-wal` append | **1 failed** | **guard goes red** |
| **C** | `ede9faf` | identical append | **2 passed** | **old guard blind** |

Run B's failure names the mechanism directly — `main` identical, only `wal` moved:

```
AssertionError: expected { main: 1785269563933.3342, …(2) } to deeply equal { … }
  Object {
    "main": 1785269563933.3342,
    "shm": 1785269563936.3342,
-   "wal": 1785269563936.3342,
+   "wal": 1785269582180.299,
  }
 ❯ src/services/session-registry-service.test.ts:437:30
```

Run C is the counterfactual that makes B meaningful: the **same** injected line against the **pre-fix**
file left the suite green. The `-wal` stand-in measured 2 bytes afterwards, proving both injections
actually fired. Old code silent, new code loud, same stimulus.

**All three blocks are armed, not just B15's** — injecting the same append into the first test of each:

- `S04 … > fresh DB: owner column present, SCHEMA_VERSION ≥ 102` → **failed**, `wal` delta reported.
- `S07 … > deriveSessionOwner fail-safe table …` → **failed**, `wal` delta reported.

The commit's claim that it fixed all three duplicated guards holds under test, not just under reading.

## 6. Focused regression run

`HELM_SESSION_JANITOR=0`, the B15-touched test surface only — no full-suite thrash:

```
✓ src/services/session-registry-service.test.ts  (68 tests)
✓ src/s18a-housekeeper-dispatch.test.ts          (25 tests)
✓ src/services/session-close-service.test.ts     (15 tests)
✓ src/api/routes/session-close-routes.test.ts     (9 tests)
✓ src/services/ovm-tracking-read-service.test.ts  (3 tests)

Test Files  5 passed (5)
     Tests  120 passed (120)
```

`npx tsc -p tsconfig.json --noEmit` → **exit 0**. The test file is inside `include: src/**/*.ts`, so
`Record<'main'|'wal'|'shm', number｜null>` and `ReturnType<typeof liveDbMtimes>` are genuinely checked.

Live triplet across that run, measured by the new three-file standard:

```
before / after — data/helm.db      1785248382.143138252  size=2224128
before / after — data/helm.db-wal  1785267361.301933281  size=123632
before / after — data/helm.db-shm  1785267361.301933281  size=32768
```

Unchanged. Baseline-to-final `diff` over mtime+size+inode for all six files (`helm.db` and
`cards2-ibrain.db` triplets) is **identical**: the validation itself wrote nothing.

## 7. §7.2 completeness — nothing B15 introduced was left fragile

The commit scopes itself to the guards B15 touched. Verified:

- Only two test files repo-wide carry an `mtimeMs` live-DB guard: the fixed one, and
  `src/s16-studio-house-tiered.test.ts`.
- s16's guard is **pre-existing** — introduced by `8a032b9 [batch-S16]`, and **not touched by B15**
  (`git diff --name-only e170ec5..9b038e0` does not list it).
- `p2-1.test.ts` / `plumbing-watcher.test.ts` are a different pattern: read-only *copies* of the live
  DB, no mtime guard. Untouched by B15.

No B15-introduced fragile guard survives. The scoping claim in the commit message is accurate.

## 8. Follow-ups — non-blocking, not conditions on B15

**8.1 `s16-studio-house-tiered.test.ts` carries the same blind spot.** Its guard checks main-file
`mtimeMs` **and** `size` — under WAL with a holder open, neither moves, so it is blind to exactly the
class §7.2 identified. Pre-existing and outside the B15 diff, so correctly out of scope here, but it is
the last instance of the pattern and should be folded into the shared helper when that file is next
opened.

**8.2 The guard is now coupled to live-server activity.** The Helm server (pid `2409790`, started
14:25:38) is running and holds `data/helm.db` open. Any write it makes during a test run moves `-wal`
and will now trip the guard — a red build caused by the server, not by the test. It stayed idle across
my 6s run, so no flake was observed. This is the **correct trade**: the failure direction is fail-safe
(loud and wrong) rather than fail-open (silent and wrong), which is what §7.2 demanded. If the flake
materialises, R1's alternative — snapshot `schema_version` + a `sqlite_master`/row-count hash — is
immune to benign server writes while still catching test-caused damage. Worth logging, not worth
blocking on.

**8.3 A read-open of the live DB now trips the guard too.** Opening a WAL database even read-only
touches `-shm`. That is a strengthening, not a defect — worth knowing before someone adds a
deliberately read-only live-DB assertion to this file.

## 9. §7.1 status — unchanged, still open

Not in fix1's scope and not actioned. The live DB was **never opened** by this validation; status is
inferred from `stat` alone. The triplet's mtimes are **bit-identical to the values R1 recorded**:

```
data/helm.db      2026-07-28 14:19:42.143138252   (R1: 14:19:42.143138252)
data/helm.db-wal  2026-07-28 19:36:01.301933281   (R1: 19:36:01.301933281)
```

Nothing has written to it since R1 observed it. The out-of-band v108 divergence — live schema ahead of
the running pre-B15 build — **persists and still awaits JROM's operational call** (checkpoint + verify
372 rows / owner distribution, then decide run-forward vs restore; note there is still no fresh
pre-v108 backup). It should not be closed silently on the back of this PASS.

---

### Constraints held

`HELM_SESSION_JANITOR=0` throughout. Disposable DBs only — every probe under `/tmp/helm-b15r2-*`, every
injection run inside a throwaway worktree against a fake `data/` triplet. No writes under the repo's
`data/`; baseline and final mtime+size+inode identical across all six live files. No product edits —
working tree carries only the untracked `validation/` artifacts. Worktree removed
(`git worktree list` shows only the primary). Tip unchanged at `9b038e0`. No merge to main.

**Verdict: PASS — §7.2 closed (test-only), AC20 unchanged from R1, §7.1 remains open for JROM.**
