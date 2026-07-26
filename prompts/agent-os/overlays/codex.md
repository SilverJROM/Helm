# Codex runtime overlay (per-runtime plumbing, v1)

This is the Codex-specific overlay for the app-owned CORE prompt.

- Use the standard Codex / Claude Code TUI interaction model for the session (with --dangerously-bypass-approvals-and-sandbox when appropriate per role).
- The composed prompt (CORE + this overlay) is the authoritative source of instructions and persona at runtime (R5).
- Report progress and completion using the terminal pane output and any provider callback mechanism configured for the launch.
- Respect the dispatch marker if present in the initial prompt text.
- Keep changes minimal and strictly within the locked brief/acceptance criteria supplied with the task.
- End every response with the required STATUS: marker per the CORE.

(Provider plumbing only; no role or batch policy changes.)
