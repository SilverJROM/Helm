# S05 changes — pre-spawn owner refuse + 6 create paths (AC2, AC3)

## Root cause / objective
S04 stored `owner` but every product create path still omitted it. Refusal inside `register()`/`onCreate` is too late: `createSession` already ran `has-session`/`kill`/`new-session`, and `onCreate` is try/caught — yielding live untracked sessions (F2). S05 refuses **before any tmux mutation** and threads explicit `owner` on all six create paths in the same slice.

## Mechanism
1. **`assertValidSessionOwner`** at top of `TmuxService.createSession` after `ensureValidSessionName` — throw if missing/invalid **before** any `execFile`/tmux command.
2. **Defensive `SessionRegistryService.register()`** — throws if owner missing/invalid (belt for direct callers).
3. **Six product call sites** pass owner:
   - `worker-service` workers → `helm`
   - `real-transport` brains → `helm`
   - `master-runtime` preflight (`helm-preflight-*`) → `helm`
   - `master-runtime` launchMaster brains → `helm`
   - `model-validation` probes → `helm`
   - `chat-session-service` discovery/chat → `human`
4. **`index.ts` onCreate** forwards `owner` into `register`.
5. **`EnrichOpts`** separated from `RegisterOpts` so late enrich does not require owner.

## Code changes
- `src/tmux/tmux-service.ts` — required owner + pre-spawn guard
- `src/services/session-registry-service.ts` — register refuse; EnrichOpts
- `src/services/worker-service.ts` — owner helm
- `src/services/real-transport.ts` — owner helm
- `src/services/master-runtime-service.ts` — preflight + brain owner helm
- `src/services/model-validation-service.ts` — probe owner helm
- `src/services/chat-session-service.ts` — human owner
- `src/index.ts` — onCreate owner forward
- Tests: `tmux-helm-child-tag.test.ts` (fake-exec pre-spawn), `session-registry-service.test.ts`, `s05-owner-create-paths.test.ts`, a15/orchestrator-loop/run-orchestrator register/createSession owners

## Guardrails
- `HELM_SESSION_JANITOR=0` unchanged (`.env` + `ecosystem.config.cjs`)
- Fake exec / synthetic DB only; no live reap
- Out of scope: S06 preflight kind, S07 backfill

## Test status
`HELM_SESSION_JANITOR=0 npx vitest run src/tmux/tmux-helm-child-tag.test.ts src/services/session-registry-service.test.ts src/s05-owner-create-paths.test.ts src/a15-worker-finalize.test.ts --poolOptions.forks.maxForks=2` → **61 passed**  
`npx tsc --noEmit -p .` → **exit 0**
