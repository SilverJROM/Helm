# Batch S19 Changes — GATE-ATOMIC + RELEASE-ATOMIC capstone

## Branch: `s19-release-capstone` (cut from `6ead827` @ S18b VERIFIED tip)

## User Report (verbatim from brief / approval)
Capstone evidence only: AC matrix, shadow audit, release packet, build/vitest/playwright proofs;
HELM_SESSION_JANITOR stays 0 (never flip); branch s19-release-capstone from 6ead827.
No product redesign.

## Root Cause / Scope
S19 is evidence-only. Product path S01–S18b already VERIFIED. AC20 is build-to-ready + shadow
audit + JROM release packet; flag flip remains JROM-owned
(`decisions/2026-07-27-ac20-build-to-ready.md`).

## Code / Artifact Changes
- `e2e/S19.live.spec.ts` — fully intercepted :3110 Sessions + Studio screenshots (zero live close/mutate)
- `plan/janitor-consent-redesign/validation/S19-ac-matrix.md` — 22 IN-SCOPE + 9 SUPERSEDED audit
- `plan/janitor-consent-redesign/validation/S19-shadow-audit.md` — off|shadow|on + deploy stays 0
- `plan/janitor-consent-redesign/validation/S19-jrom-release-packet.md` — JROM-only enable packet
- `plan/janitor-consent-redesign/validation/S19-proof-log.md` — command results + full-suite inventory
- `plan/janitor-consent-redesign/validation/S19-manual-close.png`
- `plan/janitor-consent-redesign/validation/S19-housekeeper-studio.png`
- `plan/janitor-consent-redesign/req-matrix.md` — status refresh to VERIFIED / JROM-GATE
- No product source under `src/` (except none); no `.env` / `ecosystem.config.cjs` edits

## Standing Rules
- HELM_SESSION_JANITOR remains 0; no flag flip to on/shadow in deploy.
- Destructive/reaper only synthetic DB + fake tmux (focused suite).
- Live `data/helm.db` mtime unchanged across capstone harness.

## Tests / Proofs
- `node --check src/web/public/app.js` OK
- `npm run build` OK
- Focused: 8 files / 135 tests PASS (`HELM_DB_PATH` temp, `HELM_SESSION_JANITOR=0`, maxForks=2)
- Full vitest: 178 files pass / 21 fail (39 tests) — pre-existing debt documented in S19-proof-log.md; not fixed in S19
- Playwright cap: S14b + S16 + S19 → 4/4 PASS

## Commits
- (this commit) `[batch-S19] capstone AC matrix + shadow audit + release packet + UI evidence | scenarios: AC1-5,14-20,22-31`

## Caveats
- Full suite failures are schema-pin / oracle / live-tmux / env drift; effort-critical suite is green.
- AC20 live enable is **not** claimed; see JROM release packet.
