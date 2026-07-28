# Changes - E6 Composer Echo Anchor

## User Report

> Read /tmp/e6-fix-brief.md in full and execute it exactly. The bug is already diagnosed AND reproduced with a real captured pane fixture — verify the reproduction first, then fix, then prove it with the tests listed. The critical point: every test must pass the 'pending' argument the way app.js does. A test that calls the extractor with '' is exactly the mistake that let this ship. Do not refactor, do not touch the janitor, do not restart pm2.

## Root Cause / Mechanism

- `findAfterLastUserPromptRobust` anchored on the last exact `pending` text occurrence, which can be the live composer echo at the bottom of a completed pane.
- That scoped extraction to footer chrome instead of the completed agent reply above it, causing `extractHelmReply` to return `thinking` and leaving `app.js` to fall back to chrome-like segment extraction.
- Exact and whitespace-flexible prompt matching had the same last-match bias.

## Files Changed

- `src/web/public/reply-extractor.js` - changed prompt-anchor selection to inspect all exact and flexible matches and prefer the last match with non-chrome content after it; allowed idle marker recovery before returning on an empty footer scope.
- `src/reply-extractor.test.ts` - added E6 regression tests using the real captured pane and `pending` values matching the `app.js` call path.
- `src/test-fixtures/panes/discovery-sent-echoed-in-composer-20260728.txt` - added the captured pane fixture used by the regression.

## What Changed

- Replaced direct `lastIndexOf` anchoring with all-match collection for literal and whitespace-flexible prompt matches.
- Reused `stripChrome` and `looksLikeChrome` to choose an occurrence that has real following content.
- Preserved current fallback to the last occurrence when no occurrence has real following content.
- Let idle panes with completed reply markers recover from an empty footer scope before returning `thinking`.

## Verification

- command or method: `node --input-type=module` reproduction against `src/test-fixtures/panes/discovery-sent-echoed-in-composer-20260728.txt`
- result: PASS
- evidence: before fix `extractHelmReply(pane, sent)` returned `thinking`; after fix it returns `reply`, contains `Status: INTERVIEWING`, and excludes `bypass permissions` and box separators.

- command or method: `node --check src/web/public/reply-extractor.js`
- result: PASS
- evidence: exited 0.

- command or method: `HELM_DB_PATH=/tmp/helm-test-$$.db npx vitest run src/reply-extractor.test.ts --poolOptions.forks.maxForks=2`
- result: PASS
- evidence: 19 tests passed.

- command or method: `npm run build`
- result: PASS
- evidence: build exited 0; `tools/helm-sandbox.c` emitted the known `/*` inside comment warning; `dist/web/public/reply-extractor.js` contains the updated extractor copy.

## Standing Rules

- Regression tests for pending-user extraction must pass a non-empty `pending` value the way `app.js` does, except where the specific case is cleared-pending compatibility.

## Caveats

- `dist/` is ignored by git, but `npm run build` refreshed the local runtime copy.
- pm2 was not restarted.
