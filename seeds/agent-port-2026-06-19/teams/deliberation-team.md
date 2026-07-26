# Team Charter: deliberation-team

> Helm team type. Bound to the `deliberation` role. Front gate — audits APPROACH and
> plan soundness before implementation. Back gate is red-team (audits code).
> Engine owns dispatch, sessions, and callbacks; this charter describes the
> consensus protocol, roster, and degradation rules only.

---

## Purpose

Deliberate on **non-routine, high-stakes decisions** where a single-model read is insufficient:
- Cross-module schema or architectural pivots
- Security-sensitive or hardened-module touches
- Validator 2× contest (loop-break escalation)
- Any item explicitly tagged `[DELIB]` by the coordinator

~85–90 % of batches never convene this team. Routine work flows through the normal
plan-handshake gate; do NOT panel every batch.

*Slow is fast on planning leverage. A fully fleshed-out plan makes implementation fast.
Don't rush the req/planning stage — all angles, evidence, no holes.* (JROM 2026-06-07)

---

## Default roster (4 members — editable, JROM plugs models in/out)

| Position | Default model | Lens / role |
|----------|--------------|-------------|
| 1 | **opus** | Heavyweight architecture + strategic gaps; writes its own verdict first-class |
| 2 | **codex-5.5** | Code-level correctness + integration seams; co-settler on split |
| 3 | **sonnet** | Cost-efficiency lens + practical UX/DX concerns; first-class, not a formality |
| 4 | **spark** | Edge-case adversarial + cheap blind-spot voice; first-class, not a formality |

Members 3–4 carry equal dissent weight in every round. The panel is multi-model:
each member receives the **same packet**, spawns its own context, and writes its own
verdict independently. This is NOT a single agent running three lenses — it is four
real participants.

To plug a model in or out, edit this roster in Agent Studio. The consensus protocol
below applies to whatever N members are active (≥ 3 required — see degradation).

---

## Consensus protocol

### Packet rule (load-bearing)
Each deliberation is scoped to **one topic**. The engine sends all members an identical
packet: confirmed anchor (topic north-star + goal) prepended verbatim, then source
pointers (≤ 12 entries), then a focused ask. Total packet ≤ ~150 lines. Topics that
need more are **split into sub-topics** — never bloat the packet, which handicaps
members 3–4 and invalidates the panel.

### Round structure
1. All active members receive the packet simultaneously and independently produce a
   verdict (`AGREE` or `REVISE`) with evidence at file:line.
2. The engine (or coordinator) collects all verdicts and checks for consensus.
3. If **all AGREE** → consensus reached. Done.
4. If any `REVISE` or `NEW-FINDING` → the coordinator synthesizes the dissent delta,
   produces a Round-N+1 packet with a focused prior-round section, and dispatches again.

### Unanimous requirement
Consensus is **strict unanimous** — not majority. Every active member must reach
`AGREE`. Sonnet and spark dissent is not a formality; it carries full blocking weight
through round 3.

### Round cap + settle rule
- Maximum **3 rounds**.
- After Round 3, if still split: **opus + codex-5.5 settle**. The coordinator reads
  all verdicts across all rounds, drafts a settle proposal, sends it to codex-5.5 for
  a final cross-check, then writes the consensus record noting the settlers and the
  overridden dissent.
- The settle is a named, documented outcome — not a silent tie-break.

---

## Bucket-exhaustion degradation

Before convening, the engine checks each member's token budget. If a member's bucket
is ≥ 95 % used:
- Skip that member for this round (log which member and why).
- Unanimous rule becomes **unanimous over the remaining ≥ 3 active members**.
- If two members would degrade simultaneously (dropping below 3 active) → defer the
  panel by 30 minutes and retry once. Log; no notification.
- Never fewer than 3 active members. If fewer are available → defer only; do not
  reduce the gate further.

---

## What this team is NOT

- NOT a per-batch gate — fires only on the trigger classes above.
- NOT a vote — strict unanimous (with the ≥ 3 settle carve-out) is the rule.
- NOT a code-write phase — panelists audit and decide approach; the implementer writes
  code against the agreed approach in the next task.
- NOT the back gate — red-team (`red-team.md`) audits the implemented code.

---

*Four independent angles, lean packet, confirmed anchor, strict consensus.
Quality dominant; speed secondary on the planning gate.*
