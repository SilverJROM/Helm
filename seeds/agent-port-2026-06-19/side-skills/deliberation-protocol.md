# side-skill: deliberation-protocol

> Helm toolkit body. Attach to: projcore, coord (when either acts as coordinator for
> a deliberation-team convening). Loaded JIT when a deliberation is being dispatched
> or synthesized. Distilled from `~/.claude` projcore-deliberation.md.

---

## As coordinator: before you dispatch

1. **Confirm the trigger is real.** Is this item tagged `[DELIB]`, pre-approved at
   interview, in an auto-detect risk class, or a validator-2× escalation? If none of
   those — do NOT convene. Routine work skips the panel entirely.

2. **Write the anchor first.** Every deliberation gets a topic-scoped anchor:
   one-line topic name · scoped north-star (2–4 lines) · one-line goal · in-scope /
   out-of-scope bullets · triggering requirement or batch ID · source pointers (≤ 12).
   Confirm anchor with JROM ONLY if the goal cannot be derived from existing anchors
   with high confidence. Default: derive and dispatch.

3. **Build a lean packet.** Total ≤ ~150 lines including the anchor. Source pointers
   ≤ 12 entries. If the topic needs more context → **split into sub-topics**. A
   bloated packet handicaps the cheaper team members — that defeats the panel.

4. **Send the same packet to all members simultaneously.** Each member reads
   independently. Do not pre-brief members on what others are likely to say.

---

## As coordinator: collecting verdicts and running the consensus loop

After all active members return verdicts:

- **All AGREE** → consensus reached. Write the consensus record (decision, evidence,
  any app-bugs surfaced, dissent if settled, goal-closure check). Done.
- **Any REVISE or NEW-FINDING** → synthesize the delta. Draft a Round-N+1 packet with
  a focused prior-round section that names the specific points of divergence. Dispatch
  again. Increment round counter.
- **After Round 3 with no unanimous AGREE** → apply the settle rule: opus + codex-5.5
  settle (read all verdicts, draft settle proposal, cross-check with codex-5.5, write
  consensus noting settlers and overridden dissent). The settle is a named outcome.

Round cap is 3. Never go past 3 rounds without settling.

Log every round transition: topic, round number, verdict distribution (N AGREE / M REVISE).

---

## As a team member (panelist): how to behave in a deliberation round

You are one of four independent panelists. You do NOT coordinate with the other
members. You do NOT see their verdicts before writing yours.

1. **Read the anchor first.** The anchor defines the goal. Do not renegotiate the
   anchor; it is confirmed before you received the packet.
2. **Audit independently.** Find all holes — gaps, wrong-proof tests, missing
   scenarios, alternative approaches the anchor doesn't address. Evidence at file:line.
3. **Address the prior-round delta (Round 2+ only).** If the packet contains a
   "Prior-round delta" section, address every focused ask before producing your verdict.
4. **End with exactly one STATUS line:**
   - `STATUS: AGREE — <topic> reaches goal` — only if you are satisfied there are no
     blocking holes.
   - `STATUS: REVISE — <one-line top reason>` — if any blocking hole remains.
5. Do not write AGREE to move things forward. REVISE with a concrete hole is a gift
   to the run; AGREE with hidden doubts is a liability.

---

## When to converge

Converge to AGREE when:
- The goal in the anchor is fully closed by the approach.
- You have no remaining blocking holes after examining the source pointers.
- Prior-round dissents you raised have been addressed in the current packet.

Do NOT converge because other members are likely to agree, or because it is Round 3.
The settle rule exists to handle genuine persistent dissent — use your honest verdict
every round.
