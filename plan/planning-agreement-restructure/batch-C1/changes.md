# changes.md — Batch C1

**Batch:** C1 — Make real transport reviewer identity unique  
**AC:** AC13  
**Branch:** `fix/planning-agreement-restructure`  
**Date:** 2026-07-30

## Summary

RealTransport no longer writes every seat's brief to the shared path `prompts/${role}.brief.md`. Concurrent partner seats that share logical role `deliberation` but pass distinct `batchId`s (already true in planning) now get distinct on-disk basenames. External `role` returned from spawn and passed to dispatch is unchanged.

## Mechanism

**Before:** `real-transport.ts` always did:

```ts
path.join(runDir, 'prompts', `${role}.brief.md`)
```

Planning already wrote unique names via `artifacts.writeBrief(runDir, partner | partner-N, …)`, but spawn rewrote the shared role path and seat-2 clobbered seat-1's brief — the mechanism behind partner-2 never verdicting.

**After:** pure `resolveSpawnBriefFileName` composes the basename:

| Inputs | Basename |
|--------|----------|
| role only | `${role}.brief.md` (legacy / backward compatible) |
| role + batchId (partner seats today) | `${role}--${batchId}.brief.md` |
| + seatId / round / attemptId | additional `--` segments |
| `briefFileName` set | sanitized override basename |

Spawn uses **caller-supplied** `batchId` for the path (not the internal dispatch default `batch-A1`), so bare-role spawns without `batchId` keep the legacy path.

## Files

| File | Change |
|------|--------|
| `src/services/real-transport.ts` | Export `SpawnBriefIdentity`, `sanitizeBriefToken`, `resolveSpawnBriefFileName`; additive spawn params `seatId?`, `round?`, `briefFileName?`; brief write uses helper |
| `src/services/real-transport-unique-seat-c1.test.ts` | **New** C1-only gate (9 tests) |

## Explicit non-edits

- `planning-phase-service.ts` — later slices wire seat labels; partners already pass distinct batchIds so uniqueness works once this lands
- `src/index.ts`, schema, FakeTransport, other stream-owned files

## External role semantics

- `return { handle, role }` still returns `params.role` (e.g. `deliberation`)
- Dispatch still receives `role: params.role`
- Uniqueness is path-only (additive identity)
