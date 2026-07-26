cards2 harness — SANITIZED per-CLI auth material (READ-granted via HELM_STRICT_READ_ALLOW).

[wflow] MUST populate this dir before crossing, and it MUST contain AUTH MATERIAL ONLY —
no prior-session history, no transcripts, no cards/ material of any kind (the isolation AGREEMENT's
top risk = indirect leakage via provider session state).

Each roster CLI reads its auth from its own home/config dir; under the strict read profile the real
~/.claude, ~/.codex, ~/.grok trees are WRITE-ONLY (unreadable), so their auth must be provided here
and each CLI pointed at it (e.g. CLAUDE_CONFIG_DIR / CODEX_HOME / grok config-dir), or via a
sanitized HOME whose dot-dirs hold auth only. Prove each provider boots under strict via the
AGREEMENT's provider smoke matrix BEFORE any run counts.
