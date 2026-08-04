# Effort north-star — Agreement is engine state, not agent goodwill

**Effort:** `planning-agreement-restructure`
**Authored by:** `[north]` `helm-97`, 2026-07-30 06:5x PHT
**Project:** Helm — `/home/agjrom/websites/Helm`, live on `:3110` (pm2 `helm-harness`, DB `data/helm.db`)
**Append-only.** Dated entries. Never retconned.

> **INHERITS** the project north-star at `/home/agjrom/websites/Helm/north-star.md` by citation, not by
> copy. SD1-SD10 and its standing constraints bind this effort without being restated here.

---

## 2026-07-30 — Why this effort exists

Helm's planning phase has been fixed **four times** and failed **four times**. Every fix was correct.
Every fix changed an **agent's brief**. A 3-seat independent panel (grok45 · sol · opus, all xhigh)
returned a **unanimous `NEEDS-RESTRUCTURING`** and named the reason in one line:

> **The phase shape is right; the protocol between phases is not enforced by anything.**
> Agreement is prompt instructions to cooperative agents, polled passively by the engine.

So every cooperative assumption — *partners wait, plancore revises, partners re-verdict, "round cap"
means rounds* — is discovered to be false only by burning a real run.

## The one sentence

**Agreement is a fact the engine establishes, never a claim an agent makes.**

## The governing principle

**If a property matters, the engine must enforce it — a brief is not a protocol.**

Its corollary, which is the rule that actually prevents recurrence: **anything an agent is merely
*asked* to do will eventually not happen, and the run must still be correct when it doesn't.**

## The keystone finding

There is **no `transport.send`** in `planning-phase-service.ts` — only `spawn`, `reap`, `inspectSeat`.
`inspectSeat`/`resubmitIfComposerHeld` is invoked **only for `brainRole`** (`:461`), never for a partner.

**A partner whose CLI turn has ended cannot be re-engaged by anything in Helm.** The code comment at
`:520-522` already knew: *"a seat that already emitted VERDICT-READY does not re-emit."*

Therefore a review round **cannot reuse a seat**. Each round must **spawn a fresh reviewer** against the
current plan hash. That single realisation is what makes the round machine implementable — and it is why
the brief-based fix attempted on 2026-07-30 04:00 PHT was inert before it was written.

## What "done" means here (the bar)

- A `CLEAN` verdict on a **superseded** plan revision can never count as agreement. Today it can.
- A failed planning run **cannot** mark a live session reapable, and cannot mark its cycle `complete`.
- `planning_round_cap = 3` means **three rounds**, not three times the timeout.
- The engine — not plancore — declares agreement and grants ingest permission.
- Every historical failure mode has a **token-free test**. This is attempt 3+; the tests are the only
  thing that stops failure N+1 from being a repeat of failure N.

## Ordering rationale — safety before capability

**P0 → P1 → P2 → P3, non-negotiable.**

P0 stops corruption that is happening *today* on every failed planning run. P1 converts the fail-OPEN
agreement gate to fail-CLOSED — it makes the system **safe while still broken**. Only then does P2 make
it work.

**The lesson that set this order,** learned at 05:56 PHT today: a half-fix was worse than no fix.
Removing the BROKEN fail-fast *alone* would have traded an honest failure for a possible **silent
ingest of an unreviewed plan**. Halting it was right. **"Do nothing" beat "ship half"** — and on a
fail-open gate it always will.

## Non-goals

- Re-enabling `HELM_SESSION_JANITOR`. It stays `0`; P0.3 is merely a precondition for reconsidering it.
- Old-cycle compatibility — **D-03**: new cycles are the bar.
- Merging to `main` (**SD10**).
- Rebuilding what works: commit `8024452`'s convene-race fix is **proven on run 32** and must survive
  untouched.
- Tiller. Its gaps were handed to `wflow-0` on 2026-07-30 06:42 PHT; P2/P3 is earmarked for it *after*
  a clean attended Helm run, not before.

## The meta-pattern this effort closes

Four defects tonight shared one shape — **Helm asking an agent to uphold an invariant instead of
enforcing it**: partners asked to wait for artifacts (they didn't, run 31), plancore asked to claim
agreement truthfully (it didn't, run 32), partners asked to re-verdict (they *can't*), reviewers asked
to review the current plan (nothing checks which revision they read).

**Promotion candidate for the project north-star:** *where Helm depends on a model behaving, it must
instead make the misbehaviour harmless — enforce in the mechanism, never in the prompt.*
