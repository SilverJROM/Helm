# changes.md — Batch C7

**Batch:** C7 — Reviewer first-callback and submit watchdog
**AC:** AC15, AC23
**Branch:** `fix/planning-agreement-restructure`
**Date:** 2026-07-30

## Summary

`planning-phase-service.ts` already rescues an empty/dead plancore spawn via its private
`waitForFirstCallback` (POCFIX20): after `transport.spawn`, it waits for the plancore seat's FIRST
callback (any STATUS) before committing to the much longer agreement wait, retrying the spawn (up to
3x) on `no-first-callback`/`session-gone`. Today only the plancore (`brainRole`) seat is rescued —
reviewer seats spawned by `runReviewRound` have no equivalent, so a reviewer that never lands (empty
pane, dead session, or a brief stuck un-submitted in the composer) silently burns the entire
agreement-wait budget before the round times out with a generic `ROUND-CAP-EXHAUSTED` reason that
never actually says a reviewer was the problem.

C7 generalizes that mechanism to reviewer seats, entirely inside `planning-review-round.ts`: after
each round's `spawnRoundSeats` call and before that round's `waitForAgreement` call, every freshly
spawned reviewer seat must show a first callback line in `callbacks.md`. A stuck seat produces a typed
blocked result naming the exact seat and reason — `waitForAgreement` is never called for that round.

## Mechanism

**New local helper `waitForReviewerFirstCallback` in `planning-review-round.ts`** — a narrower,
reviewer-scoped analog of `waitForFirstCallback`. It cannot import or move that method (private to
`PlanningPhaseService`, locked scope), so it duplicates only the identity-match shape this module
already has (`RAW_CALLBACK_IDENTITY_RE` + `roleMatches`, the same pair `collectSameShaBrokenEvidence`
(C6) already uses) — no pane/idle-prompt classification, which would expand scope beyond this row:

```ts
async function waitForReviewerFirstCallback(
  cbPath, partnerRole, batchId, timeoutMs, sinceOffset,
  watchdog: { handle: string; brief: string; transport: ReviewerWatchdogTransport }
): Promise<{ ok: true } | { ok: false; reason: 'no-first-callback' | 'session-gone' }>
```

- Polls `cbPath` every 200ms for a line matching `RAW_CALLBACK_IDENTITY_RE` whose batch id equals the
  seat's and whose role satisfies `roleMatches(partnerRole, ...)` — ANY status counts as "first
  callback" (proof the seat is alive), mirroring `waitForFirstCallback`'s own "any STATUS" semantics.
- If the transport exposes `inspectSeat` (optional, typed through a narrow local
  `ReviewerWatchdogTransport` interface) and it reports `!sessionAlive` → returns `{ok:false,
  reason:'session-gone'}` immediately.
- If the transport exposes `resubmitIfComposerHeld` (same narrow interface — `ITransport` does not
  declare it; accessed the same way `waitForFirstCallback` already accesses it via
  `(this.transport as any).resubmitIfComposerHeld?.(...)`), it is invoked every poll tick, bounded to
  `REVIEWER_FIRST_CALLBACK_MAX_PRESSES` (5) successful presses — "keep the retry bounded" per the
  brief. A transport without either optional method degrades to a plain bounded poll-then-timeout —
  never a thrown error, never an expanded surface.
- Bounded by `timeoutMs`; on expiry with no match → `{ok:false, reason:'no-first-callback'}`.

**`spawnRoundSeats` return type widened** from `string[]` to
`Array<{ batchId: string; brief: string; handle: string }>` so the watchdog has each seat's brief text
(for the optional resubmit nudge) and handle (for the optional session-alive probe) without any new
file I/O or transport call. `partnerBatchIds` (consumed by `waitForAgreement`, the blocked-reason
messages, and `ReviewRoundResult`) is still derived as a plain `string[]` immediately after —
`roundSeats.map(s => s.batchId)` — so every existing consumer of that field is unchanged.

**Round-loop wiring**, right after `partnerBatchIds` is computed and before the round's
`waitForAgreement` call:

```ts
const reviewerFirstCallbackActive =
  !isFake && (process.env.USE_FAKE_TMUX !== '1' || reviewerFirstCallbackTimeoutMs != null);
if (reviewerFirstCallbackActive) {
  const boundedFirstCallbackTimeoutMs = Math.min(
    reviewerFirstCallbackTimeoutMs ?? resolvedPerRoundTimeoutMs,
    resolvedPerRoundTimeoutMs
  );
  const firstCallbackOutcomes = await Promise.all(roundSeats.map(seat => ({
    seat, result: await waitForReviewerFirstCallback(cbPath, partner, seat.batchId,
      boundedFirstCallbackTimeoutMs, agreementFenceOffset,
      { handle: seat.handle, brief: seat.brief, transport })
  })));
  const stuck = firstCallbackOutcomes.filter(o => !o.result.ok);
  if (stuck.length > 0) {
    return { agreed: false, partnerBatchIds, roundsAttempted,
      blockedReason: `REVIEWER-NO-FIRST-CALLBACK (C7/AC15/AC23): stuck reviewer seat(s) [...] ...` };
  }
}
```

- All of a round's seats are waited on **concurrently** (`Promise.all`), each independently bounded —
  wall time is `~boundedFirstCallbackTimeoutMs`, not `partnerCount × timeout`.
- On any stuck seat, the function returns immediately with `agreed: false`, this round's
  `partnerBatchIds`, `roundsAttempted` reflecting the round being attempted, and a `blockedReason`
  naming every stuck seat's batch id and its specific reason (`no-first-callback` or `session-gone`).
  `waitForAgreement` is never called for that round, and this module never does any canonical
  plan.md/og-requirements.md polling of its own, so nothing downstream is reached either.

## Default-on design (the live fix-cycle correction)

The brief's own guidance said to keep any new option/type fields additive and optional, and my first
cut made the watchdog **opt-in only** via a new `reviewerFirstCallbackTimeoutMs` field, defaulting to
fully OFF. The coordinator correctly pushed back mid-implementation: `AC15` describes the watchdog as
something that must actually run in real planning, not remain permanently unwired (since
`planning-phase-service.ts` — the only place that could opt a real run in — is out of scope for C7;
"C8 owns replacing that fail-fast after C7 is green" implies C7's mechanism is meant to already be
live). A pure opt-in flag would have shipped a mechanism no real caller could ever reach.

The resolution mirrors a pattern already established in this exact file's own sibling,
`planning-phase-service.ts`'s POCFIX20 watchdog, which is skipped entirely under the fixture harness
via `const isFakeP = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production'`. C7's
gate is now:

```ts
!isFake && (process.env.USE_FAKE_TMUX !== '1' || reviewerFirstCallbackTimeoutMs != null)
```

- **On by default in real mode** (`!isFake && USE_FAKE_TMUX !== '1'`) — genuinely live once a real,
  non-fixture caller reaches this code (real callers never set `USE_FAKE_TMUX=1`).
- **Inactive for every existing C2-C6 fixture** without editing a single one of them: every spec file
  in this suite sets `process.env.USE_FAKE_TMUX = '1'` at module load (including
  `planning-review-round-c3.test.ts`'s real-mode/`isFake:false` direct-success test, which asserts
  agreement with zero reviewer callbacks ever seeded in `cbPath` and cannot be edited), so
  `USE_FAKE_TMUX !== '1'` is false for all of them, and none of them sets
  `reviewerFirstCallbackTimeoutMs` (the only other way to activate it) — verified empirically by
  rerunning C2-C6 unmodified (30/30 green including C7, see test-report.md).
- `reviewerFirstCallbackTimeoutMs` remains additive/optional, now serving two purposes: force-enabling
  the watchdog under the fixture harness (so C7's own dedicated test file can drive `FakeTransport`,
  which itself requires `USE_FAKE_TMUX='1'` to construct, while still exercising the watchdog), and/or
  overriding the bound. When omitted on the real default-on path, the bound is
  `resolvedPerRoundTimeoutMs` directly, per the coordinator's explicit correction.

This exact conflict — and the fix — was surfaced and approved through the callback handshake before
being implemented (see `callbacks.md`: PROPOSED → REVISE-PLAN → NEEDS-INFO with reproduced evidence →
REVISE-PLAN with the corrected mechanism), not decided unilaterally.

## Files

| File | Change |
|------|--------|
| `src/services/planning-review-round.ts` | Add `ReviewerWatchdogTransport` interface, `REVIEWER_FIRST_CALLBACK_POLL_MS`/`REVIEWER_FIRST_CALLBACK_MAX_PRESSES` constants, `waitForReviewerFirstCallback` (local, unexported); widen `spawnRoundSeats`'s return type to carry `{batchId, brief, handle}`; add `reviewerFirstCallbackTimeoutMs?: number` to `RunReviewRoundOptions`; wire the default-on real-mode gate into the round loop between `spawnRoundSeats` and `waitForAgreement`. No change to `ReviewRoundResult`'s shape, `checkArtifactsPublished`, the revise actuator (C6), or any C2-C5 code path. |
| `src/services/planning-review-round-c7.test.ts` | **New.** C7-only gate (5 tests). |

## Explicit non-edits

- `planning-phase-service.ts`, `brief-writer-service.ts`, `plan-parser-service.ts`, `real-transport.ts`,
  `fake-transport.ts`, schema files, `src/index.ts` — untouched. No schema version invented.
- `planning-review-round-c2.test.ts` through `-c6.test.ts` — prior-slice files, untouched, rerun green
  with no modification (see the default-on design section above for why that stays true).
- The honest `BROKEN` fail-fast inside `waitForAgreement` (`planning-phase-service.ts`) is not touched.
  C8 remains the owner of replacing it.
- C7's watchdog is a wholly separate, earlier gate than the round's `waitForAgreement` call — it never
  reads a `VERDICT-READY`/`CLEAN`/`BROKEN` line itself and never calls `waitForAgreement` on a stuck
  seat, so it cannot be confused with or interfere with C6's revise-actuator evidence scan.
