# Team Charter: red-team

> Helm team type. Bound to the `red-team` role. Back gate — adversarially audits the
> **implemented diff** (code), never the approach. Front gate is deliberation-team
> (audits approach). Engine owns dispatch, sessions, and callbacks; this charter
> describes the tier rosters, gate rule, and degradation only.

---

## Purpose

Break the implemented diff through rotating attack lenses before it ships. A fix can
pass design deliberation, pass a single-pass validator gate, and still fail live. The
highest-value back gate is an adversarial multi-angle red-team of the **real code**,
run until it converges.

*Design review and code review catch different bugs. The panel finds what a single
reviewer — however capable — systematically misses.*

Default is the **normal validator gate, no red-team.** This team fires only on
high-stakes or explicitly tagged batches (~10–15 % of work). Do NOT red-team every
batch; overkill burns model-turns and disrespects the timeline.

---

## The three tiers (roster = the master cost/speed dial)

Picking a tier sets agent-count, gate-depth, and round cap in one move.
No per-knob fiddling.

| | **Budget** | **Standard** | **Elite** |
|---|---|---|---|
| **Members** | 3 | 3 | 6 |
| **Default roster** | sonnet · spark · haiku | codex-5.5 · sonnet · spark | opus · codex-5.5 · gpt-5.4 · sonnet · spark · haiku |
| **Frontier anchors** | none | 1 (codex-5.5) | 3 (opus · codex-5.5 · gpt-5.4) |
| **Gate** | 1-consecutive-CLEAN over 1 distinct lens | 2-consecutive-CLEAN over 2 distinct lenses | 3-consecutive-CLEAN over 3 distinct lenses |
| **Round cap** | 2 | 6 | 12 |
| **Typical wall-clock** | ~1 round (~8 min) | ~2–4 rounds | ~3–8+ rounds |

**Progression logic:** budget → standard swaps haiku for a frontier anchor (codex-5.5)
and deepens the gate 1 → 2; standard → elite adds opus + gpt-5.4 + haiku and deepens
2 → 3. Cost scales by adding frontier anchors and rounds, never by dropping the cheap
diverse voice — diversity of blind-spots is the feature.

Rosters are editable in Agent Studio. The gate rule below applies to whatever roster
is active, as long as ≥ 3 members remain.

---

## Gate rule: N-consecutive-CLEAN over N DISTINCT rotating lenses

A round counts toward the streak **only if**:
1. It used a **new lens** not used in any prior round of this topic.
2. **All active members** returned `CLEAN` that round.

Any `BUGS` verdict from any member resets the streak to 0. The next round must
also use a new lens (fixing bugs does not "re-use" a prior clean lens).

**Gate passes when streak == tier threshold** (1, 2, or 3), each streak point earned
over a distinct lens. Two clean rounds on the same lens = still 1 streak point.

Round cap is the timeline backstop. At cap with no convergence: stop, write open
findings, escalate — do not loop past the cap silently.

---

## Lens catalog (project-agnostic — rotate fresh per round)

Assign the single highest-value lens for the change type on Budget; rotate ≥ 2 on
Standard; rotate ≥ 3 on Elite. Extend this list per project as needed.

- **L1 — Structural / correctness:** does each changed line do what the requirement asks?
- **L2 — Fix-verification + false-positive / silence edges:** does the fix actually close
  the bug? Can a new guard mis-fire on a benign case?
- **L3 — Re-verify after a fix round + remaining structural.**
- **L4 — Concurrency / async + memory / listener / resource leaks + real-scenario trace.**
- **L5 — Adversarial / garbage inputs + platform quirks + error-path coverage.**
- **L6 — Spec-vs-code divergence + observability:** trace each requirement → code → test.
- **L7+ — State-machine exhaustiveness · privacy / security · performance · teardown.**

Tier → lens guidance: bug fix → L2 first; async change → L4 first; cross-module → L6.

---

## Convergence loop

```
Round CRk (assign lens Lk) → all members read the real code + diff
  → each writes a verdict: CLEAN or BUGS with file:line evidence
       │
  any BUGS? ──yes──► coordinator synthesizes a precise numbered bug list
       │                   │
       │             implementer fixes only those bugs (verifier ≠ fixer)
       │                   │
       │             coordinator independently re-runs the strict gate
       │                   │
       └─────────◄── streak = 0 ; next round CR(k+1) with a NEW lens
       │
  all CLEAN + new lens ──► streak += 1
       │
  streak == gate? ──no──► next round, new lens
       │
      yes ──► PASS
```

**Hard rules:**
- Panel members NEVER write the production fix. The implementer does.
- Coordinator re-runs the strict gate independently — does NOT trust the implementer's
  self-reported DONE.
- A fix that introduces its own edge-cases resets the streak; any bug resets to 0.

---

## Bucket-exhaustion degradation

Before each round the engine checks member token budgets. If a member's bucket
is ≥ 95 % used:
- Skip that member this round (log which and why; no notification).
- Gate rule applies over remaining active members.
- Never fewer than 3 active members. If two members would degrade simultaneously
  (dropping below 3) → defer the round 30 minutes and retry once. Log; no
  notification. Do not degrade to fewer than 3.

---

## What this team is NOT

- NOT the deliberation team — that audits APPROACH pre-implementation (front gate).
- NOT a per-batch default — ~85–90 % of batches use the normal validator gate only.
- NOT a vote — streak-over-distinct-lenses is the gate; a single BUGS from any member
  resets it regardless of the other members' verdicts.
- NOT a code-write phase — members audit and report; the implementer fixes.
- NOT project-specific — no domain assumptions; the requirement, source pointers, and
  strict-gate command are parameters supplied per batch.

---

*Tier the spend to the stakes; respect the clock; never trade the quality floor.
A fix that survives N different adversarial lenses on the real code is worth far more
than one that "passed review."*
