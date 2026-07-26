# Helm — Implementation Plan

**Approach:** Phased MVP, then expand (JROM-chosen). Standalone service; lift the proven engine substrate from
the shelved AGJAssist Agent OS branch; rebuild the UI around the 3 sections. Atomic batches (<30min target,
projcore §1.4c). 3-agent topology + deliberation/red-team on genuinely complex batches.

**Home:** `/home/agjrom/TGBOTS/Helm/` (own git repo). **Port:** `3110` (AGJAssist is 3101). **Stack:**
TypeScript / Fastify / better-sqlite3 (WAL) / no-build Preact+htm frontend / pm2 (`helm`).

**Lift source:** AGJAssist branch `feat/agj-upgrade-B6-spawn-security` — substrate files:
`src/config/providers.ts`, `provider-resolver-service.ts`, `agent-event-ingest.ts`, `agent-events-service`,
`wake-scheduler`, `provider-dispatch-service.ts`, `coordinator-launch-service.ts`, the `prompts/agent-os/`
corpus, and the relevant DB tables (agents, role_bindings, role_defaults, agent_events, agent_wake_schedule).

---

## Phase 1 — MVP spine (usable command center)

> **End-of-P1 outcome:** Open Helm → pick an OVM project → set its master model → **talk to projcore in the
> Command Center and have it actually work, ask you back, and continue** — engine underneath, hot model-swap available.

- **P1-1 — Scaffold standalone service.** git init; package.json; tsconfig; Fastify server on :3110; SQLite
  init (WAL, schema_version); `/health`; no-build Preact frontend shell with the 3-section nav (Studio /
  Project Setup / Command Center) stubbed; pm2 ecosystem entry. *(low risk — standard gate)*
- **P1-2 — Lift the engine substrate.** Port providers registry + resolver + agent_events schema/service into
  Helm's DB; unit-prove resolver returns correct launch specs for claude/codex/grok + the one-edit dummy.
  *(low/med risk — standard gate)*
- **P1-3 — Link seam + auth.** Read-only OVM projects reader (from AGJAssist's `projects` table: id,
  directory_name, display_name, status, active); reuse AGJAssist owner login; carry the B6 guardrails
  (loopback-bound spawn, owner-only, enumerated role×runtime vocab). *(med risk — standard gate + security check)*
- **P1-4 — Project Setup (minimal).** List OVM projects; per project set master model + preference chain;
  persist to Helm DB; "set up" flips a project eligible for the Command Center dropdown. *(low/med risk)*
- **★ DELIBERATE + RED-TEAM** the master-runtime + hot-swap + state-resume mechanic (H13/H15/H16) BEFORE P1-5.
  Panel = sonnet + codex-5.5 + grok-build. Output: consensus.md the P1-5/P1-6 briefs implement.
- **P1-5 — Persistent master lifecycle.** Spawn projcore master as a bare agentic CLI fed the app-composed
  prompt (CORE+overlay); supervise + auto-respawn; lift the projcore CORE + overlays corpus. *(HIGH risk —
  3-agent + post-build red-team)*
- **P1-6 — Command Center chat + model-swap.** Talk to the master (structured agent_events, role/status/ts);
  agent-asks-you → reply → proceeds; switch-model dropdown performs the hot handoff (park process → launch
  fallback in same session → re-feed prompt + state digest). *(HIGH risk — 3-agent + post-build red-team)*

## Phase 2 — Spawn + live board + auto-fallback

- **P2-1 — Worker spawn through the app** (app-owned lifecycle: create/feed/watch/teardown; ephemeral).
- **P2-2 — Live "what's happening now"** board (current task, worker activity, progress) from the event stream.
- **P2-3 — Auto-fallback** on token-exhaustion via the usage gateway (`agent-usage.sh`), with the swap event.

## Phase 3 — Full Studio + polish

- **P3-1 — Agent Studio editor** (friendly `.md` CRUD; create agents addable to projects).
- **P3-2 — Toolkit sidecars** (manifest + JIT load).
- **P3-3 — Multi-project tab polish** + Project Setup overrides UX.

---

## Gating

- Per-batch 7-check gate + Q0–Q7 evidence quality. Verifier ≠ fixer. Commit-landed-before-gate.
- Clean-checkout test gate uses `git stash` **NEVER `-u`** (N15).
- HIGH-risk batches: 3-agent (independent validator) + post-build red-team panel.
- Genuinely complex *design* decisions: deliberate + red-team BEFORE the implementing batch.
