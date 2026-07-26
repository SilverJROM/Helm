# Phase C-b Validation — codex55

Date: 2026-06-19
Validator: codex55
Scope: Validate grok Phase C-b commits `e23e389` (C2 validator), `24f390e` (C3 issue defer), and `af69872` (C4 reviewer) using runtime probes plus build/full-suite evidence.

## Verdict

STATUS: FAIL

Phase C-b does not pass runtime validation. `npm run build` is clean, and the full suite has only the allowed emit-status failure, but the real-path callback fencing breaks multi-phase C2/C3 execution. The requirements-aware validator can be spawned with the right contract, but its callback is not consumed after prior ACK content, so the reviewer is never reached. The issue repro retry path similarly reaches retry 2, receives `REPRO-FAILED`, then hangs instead of returning `DEFERRED`.

## Live DB Guard

- Baseline `data/helm.db` mtime: `1781838325`
- After runtime probes/build/full suite: `1781838325`
- Result: unchanged
- All DB-backed commands used temp `HELM_DB_PATH` files under `/tmp`.

## Mechanism Findings

### C2 Requirements Validator

Partial PASS: the real feature path does spawn the requirements-aware validator after the deterministic test gate.

Runtime probe used a custom in-process transport with no `USE_FAKE_TMUX`, `HELM_PROJECT_TEST_CMD=sh`, and `HELM_PROJECT_TEST_ARGS='-c true'`, so `src/services/orchestrator-loop.ts:596-615` took the deterministic real-path branch. Observed dispatch:

```text
SPAWN implementer ...
APPEND implementer DONE
SPAWN validator As requirements-aware validator ...
```

The validator brief included the required contract:

```text
## CONTRACT
North-star / run prompt:
NORTH STAR: deliver observable checkout total

Task:
task_key: T1
atomic_work: Add checkout total display
validation_criteria: total is visible and equals sum of line items

Diff/behavior: inspect actual changes ...
```

FAIL: after appending a valid `validator PASS` callback, the loop did not consume it and no reviewer spawned. Transitions stopped at:

```text
dispatched, working, done, ack-written, acked, reap-called, reaped,
validating, deterministic-validating, test-gate:PASS, requirements-validating
```

Mechanism: `src/services/orchestrator-loop.ts:258-262` records `fs.stat().size` byte offsets, but `findLatestCallback` slices a JavaScript string with that offset at `src/services/orchestrator-loop.ts:135-137`. After ACK text containing an em dash is written, byte offsets and UTF-16 code-unit offsets diverge, so later callbacks can be sliced past their start and never parsed.

### C3 Issue Repro Retry / Defer

FAIL. Runtime probe with `HELM_REPRO_RETRY=2` reached retry 2 and appended the second `REPRO-FAILED`, but the run timed out before `DEFERRED`.

Observed:

```text
SPAWN validator ... Reproduce the issue ...
APPEND validator REPRO-FAILED no repro attempt 1
REAP h1 val-complete
SPAWN validator REPRO RETRY 2/2 ...
APPEND validator REPRO-FAILED no repro attempt 2
C3_RC=124
```

Expected: `finalStatus: DEFERRED`, `run_tasks.status='deferred'`, queue continues, and `deferred-issues.md` is written at run completion.

Actual: retry callback was not consumed before the 25s timeout, so the defer path and run-end summary were not reached. This is the same byte-offset/string-slice mechanism above. The intended queue/status wiring exists at `src/services/task-queue-service.ts:90-103` and `src/services/run-orchestrator-service.ts:257-319`, but runtime did not reach it on the real path.

### C4 Reviewer

FAIL. Reviewer APPROVE/REVISE behavior could not be accepted because the C2 requirements-validator phase does not complete on the real path. The reviewer dispatch is nested after a consumed requirements-validator PASS at `src/services/orchestrator-loop.ts:627-643`; the probe never reached that point after a valid validator PASS callback.

Additional risk: the C4 happy-path evidence in the committed test file is skipped (`src/services/orchestrator-loop.test.ts:846` and `src/services/orchestrator-loop.test.ts:913`), so the full suite does not exercise reviewer evidence persistence or reviewer rejection routing.

## Build and Suite

- `HELM_DB_PATH=/tmp/helm-phaseC-b-build-*.db npm run build`: PASS.
  Only the existing `tools/helm-sandbox.c` comment warning was emitted.

- `HELM_DB_PATH=/tmp/helm-phaseC-b-full-*.db npx vitest run`: expected FAIL only for the allowed emit-status test.

```text
Test Files  1 failed | 20 passed (21)
Tests       1 failed | 243 passed | 3 skipped (247)
```

Sole failure:

- `src/services/orchestrator-loop.test.ts`: known `projcore-emit-status.sh` failure.

`src/p1-6b.test.ts` passed in this full run. The suite result does not rescue Phase C-b because the critical C2/C4 tests are skipped and the independent real-path probes fail.

## Required Gaps

1. Fix real-path callback offset fencing: do not use byte offsets from `fs.stat().size` as JavaScript string slice indexes, or read/slice as bytes consistently.
2. Re-prove C2 validator PASS and FAIL routing on the real deterministic path after prior ACK content exists.
3. Re-prove C3 default retry `REPRO-FAILED` x2 reaches `DEFERRED`, marks `run_tasks.status='deferred'`, continues independent queue work, and writes `deferred-issues.md`.
4. Re-prove C4 reviewer APPROVE persists separately and reviewer REVISE/REJECT routes back.

STATUS: FAIL — C2/C3 real-path callbacks after prior ACK content are not consumed due byte-offset/string-slice fencing; reviewer and deferred-summary paths are therefore not proven at runtime.

## Re-validation After Byte-Accurate Callback Fix

Date: 2026-06-19
Validator: codex55
Scope: Re-validate Phase C-b after commit `966dd05` and regression commit `69b8aea`.

### Verdict

STATUS: PASS

The prior failure is closed. `src/services/orchestrator-loop.ts` now reads callback windows as bytes with `Buffer.subarray(sinceOffset)` before decoding to UTF-8, matching the byte offset from `fs.stat().size`. Runtime probes confirmed post-ACK callbacks are no longer dropped.

### Runtime Probe Evidence

1. **Feature gate -> requirements validator PASS -> reviewer spawn: PASS.**

   On the real deterministic path (`HELM_PROJECT_TEST_CMD=sh`, `HELM_PROJECT_TEST_ARGS='-c true'`, no `USE_FAKE_TMUX`), the feature task completed:

   ```text
   test-gate:PASS
   requirements-validating
   pass
   reviewer
   complete
   ```

   The requirements-aware validator brief included `## CONTRACT`, the north star, `atomic_work`, `validation_criteria`, and `Diff/behavior`. After appending validator `PASS`, the reviewer actually spawned and `APPROVE` was consumed.

2. **Requirement-bearing filter: PASS.**

   A docs-only/no-criteria task completed `PASS` with no post-gate validator or reviewer spawns.

3. **Validator FAIL routes back: PASS.**

   A requirements-aware validator `FAIL` produced a second implementer dispatch. The retry then passed validator and reviewer gates. Probe evidence:

   ```text
   implementerSpawns: 2
   transitions include: requirements-validating, fail, working, ... requirements-validating, pass, reviewer, complete
   ```

4. **Reviewer REVISE routes back: PASS.**

   Reviewer `REVISE` produced a second implementer dispatch and a second reviewer pass. Probe evidence:

   ```text
   reviewerSpawns: 2
   implementerSpawns: 2
   validations include: reviewer:REVISE ... then reviewer:APPROVE ...
   ```

5. **Issue repro retry -> DEFERRED + queue continues: PASS.**

   Full `RunOrchestratorService` probe with `HELM_REPRO_RETRY=2` produced:

   ```text
   reproSeen: 2
   I1 status: deferred
   F1 status: complete
   footerDone: true
   footerValDone: true
   footerRevDone: true
   ```

   Run completion printed and wrote:

   ```text
   # Deferred Issues (raised at run completion)
   - I1: Intermittent crash issue (status=deferred, NOT-REPRODUCIBLE)
   These issues did not reproduce after retry; they were not blocking to independent tasks.
   ```

   An artifacts row was recorded with `type='deferred-issues'` and `path='deferred-issues.md'`.

### Regression Test

- `HELM_DB_PATH=/tmp/helm-phaseC-b-reval-byte-test-*.db npx vitest run src/services/orchestrator-loop.test.ts -t 'POCFIX22 regression'`: PASS.

```text
Test Files  1 passed (1)
Tests       1 passed | 27 skipped (28)
```

### Build and Suite

- `HELM_DB_PATH=/tmp/helm-phaseC-b-reval-build-*.db npm run build`: PASS.
  Only the existing `tools/helm-sandbox.c` comment warning was emitted.

- `HELM_DB_PATH=/tmp/helm-phaseC-b-reval-full-*.db npx vitest run`: expected FAIL only for the allowed emit-status test.

```text
Test Files  1 failed | 20 passed (21)
Tests       1 failed | 244 passed | 3 skipped (248)
```

Sole failure:

- `src/services/orchestrator-loop.test.ts`: known `projcore-emit-status.sh` failure.

`src/p1-6b.test.ts` passed in the full run.

### Live DB Guard

- `data/helm.db` mtime before validation: `1781838325`
- `data/helm.db` mtime after runtime probes/build/full suite: `1781838325`
- Result: unchanged
- All DB-backed commands used temp `HELM_DB_PATH` files under `/tmp`.

STATUS: PASS
