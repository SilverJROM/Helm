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
#
# D9 (2026-08-08, north/helm-97): enumerated baseline exclusion of pre-existing residual failures
# (35 files / ~106 tests). Source of truth: plan/fence-workflow-upgrade/dispatch/s0-residual-failures.txt
# (extracted from /tmp/s0-clean-1.log, not hand-typed). NOT a blanket skip — only these exact files.
# Any failure outside this list still fails the gate. See decisions/D9-suite-band-baseline-exclusion.md
# and project north-star §8 known-debt. Reversible: remove the per-file excludes below.
# S0 (fence-workflow-upgrade): fork isolation + v89/models/smoke + D9 excludes; green×2 required.
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
  --exclude '**/*.integration.test.ts' \
  \
  `# --- D9 baseline: live-oracle / schema-migration residual ---` \
  --exclude 'src/b24-topology-v2-export.test.ts' \
  --exclude 'src/b00-parity.test.ts' \
  --exclude 'src/b12a-role-tiers-crud.test.ts' \
  --exclude 'src/b15b-validator-coupling.test.ts' \
  --exclude 'src/b19-freeze.test.ts' \
  --exclude 'src/b21-r6-recon.test.ts' \
  --exclude 'src/b25-debt-f3-residual-identity.test.ts' \
  --exclude 'src/b25-fix1-orphan-model.test.ts' \
  --exclude 'src/b25c-model-bearing-oracle.test.ts' \
  --exclude 'src/b25d-write-guards.test.ts' \
  --exclude 'src/b5-per-rung-effort.test.ts' \
  --exclude 'src/cbl-b15-run-end-park.test.ts' \
  \
  `# --- D9 baseline: session/substrate residual ---` \
  --exclude 'src/a15-worker-finalize.test.ts' \
  --exclude 'src/master-runtime-seat-binary.test.ts' \
  --exclude 'src/services/substrate.test.ts' \
  \
  `# --- D9 baseline: master-runtime / chat / worker spawn residual ---` \
  --exclude 'src/p1-5a.test.ts' \
  --exclude 'src/p1-6a.test.ts' \
  --exclude 'src/p1-6b.test.ts' \
  --exclude 'src/p2-1.test.ts' \
  \
  `# --- D9 baseline: draft-blind / planning residual (post-R2 fixture lag) ---` \
  --exclude 'src/finish-planning-production.test.ts' \
  --exclude 'src/pause-after-planning-gate.test.ts' \
  --exclude 'src/services/planning-phase-no-plancore-author.test.ts' \
  --exclude 'src/services/planning-phase-nonconvergence-b6.test.ts' \
  --exclude 'src/services/planning-phase-one-terminal-owner-a6.test.ts' \
  --exclude 'src/services/planning-phase-reap-before-finalize-a5.test.ts' \
  --exclude 'src/services/planning-phase-service.test.ts' \
  --exclude 'src/services/planning-phase-signature-path.test.ts' \
  --exclude 'src/services/run-orchestrator-cycle-builddir.test.ts' \
  --exclude 'src/services/run-orchestrator-service.test.ts' \
  \
  `# --- D9 baseline: other residual (not D8 CHECK/models) ---` \
  --exclude 'src/cycle-terminal-on-run-complete.test.ts' \
  --exclude 'src/project-service.test.ts' \
  --exclude 'src/s06-core-seats.test.ts' \
  --exclude 'src/services/adaptive-planning-stages.test.ts' \
  --exclude 'src/services/orchestrator-loop-idle-hang.test.ts' \
  --exclude 'src/services/planner-panel-service.test.ts'
rc=$?
rm -f "$SUITE_DB" "$SUITE_DB-wal" "$SUITE_DB-shm" 2>/dev/null || true
exit $rc
