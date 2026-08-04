# D-01 — Planning start is manual confirm only (no autonomous Helm start)

**Effort:** `discovery-planning-handoff`
**Decided by:** JROM, 2026-07-29 · **Logged by:** `[north]` `helm-97`
**Status:** LOCKED for this effort · **Affects:** AC13, AC29, TS-002 · **Plan change required: NONE**

---

## The question put to JROM

He described two ways planning could start:

> "i can either start the planning manually or discovery can ask helm (algo) himself to start the
> planning but only helm can do it not discovery agent"

Those are two different modes, and the plan only encoded one. **AC13** requires the owner's explicit
confirmation before any run is created, so "discovery asks Helm and Helm starts it" still routed
through JROM's click. There was no path where Helm proceeds on discovery's ask alone.

Asked whether he wanted a genuinely autonomous second mode, or whether "only helm can do it" was
purely about the **actuator** being Helm-algo rather than the discovery LLM.

## The decision

> **"ok let make it manual for now"**

**Manual confirmation is mandatory on every path.** A ready callback from Discovery creates a pending
handoff and nothing else. Only JROM's explicit `Start planning team` action consumes it.

## What this confirms (no AC changes)

The existing acceptance criteria are already correct and stay exactly as written:

| AC | What it locks |
|---|---|
| **AC13** | A ready callback alone leaves the cycle in `discovery`, creates zero runs, starts zero seats **until the owner explicitly confirms**. |
| **AC29** | The chat agent can submit ready but **cannot** call the owner-confirm endpoint or Planning starter with its callback credential. |
| **AC11** | Printing `[helm callback] north STATUS: HANDOFF` into a pane is presentational only. Helm never parses rendered terminal prose as a transition command. |
| **TS-002** | "Discovery asks; ready does not auto-start." |

**The invariant, unchanged:** Discovery may only ever *request*. Helm actuates. This is enforced at the
credential layer, not in prompt text — which is why it holds even when the model misbehaves.

## Why manual first (the reasoning JROM accepted)

This effort exists because planning started without telling him. An auto-start path shipped in the same
change is **observationally identical to the bug**: on the first test run he could not distinguish
"the gate worked" from "it bypassed me again," because both produce a planning run he did not click.

One clean run where it stops and asks establishes the baseline. Only then is an autonomous variant
measurable against it.

## Explicitly deferred, not rejected

The autonomous mode ("discovery asks → Helm starts, no click") is **held**, not dropped — "for now"
is JROM's wording. Filed as `../_backlog/R-autonomous-planning-start.md`.

It is **additive**: the confirm path stays, and the autonomous mode becomes a per-cycle setting layered
on top. It needs a third `cycles.autonomy` value or a separate flag — the current enum is exactly
`autonomous_after_discovery | pause_after_planning`, and `autonomous_after_discovery` governs
**implementation** auto-start (`cycle-auto-start.ts:76`, "a valid plan and NO active run"), not
planning start. So no existing switch fits, and none should be overloaded to mean two things.

## Standing assumption (correctable)

"Let me know once that is done" is served by the **inline Discovery handoff card** (AC12) — the
question, document-ready state, resolved seat manifest, `Start planning team` / `Not yet`. There is no
Telegram ping on Discovery-ready in scope. JROM said he will test once the effort is fully done, so he
is expected to be at the UI. If he will be away when Discovery finishes, a TG notification on ready is
a small addition — raise it before S09 lands.

## Related

- `../og-requirements.md` R2 (AC 7–17, 29)
- `../_backlog/R-discovery-handoff-confirm.md` — the originating request
- `../_backlog/R-autonomous-planning-start.md` — the deferred mode
- Project north-star `SD6` (Helm is source of truth for projects)
