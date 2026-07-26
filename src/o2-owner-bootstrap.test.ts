import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapNativeOwner, NATIVE_OWNER_ID } from './auth/owner-bootstrap.js';
import { DatabaseService } from './db/database.js';

const OWNER_TELEGRAM_ID = 5294055107;

function tempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o22-'));
  return { dbPath: path.join(dir, 'helm.db'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('O2.2 native owner bootstrap', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('T1 seeds stable native owner once and reboots as a no-op', () => {
    const t = tempDb(); cleanups.push(t.cleanup);

    const first = new DatabaseService(t.dbPath);
    bootstrapNativeOwner(first.raw, OWNER_TELEGRAM_ID);
    expect(first.raw.prepare('SELECT id, telegram_id, role, active FROM users').all()).toEqual([
      { id: NATIVE_OWNER_ID, telegram_id: OWNER_TELEGRAM_ID, role: 'owner', active: 1 },
    ]);
    first.close();

    const rebooted = new DatabaseService(t.dbPath);
    bootstrapNativeOwner(rebooted.raw, OWNER_TELEGRAM_ID);
    expect(rebooted.raw.prepare('SELECT id, telegram_id, role, active FROM users').all()).toEqual([
      { id: NATIVE_OWNER_ID, telegram_id: OWNER_TELEGRAM_ID, role: 'owner', active: 1 },
    ]);
    rebooted.close();
  });

  it('T2 rejects a conflicting owner without mutating its row', () => {
    const t = tempDb(); cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    db.raw.prepare("INSERT INTO users (id, telegram_id, role, active) VALUES (2, 1002, 'owner', 1)").run();
    const before = db.raw.prepare('SELECT id, telegram_id, role, active FROM users').all();

    expect(() => bootstrapNativeOwner(db.raw, OWNER_TELEGRAM_ID))
      .toThrow(/conflicts with the existing owner/i);
    expect(db.raw.prepare('SELECT id, telegram_id, role, active FROM users').all()).toEqual(before);
    db.close();
  });
});
