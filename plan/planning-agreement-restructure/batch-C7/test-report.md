# test-report.md — Batch C7

**Gate file:** `src/services/planning-review-round-c7.test.ts`

## Type check

```bash
npx tsc --noEmit -p tsconfig.json
```
**Result:** PASS — no errors, whole project.

## C7 gate (own new unit-test file)

```bash
npx vitest run src/services/planning-review-round-c7.test.ts
```
**Result:** PASS — 5/5 tests, 1 file, ~1.8s.

| # | Case | Result |
|---|------|--------|
| 1 | `plan.md`/`og-requirements.md` seeded valid; `isFake:false`; `reviewerFirstCallbackTimeoutMs:500` (fixture-harness force-enable, since the test runs under `USE_FAKE_TMUX=1`); no callback ever appended to `cbPath` → typed blocked result: `agreed:false`, `roundsAttempted:1`, `partnerBatchIds:['batch-C7-partner']`, `blockedReason` matches `REVIEWER-NO-FIRST-CALLBACK`, names `batch-C7-partner` and `no-first-callback`; `waitForAgreement` never called (call counter stays 0); exactly 1 `transport.spawn` call (the reviewer seat spawns before the watchdog runs) | PASS |
| 2 | Same setup as case 1, but drives the **genuine production default-on path**: `process.env.USE_FAKE_TMUX` temporarily `delete`d (restored in `finally`) around the `runReviewRound` call, `reviewerFirstCallbackTimeoutMs` explicitly `undefined` (omitted) — `FakeTransport` is already constructed under `USE_FAKE_TMUX='1'` in `beforeEach`, only the watchdog's runtime gate check observes the unset value → same typed blocked result (`no-first-callback`, names the batch id), `waitForAgreement` never called. Proves the watchdog is live without any opt-in flag, not merely fixture-harness-only machinery | PASS |
| 3 | `transport.queueSeatScript([{ sessionAlive:false, pane:'', composerHoldsBrief:false }])` before spawn (so the reviewer's `inspectSeat` reports the session is gone from its very first probe) → typed blocked result naming `batch-C7-partner` and `session-gone`; `waitForAgreement` never called; `transport.inspectCalls.length > 0` confirms the probe actually ran | PASS |
| 4 | Transport patched with a `resubmitIfComposerHeld` mock that always returns `true` (composer never clears) and `reviewerFirstCallbackTimeoutMs:700`; no callback ever lands → typed blocked result (`no-first-callback`, names the batch id), `waitForAgreement` never called; `resubmitCalls.length` is between 2 and 10 (invoked repeatedly — genuine retry, not a one-off — but the wait still resolved instead of hanging forever on a perpetually-held composer, proving both "reuse the retry path" and "keep it bounded") | PASS |
| 5 | A valid `[helm callback] planner batch-C7-partner STATUS: VERDICT-READY — CLEAN` line appended to `cbPath` before the run (default `reviewerFirstCallbackTimeoutMs:500` force-enable) → `agreed:true`, `blockedReason` undefined, `partnerBatchIds:['batch-C7-partner']`, `waitForAgreement` called exactly once, exactly 1 spawn — the existing agreement path continues completely unchanged once the seat is proven alive | PASS |

## C2-C6 regate (shares the same module, files unmodified)

```bash
npx vitest run src/services/planning-review-round-c2.test.ts src/services/planning-review-round-c3.test.ts src/services/planning-review-round-c4.test.ts src/services/planning-review-round-c5.test.ts src/services/planning-review-round-c6.test.ts
```
**Result:** PASS — 25/25 tests (4 + 6 + 4 + 6 + 5), 5 files. No assertion in any of these five files
changed. In particular, `planning-review-round-c3.test.ts`'s real-mode (`isFake:false`) direct-success
test — the one case that could have collided with a default-on real-mode gate — asserts agreement with
zero reviewer callbacks ever seeded in `cbPath`; it stays green because every spec file in this suite
sets `process.env.USE_FAKE_TMUX = '1'` at module load and none of them sets
`reviewerFirstCallbackTimeoutMs`, so C7's `!isFake && (USE_FAKE_TMUX !== '1' || override != null)` gate
evaluates `false` for every one of their cases regardless of each file's individual `isFake` value.

Full combined run (all 6 files together):

```bash
npx vitest run src/services/planning-review-round-c2.test.ts src/services/planning-review-round-c3.test.ts src/services/planning-review-round-c4.test.ts src/services/planning-review-round-c5.test.ts src/services/planning-review-round-c6.test.ts src/services/planning-review-round-c7.test.ts
```
**Result:** PASS — 30/30 tests, 6 files, ~3.8s.

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

C7's named acceptance gate — own test file (5/5, including the genuine production default-on path),
C2-C6 regate (25/25 unmodified, 30/30 combined), raceguard (`3`), whole-project `tsc` — is fully green.
Reviewer seats now get the same first-callback/submit-watchdog protection plancore already had; a
stuck reviewer seat is caught and named before the engine ever commits to the much longer agreement
wait, and `waitForAgreement`/canonical-plan polling are never reached on that path.
