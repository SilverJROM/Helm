# side-skill: redteam-protocol

> Helm toolkit body. Attach to: projcore, coord (when either acts as coordinator for
> a red-team convening). Loaded JIT when a red-team round is being dispatched or
> synthesized. Distilled from `~/.claude` projcore-redteam.md.

---

## As coordinator: before you dispatch a round

1. **Confirm the trigger is real.** Is this batch tagged `[REDTEAM:tier]`, pre-approved
   at interview, or in a §2c risk class (recurring bug; hardened-module; security path;
   large capstone cross-module)? If none — do NOT red-team. Normal validator gate stands.
   Overkill wastes model-turns.

2. **Pick the tier.** Budget (3 members, 1-clean gate), Standard (3 members, 2-clean),
   or Elite (6 members, 3-clean). The tier sets agent-count, gate-depth, and round cap
   together. No per-knob fiddling. If `[REDTEAM]` without a tier suffix, auto-select
   from the risk class.

3. **Assign the lens for this round.** Each round must use a DISTINCT lens not used in
   any prior round of this topic. Budget: pick the single highest-value lens for the
   change type. Standard/Elite: rotate through the catalog. Record the assigned lens in
   the packet and in the streak table.

4. **Build a lean packet.** ≤ ~40 lines: the unified diff + source pointers to the
   real files on disk + the exact requirement bar + the strict-gate output contract +
   the assigned lens and focused ask. Same packet to all members simultaneously.
   A bloated packet handicaps cheaper members — that invalidates the panel.

---

## As coordinator: after verdicts arrive

- **All CLEAN (new lens)** → streak += 1. Check if streak == gate threshold:
  - Yes → PASS. Update req-matrix, commit, live validation.
  - No → next round, assign a NEW lens, dispatch.
- **Any BUGS** → streak = 0. Synthesize a precise numbered bug list (file:line | what
  breaks | how to fix). Dispatch to the implementer (NOT a panel member — verifier ≠
  fixer). After the fix: independently re-run the strict gate yourself. Then dispatch
  the next round with a NEW lens.
- **At round cap with no convergence** → stop. Write open findings, escalate with a
  verdict-led summary of the worst open finding. Do not loop past the cap silently.

Log every round transition: topic, round number (CR-k), lens (L-n), verdict distribution
(N CLEAN / M BUGS), current streak.

---

## As a team member (panelist): how to behave in a red-team round

You are one attack angle. You do NOT coordinate with the other members. You do NOT see
their verdicts before writing yours.

1. **Read the assigned lens.** Your job this round is to attack the diff from THAT angle
   only. Do not wander to other surfaces — focused attack is why lenses rotate.
2. **Read the REAL code and diff.** Not a summary, not a description. The actual changed
   lines on disk. Your verdict must trace to `file:line`.
3. **Actively try to break it.** Look for edge cases, silent-failure paths, wrong guards,
   races, spec divergence — whatever the lens targets. CLEAN is a conclusion you reach
   after genuinely trying to find a bug, not a default.
4. **End with exactly one STATUS line:**
   - `STATUS: CLEAN — <one-line summary of what you verified>` — only if you genuinely
     could not find a bug under this lens.
   - `STATUS: BUGS — <count> found` — followed by a numbered list: each entry = bug
     description · file:line of the defect · concrete repro steps or trace.
5. Do not return CLEAN to keep things moving. A false CLEAN that ships a bug is the
   exact failure mode this panel exists to prevent.

---

## What counts as a BUGS verdict

- A concrete defect traceable to file:line in the diff or in code the diff touches.
- A silent-failure path: the system succeeds or fails silently where it should error.
- A guard that mis-fires on a benign input (false positive).
- A missing case the requirement explicitly covers but the code does not handle.

Hypotheses without a file:line trace are NOT bugs — label them as hypotheses in your
report. Do not block the streak on ungrounded speculation; do note them for the coordinator.

---

## Streak and lens rules (summary)

- Streak increments ONLY on a round where ALL members return CLEAN AND the lens is NEW.
- ANY BUGS from ANY member resets streak to 0.
- Reusing a prior lens does not increment the streak even if all CLEAN.
- Gate passes at streak == tier threshold over that many DISTINCT lenses.
