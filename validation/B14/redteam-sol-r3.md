# B14 R3 red-team (sol) — CLEAN

**Tip reviewed:** `e170ec5cf96371d5ce4f44afe589e9c9f394b2d0`  
**Prior CRITICAL:** live-replacement staging cleanup swallowed a failed rollback kill, hiding a
live, tagged, unregistered `-stg-` orphan.  
**Constraint:** static adversarial review only; no live tmux/reap and no product edits.

## Verdict

**CLEAN — the R2 staging rollback-kill swallow is closed.**

Every failure branch after a staging session has been successfully created and tagged now routes
through the shared fail-closed `rollbackOrphanSession(stagingName, cause)` helper:

| Replace failure branch | Fail-closed path |
|---|---|
| old-lifecycle `terminateSession` throws | `src/tmux/tmux-service.ts:721-730` |
| old-lifecycle CAS refuses (`closed === false`) | `src/tmux/tmux-service.ts:731-739` |
| staging-to-final rename fails | `src/tmux/tmux-service.ts:743-747` |

All three calls target `stagingName`. None retargets the old/final name; that lifecycle remains
behind the existing eligibility and `terminateSession` CAS boundary.

## Adversarial checks

### Failed cleanup is visible

`rollbackOrphanSession` attempts `killSessionRaw(sessionName)` and preserves the original failure
when cleanup succeeds. If the kill rejects, it probes with `sessionExistsTriState`:

- a probe that proves the session gone rethrows the exact original error;
- a live or unknown result throws an `AggregateError` containing both the original cause and the
  rollback-kill error (`src/tmux/tmux-service.ts:844-858`).

Thus a surviving staging orphan is no longer reported as an ordinary collision/rename/termination
failure. Unknown existence also fails closed rather than being treated as successful teardown.

### No alternate swallow remains

An executable-path scan found no remaining `killSessionRaw(...).catch(() => {})` in
`src/tmux/tmux-service.ts`. The fresh-create tag failure and final-name registry publication failure
also use the same helper (`src/tmux/tmux-service.ts:791-825`), so neither create branch bypasses the
fail-closed rollback behavior.

### Regression coverage matches the prior exploit

The committed focused tests exercise both required shapes:

- CAS refusal followed by staging rollback-kill failure asserts `AggregateError`, both causes, a
  still-live/tagged staging orphan, zero final-name rollback kills, and no registry publication
  (`src/tmux/create-session-safe-replace.test.ts:347-401`).
- Post-old-close rename failure followed by staging rollback-kill failure asserts the same visible
  double failure, exactly one authorized kill of the old final lifecycle, and a still-live/tagged
  staging orphan (`src/tmux/create-session-safe-replace.test.ts:403-459`).

The terminate-throws branch is not separately duplicated in the test file, but its catch invokes the
same helper with the same staging target directly; there is no branch-specific cleanup logic left to
swallow the failure.

## Conclusion

No CRITICAL remains in the R3 scope. A rollback kill can physically fail, but that state is now
explicitly surfaced with both causes and cannot be mistaken for successful orphan cleanup.

redteam-sol B14 R3 STATUS: DONE — CLEAN
