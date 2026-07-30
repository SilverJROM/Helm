# Batch A5 — changes.md

**Batch:** A5 — Reap planning transports before DB finalize
**Requirements:** AC5, AC23
**Scope:** `src/services/planning-phase-service.ts` (edit) + new test/artifacts only.

## Root cause (mechanism-level)

`runPlanningPhase` spawns the plancore seat (`spawned.handle`, line ~454) and each partner seat
(`partnerSpawned.handle`, lines ~536-549) via `this.transport.spawn(...)`, and records each in
`worker_runtimes` through `registerWorkerRuntime` — but only the DB row id was ever kept
(`plancoreRuntimeId` / `partnerRuntimeIds`). The transport `handle` itself was a block-local `const`
that went out of scope once each spawn loop body finished.

At the two normal terminal exits — `agreed:false` (gate blocked/timed out) and `agreed:true`
(success) — the method called `finalizeWorkerRuntime(...)` to flip the DB row to a terminal state
(`reaped`/`done`), but never called `this.transport.reap(handle, ...)` for that seat. The only
existing `transport.reap` call site was inside the internal spawn-retry loop, and it only fires when a
respawn attempt never received a first callback — unrelated to a seat finishing its work normally.

Net effect: on every normal terminal exit, the DB row was marked terminal while the underlying
transport session was never reaped — a leaked session that can poison a retry (AC5's literal wording).

## Fix

- Retained each spawned handle in outer-scoped variables parallel to the existing runtime-id
  bookkeeping: `plancoreHandle: string | null` and `partnerHandles: string[]`.
  - `plancoreHandle` is overwritten on every spawn attempt inside the existing retry loop — an
    earlier failed attempt's own handle is already reaped in-loop before the loop moves on, so only
    the LAST surviving spawn's handle needs retaining for the final terminal exit.
  - `partnerHandles` gets one entry per spawned partner seat, parallel to `partnerRuntimeIds`.
- Added a small private helper, `reapPlanningHandle(handle, reason)`, that best-effort/never-throw
  awaits `this.transport.reap(handle, reason)` — same contract as the existing `finalizeWorkerRuntime`
  and the existing retry-loop reap call.
- At both existing terminal exits (`agreed:false` and `agreed:true`), added a reap pass over
  `plancoreHandle` + every `partnerHandles` entry immediately BEFORE the existing
  `finalizeWorkerRuntime` calls — transport cleanup now precedes DB terminalization on the code path,
  not just in a comment.
- Idempotency: `FakeTransport.reap` and `RealTransport.reap` are both already no-ops on an
  already-reaped handle (confirmed by reading, not editing, `real-transport.ts` — C1's file), and the
  new call sites wrap in try/catch, so a duplicate reap of the same handle is always safe.

## Explicitly out of scope (left for A6)

The `throw new Error(...)` path inside the spawn-retry loop (after `maxSpawnAttempts` exhausted) is
untouched. A6 ("one terminal owner") is the slice that routes success, blocked, AND thrown exits
through a single transport-first `try/finally`; A5 only fixes the two exits that already called
`finalizeWorkerRuntime` today.

## Files touched

- `src/services/planning-phase-service.ts` — retained handles + `reapPlanningHandle` helper +
  reap-before-finalize at both existing terminal exits. No changes to `waitForAgreement`, the
  race-guard lines, or any exported type signature.
- `src/services/planning-phase-reap-before-finalize-a5.test.ts` (new) — see test-report.md.

## Standing rules honored

- `real-transport.ts` untouched (C1's file) — read-only inspection to confirm reap idempotency.
- `src/index.ts` untouched.
- `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` still returns `3`.
- No schema changes.
