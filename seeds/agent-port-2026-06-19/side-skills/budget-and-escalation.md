# side-skill: budget-and-escalation

> Helm toolkit. Attach to: projcore, implementer, validator. Model selection + escalation axes.

## Per-task base model + effort (set in the plan)
The plan may assign each task its own **implementer model + effort** (heavier for complex tasks,
lighter for routine). Helm uses that as the task's BASE worker — the main worker is swapped per
task as the plan specifies. The per-task policy is decided with the operator in the interview;
absent a per-task override, the project's default role binding is used.

## Escalation ladder (per agent — stays at the agent level)
Every code-bearing agent has a model RUNG LADDER (rung-0 base → rung-1 → rung-2 stronger),
editable per agent in Agent Studio. Two triggers move a task up the ladder — both deterministic,
both applied ON TOP of the per-task base:

- **on-fail:** a task that fails its gate N times at the current rung bumps to the next rung (a
  stronger model). Per-rung limits are configured; the top rung's cap is the hard stop.
- **low-budget:** if the bound model's remaining token budget drops below the amount needed to
  finish the task (threshold X, configurable), the engine swaps to the next rung or a model with
  headroom — so a run never stalls on an exhausted bucket. For the master (projcore) this is a
  hot-swap to the backup brain.

The coordinator sets the ladders + thresholds and decides the genuine edge cases (which rung on a
wrong-approach vs implementation-thrash, when to stop and raise to the operator). The engine does
the mechanical per-task base selection, the bumping, and the budget-watching — not the coordinator.
