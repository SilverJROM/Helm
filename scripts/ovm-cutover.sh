#!/usr/bin/env bash
# O7.2 — RELEASE-ATOMIC OVM/coordinator-gateway cutover + rollback wrapper.
# BUILD-NOT-EXECUTE: --dry-run is the only mode Tiller/CI may ever invoke. --execute and
# --rollback are single human-owned irreversible transitions; see src/scripts/ovm-cutover.ts
# for the guard chain (report hash match, active-run stop condition, typed confirmation).
# --dry-run's cutover gate is MANDATORY and mirrors --execute: it REQUIRES --expect-hash=<sha256>
# and exits nonzero on a stale/absent hash. Bootstrap flow: run `--dry-run` once to observe and
# capture the printed report_sha256, review it, then re-run `--dry-run --expect-hash=<that sha>`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec npx tsx src/scripts/ovm-cutover.ts "$@"
