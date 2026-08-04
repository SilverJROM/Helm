# R — Reconcile pre-AC28 test fixtures with the provenance guard

**Filed by** `[north]` `helm-97`, 2026-07-29 · **Status: OPEN** · **Not a regression — stale fixtures**

S13 (`2f0583c`) made Start Implementation require a cycle-linked Planning agreement with a byte-matching
`plan.md` and confirmed seat manifest (AC27-28). Three suites construct **pre-AC28** cycles and are
correctly refused with `PLANNING_REQUIRED`:

- `src/pause-after-planning-gate.test.ts` (3 failing)
- `src/cycle-terminal-on-run-complete.test.ts`
- `src/services/run-orchestrator-cycle-builddir.test.ts`

`src/services/cycle-service.ts` is **byte-identical to baseline** — the pause gate itself did not change.

**Fix:** update each fixture to record provenance through the real path before Start Implementation.
**Do NOT** weaken the guard or stub the check to make them green.

## Also open, unexplained

`src/b25-fix1-orphan-model.test.ts` and `src/model-service.test.ts` fail on the effort tip but pass at
the true baseline (`3481e5b`) with `.env` + live DB present. No model or config code was touched
(`src/config.ts` is not in the effort's changed-file list). **Verified the live outcome directly:**
migrating a copy of `data/helm.db` to v112 leaves `models` and `agents` rows byte-identical, so there is
no data impact — the failures are test-expectation drift of unknown origin. Diagnose before trusting
either suite as a gate.

**Note on baselines:** `main` (`680b6ca`) is ~70 commits behind the real fork point; comparing against it
over-attributes E8-era changes to this effort. Use `3481e5b`, and copy `.env` + link `data/` into any
worktree — several suites skip when the live DB is absent (54 skipped vs 11).
