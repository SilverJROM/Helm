# S14 Independent Validation

Verdict: PASS

Validator: L2 independent
HEAD validated: 0f052122d2a5863cae96311080a07eef85a43cd6
Timestamp: 2026-07-29T09:35:15Z

## Scope

- Studio co-planner copy.
- Planning Seats preview and runtime concordance.
- Provenance-specific Start Implementation refusal visibility.
- `S14.live.spec.ts` collected and run only under `playwright.cap.config.ts`.
- Cycle 13 not used by the S14 validation flow.
- `node --check src/web/public/app.js`.
- `npm run build`.

## Evidence

1. `HELM_SESSION_JANITOR=0 npx playwright test --config=playwright.cap.config.ts e2e/S14.live.spec.ts`
   - Result: PASS.
   - Output: `1 passed (21.9s)`.
   - Cap target: `playwright.cap.config.ts` uses `baseURL: http://127.0.0.1:3110` and no isolated webServer.
   - The spec creates a throwaway `s14-validation-*` project/cycle and asserts `projectId !== 13` and `cycleId !== 13`.
   - Screenshot evidence written by the spec: `validation/S14/S14-planning-seats-390.png`.

2. `node --check src/web/public/app.js`
   - Result: PASS.

3. `npm run build`
   - Result: PASS.
   - Build completed `node --check`, `tsc`, sandbox C compile, binary copy, and web asset copy.
   - Non-blocking compiler warning observed: `tools/helm-sandbox.c:559:56: warning: "/*" within comment [-Wcomment]`.

## AC Mapping

- AC 20-23: PASS. Planning Seats preview and runtime concordance were exercised by the live spec with controlled preview, blocked, and runtime seat fixtures.
- AC 25: PASS. Empty co-planner/panel blocked copy was visible: `Configure co-planners in Agent Studio`.
- AC 27: PASS. Provenance-specific Start Implementation refusal path was exercised by the intercepted `start-implementation` route and visible notice assertions.
- AC 30-31: PASS. Studio copy contract was verified through mounted UI when available or served `app.js` source text, including `Co-planners (excluding plancore)` and `Lead co-planner`; 390px Planning Seats accessibility/layout assertions passed.

## Safety Notes

- No implementation changes were made.
- The S14 run used the capped live Playwright config only.
- Cycle 13 was not targeted by the S14 spec; the validation flow creates and removes a throwaway project shell.
