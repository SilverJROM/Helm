# B14 R3 Redteam: codex55

Tip reviewed: `e170ec5cf96371d5ce4f44afe589e9c9f394b2d0`

Prior R2 CRITICAL: staging rollback kill was swallowed on `createSessionReplacingLive`, leaving a live tagged staging session that was never registered and therefore invisible to registry-driven janitor cleanup.

## Verdict

CLEAN

All create/replace orphan teardown paths reviewed use fail-closed rollback semantics. I found no remaining create/replace path that tears down a post-create orphan with a swallowed `killSessionRaw(...).catch(() => {})`.

## Code Review

- Fresh create path: `createSession` creates directly under the final name only after `sessionExistsTriState` proves absence, then calls `spawnTaggedSession` and `publishCreatedSession`; both post-create failure points route through `rollbackOrphanSession` (`src/tmux/tmux-service.ts:590`, `src/tmux/tmux-service.ts:604`, `src/tmux/tmux-service.ts:784`, `src/tmux/tmux-service.ts:812`).
- Replace path: `createSessionReplacingLive` stages under a unique `-stg-` name, then every failure branch after successful staging uses `rollbackOrphanSession(stagingName, ...)`: terminate throws, terminate returns false/CAS refusal, and rename fails (`src/tmux/tmux-service.ts:705`, `src/tmux/tmux-service.ts:728`, `src/tmux/tmux-service.ts:731`, `src/tmux/tmux-service.ts:743`).
- Rollback helper is fail-closed: it calls `killSessionRaw`, rethrows the original cause only if kill succeeds or a follow-up tri-state probe proves the session gone, and throws `AggregateError` when the cleanup kill fails while the session remains live or unknown (`src/tmux/tmux-service.ts:844`).
- Old/final target protection remains intact: the rollback calls in the replace path always target `stagingName`; the old final name is closed only through `terminateSession` after eligibility/CAS gates (`src/tmux/tmux-service.ts:714`).

## Regression Evidence

- Added coverage forces the R2 swallow cases to fail loudly:
  - CAS-refusal after staging + rollback kill failure returns `AggregateError` and proves the tagged staging orphan still exists (`src/tmux/create-session-safe-replace.test.ts:347`).
  - Rename failure after old close + rollback kill failure returns `AggregateError`, kills the old final name exactly once through authorized close, and proves the tagged staging orphan still exists (`src/tmux/create-session-safe-replace.test.ts:403`).

## Validation Run

- `HELM_DB_PATH=/tmp/helm-b14-redteam-codex55-r3-$$.db npx vitest run src/tmux/create-session-safe-replace.test.ts`
  - PASS: 1 file, 11 tests.
- `npm run build`
  - PASS: `node --check`, `tsc`, sandbox compile, web copy.
  - Existing tolerated warning: `tools/helm-sandbox.c:559:56: warning: "/*" within comment [-Wcomment]`.

## Callback

redteam-codex55 B14 R3 STATUS: DONE — CLEAN
