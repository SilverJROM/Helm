# REVIEW CHARTER — sanity-check the requirements before any implementation planning

**Commissioned by** `[north]` `helm-97`, 2026-08-01 · **Seats:** `grok45`, `sol` (xhigh), `opus` —
independent, no cross-talk.

## Why you were convened

This is the **second core-contract change** to Helm's planning subsystem inside 48 hours. The first
(`planning-agreement-restructure`) was fixed four times before the real diagnosis held, and even after
a clean 24-slice ship, `[north]` still built the wrong thing on the first pass of *this* effort — took a
clear operator directive ("plancore orchestrates, planners debate") and implemented "plancore authors,
planners review" instead, and only caught it when the operator read the mechanism back and said no.

That is the failure mode you are here to prevent happening a THIRD time: **read `north-star.md` and
`og-requirements.md` in `plan/plancore-orchestrator-redesign/` and find where they still get it wrong**,
before a single line of implementation is planned.

## What you are reviewing

1. `plan/plancore-orchestrator-redesign/north-star.md`
2. `plan/plancore-orchestrator-redesign/og-requirements.md`

Both cite `file:line` against the current mechanism. **Verify every citation against the real code** —
`src/services/brief-writer-service.ts`, `src/services/planning-review-round.ts`,
`src/services/planning-phase-service.ts`. A citation that is wrong or stale is itself a finding.

## The single largest bet in the document — stress-test this hardest

**R2.7**: *"agreement = both co-planners' current proposed plan.md bytes hash identically"* — byte-
identity between two independently-authored drafts, not a semantic "close enough" or a verdict from
either seat on the other's draft.

Questions to actually answer, not just note as open:
- Is byte-identical convergence **achievable** in practice for two different models drafting
  independently, or does it produce an infinite/near-infinite reconciliation loop because two models
  will phrase the same content differently even when they agree substantively? If this bet is wrong,
  say so plainly and propose the alternative (e.g. one seat's reconciled draft becomes canonical once
  the OTHER seat explicitly signs off on it byte-for-byte — a different mechanism, not just a looser
  hash check).
- **R2.8**'s reconciliation-round design: on divergence, fresh seats are spawned, each shown the OTHER's
  current draft, asked to reconcile. Trace this through 2-3 rounds concretely. Does it actually converge,
  or can it oscillate (A adopts B's structure, B then adopts a DIFFERENT part of A's structure, neither
  round ever produces matching bytes)? If oscillation is a real risk, what termination condition (beyond
  the existing round-cap → BLOCKED) would help, if any?
- **R4.14**'s recommendation** (plancore stays a real, minimized seat rather than being retired) — is
  this the right call, or does keeping a coordinator seat that contributes zero content just add an
  extra hop with no function? Argue it either way with the actual mechanism in mind (who currently
  reads `role_bindings`, topology contracts, S05/S06 staffing resolution — would retiring plancore
  as a role genuinely break those, or was that overstated as a reason to keep it?)

## Also check

- **R6** (the shared `generatePanelBrief` function serving BOTH planning co-planners and
  implementation-diff deliberation/red-team) — is the separation between the two call sites clean enough
  in the CURRENT code that this change can land without regressing diff review? Cite the actual call
  sites.
- **Anything JROM's verbatim quotes imply that the requirements document missed.** Re-read the three
  quotes in `north-star.md` closely — is there a reading of "coordinate effectively" or "minimal inputs"
  that R1-R4 do not capture?
- **Anything from `planning-agreement-restructure`'s own panel** (`plan/_panels/planning-path-review/`,
  if you want the background) that this redesign risks reopening. R5 claims nothing regresses — verify
  that claim isn't just asserted.

## Rules

- **Read-only.** No edits, no commits, nothing dispatched. Just findings.
- **Mechanism-level or it does not count.** Cite file:line. "This seems risky" is worthless without the
  concrete failure sequence.
- **Work independently.** Do not read another seat's output.
- **Take a position.** If you think R2.7's convergence definition is simply wrong, say so and propose
  the replacement — do not hedge with "consider revisiting this."

## Deliverable

`plan/plancore-orchestrator-redesign/review-<yourmodel>.md`:

```
## VERDICT: REQUIREMENTS SOUND | NEEDS-REVISION  (one paragraph, no hedging)

## R2.7 CONVERGENCE DEFINITION — achievable as written, or needs a different mechanism?

## RANKED FINDINGS
mechanism (file:line) · why it matters · concrete fix

## WHAT I COULD NOT DETERMINE
```

End with `REVIEW-DONE <yourmodel>`.
