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

*(Further defects, if any, appended below as the run progresses.)*
