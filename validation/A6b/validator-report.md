# A6b Validator Report

Validation time: `2026-07-27T06:45:06Z`

Commit under validation: `05f29627dd00705efab61c174c30139badbe59d1` (`05f2962` - `A6b: guard TaskQueueService against stale writes from a recycled runId (L3 send-back)`)

Verdict: PASS

Verifier scope:
- A6b only: post-approve implementation queue dispatch after a cycle parked at `awaiting_approval`.
- Verifier role only; no product-code edits.
- No full suite.
- Not A6 park half and not A15.

Commands:
- `git rev-parse --short HEAD`
  - Exit code: 0
  - Output: `05f2962`
- `git merge-base --is-ancestor 05f2962 HEAD`
  - Exit code: 0
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3110/`
  - Exit code: 0
  - Output: `200`
- `HELM_DB_PATH=/tmp/helm-a6b-val-$$.db npx vitest run src/services/task-queue-service.test.ts src/pause-after-planning-gate.test.ts src/services/run-resume.test.ts src/run-root-durability.test.ts`
  - Exit code: 0
  - Result: 4 files passed, 36 tests passed.
- `timeout --signal=TERM --kill-after=15s 180s npx playwright test e2e/A6b.live.spec.ts --config=playwright.cap.config.ts`
  - Exit code: 0
  - Result: 1 passed.

Mechanism notes:
- Live app at `http://127.0.0.1:3110/` was healthy before UI proof.
- Live DB scope remained `data/cards2-ibrain.db`; no pm2 restart was performed.
- Playwright used `playwright.cap.config.ts`; default `playwright.config.ts` / `:3111` was not used.
- Live timing observed the required post-approve dispatch path:
  - `finish-planning returned at +16ms`
  - `awaiting_approval=1 (park banner eligible) at +18ms`
  - `approve click at +371ms`
  - `fresh cyclePlan run discovered at +430ms`
  - `cyclePlan run_tasks ingested at +1935ms`
  - `proceed poll exited at +6441ms`
  - `proceeding evidence written at +6507ms`
- Evidence refreshed:
  - `validation/A6b/A6b-implementation-proceeding.png`
  - `validation/A6b/A6b-implementation-proceeding-aria-snapshot.yaml`
  - `plan/helm-ux-remediation/validation/A6b/A6b-implementation-proceeding.png`
  - `plan/helm-ux-remediation/validation/A6b/A6b-implementation-proceeding-aria-snapshot.yaml`

Commit/diff note:
- HEAD is exactly `05f2962`.
- Commit contents include product code, focused test/live spec updates, and A6b evidence artifacts. Product fix files are `src/services/task-queue-service.ts` and `src/services/run-orchestrator-service.ts`.

DONE
