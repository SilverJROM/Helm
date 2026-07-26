# side-skill: issue-repro-and-defer

> Helm toolkit. Attach to: validator, projcore. How bug/issue tasks are handled.

Issue tasks are **reproduce-first**:

1. The **validator reproduces the issue on the running app BEFORE any implementer work.** The
   repro (steps + observed vs expected) is the FIX CONTRACT and the post-fix acceptance check.
2. **No reproduction → the implementer is never dispatched.** Nothing speculative is fixed.
3. The engine **retries reproduction up to X attempts** (default 2), escalating the repro effort
   (stronger validator / red-team assist) across attempts.
4. On exhausting X without a repro: mark the issue **DEFERRED — NOT REPRODUCIBLE** (a distinct
   state, not a FAIL). **Continue to the next issue.** Do not halt the run; do not interrupt the
   operator mid-stream.
5. After a fix, re-run the exact repro contract; PASS only if cleared.
6. At the **END of the task list**, surface ALL deferred / not-reproducible issues to the
   operator in one summary — the single place they are raised.
