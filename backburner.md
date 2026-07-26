# Helm — Backburner (ideas to do later, on JROM's ask)

## 1. Native model-agnostic agent runtime (recreate the Claude/Codex/Grok "SDK" inside Helm)
**JROM's idea (2026-06-16):** build a native agent runtime so you can plug in any API access —
OpenRouter (OpenAI-compatible) or local Ollama — and that model functions like Claude on the Claude SDK:
it has a system prompt, knows the tool set, calls tools, and does its work autonomously. Instead of being
limited to the external claude/codex/grok CLIs driven over tmux.

**Why (value):**
- Breaks CLI/usage-limit lock-in — OpenRouter = many models, Ollama = local/free/unlimited; route cheap/
  local for routine, premium for hard. (Directly addresses the budget walls hit during the cards POC.)
- Architecturally cleaner + on north-star ("Helm conducts"): Helm runs the agentic loop natively (precise
  tool-call observation/logging) and could eventually REPLACE the brittle tmux/RealTransport/callback-file
  transport with a clean native loop.

**Scope (it's a real build — a mini agent-SDK):**
- Tool registry (read/write/edit/bash/etc.) reusing the existing helm-sandbox write-fence for tool exec.
- Per-provider tool-call protocol (OpenAI function-calling vs Anthropic tool-use format) + an execute→loop.
- Context/budget management, streaming, error handling, retries.
- A provider layer for OpenRouter + Ollama (API base + key) selectable in Agent Studio (the model/provider
  abstraction already exists in providers.ts/models — extend it).
- Same role model: a native-runtime agent can fill any role (projcore/implementer/validator/...).

**Caveats:** arbitrary/small models (esp. local Ollama) are much weaker at agentic *coding* — quality risk
for implementer/validator roles; premium models still best for hard work. Tool execution must stay fenced.

**Recommendation:** do this as its own major initiative AFTER the orchestration is proven (the Lucky-9 POC).
It can then be introduced as an alternative transport alongside (eventually replacing) the CLI/tmux path.

## 2. [FIX-NEEDED] Project Setup → Project agents shows NO agents for a live project (real-state reflection)
**JROM (2026-06-17, verbatim):** "i checked the cards project on helm and it does not have any agents assigned to it, this is bad as i want this to be as close to the real thing as possible. meaning if we are going live on this that agents are working on the project i should be able to see it here. as well as the other setup please add this to what needs to be fixed"

**Observed:** `helm.silverjrom.app/#05-setup-project-agents` → Project = "cards" → "No agents yet for this project — use Add all or + Add agent." Screenshot: `_issue-assets/2026-06-17-cards-no-agents.png`.

**The gap:** Project Setup → Project agents reflects only manually-configured team assignments, not the agents actually working/registered on the project at runtime. JROM expects: if a project is live and agents are working it (overmind has child_sessions registered against its run), that should be visible here — Helm should mirror the real state, not require manual team config to look populated.

**Scope to investigate:** (a) Project-agents view should surface the runtime/registered agents for the project (from overmind child_sessions/roles), not just static team config — or at least auto-seed the team from observed agents; (b) "as well as the other setup" — audit the other Project Setup tabs (Projects, Documents) + Agent Studio / Command Center / Memory for the same real-vs-configured mismatch.

**Priority:** JROM-flagged for the going-live bar (must look like the real thing). Type: bug/feature. Not yet scheduled.

---

## Helm engine — POC follow-ups (backlog, 2026-06-17, after the Lucky-9 POC succeeded)
The cards Lucky-9 POC SUCCEEDED (Helm orchestrated grok to build a playable, tested Lucky 9). These are the
loop-back items that surfaced. Run artifacts: /home/agjrom/TGBOTS/AGJAssist/Helm-build/engine-live-poc-2026-06-16/.

### P1 — Engine correctness (small, clear)
- [ ] **waitForVerdict per-dispatch cursor** (`src/services/panel-service.ts` ~line 158). Same bug class as
  POCFIX22 (orchestrator-loop): waitForVerdict scans the full callbacks.md, so red-team/panelist calls after
  task 1 match the STALE task-1 `VERDICT-READY CLEAN`. Advisory-only today (red-team is non-blocking per
  POCFIX21) so it didn't break the build — but it means red-team does NOT genuinely re-verify tasks 2..N.
  Fix: add `sinceOffset` param; snapshot callbacks.md size before each `transport.spawn` in
  `conveneRedTeamPanel`/`conveneDeliberationPanel`; `raw.slice(sinceOffset)` window. **Exact plan written in
  `grok-fix-panel/next-fix.md`.** (Mirror of POCFIX22.)

### P2 — Engine reliability
- [ ] **claude-projcore spawn flakiness.** Helm's claude spawn intermittently produces an empty pane / the
  brief never lands (~50%, sometimes 100%) → projcore never plans → dead run. Manual claude launch + grok
  spawn are 100% reliable, so it's a Helm spawn timing/race not yet root-caused by inspection (resisted
  POCFIX18 genuine-ready + POCFIX20 spawn-retry). WORKAROUND IN PLACE: projcore→grok-build (reliable). To
  restore claude/sonnet planning: add real logging inside `real-transport.spawn` around
  createSession→sendCommand(launch)→waitForClaudeComposerReady→dispatch and capture a failing spawn live.
  Candidate: race between createSession and the launch sendCommand; consider unique-per-run session names
  (vs the fixed `helm_cards`) + confirm the kill-then-new in idempotent createSession doesn't race.

### P3 — Engine hardening / quality (from the panel red-teams)
- [ ] **Deterministic test-gate runs `npm test` (unit) only** (POCFIX17). lucky9 e2e is under
  `npm run test:e2e` → wiring tasks (server/client) aren't truly gated by e2e. Option: gate also runs the
  project's e2e for wiring tasks, or make the gate command per-project (env HELM_PROJECT_TEST_CMD/ARGS exist).
- [ ] **emit-status.sh prefix** now writes `[helm callback]` (changed in POCFIX15). Parser accepts both, so
  low risk, but confirm no other consumers (/coord, codex-projcore proxy) relied on `[projcore callback]`;
  revert the helper prefix if so (keep the additive role/state widening).
- [ ] **Remove redundant `ensureClaudeTrust`** (POCFIX7) — `--dangerously-skip-permissions` (POCFIX19) already
  suppresses the trust dialog; the `~/.claude.json` mutation is now belt-and-suspenders.
- [ ] **POCFIX20 projcore spawn-retry** is moot while projcore=grok; keep for when claude-projcore returns.

### P4 — Product / feature
- [ ] Native model-agnostic agent runtime (section 1 above — OpenRouter/Ollama SDK).
- [ ] Lucky-9 polish (cosmetic): server startup log omits "lucky9"; no natural-9 bonus payout (confirm if a
  natural bonus was ever intended — current 1:1 matches the stated spec).

### One-time (time-sensitive, not backlog)
- Restarted-if-needed: I accidentally killed `hris-codex`, `hris-grokbuild`, `lkcamp-panel-sonnet` during
  cleanup (too-broad reap pattern) — restart those if they were mid-work.
