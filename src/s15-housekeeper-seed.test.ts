/**
 * S15 — housekeeper house+tiered seed (AC28/AC31).
 * Synthetic DB only. HELM_SESSION_JANITOR must stay 0.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import {
  SCHEMA_VERSION,
  HOUSEKEEPER_DEFINITION_MD,
  applyHousekeeperSeed,
  B09A_CANONICAL_NAMES,
  B09A_HOUSE_NAMES,
} from './db/schema.js';

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-s15-${process.pid}.db`);
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

function modelSlug(db: Database.Database, modelId: number | null): string | null {
  if (modelId == null) return null;
  const row = db.prepare('SELECT slug, name, model_id FROM models WHERE id = ?').get(modelId) as
    | { slug: string | null; name: string; model_id: string }
    | undefined;
  if (!row) return null;
  return row.slug || row.name || row.model_id;
}

describe('S15 housekeeper seed (AC28/AC31)', () => {
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

  it('fresh DB: one housekeeper house+tiered row, main grok45, ordered spark then haiku, guardrails present', () => {
    const t = tempDbPath('helm-s15-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBe(103);
    expect(B09A_HOUSE_NAMES).toContain('housekeeper');
    expect(B09A_CANONICAL_NAMES).toContain('housekeeper');
    expect(B09A_CANONICAL_NAMES).toHaveLength(11);

    const rows = dbs.raw.prepare("SELECT * FROM agents WHERE name = 'housekeeper'").all() as any[];
    expect(rows).toHaveLength(1);
    const hk = rows[0];
    expect(hk.agent_type).toBe('house');
    expect(hk.classification).toBe('tiered');
    expect(hk.default_model_id).toBeTruthy();
    expect(modelSlug(dbs.raw, hk.default_model_id)).toMatch(/grok45|grok-4\.5/);

    const esc = dbs.raw
      .prepare(
        `SELECT e.position AS position, m.slug AS slug, m.name AS name, m.model_id AS model_id
         FROM agent_escalations e JOIN models m ON m.id = e.model_id
         WHERE e.agent_id = ? ORDER BY e.position`
      )
      .all(hk.id) as Array<{ position: number; slug: string | null; name: string; model_id: string }>;
    expect(esc).toHaveLength(2);
    expect(esc[0].position).toBe(1);
    expect(esc[0].slug || esc[0].name).toMatch(/spark/i);
    expect(esc[1].position).toBe(2);
    expect(esc[1].slug || esc[1].model_id).toMatch(/haiku/i);

    const md = String(hk.definition_md || '');
    expect(md.length).toBeGreaterThan(0);
    expect(md).toMatch(/keep-biased/i);
    expect(md).toMatch(/needs-human/i);
    expect(md).toMatch(/evidence recorded|verdict auditable/i);
    expect(md).toMatch(/helm-owned|helm-owned seats only/i);
    expect(md).toMatch(/cooldown/i);
    expect(md).toMatch(/bounded-input|bounded diagnosis/i);
    expect(md).toMatch(/pane tail/i);
    expect(md).toMatch(/callback/i);
    expect(md).not.toMatch(/reap sessions|you reap/i);

    expect(process.env.HELM_SESSION_JANITOR).toBe('0');
    dbs.close();
  });

  it('idempotent: re-apply seed keeps one row and stable main+2 bindings', () => {
    const t = tempDbPath('helm-s15-idem-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const before = dbs.raw.prepare("SELECT * FROM agents WHERE name = 'housekeeper'").get() as any;
    const escBefore = dbs.raw
      .prepare('SELECT position, model_id FROM agent_escalations WHERE agent_id = ? ORDER BY position')
      .all(before.id) as Array<{ position: number; model_id: number }>;

    applyHousekeeperSeed(dbs.raw);
    applyHousekeeperSeed(dbs.raw);

    const after = dbs.raw.prepare("SELECT * FROM agents WHERE name = 'housekeeper'").all() as any[];
    expect(after).toHaveLength(1);
    expect(after[0].default_model_id).toBe(before.default_model_id);
    expect(after[0].definition_md).toBe(before.definition_md);
    const escAfter = dbs.raw
      .prepare('SELECT position, model_id FROM agent_escalations WHERE agent_id = ? ORDER BY position')
      .all(before.id) as Array<{ position: number; model_id: number }>;
    expect(escAfter).toEqual(escBefore);
    dbs.close();
  });

  it('Studio edits survive: custom definition_md and rungs not overwritten on re-seed', () => {
    const t = tempDbPath('helm-s15-preserve-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const hk = dbs.raw.prepare("SELECT id FROM agents WHERE name = 'housekeeper'").get() as { id: number };
    const customMd = '# user-edited housekeeper prompt — keep me';
    dbs.raw.prepare("UPDATE agents SET definition_md = ? WHERE name = 'housekeeper'").run(customMd);

    // Swap main + both rungs to other canonical models (distinct from seed defaults).
    const altMain = dbs.raw.prepare("SELECT id FROM models WHERE slug = 'sonnet5' LIMIT 1").get() as {
      id: number;
    };
    const alt1 = dbs.raw.prepare("SELECT id FROM models WHERE slug = 'codex55' LIMIT 1").get() as {
      id: number;
    };
    const alt2 = dbs.raw.prepare("SELECT id FROM models WHERE slug = 'opus5' LIMIT 1").get() as {
      id: number;
    };
    expect(altMain && alt1 && alt2).toBeTruthy();
    dbs.raw.prepare('UPDATE agents SET default_model_id = ? WHERE name = ?').run(altMain.id, 'housekeeper');
    dbs.raw.prepare('UPDATE agent_escalations SET model_id = ? WHERE agent_id = ? AND position = 1').run(alt1.id, hk.id);
    dbs.raw.prepare('UPDATE agent_escalations SET model_id = ? WHERE agent_id = ? AND position = 2').run(alt2.id, hk.id);

    applyHousekeeperSeed(dbs.raw);

    const row = dbs.raw.prepare("SELECT definition_md, default_model_id FROM agents WHERE name = 'housekeeper'").get() as any;
    expect(row.definition_md).toBe(customMd);
    expect(row.default_model_id).toBe(altMain.id);
    const esc = dbs.raw
      .prepare('SELECT position, model_id FROM agent_escalations WHERE agent_id = ? ORDER BY position')
      .all(hk.id) as Array<{ position: number; model_id: number }>;
    expect(esc).toEqual([
      { position: 1, model_id: alt1.id },
      { position: 2, model_id: alt2.id },
    ]);
    // Canonical seed text still available for empty-fill path elsewhere
    expect(HOUSEKEEPER_DEFINITION_MD).toMatch(/Keep-biased/i);
    dbs.close();
  });

  it('v102→v103 upgrade seeds housekeeper when missing', () => {
    const t = tempDbPath('helm-s15-upg-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Fresh open to current, then strip housekeeper and downgrade version to 102.
    const first = new DatabaseService(t.dbPath);
    first.raw.prepare("DELETE FROM agent_escalations WHERE agent_id IN (SELECT id FROM agents WHERE name = 'housekeeper')").run();
    first.raw.prepare("DELETE FROM agents WHERE name = 'housekeeper'").run();
    first.raw.prepare('UPDATE schema_version SET version = 102').run();
    first.close();

    const second = new DatabaseService(t.dbPath);
    const ver = (second.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(103);
    const rows = second.raw.prepare("SELECT * FROM agents WHERE name = 'housekeeper'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_type).toBe('house');
    expect(rows[0].classification).toBe('tiered');
    expect(rows[0].default_model_id).toBeTruthy();
    const esc = second.raw
      .prepare(
        `SELECT e.position FROM agent_escalations e
         WHERE e.agent_id = ? ORDER BY e.position`
      )
      .all(rows[0].id) as Array<{ position: number }>;
    expect(esc.map((e) => e.position)).toEqual([1, 2]);
    expect(String(rows[0].definition_md)).toMatch(/keep-biased/i);
    second.close();
  });
});
