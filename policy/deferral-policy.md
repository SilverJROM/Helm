# Deferral Policy (Helm product)

**Mandatory read** before any plan, batch dispatch, code change, or completion check.
Cross-cutting — applies to every Helm-dispatched worker that makes implementation calls
(implementer, validator, helm_pm / planning, panelists when they prescribe work).

This file is **owned by Helm** and ships in the product tree. Workers must **not** read
builder-side scaffolding under `~/.claude/JROM/**` or other external agent homes for this
policy. The product stands without the build crew.

Owner's recurring annoyance: models suggest "let's defer this" / "follow-up PR" / "address
later" instead of doing the work. This policy makes deferral a *gated* mechanism, not a
default escape hatch.

---

## 1 — Lifecycle modes (set at intake, stored in north-star.md or cycle intake)

| Mode | Deferral | When |
|---|---|---|
| **pre-live** (DEFAULT if unanswered) | **OFF** | Project is in development phase. Code/requirements churn. Dead/unused code must be removed in the same batch as the change that obsoletes it. |
| **post-live** | **CONDITIONAL** | Project is in production. Default is still removal; deferral allowed only where the owner explicitly flags a path (e.g. "auth signature changes → defer") at frontload. |
| **demo-crunch** | **ON** | Deadline / demo / presentation. Deferral allowed at implementer discretion to keep the demo working; cleanup batch appended to queue, processed post-demo. |

**Default = pre-live.** If lifecycle is not set, the worker behaves strictly. Burden of
unlocking deferral is on the owner, not the model.

**Mid-run override:** the owner may flip lifecycle by chat keyword (`lifecycle: demo-crunch`,
`lifecycle: post-live`). Coordinator appends a dated entry to north-star.md and broadcasts to
the in-flight implementer at the next boundary.

---

## 2 — The enforceable test (the only test that matters)

**Does the deferred work have a concrete queued task in *this run* that gates run completion?**

- **YES** → legal intra-run sequencing. Proceed.
- **NO** → illegal deferral. REJECT at handshake / FAIL at gate.

Run completion already requires the queue empty AND every requirements-matrix row VERIFIED.
So a queued task is the structural guarantee that deferred work actually gets done before
the run ends.

---

## 3 — Legal patterns (intra-run sequencing, NOT deferral)

- "Stage cleanup of old auth helpers as batch 7" + a queue row exists for this run.
- Dependency-ordered batches: "schema migration before UI update."
- Atomic decomposition: splitting a >30min task into ordered atomic slices. All slices are
  in this run.
- Out-of-scope expansion to a different module / different requirement — that's *scope
  discipline*, never was in the contract, doesn't count as deferral.
- Genuine `STATUS: BLOCKED` on a stop condition (auth missing, contradictory spec, decision
  required).
- `STATUS: NEEDS-INFO` / `NEEDS-CLARIFICATION` when genuinely unsure — the model owes the
  owner a real question, not a punt.

---

## 4 — Illegal patterns (the BS, hard-blocked under pre-live)

The diff or plan introduces ANY of the following without a corresponding queue row that
lands in this run:

- **TODO / FIXME / XXX / HACK comments** added in the diff.
- **Punt-language in changes.md / plan:** "address in follow-up," "tracked in ticket,"
  "out of scope for now," "will revisit," "leave for later," "can be cleaned up later."
- **Dead code left in place:** unused functions, commented-out blocks, orphan helpers,
  unused imports, unreferenced exports.
- **Backwards-compat shims** when the caller-tree is contained (no external consumer).
- **`@deprecated` / "do not use" markers** without an actual removal task in the queue.
- **Renamed-but-old-name-kept-as-alias** patterns.
- **New flags / config switches "for safety"** with no concrete caller needing them.
- **Uncertainty-laundering:** "not sure how to handle X, deferring" — this is a
  NEEDS-INFO, not a deferral. Owe a question, not a punt.

---

## 5 — Enforcement points

**At plan handshake (`STATUS: PROPOSED`):** scan plan text for §4 patterns. If hit AND
lifecycle = pre-live AND no queue row covers it → REJECT with one-line correction:
*"Lifecycle = pre-live, deferral OFF. Do [X] in this batch, or propose appending [Y] to the
run queue with Req# assignment."*

**At completion gate (`STATUS: DONE`):** scan diff + changes.md for §4 patterns. If hit
AND lifecycle = pre-live AND no queue row → FAIL batch on evidence quality. REVISE brief
lists the deferred items as the gaps to close.

**Implementer can always propose** appending a cleanup/follow-up task to the run queue at
handshake. That converts illegal deferral → legal intra-run sequencing.

---

## 6 — Logging

Every deferral-policy fire (REJECT at handshake, FAIL at gate, mid-run override) → log to
the cycle/run `decisions/` folder with the trigger line + verdict.
