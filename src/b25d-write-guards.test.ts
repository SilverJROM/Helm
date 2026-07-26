/**
 * B25d — delete unknown-provider master_runtimes (v77) + write-time fail-closed guards + live oracle green.
 * Authority: decisions/2026-07-10-projcore-orphan-row-disposition.md
 * Never registers provider projcore. Never carves unknown providers out of the sweep.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import {
  SCHEMA_VERSION,
  applyB25dDeleteUnknownProviderMasterRuntimes,
  assertMasterWriteAllowed,
  sweepModelBearingAllowList,
  assertModelBearingColumnsExhaustive,
} from './db/schema.js';
import { PROVIDERS } from './config/providers.js';
import { MasterModelService } from './services/master-model-service.js';

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

describe('B25d delete unknown-provider master_runtimes + write-time guards', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('SCHEMA_VERSION ≥77; PROVIDERS has no projcore key', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(77);
    expect(Object.prototype.hasOwnProperty.call(PROVIDERS, 'projcore')).toBe(false);
  });

  it('applyB25dDeleteUnknownProviderMasterRuntimes deletes unknown-provider rows; idempotent', () => {
    const t = tempDbPath('helm-b25d-del-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const projDir = path.join(path.dirname(t.dbPath), 'p');
    fs.mkdirSync(projDir, { recursive: true });
    const p1 = dbs.raw
      .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
      .get('b25d-legal', projDir) as { id: number };
    const p2 = dbs.raw
      .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
      .get('b25d-orphan', projDir + '2') as { id: number };

    dbs.raw
      .prepare(
        `INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state)
         VALUES (?, 'legal', 'helm-legal', 'grok', 'grok-4.5', 'running')`
      )
      .run(p1.id);
    dbs.raw
      .prepare(
        `INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state)
         VALUES (?, 'orphan', 'helm-orphan', 'projcore', 'run-projcore', 'failed')`
      )
      .run(p2.id);

    const before = dbs.raw
      .prepare('SELECT project_id, provider, model, state FROM master_runtimes ORDER BY project_id')
      .all();
    expect(before).toHaveLength(2);

    const counts = applyB25dDeleteUnknownProviderMasterRuntimes(dbs.raw);
    expect(counts.deleted).toBe(1);
    expect(counts.deleted_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          project_id: p2.id,
          provider: 'projcore',
          model: 'run-projcore',
          state: 'failed',
        }),
      ])
    );

    const after = dbs.raw
      .prepare('SELECT project_id, provider, model, state FROM master_runtimes ORDER BY project_id')
      .all() as Array<{ provider: string }>;
    expect(after).toHaveLength(1);
    expect(after[0].provider).toBe('grok');

    const again = applyB25dDeleteUnknownProviderMasterRuntimes(dbs.raw);
    expect(again.deleted).toBe(0);

    dbs.close();
  });

  it('v76→77 migrate path deletes unknown-provider master_runtimes', () => {
    const t = tempDbPath('helm-b25d-mig-');
    cleanups.push(t.cleanup);

    // Seed a pre-v77 DB shape: open service, plant orphan, rewind version to 76, re-open.
    process.env.HELM_DB_PATH = t.dbPath;
    let dbs = new DatabaseService(t.dbPath);
    const projDir = path.join(path.dirname(t.dbPath), 'mig');
    fs.mkdirSync(projDir, { recursive: true });
    const p = dbs.raw
      .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
      .get('b25d-mig', projDir) as { id: number };
    dbs.raw
      .prepare(
        `INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state)
         VALUES (?, 'pc', 'helm-pc', 'projcore', 'run-projcore', 'failed')`
      )
      .run(p.id);
    dbs.raw.prepare('UPDATE schema_version SET version = 76').run();
    dbs.close();

    dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(77);
    const left = (
      dbs.raw
        .prepare("SELECT COUNT(*) AS c FROM master_runtimes WHERE provider = 'projcore'")
        .get() as { c: number }
    ).c;
    expect(left).toBe(0);
    dbs.close();
  });

  it('assertMasterWriteAllowed + setChain reject unknown provider fail-closed', () => {
    expect(() => assertMasterWriteAllowed('projcore', 'run-projcore')).toThrow(
      /unknown provider \(not in PROVIDERS\): projcore/
    );
    expect(() => assertMasterWriteAllowed('grok', 'not-a-real-model')).toThrow(
      /unknown \{provider,model\}/
    );
    expect(() => assertMasterWriteAllowed('grok', 'grok-4.5')).not.toThrow();

    const t = tempDbPath('helm-b25d-setchain-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    const projDir = path.join(path.dirname(t.dbPath), 'sc');
    fs.mkdirSync(projDir, { recursive: true });
    const p = dbs.raw
      .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
      .get('b25d-sc', projDir) as { id: number };

    const svc = new MasterModelService(dbs);
    expect(() =>
      svc.setChain(p.id, [{ provider: 'projcore', model: 'run-projcore' }])
    ).toThrow(/unknown provider \(not in PROVIDERS\): projcore/);
    // Legal write still works
    svc.setChain(p.id, [{ provider: 'grok', model: 'grok-4.5' }]);
    const chain = svc.getChain(p.id);
    expect(chain).toEqual([{ position: 0, provider: 'grok', model: 'grok-4.5' }]);
    dbs.close();
  });

  it('COPY: insert bad-provider row → sweep RED (fail-not-skip oracle proof)', () => {
    const t = tempDbPath('helm-b25d-copy-red-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    // Fresh should be green
    expect(sweepModelBearingAllowList(dbs.raw)).toEqual([]);

    const projDir = path.join(path.dirname(t.dbPath), 'red');
    fs.mkdirSync(projDir, { recursive: true });
    const p = dbs.raw
      .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
      .get('b25d-red', projDir) as { id: number };

    // Bypass service — raw insert simulates data-layer poison (what the oracle must catch).
    dbs.raw
      .prepare(
        `INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state)
         VALUES (?, 'bad', 'helm-bad', 'not-a-provider', 'not-a-model', 'failed')`
      )
      .run(p.id);

    const violations = sweepModelBearingAllowList(dbs.raw);
    expect(violations.length).toBeGreaterThan(0);
    expect(
      violations.some((v) => v.reason.startsWith('provider_not_in_PROVIDERS:not-a-provider'))
    ).toBe(true);

    dbs.close();
  });

  it('live DB after migrate: schema ≥77, no projcore row, sweep 0 violations', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    // F2: absence must be loud — never green-when-absent.
    expect(fs.existsSync(livePath), 'data/helm.db must exist for R6.25 live gate').toBe(true);

    const t = tempDbPath('helm-b25d-live-');
    cleanups.push(t.cleanup);
    fs.copyFileSync(livePath, t.dbPath);
    const wal = `${livePath}-wal`;
    const shm = `${livePath}-shm`;
    if (fs.existsSync(wal)) fs.copyFileSync(wal, `${t.dbPath}-wal`);
    if (fs.existsSync(shm)) fs.copyFileSync(shm, `${t.dbPath}-shm`);

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBeGreaterThanOrEqual(77);
    expect(ver).toBe(SCHEMA_VERSION);

    const exh = assertModelBearingColumnsExhaustive(dbs.raw);
    expect(exh.ok, JSON.stringify(exh)).toBe(true);

    const pc = (
      dbs.raw
        .prepare("SELECT COUNT(*) AS c FROM master_runtimes WHERE provider = 'projcore'")
        .get() as { c: number }
    ).c;
    expect(pc).toBe(0);

    const violations = sweepModelBearingAllowList(dbs.raw);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);

    dbs.close();
  });

  it('direct live open (read-only): 0 violations after v77', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    // F2: absence must be loud — never green-when-absent.
    expect(fs.existsSync(livePath), 'data/helm.db must exist for R6.25 live gate').toBe(true);

    // Apply migrate first via a short-lived write open if still on 76 — production path.
    // Test itself re-opens read-only for the sweep assertion after ensuring migrate.
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
      const ver = (raw.prepare('SELECT version FROM schema_version').get() as any).version;
      expect(ver).toBeGreaterThanOrEqual(77);
      const pc = (
        raw.prepare("SELECT COUNT(*) AS c FROM master_runtimes WHERE provider = 'projcore'").get() as {
          c: number;
        }
      ).c;
      expect(pc).toBe(0);
      const violations = sweepModelBearingAllowList(raw);
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
      const rows = raw
        .prepare('SELECT project_id, provider, model, state FROM master_runtimes ORDER BY project_id')
        .all();
      // No unknown providers remain
      for (const r of rows as Array<{ provider: string }>) {
        expect(Object.prototype.hasOwnProperty.call(PROVIDERS, r.provider)).toBe(true);
      }
    } finally {
      raw.close();
    }
  });
});
