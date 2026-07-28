# B09 Validation - AC12 Collision Refusal UI

Verdict: FAIL

Tip validated: `587fa8e129e52724005c57380734ff2335a29337`

## Evidence Reviewed

- `git show 587fa8e` confirms B09 changed:
  - `src/index.ts`
  - `src/web/public/app.js`
  - `src/b09-collision-refusal-api.test.ts`
  - `e2e/B09.live.spec.ts`
- `plan/janitor-audit-remediation/validation/B09/changes.md` reviewed.
- `playwright.cap.config.ts` reviewed: base URL is `http://127.0.0.1:3110`; default `playwright.config.ts` targets `3111`.
- Screenshot reviewed: `plan/janitor-audit-remediation/validation/B09/B09-human-collision-refusal.png`.

## Checks Run

```text
node --check src/web/public/app.js
PASS

HELM_SESSION_JANITOR=0 npx vitest run src/b09-collision-refusal-api.test.ts
PASS - 3/3 tests

npm run build
PASS - exited 0; existing tools/helm-sandbox.c warning only

HELM_SESSION_JANITOR=0 npx playwright test e2e/B09.live.spec.ts --config=playwright.cap.config.ts
PASS - 1/1 tests
```

Additional DOM probe with the same intercepted 409 body:

```json
{
  "text": "session name collision refused (human): will not replace live human session helm-b09-human-live",
  "box": {
    "x": 494,
    "y": 717.5,
    "width": 491,
    "height": 36
  },
  "toggle": "Session Off"
}
```

## Findings

1. API mapping passes.
   - Both chat-session create surfaces map `SessionNameCollisionError` to HTTP `409`.
   - Stable body includes `code: SESSION_NAME_COLLISION`, `reason`, and `session_name`.
   - Non-collision create failure remains `500` in the focused API test.

2. Playwright cap contract passes.
   - B09 e2e uses `playwright.cap.config.ts`.
   - The spec asserts `:3110`, rejects `:3111`, and intercepts create POSTs with synthetic `409` responses.
   - No evidence of real session create/close in the B09 proof path.

3. UI implementation sets the correct error text, but the human-visible proof fails.
   - The saved screenshot does not visibly show the refusal message.
   - A follow-up DOM probe confirms `chat-err` contains the correct text, but its bounding box starts at `y=717.5` in a `720px` viewport, so the message is effectively clipped at the bottom of the captured UI.
   - Playwright `toBeVisible()` passed because the element exists and intersects the viewport, but the evidence does not prove a readable human-session refusal in the initiating UI.

## Result

FAIL - AC12 API behavior is correct and tests pass, but the UI evidence does not prove a readable human-visible collision refusal. The `chat-err` placement needs to be adjusted or the proof needs to capture the readable error state.
