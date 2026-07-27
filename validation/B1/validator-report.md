# B1 Validator L2 Re-Gate Report

Verdict: PASS

Validated commit: `072f2e27c665de6b0d6fa0ca775a065966aea90f`

Scope: re-gate after red-team CRITICAL send-back requiring `HELM_SANDBOX_WRITE_ALLOW` to grant only the concrete seat `runDir`, not the shared `HELM_RUN_ROOT`.

Findings:
- PASS: `makeRunRootWriteAllowEnv(runDir, runRoot)` in `src/security/landlock-sandbox.ts` grants only the resolved concrete run directory when it is a child of `HELM_RUN_ROOT`; it returns no grant for absent `runDir`, unset root, `runDir === root`, or a `runDir` outside the root.
- PASS: `src/services/real-transport.ts` passes its concrete `params.runDir`, which is the only reviewed call site with a real run-scoped callback/artifact directory.
- PASS: `src/services/worker-service.ts` and `src/services/master-runtime-service.ts` no longer call `makeRunRootWriteAllowEnv`; those launch paths have no owned run directory and must not receive a shared-root write grant.
- PASS: sibling-run denial is covered by `src/run-root-durability.test.ts`: the kernel probe creates two sibling run directories under the same shared root, grants only `ownRunDir`, verifies own-run write succeeds, verifies sibling `callbacks.md` append fails with permission denied, and verifies sibling content remains unchanged.
- PASS: live remains green on `:3110`; `/health` reports `writeFence: active`, and `e2e/B1.live.spec.ts` passed against `playwright.cap.config.ts`.

Commands run:
- `npm run build` -> PASS. Only existing `tools/helm-sandbox.c` comment warning emitted.
- `npx vitest run src/run-root-durability.test.ts src/run-cycle-linkage.test.ts src/services/run-orchestrator-service.test.ts` -> PASS, 3 files / 67 tests.
- `curl -fsS http://127.0.0.1:3110/health && timeout --signal=TERM --kill-after=15s 180s npx playwright test e2e/B1.live.spec.ts --config=playwright.cap.config.ts` -> PASS, health OK and 1/1 Playwright passed.

Residual notes:
- Existing unrelated dirty validation artifacts remain under `validation/A2` and `validation/A4`; not part of this gate.
- The B1 live Playwright run refreshed `validation/B1/B1-planning-docs-survive-scratch-removal.png` and `validation/B1/B1-docs-aria-snapshot.yaml`.

Final: PASS.
