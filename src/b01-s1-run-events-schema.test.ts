import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';

function expectAppendOnly(db: DatabaseService): void {
  const inserted = db.raw.prepare(
    "INSERT INTO run_events (run_id, batch_id, event_type, payload_json) VALUES (?, ?, ?, ?) RETURNING id"
  ).get('run-b01-s1', null, 'CREATED', '{"source":"test"}') as { id: number };
  const eventId = inserted.id;
  expect(() => db.raw.prepare(
    'INSERT OR REPLACE INTO run_events (id, run_id, batch_id, event_type, payload_json) VALUES (?, ?, ?, ?, ?)'
  ).run(eventId, 'run-b01-s1', null, 'REPLACED', '{"source":"replace"}'))
    .toThrow(/run events are append-only/i);
  expect(() => db.raw.prepare('UPDATE run_events SET event_type = ? WHERE id = ?').run('MUTATED', eventId))
    .toThrow(/run events are append-only/i);
  expect(() => db.raw.prepare('DELETE FROM run_events WHERE id = ?').run(eventId))
    .toThrow(/run events are append-only/i);
  expect(db.raw.prepare('SELECT event_type, payload_json FROM run_events WHERE id = ?').get(eventId))
    .toMatchObject({ event_type: 'CREATED', payload_json: '{"source":"test"}' });
}

describe('B01.s1 run_events schema migration', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function tempDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b01-s1-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'helm-test.db');
  }

  it('fresh DB has the append-only run_events contract at the current schema version', () => {
    const db = new DatabaseService(tempDbPath());
    const columns = db.raw.prepare('PRAGMA table_info(run_events)').all() as Array<{ name: string; notnull: number }>;
    expect(columns.map((column) => column.name)).toEqual([
      'id', 'run_id', 'batch_id', 'event_type', 'payload_json', 'created_at',
    ]);
    expect(columns.find((column) => column.name === 'run_id')?.notnull).toBe(1);
    expect(columns.find((column) => column.name === 'batch_id')?.notnull).toBe(0);
    expect((db.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version)
      .toBe(SCHEMA_VERSION);
    expectAppendOnly(db);
    db.close();
  });

  it('migrates a v78 database without clobbering existing rows', () => {
    const dbPath = tempDbPath();
    const seeded = new DatabaseService(dbPath);
    seeded.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?)').run('b01-s1-preserved', '/tmp/b01-s1');
    seeded.raw.exec('DROP TABLE run_events');
    seeded.raw.prepare('UPDATE schema_version SET version = 78').run();
    seeded.close();

    const migrated = new DatabaseService(dbPath);
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_events'").get())
      .toBeTruthy();
    expect((migrated.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version)
      .toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare('SELECT directory FROM projects WHERE name = ?').get('b01-s1-preserved'))
      .toMatchObject({ directory: '/tmp/b01-s1' });
    expectAppendOnly(migrated);
    migrated.close();
  });

  it('heals an already-v79 database missing append-only triggers', () => {
    const dbPath = tempDbPath();
    const v79 = new DatabaseService(dbPath);
    v79.raw.exec(`
DROP TRIGGER run_events_no_replace;
DROP TRIGGER run_events_no_update;
DROP TRIGGER run_events_no_delete;
`);
    v79.raw.prepare('UPDATE schema_version SET version = 79').run();
    v79.close();

    const healed = new DatabaseService(dbPath);
    const triggers = healed.raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'run_events' ORDER BY name"
    ).all() as Array<{ name: string }>;
    expect(triggers.map((trigger) => trigger.name)).toEqual([
      'run_events_no_delete', 'run_events_no_replace', 'run_events_no_update',
    ]);
    expect((healed.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version)
      .toBe(SCHEMA_VERSION);
    expectAppendOnly(healed);
    healed.close();
  });
});
