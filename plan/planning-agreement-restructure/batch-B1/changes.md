# changes.md — B1: pure plan revision hashing

**Batch:** B1  
**AC:** 6  
**Branch:** `fix/planning-agreement-restructure`  
**Tier:** L2 / medium  
**Status:** DONE

## Summary

Added a pure, importer-free module that hashes exact `plan.md` bytes into
`{ sha256, short12 }` so later agreement slices can bind partner verdicts to
the revision they reviewed (AC6 foundation).

## Files

| Path | Change |
|------|--------|
| `src/services/plan-revision.ts` | **NEW** — `PlanRevision`, `planRevision(bytes)`, `readPlanRevision(path)` |
| `src/services/plan-revision-b1.test.ts` | **NEW** — dedicated B1 unit gate (10 tests) |

## Mechanism

1. **`planRevision(bytes: Buffer | string)`** — `createHash('sha256').update(bytes).digest('hex')`; `short12` is the first 12 hex chars of the full digest.
2. **`readPlanRevision(path)`** — sync read of path bytes; returns the revision or **`null`** if absent/unreadable (never throws). No I/O beyond that single read.

## Explicit non-changes

- No production importers (wiring is B2+).
- No `src/index.ts` edit.
- No schema / migration.
- No shared-host or cross-stream edits.
- Did not refactor existing `sha256Hex` in provenance — additive only.

## Gate command

```bash
HELM_DB_PATH=/tmp/helm-b1-$$.db npx vitest run src/services/plan-revision-b1.test.ts
```

**Result:** 10/10 passed.
