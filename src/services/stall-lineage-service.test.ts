import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { computeLineageId, StallLineageService } from './stall-lineage-service.js';

describe('B01.s3 stall lineage service', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function tempDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b01-s3-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'helm-test.db');
  }

  it('fresh and v80-upgrade databases contain stall_lineages at the current schema version', () => {
    const dbPath = tempDbPath();
    const v81 = new DatabaseService(dbPath);
    expect(v81.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stall_lineages'").get()).toBeTruthy();
    v81.raw.exec('DROP TABLE stall_lineages');
    v81.raw.prepare('UPDATE schema_version SET version = 80').run();
    v81.close();
    const migrated = new DatabaseService(dbPath);
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stall_lineages'").get()).toBeTruthy();
    expect((migrated.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(SCHEMA_VERSION);
    migrated.close();
  });

  it('lineage hash is stable and changes with every identity input', () => {
    const input = { run_id: 'run-1', batch_id: 'B01.s3', scope_generation: 0, initial_signature: 'initial-class' };
    const id = computeLineageId(input);
    expect(computeLineageId(input)).toBe(id);
    expect(computeLineageId({ ...input, run_id: 'run-2' })).not.toBe(id);
    expect(computeLineageId({ ...input, batch_id: 'B01.s4' })).not.toBe(id);
    expect(computeLineageId({ ...input, scope_generation: 1 })).not.toBe(id);
    expect(computeLineageId({ ...input, initial_signature: 'other-class' })).not.toBe(id);
  });

  it('rejects embedded NUL identity values before delimiter serialization can collide', () => {
    const collisionLeft = { run_id: 'run\u0000batch', batch_id: 'B01.s3', scope_generation: 0, initial_signature: 'initial' };
    const collisionRight = { run_id: 'run', batch_id: 'batch\u0000B01.s3', scope_generation: 0, initial_signature: 'initial' };
    expect(() => computeLineageId(collisionLeft)).toThrow(/run_id must not contain NUL/i);
    expect(() => computeLineageId(collisionRight)).toThrow(/batch_id must not contain NUL/i);
    expect(() => computeLineageId({ ...collisionRight, batch_id: 'B01.s3', initial_signature: 'initial\u0000class' }))
      .toThrow(/initial_signature must not contain NUL/i);
  });

  it('rejects lone UTF-16 surrogates but accepts valid astral characters', () => {
    const base = { batch_id: 'B01.s3', scope_generation: 0, initial_signature: 'signature' };
    const left = { ...base, run_id: `run${String.fromCharCode(0xd800)}end` };
    const right = { ...base, run_id: `run${String.fromCharCode(0xdc00)}end` };
    expect(() => computeLineageId(left)).toThrow(/run_id must not contain unpaired UTF-16 surrogate/i);
    expect(() => computeLineageId(right)).toThrow(/run_id must not contain unpaired UTF-16 surrogate/i);
    expect(() => computeLineageId({ ...base, run_id: `run${String.fromCharCode(0xd800)}` }))
      .toThrow(/run_id must not contain unpaired UTF-16 surrogate/i);
    expect(() => computeLineageId({ ...base, run_id: String.fromCharCode(0xd800) }))
      .toThrow(/run_id must not contain unpaired UTF-16 surrogate/i);
    expect(() => computeLineageId({ ...base, run_id: 'run😀end' })).not.toThrow();
  });

  it('opens a lineage idempotently and appends later classes without changing its id', () => {
    const db = new DatabaseService(tempDbPath());
    const service = new StallLineageService(db);
    const input = { run_id: 'run-1', batch_id: 'B01.s3', scope_generation: 0, initial_signature: 'initial-class' };
    const first = service.openOrGetLineage(input);
    const second = service.openOrGetLineage(input);
    expect(second.stall_lineage_id).toBe(first.stall_lineage_id);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM stall_lineages').get()).toMatchObject({ count: 1 });
    const recorded = service.recordClass(first.stall_lineage_id, 'later-class');
    expect(recorded.stall_lineage_id).toBe(first.stall_lineage_id);
    expect(recorded.canonical_signature).toBe('initial-class');
    expect(recorded.class_history).toEqual(['initial-class', 'later-class']);
    expect(() => service.recordClass(first.stall_lineage_id, 'later\u0000class'))
      .toThrow(/signature must not contain NUL/i);
    db.close();
  });
});
