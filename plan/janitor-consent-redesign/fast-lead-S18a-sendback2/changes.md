# S18a Send-Back 2 Changes

## User Report
You are implementer L3 codex55 S18a SEND-BACK attempt 2. Do not expand to S18b.
Repo /home/agjrom/websites/Helm branch s18a-housekeeper-dispatch base fail commit 9f8aac2.
Read plan/janitor-consent-redesign/validation/S18a-validation.md FULLY.

BLOCKING:
V1: boundEnvelope must bound ALL variable evidence fields (callbacks/tasks/dispatch not only pane_tail); enforce final serialized size <= HOUSEKEEPER_ENVELOPE_MAX_CHARS before persist/spawn; add regression with oversized callback/task/dispatch facts (not only large pane).
V2: S18a production path must not be able to terminate via RealTransport launch-failure. Prefer: inject a housekeeper-only fake/no-op transport for spawn in S18a wiring, OR refuse real transport until later authorized slice. Absolute: never terminate investigated session; prove candidate name cannot reach terminate. Prefer zero terminate from housekeeper path entirely for this slice.

HARD SAFETY: HELM_SESSION_JANITOR=0; no reap; no markIdle on candidates; synthetic tests.
Commit fix; append:
[projcore callback] impl S18a STATUS: DONE — COMPLETE | send-back 2/6 | commit=<hash>; V1..V2; ...

## Root Cause
V1: `boundEnvelope()` only shortened `pane_tail`, so oversized durable evidence from `callbacks.raw_line`, `run_tasks.label`, and `dispatches` fields could be persisted and included in spawn briefs over the 8,000-character envelope cap.

V2: `src/index.ts` wired the housekeeper service to shared `orchT`; outside fake tmux that can be `RealTransport`, whose launch-failure cleanup calls terminate on the newly created spawned session. That was outside S18a's fake/no-op dispatch-only authorization.

## Changes
- `src/services/housekeeper-service.ts`: bound all variable evidence fields through deterministic stages, including callback, run, task, and last-dispatch values; added fail-closed serialized-size assertions before investigation persistence and before spawn.
- `src/index.ts`: added `HousekeeperNoopTransport` and wired S18a housekeeper dispatch through it instead of shared `orchT`, leaving this slice unable to reach `RealTransport` or tmux termination.
- `src/s18a-housekeeper-dispatch.test.ts`: added oversized callback/task/dispatch regression and production-wiring proof that housekeeper uses the no-op transport, not shared `RealTransport`.

## Verification
- `HELM_SESSION_JANITOR=0 USE_FAKE_TMUX=1 HELM_DB_PATH=/tmp/helm-s18a-codex55.db npx vitest run src/s18a-housekeeper-dispatch.test.ts --poolOptions.forks.maxForks=2`
- `HELM_SESSION_JANITOR=0 HELM_DB_PATH=/tmp/helm-s18a-typecheck.db npm run typecheck`
- `HELM_SESSION_JANITOR=0 USE_FAKE_TMUX=1 HELM_DB_PATH=/tmp/helm-s18a-suite.db npx vitest run src/s18a-housekeeper-dispatch.test.ts src/s17-house-usage-selector.test.ts src/s15-housekeeper-seed.test.ts src/b07b-house-dispatch-fence.test.ts --poolOptions.forks.maxForks=2`
- `git diff --check`

## Safety Notes
- `HELM_SESSION_JANITOR=0` for all verification.
- No candidate `markIdle`, reap, repair, or terminate calls were added.
- The S18a production housekeeper path now has zero tmux-spawn and zero tmux-terminate capability through its injected transport.
