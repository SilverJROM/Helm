/**
 * DEBT-F3 — exact-tuple residual identity (not reason substring).
 * Historical orphan: master_runtimes / projcore / run-projcore (JROM deleted via v77).
 * Proves isHistoricalProjcoreOrphanResidual never matches on reason text alone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import {
  isHistoricalProjcoreOrphanResidual,
  sweepModelBearingAllowList,
  type ModelBearingViolation,
} from './db/schema.js';

function synth(
  partial: Partial<ModelBearingViolation> &
    Pick<ModelBearingViolation, 'table' | 'provider' | 'value' | 'reason'>
): ModelBearingViolation {
  return {
    column: partial.column ?? 'model',
    domain: partial.domain ?? 'product-id',
    row: partial.row ?? {},
    ...partial,
  };
}

describe('DEBT-F3 exact-tuple residual identity', () => {
  it('positive: exact master_runtimes/projcore/run-projcore matches regardless of reason text', () => {
    expect(
      isHistoricalProjcoreOrphanResidual(
        synth({
          table: 'master_runtimes',
          provider: 'projcore',
          value: 'run-projcore',
          reason: 'provider_not_in_PROVIDERS:projcore',
        })
      )
    ).toBe(true);
    // reason ignored entirely
    expect(
      isHistoricalProjcoreOrphanResidual(
        synth({
          table: 'master_runtimes',
          provider: 'projcore',
          value: 'run-projcore',
          reason: 'unrelated-reason-with-no-special-token',
        })
      )
    ).toBe(true);
  });

  it('negative: reason/model substring projcore alone is NOT the residual', () => {
    // Classic disease: reason.includes('projcore') would wrongly match these.
    expect(
      isHistoricalProjcoreOrphanResidual(
        synth({
          table: 'agents',
          column: 'model',
          provider: 'grok',
          value: 'projcore-foo',
          reason: 'product_id_not_allowlisted:projcore-foo',
        })
      )
    ).toBe(false);

    expect(
      isHistoricalProjcoreOrphanResidual(
        synth({
          table: 'master_runtimes',
          provider: 'projcore',
          value: 'something-else',
          reason: 'provider_not_in_PROVIDERS:projcore',
        })
      )
    ).toBe(false);

    expect(
      isHistoricalProjcoreOrphanResidual(
        synth({
          table: 'project_master_models',
          provider: 'projcore',
          value: 'run-projcore',
          reason: 'provider_not_in_PROVIDERS:projcore',
        })
      )
    ).toBe(false);

    expect(
      isHistoricalProjcoreOrphanResidual(
        synth({
          table: 'master_runtimes',
          provider: 'grok',
          value: 'run-projcore',
          reason: 'product_id_not_allowlisted:run-projcore',
        })
      )
    ).toBe(false);
  });

  it('live: 0 exact-tuple rows, sweep 0 violations, residual helper matches nothing', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    // F2: absence must be loud
    expect(fs.existsSync(livePath), 'data/helm.db must exist for R6.25 live gate').toBe(true);

    // Ensure migrate applied, then read-only sweep
    {
      const previousLiveOptIn = process.env.HELM_ALLOW_LIVE_DB;
      // Intentional live gate; B00.s9 owns any seed repair.
      process.env.HELM_ALLOW_LIVE_DB = '1';
      try {
        const w = new DatabaseService(livePath);
        w.close();
      } finally {
        if (previousLiveOptIn === undefined) delete process.env.HELM_ALLOW_LIVE_DB;
        else process.env.HELM_ALLOW_LIVE_DB = previousLiveOptIn;
      }
    }

    const raw = new Database(livePath, { readonly: true, fileMustExist: true });
    try {
      const orphanCount = (
        raw
          .prepare(
            `SELECT COUNT(*) AS c FROM master_runtimes
             WHERE provider = 'projcore' AND model = 'run-projcore'`
          )
          .get() as { c: number }
      ).c;
      expect(orphanCount).toBe(0);

      const violations = sweepModelBearingAllowList(raw);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
      expect(violations.filter(isHistoricalProjcoreOrphanResidual)).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('live COPY migrate: same green property (0 tuple, 0 violations)', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    expect(fs.existsSync(livePath), 'data/helm.db must exist for R6.25 live gate').toBe(true);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-debt-f3-'));
    const copyPath = path.join(dir, 'helm-copy.db');
    try {
      fs.copyFileSync(livePath, copyPath);
      const wal = `${livePath}-wal`;
      const shm = `${livePath}-shm`;
      if (fs.existsSync(wal)) fs.copyFileSync(wal, `${copyPath}-wal`);
      if (fs.existsSync(shm)) fs.copyFileSync(shm, `${copyPath}-shm`);

      const dbs = new DatabaseService(copyPath);
      const orphanCount = (
        dbs.raw
          .prepare(
            `SELECT COUNT(*) AS c FROM master_runtimes
             WHERE provider = 'projcore' AND model = 'run-projcore'`
          )
          .get() as { c: number }
      ).c;
      expect(orphanCount).toBe(0);
      const violations = sweepModelBearingAllowList(dbs.raw);
      expect(violations).toEqual([]);
      expect(violations.some(isHistoricalProjcoreOrphanResidual)).toBe(false);
      dbs.close();
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
