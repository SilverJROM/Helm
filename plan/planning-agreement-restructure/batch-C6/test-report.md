# test-report.md — Batch C6

**Gate file:** `src/services/planning-review-round-c6.test.ts`

## Type check

```bash
npx tsc --noEmit -p tsconfig.json
```
**Result:** PASS — no errors, whole project.

## C6 gate (own new unit-test file)

```bash
npx vitest run src/services/planning-review-round-c6.test.ts
```
**Result:** PASS — 4/4 tests, 1 file, ~1.2s.

| # | Case | Result |
|---|------|--------|
| 1 | `plan.md` seeded with real bytes; `callbacks.md` seeded with a `VERDICT-READY — BROKEN ... plan=<sha>` line matching round 1's reviewer batch id AND the current plan.md short12; `waitForAgreement` mocked always-false, `roundCap=2` → exactly one revise spawn, batch id `batch-C6-r1-revise`, `role='plancore'` (brainRole), distinct from every reviewer seat's batch id (`Set` size === total spawn count); the revise brief (`briefs.get('plancore-r1-revise')`) contains the aggregated defect note text | PASS |
| 2 | Same seeded-BROKEN setup, `perRoundTimeoutMs=2000`; instrumented `transport.spawn` schedules a DELAYED (250ms, never awaited inline) background rewrite of `plan.md` the moment the revise turn spawns, and asserts `planRewritten === true` synchronously at the moment round 2's reviewer spawn fires → proves the round-2 reviewer spawn is genuinely BLOCKED on `waitForPlanRevisionChange` observing a real hash change, not a fixed delay or "eventually spawns regardless"; spawn order asserted exactly `['batch-C6-partner', 'batch-C6-r1-revise', 'batch-C6-r2-partner']` | PASS |
| 3 | `plan.md` seeded with content A; `callbacks.md` seeded with a `BROKEN ... plan=0123456789ab` line — a SHA that does **not** match content A's actual short12 (stale/different-revision evidence); `roundCap=2` → zero revise spawns; spawn calls are exactly the two round-scoped reviewer seats (`batch-C6-partner`, `batch-C6-r2-partner`) — C5/C4's existing bounded non-agreement behaviour is preserved unchanged, proving B5's current-plan-SHA binding discipline carries over to the revise trigger | PASS |
| 4 | Same seeded-BROKEN setup as case 1 → after the run, `partnerHandles` has exactly 3 entries (round-1 reviewer, revise turn, round-2 reviewer) and `partnerRuntimeIds` has 3 entries — the revise handle is visible in the caller-owned accumulator (A5/A6 safety net); AND `transport.reapCalls` contains an entry for that same revise handle — proving this module also explicitly reaps it itself. Cleanup-visible by both paths, leaked by neither. | PASS |

## C2/C3/C4/C5 regate (shares the same module, files unmodified)

```bash
npx vitest run src/services/planning-review-round-c2.test.ts src/services/planning-review-round-c3.test.ts src/services/planning-review-round-c4.test.ts src/services/planning-review-round-c5.test.ts
```
**Result:** PASS — 20/20 tests (4 + 6 + 4 + 6), 4 files. No assertion in any of these four files changed;
none of them seed a `plan.md`/`callbacks.md` pair that could produce same-SHA BROKEN evidence (C2/C3/C4
never write real `plan.md` bytes into their temp `runDir`; C5's fixtures mock `waitForAgreement` but never
seed `callbacks.md` at all), so `readPlanRevision(planMdPath)` returns `null` in every one of their cases
and the C6 branch short-circuits before ever calling `collectSameShaBrokenEvidence` — byte-identical
behaviour to pre-C6 for all four files.

Full combined run (all 5 files together):

```bash
npx vitest run src/services/planning-review-round-c2.test.ts src/services/planning-review-round-c3.test.ts src/services/planning-review-round-c4.test.ts src/services/planning-review-round-c5.test.ts src/services/planning-review-round-c6.test.ts
```
**Result:** PASS — 24/24 tests, 5 files, ~1.9s.

## Raceguard + tsc (brief-named gates)

```bash
grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
```
**Result:** `3` — unchanged. This slice never touches `planning-phase-service.ts`.

```bash
npx tsc --noEmit -p tsconfig.json
```
**Result:** PASS — no errors, whole project (also listed above).

## Outcome

C6's named acceptance gate — own test file (4/4), C2-C5 regate (20/20 unmodified, 24/24 combined),
raceguard (`3`), whole-project `tsc` — is fully green. Same-plan-revision `BROKEN` evidence now
triggers a uniquely-named, cleanup-visible plancore revision turn before the next round's fresh
reviewer seats spawn; stale/different-SHA evidence and the no-`plan.md`-yet fixture convention both
preserve C5/C4's prior bounded behaviour unchanged.
