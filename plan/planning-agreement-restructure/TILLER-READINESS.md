# Tiller readiness assessment — can it orchestrate THIS effort?

**By** `[north]` `helm-97`, 2026-07-30 06:3x PHT · **Asked by JROM:** *"check if tiller is up to the
task in orchestrating this run… check the status of tiller if its up to the task this is a new brand
new cycle we can test it on"*

**Verdict: NOT for P0/P1. Genuinely viable for P2/P3 — after two small, specific fixes.**

---

## What Tiller is, and what is actually built

Real code, not a paper design: `/home/agjrom/websites/wflow/tokenless_coord/shadow-harness/`
— `tiller` (12 KB), `tiller_adopt.py` (12.9 KB), `projcore-driver.py` (108 KB), plus
`tiller-escalation-watch.sh`. Spec set in `tokenless_coord/` (14 briefs, Jul 14-15).
Last engine change **2026-07-28**.

**Its core claim is real and it matters here.** Tiller is a Python drain loop, so it *cannot park*. Every
dead turn on the previous Helm effort was one mechanism: an LLM coordinator ending its turn while
waiting. An LLM has no run loop, so "waiting" and "stopped" are the same state. Tiller structurally
cannot do that — and this effort's coordinator has dead-turned **six times** across prior runs.

## Track record — thin, and the most recent run went badly

| Run | Result |
|---|---|
| rscf Z0/B36/B37 | driven live tokenless, worked; Z0 escalated correctly |
| Helm, 2026-07-15 (run 9715) | **exactly one Helm run ever** — clean terminal drain incl. a genuine FAIL→correct→PASS |
| **`livetest/drain-0728-1215`, 2026-07-28 (latest)** | **`terminal_drain: true` but `parked: ["L1"]` — the only slice, parked twice, 0 completed** |

### What the 2026-07-28 run actually shows

From `run/dispatch/TILLER-EXIT.json`, `driver.log`, `findings/conductor-escalations.md`:

1. **Park #1** — implementer reported `BLOCKED — Missing project build/test config (no package.json)`.
   `package.json` **does exist** in that directory, so the seat misdiagnosed and Tiller accepted it.
2. **Park #2 — self-inflicted deadlock.** `pre-dispatch: TRACKED dirt at slice entry — refusing to
   dispatch`. The "dirt" was **Tiller's own bookkeeping**: `run/dispatch/TILLER-EXIT.json`,
   `driver.log`, `parked-slices.json`, `tiller-watch.log`, `tiller.log`. **Tiller parked itself on
   files it had just written.**
3. A human `DIRECTION` (`RETRY_WITH_DIRECTION`) un-parked L1; it **immediately re-parked** for the same
   reason.
4. **Watcher leak:** two `tiller-escalation-watch.sh` processes were **still running 34 hours later**,
   polling a dead run, with `tiller-watch.log` reporting *"another watcher already owns this run —
   exiting"* (contention).

## Why NOT P0/P1

1. **P0/P1 is Helm-*engine* work — the one thing Tiller explicitly does not do.** `D10` already
   settled this: *"Tiller orchestrates the build; it never touches Helm's engine."* P0 rewrites teardown
   and session-registry reconciliation; P1 rewrites the agreement gate. Tiller has no leverage there and
   no model of that state.
2. **This is the most dangerous code in the effort.** C1 fail-open can silently ingest an unreviewed
   plan; C3 can mark a live session reapable. Tiller's safety model is **oversight-dependent by its own
   spec** — verbatim: *"THIS IS NOT FOOLPROOFING. IT IS A WORKABLE BRIDGE"*, and the safety net *"is NOT
   the driver's drive_gate. It is the independent validator seat + projcore/north oversight."*
   **A real false-green already happened (rscf Z0): the driver emitted it and the gate did not catch
   it** — the opus validator plus north's cross-check did.
3. **The dirt-refusal defect would fire on Helm immediately.** A Helm run writes `progress.md`,
   `callbacks.md`, and `validation/**` into the tree as it works. That is exactly the condition that
   deadlocked 2026-07-28 — and Helm generates far more of it than the livetest fixture did.
4. **Blast radius asymmetry.** A false-green on P0.3 does not fail loudly; it leaves a latent path that
   marks live sessions reapable. That is E5's exact shape, and E5 cost JROM a live chat mid-conversation.

## Why P2/P3 IS a good test case

- **Bigger and more mechanical** — P2/P3 is many slices of state-machine plumbing, which is where a
  tokenless drain loop earns its keep.
- **P1 will already be in.** Once the gate is fail-closed, a driver mistake produces an honest failure
  rather than a silent bad plan. **P1 is what makes Tiller safe to trial here.**
- **Attended, as D10 required.** JROM is testing it deliberately, which restores the oversight half of
  its safety model that unattended running removed.
- It gets Tiller the second Helm run it needs, on work whose failure mode is visible.

## The two fixes that would make it testable

Both small, both concrete, both from its own last run:

1. **Dirt-refusal must ignore Tiller's own artifacts.** `run/dispatch/**` (and Helm's `progress.md`,
   `callbacks.md`, `validation/**`) must be excluded from the pre-dispatch tracked-dirt check, or the
   check must run against a path allowlist. As-is it deadlocks on its own logs.
2. **Watcher lifecycle must be bounded.** `tiller-escalation-watch.sh` must exit when the run reaches
   terminal drain, and must not leave a second contending watcher. Two leaked for 34 hours.

Optional but valuable: have the driver **verify** a seat's BLOCKED claim before parking (park #1 was a
seat misdiagnosis Tiller took at face value).

## Recommendation

1. **P0 + P1 on the proven path** — `[north]` drives directly, or projcore with an independent validator.
   Small, safety-critical, engine-level.
2. **Fix Tiller's two blockers** — a short `/fast_lead`-sized job for `wflow-0`, its author.
3. **Then run P2/P3 under Tiller, attended**, with an independent validator seat that is not the driver
   (verifier ≠ fixer), and `[north]` cross-checking gates — the configuration under which its one clean
   Helm run happened.

This gets JROM what he asked for — Tiller genuinely exercised on a brand-new cycle — without betting
the two fixes that stop live-session corruption on an orchestrator whose most recent live run completed
zero slices and deadlocked on its own logs.
