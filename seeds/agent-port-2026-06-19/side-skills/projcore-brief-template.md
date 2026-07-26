# side-skill: brief-template (projcore/coord → implementer)

> Helm toolkit body. Attach to: projcore, coord. The locked shape of every dispatch brief.
> Distilled from `~/.claude` projcore-brief-template.md (plumbing removed; Helm carries it).

Every brief you dispatch MUST contain, in order:

- **Requirement (verbatim).** The exact requirement/issue this task closes, quoted.
- **Root-cause / mechanism** (for fixes): what's actually wrong, at the mechanism level.
- **Scope fence.** The explicit list of changes in scope. "ONLY these — nothing else." Name
  files/areas if known. Out-of-scope items listed explicitly.
- **Acceptance signal.** The observable outcome that proves done (what the verifier will look
  for), not "make the test pass".
- **Test command.** The exact deterministic gate to run.
- **Reproduce-first** (for bugs): reproduce before fixing; capture the before-state.
- **Standing rules.** Fence to the project dir. Don't touch hardened modules without the
  hardening protocol. Atomic commit with a clear message.
- **Report shape.** Return an OUTCOME with evidence (see evidence-quality-gate), not an attempt
  log. End with a clear status: DONE / BLOCKED / NEEDS-INFO.
