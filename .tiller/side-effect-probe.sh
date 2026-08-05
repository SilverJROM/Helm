#!/usr/bin/env bash
# Tiller side-effect probe — Helm.
#
# Tiller's park rollback is `git reset --hard` plus an untracked sweep: a GIT boundary, not a system one.
# data/helm.db is GITIGNORED, so the rollback cannot see it even in principle. A slice that migrates the
# live DB and then parks leaves the schema ahead of the code — exactly what happened on B2 (2026-08-04:
# live 114, rolled-back code 113), and what data/backups/helm-pre-*.db has been hand-guarding against.
#
# Tiller samples this at slice entry and again after any park. If the value moved, the RAISE says so with
# both numbers instead of reporting a clean park. It NEVER tries to migrate back down.
#
# Read-only. Fast. One line. MUST be cwd-independent: this is compared against itself across a slice, so
# a value that changes with the caller's directory would read as drift that never happened.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # <repo>/.tiller/.. — never $PWD
DB="$REPO/data/helm.db"
if [ ! -r "$DB" ]; then printf 'schema_version=NO-DB(%s)\n' "$DB"; exit 0; fi
printf 'schema_version=%s\n' "$(sqlite3 "$DB" 'select version from schema_version' 2>/dev/null || echo unreadable)"
