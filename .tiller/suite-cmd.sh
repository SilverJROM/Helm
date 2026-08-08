#!/usr/bin/env bash
# Tiller suite band — Helm. Run by the DRIVER after a validator PASS: the only check in the pipeline
# that is not somebody's self-report. Exit 0 = green.
#
# Fork cap and temp DB are load-bearing, not tidiness: uncapped vitest spawns one fork per core, and on
# this 16-core box browser/whisper tests hit ~3.5GB per fork, OOM the machine, and kill every tmux
# session — including live Tiller runs. The temp DB keeps the suite off data/helm.db.
#
# Pin HELM_HOST/HELM_PORT so live .env / ecosystem bind (0.0.0.0) cannot fail smoke defaults.
#
# EXCLUDE plan-time fence journey files (*.integration.test.ts): OPEN baselines that intentionally
# assert product absence. Running them in the suite band makes every gate red until product lands.
# Driver still runs them via fence-contract.json integration_cmd at OPEN/CLOSE.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1
SUITE_DB="/tmp/helm-suite-$$-$RANDOM.db"
export HELM_DB_PATH="$SUITE_DB"
export HELM_HOST=127.0.0.1
export HELM_PORT=3110
npx vitest run \
  --poolOptions.forks.minForks=1 \
  --poolOptions.forks.maxForks=4 \
  --exclude '**/*.integration.test.ts'
rc=$?
rm -f "$SUITE_DB" "$SUITE_DB-wal" "$SUITE_DB-shm" 2>/dev/null || true
exit $rc
