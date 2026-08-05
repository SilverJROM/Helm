/**
 * cycle-branch-lifecycle B3 — house branch-safety canonical agent seed (R3.1, R3.3).
 * Seed present on fresh DB; idempotent on re-seed; definition_md carries never-decides clause;
 * agent_type=house; model binding (topology default grok45).
 * Synthetic DB only — does not touch data/helm.db.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import {
  SCHEMA_VERSION,
  BRANCH_SAFETY_DEFINITION_MD,
  applyBranchSafetyAgentSeed,
  applyB09aCanonicalRosterSeeds,
  B09A_CANONICAL_NAMES,
  B09A_HOUSE_NAMES,
} from './db/schema.js';

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-b3-${process.pid}.db`);
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

function modelSlug(db: import('better-sqlite3').Database, modelId: number | null): string | null {
  if (modelId == null) return null;
  const row = db.prepare('SELECT slug, name, model_id FROM models WHERE id = ?').get(modelId) as
    | { slug: string | null; name: string; model_id: string }
    | undefined;
  if (!row) return null;
  return row.slug || row.name || row.model_id;
}

describe('cycle-branch-lifecycle B3: branch-safety house agent seed (fresh DB)', () => {
  const cleanups: Array<() => void> = [];
  const prevJanitor = process.env.HELM_SESSION_JANITOR;

  beforeEach(() => {
    process.env.HELM_SESSION_JANITOR = '0';
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    if (prevJanitor === undefined) delete process.env.HELM_SESSION_JANITOR;
    else process.env.HELM_SESSION_JANITOR = prevJanitor;
  });

  it('fresh DB: branch-safety house row present with topology model binding + never-decides definition', () => {
    const t = tempDbPath('helm-b3-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(115);
    expect(B09A_HOUSE_NAMES).toContain('branch-safety');
    expect(B09A_CANONICAL_NAMES).toContain('branch-safety');
    expect(B09A_CANONICAL_NAMES).toHaveLength(12);

    const rows = dbs.raw.prepare("SELECT * FROM agents WHERE name = 'branch-safety'").all() as any[];
    expect(rows).toHaveLength(1);
    const bs = rows[0];
    expect(bs.agent_type).toBe('house');
    expect(bs.provider).toBe('grok');
    expect(bs.model).toMatch(/grok-4\.5/);
    expect(bs.default_model_id).toBeTruthy();
    expect(modelSlug(dbs.raw, bs.default_model_id)).toMatch(/grok45|grok-4\.5|grok-4-5/);

    const md = String(bs.definition_md || '');
    expect(md.length).toBeGreaterThan(0);
    // never-decides clause (R3.1 facts-only contract)
    expect(md).toMatch(/never decides|Never decides|never decide/i);
    expect(md).toMatch(/never.*blocks|blocks.*or deletes|never.*deletes/i);
    expect(md).toMatch(/facts only|facts-only|report facts/i);
    expect(md).toMatch(/branch-safety/i);

    // role_defaults bound (B2 deferred this to B3)
    const rd = dbs.raw
      .prepare(
        `SELECT rd.role AS role, a.name AS agent_name
         FROM role_defaults rd JOIN agents a ON a.id = rd.agent_id
         WHERE rd.role = 'branch-safety'`
      )
      .get() as { role: string; agent_name: string } | undefined;
    expect(rd).toBeTruthy();
    expect(rd!.agent_name).toBe('branch-safety');

    dbs.close();
  });

  it('idempotent: re-seed of existing DB keeps one row and stable model + definition', () => {
    const t = tempDbPath('helm-b3-idem-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const before = dbs.raw.prepare("SELECT * FROM agents WHERE name = 'branch-safety'").get() as any;
    expect(before).toBeTruthy();

    applyB09aCanonicalRosterSeeds(dbs.raw);
    applyBranchSafetyAgentSeed(dbs.raw);
    applyBranchSafetyAgentSeed(dbs.raw);

    const after = dbs.raw.prepare("SELECT * FROM agents WHERE name = 'branch-safety'").all() as any[];
    expect(after).toHaveLength(1);
    expect(after[0].default_model_id).toBe(before.default_model_id);
    expect(after[0].definition_md).toBe(before.definition_md);
    expect(after[0].agent_type).toBe('house');

    const count = (
      dbs.raw.prepare("SELECT COUNT(*) AS c FROM agents WHERE name = 'branch-safety'").get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);

    const rdCount = (
      dbs.raw
        .prepare("SELECT COUNT(*) AS c FROM role_defaults WHERE role = 'branch-safety'")
        .get() as { c: number }
    ).c;
    expect(rdCount).toBe(1);

    dbs.close();
  });

  it('Studio edits survive: custom definition_md and model not overwritten on re-seed', () => {
    const t = tempDbPath('helm-b3-preserve-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const customMd = '# user-edited branch-safety prompt — keep me\nNever decides still true.';
    dbs.raw.prepare("UPDATE agents SET definition_md = ? WHERE name = 'branch-safety'").run(customMd);

    const altMain = dbs.raw.prepare("SELECT id FROM models WHERE slug = 'sonnet5' LIMIT 1").get() as
      | { id: number }
      | undefined;
    expect(altMain).toBeTruthy();
    dbs.raw
      .prepare('UPDATE agents SET default_model_id = ? WHERE name = ?')
      .run(altMain!.id, 'branch-safety');

    applyBranchSafetyAgentSeed(dbs.raw);
    applyB09aCanonicalRosterSeeds(dbs.raw);

    const row = dbs.raw
      .prepare("SELECT definition_md, default_model_id, agent_type FROM agents WHERE name = 'branch-safety'")
      .get() as any;
    expect(row.definition_md).toBe(customMd);
    expect(row.default_model_id).toBe(altMain!.id);
    expect(row.agent_type).toBe('house');
    expect(BRANCH_SAFETY_DEFINITION_MD).toMatch(/never decides/i);

    dbs.close();
  });

  it('v114→v115 upgrade seeds branch-safety when missing', () => {
    const t = tempDbPath('helm-b3-upg-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const first = new DatabaseService(t.dbPath);
    first.raw
      .prepare("DELETE FROM role_defaults WHERE role = 'branch-safety'")
      .run();
    first.raw
      .prepare("DELETE FROM agents WHERE name = 'branch-safety'")
      .run();
    first.raw.prepare('UPDATE schema_version SET version = 114').run();
    first.close();

    const second = new DatabaseService(t.dbPath);
    const ver = (second.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    const rows = second.raw.prepare("SELECT * FROM agents WHERE name = 'branch-safety'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_type).toBe('house');
    expect(rows[0].default_model_id).toBeTruthy();
    expect(String(rows[0].definition_md)).toMatch(/never decides/i);

    const rd = second.raw
      .prepare("SELECT agent_id FROM role_defaults WHERE role = 'branch-safety'")
      .get() as { agent_id: number } | undefined;
    expect(rd).toBeTruthy();
    expect(rd!.agent_id).toBe(rows[0].id);

    second.close();
  });
});
