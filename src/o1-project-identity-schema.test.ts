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

function createV82Projects(dbPath: string, rows: Array<[number, string, string]>, writableDirectoryName = false): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version VALUES (82);
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      directory TEXT NOT NULL${writableDirectoryName ? ',\n      directory_name TEXT NOT NULL' : ''}
    );
  `);
  const insert = writableDirectoryName
    ? db.prepare('INSERT INTO projects (id, name, directory, directory_name) VALUES (?, ?, ?, ?)')
    : db.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)');
  for (const [id, name, directory] of rows) {
    writableDirectoryName ? insert.run(id, name, directory, `old-${id}`) : insert.run(id, name, directory);
  }
  db.close();
}

describe('O1.1 project identity schema v83', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('T1 fresh DB derives and indexes directory_name', () => {
    const t = tempDb('helm-o11-fresh-'); cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?)').run('Cards', '/work/cards/');
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    expect(dbs.raw.prepare('SELECT directory_name, status, active FROM projects').get()).toEqual({ directory_name: 'cards', status: 'active', active: 1 });
    expect((dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_directory_name'").get() as any).name).toBe('idx_projects_directory_name');
    expect((dbs.raw.prepare('PRAGMA table_xinfo(projects)').all() as any[]).find((c) => c.name === 'directory_name').hidden).toBe(2);
    dbs.close();
  });

  it('T2 upgrades valid v82 projects while preserving rows and T5 reopens idempotently', () => {
    const t = tempDb('helm-o11-v82-'); cleanups.push(t.cleanup);
    createV82Projects(t.dbPath, [[7, 'Cards', '/work/cards'], [8, 'Helm', '/work/Helm-ovm-run/']]);
    const dbs = new DatabaseService(t.dbPath);
    expect(dbs.raw.prepare('SELECT id, name, directory, directory_name FROM projects ORDER BY id').all()).toEqual([
      { id: 7, name: 'Cards', directory: '/work/cards', directory_name: 'cards' },
      { id: 8, name: 'Helm', directory: '/work/Helm-ovm-run/', directory_name: 'Helm-ovm-run' },
    ]);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    expect(dbs.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    dbs.close();
    const reopened = new DatabaseService(t.dbPath);
    expect((reopened.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    expect(reopened.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    reopened.close();
  });

  it.each([
    ['T3 collision', [[1, 'One', '/a/cards'], [2, 'Two', '/b/cards']]],
    ['T4 invalid basename', [[1, 'Bad', '/a/bad name']]],
  ])('%s rolls back v83 with version unchanged', (_name, rows) => {
    const t = tempDb('helm-o11-reject-'); cleanups.push(t.cleanup);
    createV82Projects(t.dbPath, rows as Array<[number, string, string]>);
    expect(() => new DatabaseService(t.dbPath)).toThrow();
    const raw = new Database(t.dbPath);
    expect((raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(82);
    expect((raw.prepare('PRAGMA table_xinfo(projects)').all() as any[]).map((c) => c.name)).not.toContain('directory_name');
    raw.close();
  });

  it.each([60, 61])('T6 projects-less v%s snapshot still reaches v83', (version) => {
    const t = tempDb('helm-o11-projectless-'); cleanups.push(t.cleanup);
    const old = new Database(t.dbPath);
    old.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (${version});`);
    old.close();
    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    expect(dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()).toBeUndefined();
    dbs.close();
  });

  it('T7 rejects an unexpected writable directory_name and leaves v82 intact', () => {
    const t = tempDb('helm-o11-writable-'); cleanups.push(t.cleanup);
    createV82Projects(t.dbPath, [[1, 'Cards', '/work/cards']], true);
    expect(() => new DatabaseService(t.dbPath)).toThrow(/writable directory_name/);
    const raw = new Database(t.dbPath);
    expect((raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(82);
    expect((raw.prepare('PRAGMA table_xinfo(projects)').all() as any[]).find((c) => c.name === 'directory_name').hidden).toBe(0);
    raw.close();
  });
});
