# S14b changes — Sessions panel + human manual-close UI (AC9/10/11 replacement UI)

## Root cause / objective
S14a shipped `GET /api/sessions` (+owner/status) and `POST /api/sessions/:name/close`
(human-only). S14b is the owner-facing surface: list sessions with owner/status and a
plain **manual Close** control only for human-owned rows, with explicit confirmation and
honest success/error state. Cap Playwright is widened once so `S*.live.spec.ts` runs
against :3110 with fully intercepted session/close traffic (never a live close).

## Mechanism
1. **Nav + panel** (`src/web/public/app.js`):
   - New `SECTIONS.sessions` → slug `13-sessions`, nav `data-testid="nav-sessions"`.
   - On tab: `GET /api/sessions` via `authedFetch`; manual Refresh only (no poll).
   - Each row shows `name`, `kind`, **owner**, **status**.
   - **Close** button only when `owner === 'human'` and `status !== 'reaped'`.
   - `window.confirm` required; cancel → zero POST.
   - POST uses `allowStatuses` so 400/403/404/500 bodies surface as panel-local
     `sessions-error` (`error` + `reason=…`); success sets `sessions-success` and reloads.
   - In-flight close disables buttons (`sessionsClosingName`) to limit double-click.
2. **Cap config** (`playwright.cap.config.ts`):
   - `testMatch` widened once: `[ABS]\d+[a-z]?\.live\.spec` so S14b/S16/S19 collect.
3. **E2E** (`e2e/S14b.live.spec.ts`):
   - Cap config only; base :3110.
   - `page.route('**/api/sessions**')` fulfills **all** list/close; never `continue`.
   - Proves visibility rules, confirm dismiss (0 POST), confirm accept (1 POST + refresh),
     refusal error (`not_human`), screenshot evidence.

## Code changes
- `src/web/public/app.js` — Sessions section, load/close, panel UI
- `playwright.cap.config.ts` — collect `S\d+[a-z]?\.live.spec.ts`
- `e2e/S14b.live.spec.ts` — intercepted UI proof
- `plan/janitor-consent-redesign/changes.md` — this file
- `plan/janitor-consent-redesign/validation/S14b-sessions-panel.png` — UI evidence

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged in `.env` and `ecosystem.config.cjs`
- No S14a mechanism change; no housekeeper; no live terminate in tests
- Playwright via `playwright.cap.config.ts` only

## Test status
- `node --check src/web/public/app.js` → OK
- `npm run build` → exit 0 (documented `helm-sandbox.c` -Wcomment only)
- `npx playwright test -c playwright.cap.config.ts e2e/S14b.live.spec.ts` → 1 passed
