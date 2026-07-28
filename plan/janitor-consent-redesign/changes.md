# Batch S17 Changes

## Branch: `s17-house-usage-selector` (cut from `8a032b9` @ S16 VERIFIED tip)

## User Report (verbatim from brief)
Reuse UsageGatewayService for ordered house selector grok45 → spark → haiku.
Extend only normalized rung mapping needed by that selector. Never shell to crew scaffolding or parallel usage service.
Record chosen rung/model and reason; stale/unknown usage explicit fail-safe.

## Root Cause (mechanism-level)
F6: product usage gateway existed but mapToRung was codex-only and there was no house-scoped ordered selector. AC30 needs reuse of the gateway contract for housekeeper ladder selection, not a second usage subsystem.

## Code Changes
- `src/services/usage-gateway-service.ts` — minimal mapToRung: grok+grok-4.5→grok45, claude+claude-haiku-4-5→haiku; retain codex55/spark.
- `src/services/house-usage-selector.ts` — ordered selectHouseUsageRung + HouseUsageSelector; selected vs typed no_dispatch; records reason + skipped; fail-safe stale/unknown.
- `src/services/usage-provider-client.ts` — comment only (live still Codex-only).
- `src/s17-house-usage-selector.test.ts` — injected snapshots: healthy main, depleted→backup1, two depleted→backup2, all unavailable/unknown, stale, choice/reason.
- `src/services/usage-gateway-service.test.ts` — mapToRung house ladder cases.

## Commits
- (this commit) `[batch-S17] house-scoped usage selector grok45→spark→haiku via gateway | scenarios: AC30`

## Standing Rules
- HELM_SESSION_JANITOR remains 0; no flag flip.
- No crew agent-usage.sh; no parallel usage service.
- No housekeeper spawn (S18a); no UI; no schema.

## Tests
- `HELM_SESSION_JANITOR=0 npx vitest run src/s17-house-usage-selector.test.ts src/services/usage-gateway-service.test.ts --poolOptions.forks.maxForks=2`

## Caveats
- Live Codex fetch still only produces codex55/spark; house keys are normalized + injectable for S18a. Unknown/missing rungs fail closed (no_dispatch).
