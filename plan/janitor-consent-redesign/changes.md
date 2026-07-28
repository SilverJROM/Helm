# Batch S16 Changes

## Branch: `s16-studio-house-tiered` (cut from `8f6e29b` @ S15 VERIFIED tip)

## User Report (verbatim from brief)
GATE-ATOMIC: verify existing Studio tier editor supports factual `house` + `tiered` and persists main + two backups + `definition_md`. No speculative product edit unless factual failure. Add `e2e/S16.live.spec.ts`. UI :3110 with controlled route fixtures. DB persistence via temporary DB/API harness. `HELM_SESSION_JANITOR=0`.

## Root Cause (mechanism-level)
No product defect found (F4). Studio models panel gates on `classification` alone (`studioCls === 'tiered'`); escalations CRUD has no house fence. S15 already seeds housekeeper as house+tiered with main+2. S16 is a verify+proof gate: temp-DB service/API round-trip + full-intercept Playwright UI proof.

## Code Changes
- `src/s16-studio-house-tiered.test.ts` — temp-DB harness: service updateAgent + setAgentEscalations backup-2/definition_md reload; Fastify inject PUT/GET production-shaped routes; live `data/helm.db` mtime assert; janitor=0.
- `e2e/S16.live.spec.ts` — :3110 cap-config UI-PROOF with full intercept of agents/escalations/models; synthetic housekeeper; assert tiered panel L1+L2+L3 + prompt; PUT payloads for definition_md and backup-2; controlled reload; zero live agent mutation.
- **No product files changed** (verify-only; no factual fail).

## Commits
- (this commit) `[batch-S16] gate-atomic Studio house+tiered verify + e2e intercept | scenarios: AC28,AC29,AC31`

## Standing Rules
- HELM_SESSION_JANITOR remains 0; no flag flip.
- GATE-ATOMIC: product edit only on proven factual failure.
- e2e never continues agent PUT/escalations to live server.

## Tests
- `HELM_SESSION_JANITOR=0 npx vitest run src/s16-studio-house-tiered.test.ts --poolOptions.forks.maxForks=2`
- `npx playwright test -c playwright.cap.config.ts e2e/S16.live.spec.ts` (against :3110; full intercept)

## Caveats
- e2e requires pm2/helm on :3110 for shell/login only; agent data is fully synthetic.
- S17 owns usage-gateway house selector; out of scope here.
