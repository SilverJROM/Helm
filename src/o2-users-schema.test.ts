import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';

function tempDb(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dbPath: path.join(dir, 'helm.db'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function insertUser(db: DatabaseService, telegramId: number, role: 'owner' | 'viewer', active = 1): void {
  db.raw.prepare('INSERT INTO users (telegram_id, role, active) VALUES (?, ?, ?)').run(telegramId, role, active);
}

describe('O2.1 native users schema v84', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('T1 fresh DB has the complete users contract and SQLite constraints', () => {
    const t = tempDb('helm-o21-fresh-'); cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const columns = db.raw.prepare('PRAGMA table_info(users)').all() as Array<{ name: string; notnull: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      'id', 'telegram_id', 'username', 'display_name', 'role', 'active', 'created_at', 'updated_at',
    ]);
    expect(columns.find((column) => column.name === 'telegram_id')?.notnull).toBe(1);
    expect(columns.find((column) => column.name === 'active')?.notnull).toBe(1);
    expect((db.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(SCHEMA_VERSION);
    expect((db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_one_active_owner'").get() as { name: string }).name).toBe('idx_users_one_active_owner');

    insertUser(db, 1001, 'owner');
    insertUser(db, 1002, 'owner', 0);
    insertUser(db, 1003, 'viewer');
    expect(() => insertUser(db, 1004, 'owner')).toThrow(/UNIQUE|constraint/i);
    expect(() => insertUser(db, 1001, 'viewer')).toThrow(/UNIQUE|constraint/i);
    expect(() => db.raw.prepare("INSERT INTO users (telegram_id, role) VALUES (?, 'admin')").run(1005)).toThrow(/CHECK|constraint/i);
    expect(() => db.raw.prepare("INSERT INTO users (telegram_id, active) VALUES (?, 2)").run(1006)).toThrow(/CHECK|constraint/i);
    db.close();
  });

  it('T2 upgrades v83 without changing project or run rows, then T3 reopens idempotently', () => {
    const t = tempDb('helm-o21-v83-'); cleanups.push(t.cleanup);
    const seeded = new DatabaseService(t.dbPath);
    seeded.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(17, 'O2 Project', '/tmp/o2-project');
    seeded.raw.prepare('INSERT INTO runs (id, project_id, batch_id) VALUES (?, ?, ?)').run(29, 17, 'o2-run');
    seeded.raw.exec('DROP INDEX idx_users_one_active_owner; DROP TABLE users;');
    seeded.raw.prepare('UPDATE schema_version SET version = 83').run();
    seeded.close();

    const migrated = new DatabaseService(t.dbPath);
    expect((migrated.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare('SELECT id, name, directory_name FROM projects WHERE id = 17').get())
      .toEqual({ id: 17, name: 'O2 Project', directory_name: 'o2-project' });
    expect(migrated.raw.prepare('SELECT id, project_id, batch_id FROM runs WHERE id = 29').get())
      .toEqual({ id: 29, project_id: 17, batch_id: 'o2-run' });
    insertUser(migrated, 2001, 'owner');
    migrated.close();

    const reopened = new DatabaseService(t.dbPath);
    expect((reopened.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(SCHEMA_VERSION);
    expect(reopened.raw.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
    expect(reopened.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    reopened.close();
  });
});
