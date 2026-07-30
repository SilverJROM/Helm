# Batch B3 — review.md

## Acceptance criteria checklist (from the dispatch brief)

- [x] **Update only `src/services/planning-phase-service.ts` plus one new B3 test/artifacts.** —
      confirmed: the only source edit is `parseAgreementCallbackLine`; `git status` shows exactly
      that file modified plus the new dedicated test file and these three artifacts.
- [x] **Widen `parseAgreementCallbackLine` separator support to accept em dash, en dash, hyphen,
      and colon forms.** — separator class changed from `[—-]` to `[\-—–:]` inside the same
      pre-existing optional trailing group; all four forms proven in the B3 test file.
- [x] **Add a `plan=<sha12>` field to the verdict grammar and parsed return shape as
      optional/additive data. Do not require it for all verdicts in B3.** — `planSha: string |
      null` added to the return type, populated via `/\bplan=([0-9a-f]{12})\b/` against the
      already-captured note; `null` (never throws/required) when absent. Format matches
      `plan-revision.ts`'s `short12` (first-12-lowercase-hex).
- [x] **Preserve existing accepted callback forms and role/batch/state parsing.** — the prefix
      alternation, role/batchId `(\S+)(\S+)` captures, and `STATUS:\s+([A-Z-]+)` enum capture are
      byte-unchanged; full `planning-phase-service.test.ts` (31 tests, including A9's dual-prefix
      / em-dash `waitForAgreement` coverage) reruns green.
- [x] **Do not change gate acceptance semantics beyond parser output.** — no edit outside
      `parseAgreementCallbackLine`; `waitForAgreement`'s PLAN-READY/VERDICT-READY scan and
      `parseTaskVerdictLine`'s TASK-VERDICT reuse are untouched call sites that only read
      pre-existing named fields off the parsed object.
- [x] **New dedicated B3 unit-test file** proving em/en dash, hyphen, colon separators parse;
      `plan=<12 lowercase hex>` extraction; no-note `PLAN-READY` still parses; malformed lines
      return `null`. — `src/services/planning-phase-verdict-parser-b3.test.ts`, 12/12 green.
- [x] **`HELM_DB_PATH=/tmp/helm-b3-$$.db npx vitest run <new-test-file>`** — passes (test-report.md).
- [x] **`grep -c planMdPathForRaceGuard` stays `3`.** — confirmed unchanged before and after.

## Design notes / self-review

- Escaped/led the hyphen in the character class (`[\-—–:]`) rather than trailing it, to avoid any
  risk of it being read as a range operator between the em dash and en dash code points — both are
  outside any sane ASCII range so an accidental range would likely just error or behave oddly at
  parse time; escaping removes the ambiguity outright rather than relying on engine-specific
  trailing-position leniency.
- Chose to run the `plan=` extraction as a **second** regex against the already-captured `note`
  group rather than folding it into the main line regex. The verdict grammar doesn't pin down
  where `plan=<sha12>` sits inside the note (start, middle, end, alongside free text like `CLEAN
  plan=... verified`), and B5 — which owns actually consuming `planSha` — isn't dispatched yet, so
  baking a fixed position into the top-level regex now risks having to widen it again once B5's
  real emission format is settled. A standalone `\b...\b`-bounded secondary regex finds the token
  anywhere in the note without constraining that format, and is trivial to swap out in B5 if it
  turns out to need to be stricter (e.g. requiring a fixed position or forbidding more than one
  `plan=` occurrence).
- Uppercase hex and <12-char hex intentionally do NOT match (verified explicitly in the test file)
  — `plan-revision.ts`'s `short12` is always lowercase hex sliced to exactly 12 chars, so a
  same-length uppercase or short token could only be a different producer's non-conformant note;
  failing to extract it (leaving `planSha: null`) is safer than accepting a look-alike value B5
  would otherwise treat as a genuine revision binding.
- Left the existing `A9 (R1.4/R1.5/N4)` doc comment above the method in place and added a new B3
  comment beneath it rather than rewriting the old one — it still accurately describes why this
  parser is local/dual-prefix rather than reusing the shared `parseCallbackLine`.

## Residual risk

- None identified within this batch's scope. `planSha` is unused by any caller as of this batch
  (by design — additive only); B4/B5 are the slices that will actually read and enforce it, and
  per the P1 serial-chain note in the dispatch brief (B3 → B4 → B5 → B6, same file, must run in
  order) they run after B3 lands.
