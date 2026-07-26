#!/usr/bin/env bash
# Repo-local stub implementing the same callback contract as
# ~/.claude/agents/lib/projcore-emit-status.sh (B8 test seam).
# Contract: append "[projcore callback] <role> <batch-id> STATUS: <state> — <note>" to PROJCORE_CALLBACKS_FILE.
set -euo pipefail
ROLE="${1:?role required}"
BATCH_ID="${2:?batch-id required}"
STATE="${3:?state required}"
NOTE="${4:-}"
CB="${PROJCORE_CALLBACKS_FILE:?PROJCORE_CALLBACKS_FILE must be set}"
printf '[projcore callback] %s %s STATUS: %s — %s\n' "$ROLE" "$BATCH_ID" "$STATE" "$NOTE" >> "$CB"
