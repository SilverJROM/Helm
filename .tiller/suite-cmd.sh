#!/usr/bin/env bash
# Tiller suite band — Helm. Run by the DRIVER after a validator PASS: the only check in the pipeline
# that is not somebody's self-report. Exit 0 = green.
#
# Fork cap and temp DB are load-bearing, not tidiness: uncapped vitest spawns one fork per core, and on
# this 16-core box browser/whisper tests hit ~3.5GB per fork, OOM the machine, and kill every tmux
# session — including live Tiller runs. The temp DB keeps the suite off data/helm.db.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1
HELM_DB_PATH="/tmp/helm-suite-$$.db" npx vitest run --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=4
rc=$?
rm -f "/tmp/helm-suite-$$.db"
exit $rc
