/**
 * B04 — Seed the 10 canonical models (R1.4).
 * Scope: seeds only (no B04s CLI smoke, no B06 UI).
 * B02b: dead-product absence is enforced by allow-list equality (not ban-list greps).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { ModelService } from './services/model-service.js';
import {
  SCHEMA_VERSION,
  B04_CANONICAL_MODEL_SEEDS,
  B04_CANONICAL_SLUGS,
  applyB04CanonicalModelSeeds,
} from './db/schema.js';
import { PROVIDERS } from './config/providers.js';

/** Only allowed grok model ids in any registration path (JROM 2026-07-10). */
const ALLOWED_GROK_MODEL_IDS = ['grok-4.5', 'grok-composer-2.5-fast'] as const;

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
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

describe('B04 canonical model seeds (R1.4)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB exposes every R1.4 slug with cli+provider+model_id+display_name', () => {
    const t = tempDbPath('helm-b04-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(62);

    const ms = new ModelService(dbs);
    const list = ms.listModels();
    const bySlug = new Map(list.map((m) => [m.slug, m]));

    expect(B04_CANONICAL_SLUGS).toHaveLength(13);
    for (const seed of B04_CANONICAL_MODEL_SEEDS) {
      const row = bySlug.get(seed.slug);
      expect(row, `missing slug ${seed.slug}`).toBeTruthy();
      expect(row!.cli).toBe(seed.cli);
      expect(row!.provider).toBe(seed.provider);
      expect(row!.model_id).toBe(seed.model_id);
      expect(row!.display_name).toBe(seed.display_name);
      expect(row!.slug).toBe(seed.slug);
      expect(String(row!.cli).trim().length).toBeGreaterThan(0);
      expect(String(row!.display_name).trim().length).toBeGreaterThan(0);
    }

    // codex54min bound to B01-verified CLI id only
    expect(bySlug.get('codex54min')!.model_id).toBe('gpt-5.4-mini');

    // deepseek via kloo + openrouter route
    expect(bySlug.get('deepseek-v4-flash')!.provider).toBe('kloo');
    expect(bySlug.get('deepseek-v4-flash')!.cli).toBe('kloo');
    expect(bySlug.get('deepseek-v4-flash')!.route).toBe('openrouter');

    dbs.close();
  });

  it('canonical registry ids equal B04 allow-list exactly; grok model_ids only from allow-list; glm excluded', () => {
    const t = tempDbPath('helm-b04-allowlist-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const rows = dbs.raw
      .prepare('SELECT name, slug, model_id, display_name, provider, cli FROM models')
      .all() as Array<{
      name: string;
      slug: string;
      model_id: string;
      display_name: string;
      provider: string;
      cli: string;
    }>;

    // Allow-list equality on the Helm-canonical set (stronger than ban-list): every B04 slug
    // present with exact model_id/cli/provider. Fresh DBs may also hold legacy non-canonical
    // rows; those are unconstrained by B04 except the grok/glm gates below.
    expect(B04_CANONICAL_SLUGS).toHaveLength(13);
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    for (const seed of B04_CANONICAL_MODEL_SEEDS) {
      const row = bySlug.get(seed.slug);
      expect(row, `missing canonical slug ${seed.slug}`).toBeTruthy();
      expect(row!.model_id).toBe(seed.model_id);
      expect(row!.cli).toBe(seed.cli);
      expect(row!.provider).toBe(seed.provider);
    }
    // Exact equality of the canonical subset's (slug → model_id) map.
    const canonicalPairs = B04_CANONICAL_MODEL_SEEDS.map((s) => [s.slug, s.model_id] as const).sort(
      (a, b) => a[0].localeCompare(b[0])
    );
    const registryCanonicalPairs = B04_CANONICAL_SLUGS.map((slug) => {
      const r = bySlug.get(slug)!;
      return [r.slug, r.model_id] as const;
    }).sort((a, b) => a[0].localeCompare(b[0]));
    expect(registryCanonicalPairs).toEqual(canonicalPairs);

    // glm stays excluded (not in allow-list) — check without embedding other dead product literals.
    const allIds = rows.flatMap((r) => [r.slug, r.model_id, r.name, r.display_name]);
    expect(allIds.some((x) => /glm/i.test(String(x)))).toBe(false);
    expect(B04_CANONICAL_MODEL_SEEDS.some((s) => /glm/i.test(`${s.slug} ${s.model_id}`))).toBe(
      false
    );

    // Any grok registration row (provider/cli) and any model_id that is a grok-* product id
    // must be exactly the allow-list (catches new bad ids, not only known dead ones).
    const allowed = new Set<string>(ALLOWED_GROK_MODEL_IDS);
    for (const r of rows) {
      if (r.provider === 'grok' || r.cli === 'grok' || /^grok[-.]/i.test(r.model_id)) {
        expect(allowed.has(r.model_id), `non-allow-listed grok model_id: ${r.model_id}`).toBe(
          true
        );
      }
    }
    // Canonical grok seeds are exactly the allow-list (no more, no less).
    const canonicalGrokIds = B04_CANONICAL_MODEL_SEEDS.filter((s) => s.provider === 'grok')
      .map((s) => s.model_id)
      .sort();
    expect(canonicalGrokIds).toEqual([...ALLOWED_GROK_MODEL_IDS].sort());

    // PROVIDERS registration path: grok models[] equals the same allow-list exactly.
    const providersGrokModels = PROVIDERS.grok.models.map((m) => m.model).sort();
    expect(providersGrokModels).toEqual([...ALLOWED_GROK_MODEL_IDS].sort());

    dbs.close();
  });

  it('applyB04CanonicalModelSeeds is idempotent (no dupe slugs on re-run)', () => {
    const t = tempDbPath('helm-b04-idem-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const before = (
      dbs.raw.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }
    ).c;

    applyB04CanonicalModelSeeds(dbs.raw);
    applyB04CanonicalModelSeeds(dbs.raw);

    const after = (
      dbs.raw.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }
    ).c;
    expect(after).toBe(before);

    const slugCount = (
      dbs.raw
        .prepare(
          `SELECT COUNT(*) AS c FROM models WHERE slug IN (${B04_CANONICAL_SLUGS.map(() => '?').join(',')})`
        )
        .get(...B04_CANONICAL_SLUGS) as { c: number }
    ).c;
    expect(slugCount).toBe(B04_CANONICAL_SLUGS.length);

    const distinct = (
      dbs.raw
        .prepare(
          `SELECT COUNT(DISTINCT slug) AS c FROM models WHERE slug IN (${B04_CANONICAL_SLUGS.map(() => '?').join(',')})`
        )
        .get(...B04_CANONICAL_SLUGS) as { c: number }
    ).c;
    expect(distinct).toBe(B04_CANONICAL_SLUGS.length);

    dbs.close();
  });

  it('v61→current migration seeds every canonical model on an upgraded DB', () => {
    const t = tempDbPath('helm-b04-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Synthetic v61 DB: B03a columns present, but only a couple of non-canonical rows.
    const old = new Database(t.dbPath);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (61);
      CREATE TABLE models (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        cli TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT 'medium',
        approval TEXT NOT NULL DEFAULT 'auto',
        flags TEXT,
        approval_policy TEXT,
        sandbox_mode TEXT,
        permission_mode TEXT,
        bypass INTEGER NOT NULL DEFAULT 0,
        route TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO models (name, provider, model_id, cli, slug, display_name) VALUES
        ('legacy-only', 'claude', 'claude-legacy', 'claude', 'legacy-only', 'Legacy Only');
    `);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );

    const rows = dbs.raw
      .prepare('SELECT slug, cli, provider, model_id, display_name FROM models')
      .all() as any[];
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));

    for (const seed of B04_CANONICAL_MODEL_SEEDS) {
      expect(bySlug[seed.slug], seed.slug).toBeTruthy();
      expect(bySlug[seed.slug].model_id).toBe(seed.model_id);
      expect(bySlug[seed.slug].cli).toBe(seed.cli);
      expect(bySlug[seed.slug].provider).toBe(seed.provider);
    }
    expect(bySlug['legacy-only']).toBeTruthy();
    expect(bySlug['codex54min'].model_id).toBe('gpt-5.4-mini');

    // Allow-list: every canonical seed present with exact model_id; grok ids only from allow-list.
    // (legacy-only may remain; allow-list covers registration of the canonical set.)
    for (const seed of B04_CANONICAL_MODEL_SEEDS) {
      expect(bySlug[seed.slug].model_id).toBe(seed.model_id);
    }
    const grokModelIds = rows
      .filter((r) => r.provider === 'grok' || r.cli === 'grok')
      .map((r) => r.model_id)
      .sort();
    expect(grokModelIds).toEqual([...ALLOWED_GROK_MODEL_IDS].sort());
    expect(rows.some((r) => /glm/i.test(`${r.slug} ${r.model_id}`))).toBe(false);

    dbs.close();
  });
});
