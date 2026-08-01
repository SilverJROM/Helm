# Tiller defects found — compiled for wflow, send only once this run completes

**Compiled by** `[north]` `helm-97` during the `plancore-orchestrator-redesign` run — Tiller's first
Helm run since the 2026-07-30 gap fixes (Gap 1: self-park on own bookkeeping; Gap 2: unbounded watcher
lifetime — both verified fixed in code before this run started).

**Status: OPEN, compiling.** JROM: *"if there are fixes needed on tiller pls note it and compile and
once this is completed send it to wflow for updating tiller."* Do not send until the run is done.

---

## D1 — Escalation watcher startup race (found 2026-08-01, 00:23 PHT)

**Severity:** real, not cosmetic — the watcher is the entire mechanism that wakes the brain seat
(`wake_projcore`) and detects driver crashes. If it's down, an escalation happens silently.

**Mechanism:** `tiller start` launches the driver, then immediately backgrounds
`tiller-escalation-watch.sh` (`tiller:175`, `setsid nohup ... &`). The watcher's first action is Gap 2's
own exit condition 2 (`tiller-escalation-watch.sh:64`): *"no live driver and no open RAISE — nothing
left to deliver, watcher exiting."* On this run, that check ran **before** the driver had written its
PID file (`$PIDF`), so the watcher saw no live driver, concluded there was nothing to watch, and exited
within the first few seconds — while the driver was in fact starting up normally and went on to
successfully dispatch S0 seconds later.

**Evidence:** `dispatch/tiller-watch.log` from this run: `watch: no live driver and no open RAISE —
nothing left to deliver, watcher exiting` — timestamped essentially at launch, while
`dispatch/driver.log` shows the driver dispatching S0's implementer normally in the same window.
`tiller status` immediately after launch showed `driver: LIVE` / `watcher: not running`.

**Why Gap 2's own fix doesn't already cover this:** Gap 2 correctly stops the watcher from running
forever after the driver is *actually* done. It does not account for the watcher racing the driver's
*own startup* — the watcher's "is there a live driver" check has no grace period and no retry before
concluding the run is over.

**Suggested fix:** either (a) have `tiller start` wait for `$PIDF` to exist and be non-empty before
backgrounding the watcher, or (b) give the watcher's exit-condition-2 check a short grace/retry window
(e.g. 2-3 checks a few seconds apart) before concluding "no live driver," rather than a single
zero-latency check at cold start.

**Mitigation in place for this run:** `[north]`'s own oversight watcher
(`plan/plancore-orchestrator-redesign/north-watch.log`) polls every 60s and relaunches the escalation
watcher automatically if it finds the driver live but the watcher down. Not a substitute for the real
fix — this run stayed safe by luck of timing plus active supervision, not by the mechanism itself.

---

---

## D2 — False park on the literal substring "BLOCKED" in free-text prose (found 03:56 PHT)

**Severity:** real, causes rolled-back completed work — the exact class of damage this whole effort
exists to prevent, now surfacing one layer down in the tool doing the preventing.

**Mechanism, verified directly** (`projcore-driver.py:1318-1322`):

```python
iline, iwhy = poll_cb_active(cb, rf'\[projcore callback\] implementer {re.escape(s)} STATUS: (DONE|BLOCKED)', ...)
...
elif not iline or 'BLOCKED' in iline:
    return {'slice': s, 'decision': 'ESCALATE', ...}
```

The regex correctly captures `DONE` vs `BLOCKED` as a group. The park check three lines later throws
that away and re-checks `'BLOCKED' in iline` against the **entire captured line**, including whatever
free-text note follows `STATUS: DONE`. Slice R7's own product feature (R3.15) is literally about
labeling non-convergence "BLOCKED" in an operator-facing message — so its completion note read
`STATUS: DONE — commit fc7c025 non-convergence BLOCKED + final-positions diff (R3.15)`, and the
substring match false-triggered a park + `git reset --hard` rollback on work that had genuinely
finished.

**Found by:** the brain seat (grok45), diagnosed correctly from the driver source itself, not guessed.

**Suggested fix:** check the regex's captured status group (`DONE`/`BLOCKED`), never substring-match
the raw line. Any product whose vocabulary legitimately contains the word "blocked" will hit this.

## D3 — The no-progress loop guard is process-scoped in a way that isn't documented

**Severity:** minor / operator-facing friction, not data-damaging on its own — but easy to misuse.

**Mechanism:** after a false-park unstick (D2) is retried, the driver's no-progress guard
(`~projcore-driver.py:1615-1630`) can re-trigger within the **same live driver process**, because its
"already driven once this drain" state is in-memory and process-scoped. A second `RETRY_WITH_DIRECTION`
issued while that same process is still running just re-hits the guard and thrashes (re-RAISE, burn a
seat pair, no advance). The only way to actually clear it is to let the process reach a terminal exit
(or be stopped) and resume — a fresh process has empty guard state.

**This is arguably correct behavior** (it prevents an actual infinite retry loop), but nothing in
`TILLER-USAGE.md` explains it, so a brain/operator without this specific insight would very plausibly
keep re-issuing directions into a live process and watch them silently thrash. Our brain seat figured
this out correctly on its own (`DIRECTION-R7-a2`: *"another RETRY_WITH_DIRECTION while this monitor is
live will unpark → re-hit `_no_progress` → re-RAISE thrash"*) and chose to hold the slice parked via
`SKIP_TO_PROJCORE` until natural terminal drain, then retried fresh — but this should not have to be
independently re-derived every time.

**Suggested fix:** document this explicitly in `TILLER-USAGE.md` §4 (the escalation loop section), or
better, have the RAISE payload itself say "this guard is process-scoped; a live-process retry will
re-trigger it — hold and retry after resume" so the brain doesn't have to infer it from source.

---

---

## Run outcome — COMPLETE, sending this compilation now

**21/21 slices verified, `terminal_drain: true`, `parked: []`.** No defects beyond D1-D3 surfaced in
the remainder of the run (R7 and P4 both landed clean on the brain's retry directions; X1's final
regression sweep passed elite-clean). Deployed and independently re-verified by `[north]`: 30/30 slice
test files pass, `tsc` exit 0, pre-existing baseline unchanged exactly (3/1/1), `worker-runtime-
finalize.ts` diff-clean, raceguard 3/3, janitor 0, `main` untouched.

**Net assessment: Tiller did real, correct work on a genuinely safety-critical effort**, including
catching a real gate failure (P4's missing focused-test file, `FOCUSED_SPEC_MISSING`) that a less
careful validator would have waved through. The three defects below are real and worth fixing, but none
of them caused incorrect work to ship — D1 and D2 both self-healed (via oversight + the brain seat
respectively) without needing the backup coordinator, and both are precisely diagnosed with a concrete
fix, not vague reports.

## Summary for the next run

| # | Defect | Severity | Self-healed how |
|---|---|---|---|
| D1 | Escalation watcher startup race — exits if it checks for a live driver before the driver's PID file exists | Real — leaves the wake-brain mechanism silently dark | `[north]`'s oversight watcher detected and relaunched it |
| D2 | Driver false-parks + rolls back genuinely DONE work if the callback's free-text note contains the substring "BLOCKED", even as legitimate product wording | Real — the exact class of damage a coordinator must never cause | Brain seat (grok45) diagnosed from source, issued a precise retry direction |
| D3 | No-progress loop guard is process-scoped in a way `TILLER-USAGE.md` never documents; a live-process retry just re-thrashes it | Minor/operator-friction | Brain seat worked out the process-scoping itself and held-then-retried after natural terminal drain |

**Recommended fix priority for wflow:** D2 first (data-damaging, clear one-line-ish fix — check the
captured regex group, not substring-match the raw line), then D1 (add a grace/retry window before the
watcher's "no live driver" conclusion), then D3 (documentation only — explain the process-scoping in
`TILLER-USAGE.md` §4, or surface it in the RAISE payload itself).
