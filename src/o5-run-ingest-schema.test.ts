import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';

function tempDb(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dbPath: path.join(dir, 'helm.db'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function createV84Db(dbPath: string): void {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version VALUES (84);
CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  cycle_id INTEGER,
  batch_id TEXT,
  north_star_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  phase TEXT NOT NULL DEFAULT 'planning',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
INSERT INTO projects (id, name, directory) VALUES (1, 'Helm', '/work/helm');
INSERT INTO runs (id, project_id, batch_id, north_star_ref) VALUES (41, 1, 'O5', 'native-run');
`);
  db.close();
}

describe('O5.1 run ingest durability schema v85', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('T1 fresh DB exposes the v85 run and receipt contract', () => {
    const t = tempDb('helm-o51-fresh-'); cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const columns = new Set((dbs.raw.prepare('PRAGMA table_info(runs)').all() as any[]).map((column) => column.name));
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(98); // version-pin: at least v90 iBrain deletion era
    expect(columns).toEqual(expect.objectContaining(new Set([
      'external_run_id', 'generation', 'source', 'state_revision', 'register_seal_hash', 'terminal_seal_hash',
    ])));
    expect(dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_ingest_receipts'").get()).toEqual({ name: 'run_ingest_receipts' });
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    dbs.close();
  });

  it('T1 v84 upgrade preserves native runs, applies defaults, and reopens cleanly', () => {
    const t = tempDb('helm-o51-v84-'); cleanups.push(t.cleanup);
    createV84Db(t.dbPath);
    const dbs = new DatabaseService(t.dbPath);
    const row = dbs.raw.prepare('SELECT id, project_id, batch_id, external_run_id, generation, source, state_revision, register_seal_hash, terminal_seal_hash FROM runs').get() as any;
    expect(row).toMatchObject({
      id: 41, project_id: 1, batch_id: 'O5', external_run_id: null, source: 'native', state_revision: 0,
      register_seal_hash: null, terminal_seal_hash: null,
    });
    // B01/D01: native runs backfill to a fresh nonzero generation — this row is the exact F-09
    // shape (native run, generation was unconditionally 0 before B01 fixed the allocator).
    expect(row.generation).toBeGreaterThan(0);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    expect(dbs.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    dbs.close();
    const reopened = new DatabaseService(t.dbPath);
    expect(reopened.raw.prepare('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 1 });
    expect(reopened.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    reopened.close();
  });

  it('T2 permits one external run identity per project and generation', () => {
    const t = tempDb('helm-o51-identity-'); cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    dbs.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(1, 'Helm', '/work/helm');
    const insert = dbs.raw.prepare(`INSERT INTO runs (project_id, external_run_id, generation, source) VALUES (?, ?, ?, 'ingest')`);
    insert.run(1, '9715', 0);
    expect(() => insert.run(1, '9715', 0)).toThrow(/unique|constraint/i);
    insert.run(1, '9715', 1);
    expect(dbs.raw.prepare("SELECT COUNT(*) AS count FROM runs WHERE external_run_id = '9715'").get()).toEqual({ count: 2 });
    dbs.close();
  });

  it('T3 constrains duplicate receipt keys and makes receipts append-only across reopen', () => {
    const t = tempDb('helm-o51-receipts-'); cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    dbs.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(1, 'Helm', '/work/helm');
    dbs.raw.prepare("INSERT INTO runs (id, project_id, external_run_id, source) VALUES (1, 1, '9715', 'ingest')").run();
    const insert = dbs.raw.prepare('INSERT INTO run_ingest_receipts (run_id, event_id, semantic_key, payload_hash, response_json) VALUES (?, ?, ?, ?, ?)');
    insert.run(1, 'event-1', '9715:0:register', 'hash-1', '{"status":201}');
    expect(() => insert.run(1, 'event-1', '9715:0:complete', 'hash-2', '{}')).toThrow(/unique|constraint/i);
    expect(() => insert.run(1, 'event-2', '9715:0:register', 'hash-2', '{}')).toThrow(/unique|constraint/i);
    expect(() => dbs.raw.prepare("UPDATE run_ingest_receipts SET response_json = '{}' WHERE event_id = 'event-1'").run()).toThrow(/append-only/i);
    expect(() => dbs.raw.prepare("DELETE FROM run_ingest_receipts WHERE event_id = 'event-1'").run()).toThrow(/append-only/i);
    expect(() => dbs.raw.prepare("INSERT OR REPLACE INTO run_ingest_receipts (id, run_id, event_id, semantic_key, payload_hash, response_json) VALUES (1, 1, 'event-3', '9715:0:other', 'hash-3', '{}')").run()).toThrow(/append-only/i);
    dbs.close();
    const reopened = new DatabaseService(t.dbPath);
    expect(reopened.raw.prepare('SELECT event_id, semantic_key, payload_hash, response_json FROM run_ingest_receipts').get()).toEqual({
      event_id: 'event-1', semantic_key: '9715:0:register', payload_hash: 'hash-1', response_json: '{"status":201}',
    });
    expect(reopened.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    reopened.close();
  });
});
