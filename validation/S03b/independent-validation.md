# S03b Independent Validation

Verdict: PASS

HEAD: d1097f0
Scope: S03b validator L2 independent, ACs 32-33

## Checks

- PASS: AC32 soft transient ancestor access denial is not treated as permanent dead. `isSoftSafeWriteFailure()` classifies `<parent-unreadable>` as soft, `denyGate()` records a denial without setting `entry.dead`, and `checkOne()` retries on later polls after the path is clean.
- PASS: AC32 recovery is covered by `S03b AC32: transient grandparent chmod0 then restore -> leaf EVIL->ORIGINAL after clean poll`; the test verifies the guarded file returns to `ORIGINAL plan.md` after search permission is restored.
- PASS: AC33 hard path-shape failure remains fail-closed and permanent dead. `assertSafeWritePath()` rejects symlink ancestors with `<symlink-ancestor>`, `isHardSafeWriteFailure()` treats that as hard, and `denyGate()` routes it to `failClosed()`.
- PASS: AC33 no outside write is covered by `S03b AC33: parent-as-symlink still fail-closed no outside write + permanent dead`; the outside `plan.md` remains the attacker-written value, is not overwritten with `ORIGINAL plan.md`, and further polls do not add denial flood.
- PASS: D-02 no-follow/containment remains intact. The implementation uses no-follow `lstatSync()` ancestor checks before any mutation, rejects paths outside the fence, removes leaves only after the safe-write gate, and uses `lstatSync()` for leaf probing/removal.
- PASS: Existing S03 discovery ownership behavior remains covered by the same focused suite: forbidden bound-cycle docs are restored/denied, allowed discovery docs survive, other cycles and non-Discovery phases are not over-blocked, directory/symlink/unreadable-leaf cases are handled.

## Evidence

Command run exactly as requested:

```bash
HELM_SESSION_JANITOR=0 npx vitest run src/s03-discovery-doc-ownership.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       23 passed (23)
Duration    10.68s
```

Relevant implementation anchors:

- `src/services/doc-path-guard.ts:584` soft classifier
- `src/services/doc-path-guard.ts:589` hard classifier
- `src/services/doc-path-guard.ts:601` safe path assertion
- `src/services/doc-path-guard.ts:810` soft denial leaves entry live
- `src/services/doc-path-guard.ts:816` soft/hard gate routing
- `src/services/doc-path-guard.ts:960` path-shape gate before mutation

Relevant test anchors:

- `src/s03-discovery-doc-ownership.test.ts:690` AC32 transient grandparent chmod0 recovery
- `src/s03-discovery-doc-ownership.test.ts:737` AC33 parent symlink fail-closed/no outside write/permanent dead
- `src/s03-discovery-doc-ownership.test.ts:790` normal-path restore still works

Final: PASS
