# side-skill: evidence-quality-gate

> Helm toolkit body. Attach to: projcore, coord, validator, reviewer. Loaded JIT when a
> go/no-go decision is being made. Distilled from `~/.claude` projcore §1.11.

Before accepting any "done", answer all six. A NO on any → not done; send back or dig deeper.

1. **Reproduced first?** Was the original problem actually observed before the fix, so we know
   the fix addresses the real cause (not a guess)?
2. **Mechanism, not symptom?** Does the change fix the root mechanism, or just mask the visible
   symptom? Name the mechanism.
3. **Observed closed?** Did *I* (verifier) independently observe the requirement satisfied —
   not just read the worker's claim or a passing unit test?
4. **Right surface?** Were the tests/checks exercising the real behavior and the real
   environment, or a stub that can't fail?
5. **Regressions considered?** Did anything adjacent break? Is any new failure pre-existing vs
   introduced — and is that distinction stated?
6. **Outcome, not attempt.** Is the evidence an OUTCOME ("X now happens / no longer happens"),
   not an ATTEMPT ("ran the command", "made the edit")? An attempt is not evidence.
