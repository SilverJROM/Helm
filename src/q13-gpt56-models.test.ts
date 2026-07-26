import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDERS } from './config/providers.js';
import { DatabaseService } from './db/database.js';
import {
  B04_CANONICAL_MODEL_SEEDS,
  SCHEMA_VERSION,
  sweepModelBearingAllowList,
} from './db/schema.js';

const Q13_MODEL_IDS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;
const cleanupPaths: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-q13-'));
  cleanupPaths.push(dir);
  return path.join(dir, 'helm.db');
}

afterEach(() => {
  while (cleanupPaths.length) fs.rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
});

describe('Q-13 gpt-5.6 registry', () => {
  it('adds exactly the approved Codex provider ids without changing the prior roster', () => {
    expect(PROVIDERS.codex.models.map((model) => model.model)).toEqual([
      'gpt-5.5',
      ...Q13_MODEL_IDS,
      'gpt-5.4',
      'gpt-5.3-codex-spark',
      'gpt-5.2-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex',
      'gpt-5.1-codex-mini',
    ]);
  });

  it('seeds one complete Codex row per gpt-5.6 id on fresh and v77-upgrade databases', () => {
    const dbPath = tempDbPath();
    const fresh = new DatabaseService(dbPath);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(80);
    expect(sweepModelBearingAllowList(fresh.raw)).toEqual([]);

    const expected = B04_CANONICAL_MODEL_SEEDS.filter((seed) =>
      Q13_MODEL_IDS.includes(seed.model_id as (typeof Q13_MODEL_IDS)[number])
    );
    expect(expected).toHaveLength(3);
    for (const seed of expected) {
      const rows = fresh.raw
        .prepare('SELECT cli, provider, slug, display_name, model_id, effort FROM models WHERE model_id = ?')
        .all(seed.model_id) as Array<Record<string, string>>;
      expect(rows).toEqual([
        {
          cli: 'codex',
          provider: 'codex',
          slug: seed.slug,
          display_name: seed.display_name,
          model_id: seed.model_id,
          effort: seed.effort,
        },
      ]);
    }

    fresh.raw.prepare(`DELETE FROM models WHERE model_id IN (${Q13_MODEL_IDS.map(() => '?').join(',')})`).run(...Q13_MODEL_IDS);
    fresh.raw.prepare('UPDATE schema_version SET version = 77').run();
    fresh.close();

    const upgraded = new DatabaseService(dbPath);
    for (const modelId of Q13_MODEL_IDS) {
      const count = upgraded.raw
        .prepare('SELECT COUNT(*) AS count FROM models WHERE model_id = ?')
        .get(modelId) as { count: number };
      expect(count.count).toBe(1);
    }
    expect(sweepModelBearingAllowList(upgraded.raw)).toEqual([]);
    upgraded.close();
  });
});
