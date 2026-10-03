# Helm

**An agent-orchestration application.** Helm authors agents, binds swappable models to fixed
agent roles, and runs and supervises per-project agent teams from one command center.

It plans work, dispatches AI coding agents into tmux sessions under a Landlock write-fence,
gates their output, escalates when they fail, and reports what happened.

## The founding principle

> **One source of orchestration. The app owns the prompt and the durable state; the runtime is
> disposable.**

"The runtime is disposable" means the record outlives the session — when a pane dies you lose
the pane, never the truth. Its corollary:

> **The app's report is a consequence of what happened, never a claim about it.**

State is derived from the record, never from a hardcoded assumption, a regex over prose, or a
file that may not exist. An orchestrator whose self-report cannot be trusted cannot be pointed
at a client project, because the operator's only view of the work *is* the report. Integrity of
the report is a **functional** requirement, not a presentation concern.

## Design notes

- **Roles are fixed; models are swappable.** An agent role (implementer, validator, planner) is
  a contract. Which model fills it is a routing decision, re-decided per task from measured
  performance rather than preference.
- **The validator is never the implementer.** Separation is structural, not advisory — including
  when both are models. An AI reviewer grading its own work is not a review.
- **Write-fenced execution.** Agents run under a Landlock sandbox (`tools/helm-sandbox`, built
  from the committed C source) so a dispatched agent cannot write outside its slice.
- **Gated batches.** Work advances only through an explicit gate. Failure escalates rather than
  retries indefinitely.

## Stack

TypeScript · Fastify · WebSocket · SQLite (better-sqlite3) · JWT auth · vitest · Playwright ·
tmux-based agent runtime · Landlock write-fence (C)

```
src/          control plane, API, auth, orchestration
e2e/          Playwright end-to-end suites
seeds/        fixture data
tools/        helm-sandbox (Landlock write-fence, C source)
prompts/      agent role prompts
docs/         design documents
plan/         run state and planning artifacts from real runs
validation/   evidence captured by gates during real runs
```

## A note on `plan/` and `validation/`

This repository is the working tree of a tool used on real projects, so it carries the
orchestration run artifacts those runs produced — planning documents, gate evidence, decision
logs. They are kept deliberately: in a system whose core claim is *"the report is a consequence
of what happened,"* the retained record is the proof. If you are reading this as a code sample,
`src/`, `e2e/` and `tools/` are the engineering.

## Status

Working software, used on live client projects. Not packaged for third-party deployment —
there is no stable public API and configuration assumes the author's environment.
