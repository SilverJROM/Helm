# test-report.md — Batch C5

**Gate file:** `src/services/planning-review-round-c5.test.ts`

## Type check

```bash
npx tsc --noEmit -p tsconfig.json
```
**Result:** PASS — no errors, whole project.

## C5 gate (own new unit-test file)

```bash
npx vitest run src/services/planning-review-round-c5.test.ts
```
**Result:** PASS — 6/6 tests, 1 file, ~8ms.

| # | Case | Result |
|---|------|--------|
| 1 | `roundCap=3` with always-false `waitForAgreement` → exactly 3 `transport.spawn` calls, batch ids `batch-C5-partner`, `batch-C5-r2-partner`, `batch-C5-r3-partner` (all distinct, `Set` size === length); round 1 keeps the legacy `planner` brief key, rounds 2/3 use `planner-r2`/`planner-r3` | PASS |
| 2 | Same 3-round run → exactly 2 `transport.reap` calls (never 3); shared call-order log proves `spawn(round1) → reap(round1) → spawn(round2) → reap(round2) → spawn(round3)`, i.e. every reap strictly precedes the NEXT round's spawn, and round 3's handle is never reaped by this function | PASS |
| 3 | No handle is ever reused across a second `transport.spawn` — 3 rounds produce 3 distinct handles (`Set` size === 3); `ITransport` has no `send` method at all (`transport.send` is `undefined`), so seat reuse/resend is structurally impossible | PASS |
| 4 | Early agreement on round 2 (`roundCap=3`) → loop stops before round 3 spawns (`spawnCalls.length === 2`); both attempted rounds' handles/runtime ids remain visible in the caller-owned `partnerHandles`/`partnerRuntimeIds` arrays (length 2 each); only round 1 (the non-agreeing round) was reaped — round 2's live, agreed-upon seat is left for the caller's normal terminal-owner reap | PASS |
| 5 | Multi-seat panel (2 `coPlannerSeats`), `roundCap=2`, non-agreement → 4 spawns total (2 seats × 2 rounds) with batch ids `batch-C5-partner`, `batch-C5-partner-2`, `batch-C5-r2-partner`, `batch-C5-r2-partner-2`; matching brief keys for both seats in both rounds; exactly 2 reaps (round 1's two seats, before round 2 spawns) | PASS |
| 6 | `roundCap` omitted (C2/C3/C4 default) with immediate agreement → exactly 1 round, 1 spawn with the legacy `batch-C5-partner` id, **zero** `transport.reap` calls (the reap-before-next-round branch is never entered when there is no next round) | PASS |

## C2/C3/C4 regate (shares the same module, files unmodified)

```bash
npx vitest run src/services/planning-review-round-c2.test.ts src/services/planning-review-round-c3.test.ts src/services/planning-review-round-c4.test.ts
```
**Result:** PASS — 14/14 tests (4 + 6 + 4), 3 files, ~446ms. No assertion in any of these three files
changed; all three still exercise `roundCap` omitted or a single explicit round, so the new
reap-before-next-round code path is never entered for any of them, and every id/brief-key they assert
(`batch-C2-partner`, `batch-C3-partner`, `batch-C4`'s cap cases, etc.) stays on the round-1 legacy shape.

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

C5's named acceptance gate — own test file (6/6), C2/C3/C4 regate (14/14 unmodified), raceguard (`3`),
whole-project `tsc` — is fully green. Each round now spawns genuinely fresh reviewer seats with
round-scoped, collision-free batch ids; the prior round's seats are reaped before the next round's spawn;
no seat is ever reused or resent to; caller-owned cleanup arrays keep accumulating every round's seats
for the existing terminal owner to reap/finalize.
