// AC19 / F-07: the production registry-hook wiring (src/index.ts setRegistryHook) must not swallow
// a register() failure — a swallowed failure is exactly what let a tag/registry-persist error turn
// into a "successful" create with a durable unowned row. Extracted into session-registry-hook.ts
// (buildTmuxSessionRegistryHook) specifically so this wiring is importable and testable without
// booting src/index.ts's main() (which runs at import time).
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SessionRegistryService, sessionStatusTokenFromRow } from '../services/session-registry-service.js';
import { buildTmuxSessionRegistryHook } from './session-registry-hook.js';

function openRegistry(schemaSql: string): { db: Database.Database; reg: SessionRegistryService } {
  const db = new Database(':memory:');
  db.exec(schemaSql);
  return { db, reg: new SessionRegistryService(db as any) };
}

const FULL_SCHEMA = `
  CREATE TABLE helm_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT,
    project_id INTEGER,
    run_id INTEGER,
    owner TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    ended_at TEXT,
    reason TEXT
  );
  CREATE TABLE lifecycle_seq (name TEXT PRIMARY KEY, next INTEGER NOT NULL);
  INSERT INTO lifecycle_seq (name, next) VALUES ('global', 1);
`;

// Omits `reason` so register()'s INSERT throws a genuine SQL error (real persist failure).
const BROKEN_SCHEMA = `
  CREATE TABLE helm_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT,
    project_id INTEGER,
    run_id INTEGER,
    owner TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    ended_at TEXT
  );
  CREATE TABLE lifecycle_seq (name TEXT PRIMARY KEY, next INTEGER NOT NULL);
  INSERT INTO lifecycle_seq (name, next) VALUES ('global', 1);
`;

describe('AC19 / F-07: buildTmuxSessionRegistryHook (production wiring)', () => {
  it('onCreate propagates a register() failure — not swallowed', () => {
    const { db, reg } = openRegistry(BROKEN_SCHEMA);
    const hook = buildTmuxSessionRegistryHook(reg);
    expect(() => hook.onCreate('helm-w-hookfail', { owner: 'helm' })).toThrow(/no column named reason/);
    const row = db.prepare('SELECT * FROM helm_sessions WHERE name = ?').get('helm-w-hookfail');
    expect(row).toBeFalsy();
    db.close();
  });

  it('onCreate returns a CAS token on success', () => {
    const { db, reg } = openRegistry(FULL_SCHEMA);
    const hook = buildTmuxSessionRegistryHook(reg);
    const token = hook.onCreate('helm-w-hookok', { owner: 'helm' });
    expect(token).toBeTruthy();
    expect(reg.get('helm-w-hookok')?.owner).toBe('helm');
    db.close();
  });

  it('onTerminate applies markReaped only for a valid token (fail-safe on stale/missing)', () => {
    const { db, reg } = openRegistry(FULL_SCHEMA);
    const hook = buildTmuxSessionRegistryHook(reg);
    expect(hook.onTerminate('helm-w-noToken')).toBe(false);
    const row = reg.register('helm-w-term', { owner: 'helm' })!;
    const token = sessionStatusTokenFromRow(row);
    expect(hook.onTerminate('helm-w-term', token)).toBe(true);
    // Stale replay of the same (now-consumed) token must not re-apply.
    expect(hook.onTerminate('helm-w-term', token)).toBe(false);
    db.close();
  });

  it('onLookup returns the row for createSession same-name replace eligibility', () => {
    const { db, reg } = openRegistry(FULL_SCHEMA);
    const hook = buildTmuxSessionRegistryHook(reg);
    reg.register('helm-w-lookup', { owner: 'helm' });
    expect(hook.onLookup?.('helm-w-lookup')?.owner).toBe('helm');
    expect(hook.onLookup?.('helm-w-missing')).toBeUndefined();
    db.close();
  });
});
