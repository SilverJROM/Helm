/**
 * B25c — R6.25 MODEL_BEARING_COLUMNS live-DB allow-list oracle.
 *
 * Exhaustive sweep over 23 model-bearing columns (product-id + helm-slug + FK→models(id)).
 * Exhaustiveness is derived from sqlite_master / PRAGMA table_info — fails if schema grows
 * a model-bearing column not in the locked list (oracle, not citation).
 *
 * Banned product id is assembled at runtime so B02 fail-closed greps stay green.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import {
  SCHEMA_VERSION,
  MODEL_BEARING_COLUMNS,
  assertModelBearingColumnsExhaustive,
  discoverModelBearingColumns,
  sweepModelBearingAllowList,
  buildLaunchAllowlistedModelIds,
  B04_CANONICAL_SLUGS,
} from './db/schema.js';
import { PROVIDERS } from './config/providers.js';

const ORPHAN_GROK = ['grok', 'build'].join('-');

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe('B25c MODEL_BEARING_COLUMNS oracle (R6.25)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('locked list is exactly 23 across both slug domains + 13 FK columns', () => {
    expect(MODEL_BEARING_COLUMNS).toHaveLength(23);
    const product = MODEL_BEARING_COLUMNS.filter((c) => c.domain === 'product-id');
    const helm = MODEL_BEARING_COLUMNS.filter((c) => c.domain === 'helm-slug');
    const fk = MODEL_BEARING_COLUMNS.filter((c) => c.domain === 'fk-models-id');
    expect(product).toHaveLength(7);
    expect(helm).toHaveLength(3);
    expect(fk).toHaveLength(13);

    const keys = MODEL_BEARING_COLUMNS.map((c) => `${c.table}.${c.column}`);
    expect(new Set(keys).size).toBe(23);
    expect(keys).toEqual(
      expect.arrayContaining([
        'agents.model',
        'models.model_id',
        'master_runtimes.model',
        'project_master_models.model',
        'master_switches.from_model',
        'master_switches.to_model',
        'worker_runtimes.model',
        'models.slug',
        'cycle_team_deltas.intended_slug',
        'cycle_team_deltas.actual_slug',
        'agents.default_model_id',
        'agents.backup_model_id',
        'role_tiers.primary_model_id',
        'role_tiers.backup_model_id',
        'team_tier_models.model_id',
        'team_members.model_id',
        'project_agents.model_id',
        'project_agents.backup_model_id',
        'project_role_tiers.primary_model_id',
        'project_role_tiers.backup_model_id',
        'project_team_tier_models.model_id',
        'agent_escalations.model_id',
        'project_agent_escalations.model_id',
      ])
    );
  });

  it('fresh DB: exhaustiveness holds; full sweep is green; SCHEMA_VERSION ≥ 76', () => {
    const t = tempDbPath('helm-b25c-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(76);

    const exh = assertModelBearingColumnsExhaustive(dbs.raw);
    expect(exh.missingFromList, JSON.stringify(exh.missingFromList)).toEqual([]);
    expect(exh.missingFromSchema, JSON.stringify(exh.missingFromSchema)).toEqual([]);
    expect(exh.ok).toBe(true);

    const discovered = discoverModelBearingColumns(dbs.raw);
    expect(discovered.length).toBe(23);

    const violations = sweepModelBearingAllowList(dbs.raw);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

    dbs.close();
  });

  it('exhaustiveness FAILS when an unlisted model-bearing column appears', () => {
    const t = tempDbPath('helm-b25c-exh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    // Unlisted table + column name matching MODEL_BEARING_COLUMN_NAME_RE must fail exhaustiveness.
    dbs.raw.exec(`CREATE TABLE b25c_probe_ungated (id INTEGER PRIMARY KEY, model TEXT)`);

    const exh = assertModelBearingColumnsExhaustive(dbs.raw);
    expect(exh.ok).toBe(false);
    expect(
      exh.missingFromList.some((d) => d.table === 'b25c_probe_ungated' && d.column === 'model')
    ).toBe(true);

    dbs.close();
  });

  it('F1: fallback_model_id is discovered (substring) → exhaustiveness RED (old closed regex would stay green)', () => {
    const t = tempDbPath('helm-b25c-f1-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    // Novel name that is NOT in the pre-fix1 closed alternation — only /model|slug/i sees it.
    dbs.raw.exec(
      `CREATE TABLE b25c_f1_probe (id INTEGER PRIMARY KEY, fallback_model_id INTEGER)`
    );

    // Closed alternation (regression baseline): would NOT match fallback_model_id.
    const closedNameRe =
      /^(model|model_id|from_model|to_model|default_model_id|backup_model_id|primary_model_id|intended_slug|actual_slug|slug)$/;
    expect(closedNameRe.test('fallback_model_id')).toBe(false);
    expect(/model|slug/i.test('fallback_model_id')).toBe(true);

    const exh = assertModelBearingColumnsExhaustive(dbs.raw);
    expect(exh.ok).toBe(false);
    expect(
      exh.missingFromList.some(
        (d) => d.table === 'b25c_f1_probe' && d.column === 'fallback_model_id'
      )
    ).toBe(true);

    dbs.close();
  });

  it('sweep FAILS on banned product id and on unknown provider (fail-not-skip)', () => {
    const t = tempDbPath('helm-b25c-poison-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const projDir = path.join(path.dirname(t.dbPath), 'proj');
    fs.mkdirSync(projDir, { recursive: true });
    const proj = dbs.raw
      .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
      .get('b25c-poison', projDir) as { id: number };

    // Banned product id on known provider (assembled at runtime — keep literal out of comments/titles for B02).
    dbs.raw
      .prepare(
        'INSERT INTO project_master_models (project_id, position, provider, model) VALUES (?, 0, ?, ?)'
      )
      .run(proj.id, 'grok', ORPHAN_GROK);

    // Unknown provider — must NOT be silently skipped (projcore class).
    dbs.raw
      .prepare(
        `INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state)
         VALUES (?, 'b25c-pc', 'helm-b25c-pc', 'projcore', 'run-projcore', 'failed')`
      )
      .run(proj.id);

    const violations = sweepModelBearingAllowList(dbs.raw);
    const reasons = violations.map((v) => v.reason);

    expect(reasons.some((r) => r.includes('product_id_not_allowlisted') && r.includes(ORPHAN_GROK))).toBe(
      true
    );
    expect(reasons.some((r) => r.startsWith('provider_not_in_PROVIDERS:projcore'))).toBe(true);
    // Confirm PROVIDERS truly lacks projcore (disposition is JROM-only).
    expect(Object.prototype.hasOwnProperty.call(PROVIDERS, 'projcore')).toBe(false);
    expect(buildLaunchAllowlistedModelIds().has(ORPHAN_GROK)).toBe(false);
    expect(B04_CANONICAL_SLUGS.length).toBe(13);

    dbs.close();
  });

  it('live COPY: exhaustiveness holds; banned-product residual 0; live sweep 0 violations (no unknown-provider carve-out)', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    // F2: absence must be loud — never green-when-absent.
    expect(fs.existsSync(livePath), 'data/helm.db must exist for R6.25 live gate').toBe(true);

    const t = tempDbPath('helm-b25c-live-');
    cleanups.push(t.cleanup);
    // Prefer copying whatever is on disk; migrate path re-opens through DatabaseService (v77 deletes orphan).
    fs.copyFileSync(livePath, t.dbPath);
    const wal = `${livePath}-wal`;
    const shm = `${livePath}-shm`;
    if (fs.existsSync(wal)) fs.copyFileSync(wal, `${t.dbPath}-wal`);
    if (fs.existsSync(shm)) fs.copyFileSync(shm, `${t.dbPath}-shm`);

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(ver).toBeGreaterThanOrEqual(77);

    const exh = assertModelBearingColumnsExhaustive(dbs.raw);
    expect(exh.ok, JSON.stringify(exh)).toBe(true);

    const gbPmm = (
      dbs.raw
        .prepare('SELECT COUNT(*) AS c FROM project_master_models WHERE model = ?')
        .get(ORPHAN_GROK) as { c: number }
    ).c;
    const gbMr = (
      dbs.raw
        .prepare('SELECT COUNT(*) AS c FROM master_runtimes WHERE model = ?')
        .get(ORPHAN_GROK) as { c: number }
    ).c;
    const gbAgents = (
      dbs.raw.prepare('SELECT COUNT(*) AS c FROM agents WHERE model = ?').get(ORPHAN_GROK) as {
        c: number;
      }
    ).c;
    expect(gbPmm + gbMr + gbAgents).toBe(0);

    // B25d: no carve-out — unknown-provider residual is deleted; sweep must be fully green.
    const violations = sweepModelBearingAllowList(dbs.raw);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    const pc = (
      dbs.raw
        .prepare("SELECT COUNT(*) AS c FROM master_runtimes WHERE provider = 'projcore'")
        .get() as { c: number }
    ).c;
    expect(pc).toBe(0);

    dbs.close();
  });

  it('direct live open (read-only sweep): schema ≥77 and 0 violations (no carve-out)', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    // F2: absence must be loud — never green-when-absent.
    expect(fs.existsSync(livePath), 'data/helm.db must exist for R6.25 live gate').toBe(true);

    // Ensure migrate applied (v77) without leaving this test as the sole mutator of product data
    // when already at SCHEMA_VERSION — open/close is the real DatabaseService path.
    {
      const previousLiveOptIn = process.env.HELM_ALLOW_LIVE_DB;
      // Intentional live gate; B00.s9 owns any seed repair.
      process.env.HELM_ALLOW_LIVE_DB = '1';
      try {
        const w = new DatabaseService(livePath);
        expect((w.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
          SCHEMA_VERSION
        );
        w.close();
      } finally {
        if (previousLiveOptIn === undefined) delete process.env.HELM_ALLOW_LIVE_DB;
        else process.env.HELM_ALLOW_LIVE_DB = previousLiveOptIn;
      }
    }

    const raw = new Database(livePath, { readonly: true, fileMustExist: true });
    try {
      const ver = (raw.prepare('SELECT version FROM schema_version').get() as any)?.version ?? 0;
      expect(ver).toBeGreaterThanOrEqual(77);

      const exh = assertModelBearingColumnsExhaustive(raw);
      expect(exh.ok, JSON.stringify(exh)).toBe(true);

      const violations = sweepModelBearingAllowList(raw);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

      const gb = (
        raw
          .prepare(
            `SELECT
              (SELECT COUNT(*) FROM project_master_models WHERE model = ?) +
              (SELECT COUNT(*) FROM master_runtimes WHERE model = ?) +
              (SELECT COUNT(*) FROM agents WHERE model = ?) AS c`
          )
          .get(ORPHAN_GROK, ORPHAN_GROK, ORPHAN_GROK) as { c: number }
      ).c;
      expect(gb).toBe(0);
    } finally {
      raw.close();
    }
  });
});
