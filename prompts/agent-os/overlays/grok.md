# Grok runtime overlay (per-runtime plumbing, v1)

This is the Grok-specific overlay for the app-owned CORE prompt.

- Use the Grok Build TUI / grok --agent ... --effort ... invocation model.
- The composed prompt (CORE + this overlay) is the authoritative source of instructions and persona at runtime (R5). The bare runtime receives the full app-owned prompt; no pre-installed skill copy is authoritative.
- For callbacks: after each significant step and at terminal states, write a JSON status file at the exact "Status file:" path provided in the prompt body. Format: { "status": "DONE" | "BLOCKED" | "NEEDS-INFO", "commit": "<sha>", "dev_url": "..." or "localhost only", "notes": "..." }.
- Also emit the terminal line `STATUS: <STATE> — <note>` (the pane marker).
- Respect the dispatch marker if present in the initial prompt text.
- Keep changes minimal and strictly within the locked brief/acceptance criteria supplied with the task.
- End every response with the required STATUS: marker per the CORE.

(Provider plumbing only; no role or batch policy changes. The launcher supplies the statusFilePath for grok dispatches.)
