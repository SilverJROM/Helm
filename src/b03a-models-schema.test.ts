/**
 * B03a — models.cli + models.slug + models.display_name schema, migration/backfill, uniqueness.
 * Scope: schema+mig+backfill only (no B04 seed, no B03b ModelService surface).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION, slugifyModelName, B04_CANONICAL_SLUGS } from './db/schema.js';

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  // Brief: HELM_DB_PATH=/tmp/helm-test-$$.db style isolation
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

describe('B03a models schema: cli + slug + display_name', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB lands SCHEMA_VERSION with cli/slug/display_name NOT NULL + UNIQUE slug', () => {
    const t = tempDbPath('helm-b03a-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(61);

    const cols = (dbs.raw.prepare('PRAGMA table_info(models)').all() as any[]).map((c) => c.name);
    expect(cols).toContain('cli');
    expect(cols).toContain('slug');
    expect(cols).toContain('display_name');

    const colMeta = dbs.raw.prepare('PRAGMA table_info(models)').all() as any[];
    for (const name of ['cli', 'slug', 'display_name']) {
      const c = colMeta.find((x) => x.name === name);
      expect(c, name).toBeTruthy();
      expect(c.notnull, `${name} NOT NULL`).toBe(1);
    }

    const rows = dbs.raw
      .prepare('SELECT id, name, provider, cli, slug, display_name FROM models ORDER BY id')
      .all() as any[];
    expect(rows.length).toBeGreaterThan(0);
    // B04 (R1.4) also lands on fresh DBs; those rows use Helm-canonical slug/display_name (not name-derived).
    const b04 = new Set(B04_CANONICAL_SLUGS);
    for (const r of rows) {
      expect(String(r.cli || '').trim().length, `cli for ${r.name}`).toBeGreaterThan(0);
      expect(String(r.slug || '').trim().length, `slug for ${r.name}`).toBeGreaterThan(0);
      expect(String(r.display_name || '').trim().length, `display_name for ${r.name}`).toBeGreaterThan(0);
      if (b04.has(String(r.slug))) {
        // Canonical registry rows: only require non-empty fields (asserted fully in b04-models-seed.test.ts).
        continue;
      }
      // Pre-B04 legacy seed: cli mirrors historical provider-as-cli
      expect(r.cli).toBe(r.provider);
      expect(r.display_name).toBe(r.name);
      expect(r.slug).toBe(slugifyModelName(r.name));
    }

    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    // UNIQUE enforced
    const first = rows[0];
    expect(() => {
      dbs.raw
        .prepare(
          `INSERT INTO models (name, provider, model_id, cli, slug, display_name) VALUES (?,?,?,?,?,?)`
        )
        .run(`dup-name-${Date.now()}`, 'claude', 'x', 'claude', first.slug, 'Dup');
    }).toThrow(/UNIQUE|unique/i);

    dbs.close();
  });

  it('v60→v61 migration backfills cli/slug/display_name and resolves slug collisions with -<id>', () => {
    const t = tempDbPath('helm-b03a-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Synthetic pre-B03a models table at version 60
    const old = new Database(t.dbPath);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (60);
      CREATE TABLE models (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT 'medium',
        approval TEXT NOT NULL DEFAULT 'auto',
        flags TEXT,
        bypass INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Two rows that slugify to the same base → collision must keep both (append -id)
      INSERT INTO models (id, name, provider, model_id) VALUES
        (1, 'Foo Bar', 'claude', 'foo-bar-a'),
        (2, 'foo-bar', 'grok', 'foo-bar-b'),
        (3, 'spark', 'codex', 'gpt-5.3-codex-spark');
    `);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    const cols = (dbs.raw.prepare('PRAGMA table_info(models)').all() as any[]).map((c) => c.name);
    expect(cols).toContain('cli');
    expect(cols).toContain('slug');
    expect(cols).toContain('display_name');

    const rows = dbs.raw
      .prepare('SELECT id, name, provider, model_id, cli, slug, display_name FROM models ORDER BY id')
      .all() as any[];
    // B04 may add the 10 canonical rows after v61 backfill (spark row is reused by slug/name).
    expect(rows.length).toBeGreaterThanOrEqual(3);

    // Fixture rows 1–2 keep pre-B04 equality; id=3 (spark) is claimed by B04 canonical slug.
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[1].cli).toBe(byId[1].provider);
    expect(byId[1].display_name).toBe(byId[1].name);
    expect(byId[2].cli).toBe(byId[2].provider);
    expect(byId[2].display_name).toBe(byId[2].name);
    // id=1 claims base slug "foo-bar"; id=2 collides → "foo-bar-2"
    expect(byId[1].slug).toBe('foo-bar');
    expect(byId[2].slug).toBe('foo-bar-2');
    expect(byId[3].slug).toBe('spark');
    expect(byId[3].cli).toBe('codex');
    expect(byId[3].model_id).toBe('gpt-5.3-codex-spark');

    const slugs = rows.map((r) => r.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('foo-bar');
    expect(slugs).toContain('foo-bar-2');
    expect(slugs).toContain('spark');

    // UNIQUE index present and enforced
    const idx = dbs.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_models_slug'`)
      .get() as any;
    expect(idx?.name).toBe('idx_models_slug');

    expect(() => {
      dbs.raw
        .prepare(
          `INSERT INTO models (name, provider, model_id, cli, slug, display_name) VALUES (?,?,?,?,?,?)`
        )
        .run('other', 'claude', 'x', 'claude', 'spark', 'Other');
    }).toThrow(/UNIQUE|unique/i);

    // Idempotent re-open
    dbs.close();
    const dbs2 = new DatabaseService(t.dbPath);
    expect((dbs2.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    const again = dbs2.raw.prepare('SELECT slug FROM models WHERE id = 2').get() as any;
    expect(again.slug).toBe('foo-bar-2');
    dbs2.close();
  });

  it('create without cli is rejected on fresh schema (NOT NULL)', () => {
    const t = tempDbPath('helm-b03a-nocli-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect(() => {
      dbs.raw
        .prepare(
          `INSERT INTO models (name, provider, model_id, slug, display_name) VALUES (?,?,?,?,?)`
        )
        .run(`no-cli-${Date.now()}`, 'claude', 'm', `slug-${Date.now()}`, 'No CLI');
    }).toThrow(/NOT NULL|not null|NULL/i);

    // Full insert with cli succeeds
    const slug = `ok-slug-${Date.now()}`;
    const row = dbs.raw
      .prepare(
        `INSERT INTO models (name, provider, model_id, cli, slug, display_name) VALUES (?,?,?,?,?,?) RETURNING id, cli`
      )
      .get(`ok-${Date.now()}`, 'claude', 'm', 'claude', slug, 'OK') as any;
    expect(row.id).toBeGreaterThan(0);
    expect(row.cli).toBe('claude');

    dbs.close();
  });
});
