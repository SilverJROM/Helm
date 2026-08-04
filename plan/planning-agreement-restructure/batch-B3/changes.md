# changes.md — B3: verdict-parser separator widening + optional planSha

**Batch:** B3
**AC:** 6, 8, 23
**Branch:** `fix/planning-agreement-restructure`
**Tier:** L2 / medium
**Status:** DONE

## Root cause (mechanism)

`parseAgreementCallbackLine` (`src/services/planning-phase-service.ts`) parsed the trailing
note with `/^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+([A-Z-]+)(?:\s+[—-]\s+(.+))?\s*$/`.
The optional trailing-note group's separator character class `[—-]` matched only an em dash
(—) or a hyphen (`-`). A callback line written with a colon or an en dash (–) — both forms
agents actually use — failed the **whole** regex match, so `parseAgreementCallbackLine`
returned `null` and every caller (`waitForAgreement`'s PLAN-READY/VERDICT-READY scan,
`parseTaskVerdictLine`'s TASK-VERDICT reuse, `collectTaskVerdicts`) treated that seat as
**silent** instead of failing closed on a malformed/unparseable line — the AC8 gap. Separately,
there was no field carrying `plan=<sha12>` out of the note, so nothing downstream could bind a
verdict to the exact `plan.md` revision it reviewed (AC6); `plan-revision.ts`'s own doc comment
already anticipated this: "used as `plan=<short12>` in verdict lines."

## Fix

`src/services/planning-phase-service.ts`, `parseAgreementCallbackLine` only:

1. Widened the separator class inside the **same** optional trailing group from `[—-]` to
   `[\-—–:]` (hyphen escaped/first to avoid a range, adds en dash U+2013 and colon). The
   prefix, role/batchId captures, and `STATUS:\s+([A-Z-]+)` enum capture are untouched, so
   every previously-accepted em-dash/hyphen form parses byte-identically. Colon and en-dash
   forms that previously fell through to `null` now parse with the note in group 4.
2. Added an **additive, optional** `planSha: string | null` field to the parsed return shape.
   Populated by applying `/\bplan=([0-9a-f]{12})\b/` to the already-captured note; `null` when
   the note is absent or has no `plan=` token. Both call sites (`parseTaskVerdictLine` at
   line ~924, the whole-plan gate scan at line ~1066) assign the result to an inferred
   `const parsed = ...` and only read specific named fields off it, so the new field is inert
   for existing behavior.
3. No change to gate/acceptance semantics — this batch only widens parser *output*. B4 owns
   fail-closed newest-line enforcement; B5 owns binding CLEAN acceptance to the current
   `plan.md` SHA using `planSha`.

## Explicit non-changes

- No other function in `planning-phase-service.ts` touched.
- No `src/index.ts` edit.
- No schema/migration, no importer wiring beyond the parser's own return shape.
- `plan=<sha12>` is not yet required or enforced anywhere — purely additive per the brief.

## Files changed

- `src/services/planning-phase-service.ts` (edited — `parseAgreementCallbackLine` only)
- `src/services/planning-phase-verdict-parser-b3.test.ts` (new — dedicated B3 gate, 12 tests)

## Regression sweep (shared-file/semantic-boundary rerun)

Per standing rules, reran every previously-verified slice sharing this file or the callback-
parsing semantic boundary:

- `src/services/planning-phase-service.test.ts` (31 tests — includes A9's full
  `waitForAgreement` dual-prefix/em-dash coverage)
- `src/services/run-orchestrator-planning-terminal-a1.test.ts` (4 tests)
- `src/services/planning-phase-reap-before-finalize-a5.test.ts` (3 tests)
- `src/services/planning-phase-one-terminal-owner-a6.test.ts` (1 test)
- `src/services/plan-revision-b1.test.ts` (10 tests)
- `src/services/brief-writer-panel-plan-contract-b2.test.ts` (2 tests)

All green, 51/51.

`tsc --noEmit` clean project-wide — the new `planSha` field does not break either call site's
inferred typing.

PLAN-CONTRADICTION: none.
