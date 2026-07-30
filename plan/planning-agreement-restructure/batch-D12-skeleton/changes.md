# D12-skeleton changes

## Scope

- Added a dedicated regression index test: `src/planning-regression-index.test.ts`.

## What changed

- Added an AC23 mode registry containing all seven historical failure modes:
  - `convene-before-artifacts`
  - `BROKEN->revise->CLEAN`
  - `partner1 CLEAN + partner2 BROKEN`
  - `partner-2 silent until timeout`
  - `legacy path refuses when north-star exists`
  - `ibrain row count unchanged on planning block`
  - `stale-CLEAN rejected across revisions`
- Added two tests:
  - A completeness assertion that the index matches the brief’s AC23 mode list and fails when a listed mode is missing.
  - A skeleton assertion that every mode is represented as a pending/skipped case with non-empty, TODO-free notes.
- Added explicit skeleton placeholders per mode as explicit skipped cases (no production-capable assertions yet).

## Constraints respected

- No production files changed.
- No integration-owned capstone tests imported.
- Added exactly one new unit-test file for AC23 sweep.
