/**
 * B03b — ModelService: require cli; expose slug + display_name.
 * Scope: service surface + tests only (no B04 seed, no B06 UI).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ModelService } from './services/model-service.js';
import { slugifyModelName } from './db/schema.js';

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

describe('B03b ModelService: require cli; expose slug + display_name', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function freshService(): ModelService {
    const t = tempDbPath('helm-b03b-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    return new ModelService(dbs);
  }

  it('create without cli rejects (missing / empty / whitespace)', () => {
    const ms = freshService();
    const base = { name: 'b03b-no-cli', provider: 'grok' as const, model_id: 'grok-test' };

    expect(() => ms.createModel(base as any)).toThrow(/cli is required/i);
    expect(() => ms.createModel({ ...base, cli: '' } as any)).toThrow(/cli is required/i);
    expect(() => ms.createModel({ ...base, cli: '   ' } as any)).toThrow(/cli is required/i);
  });

  it('list returns slug + display_name for every model; create persists cli/slug/display_name', () => {
    const ms = freshService();

    const listed = ms.listModels();
    expect(listed.length).toBeGreaterThan(0);
    for (const m of listed) {
      expect(typeof m.slug, `slug on ${m.name}`).toBe('string');
      expect(m.slug.trim().length, `slug non-empty on ${m.name}`).toBeGreaterThan(0);
      expect(typeof m.display_name, `display_name on ${m.name}`).toBe('string');
      expect(m.display_name.trim().length, `display_name non-empty on ${m.name}`).toBeGreaterThan(0);
      expect(typeof m.cli, `cli on ${m.name}`).toBe('string');
      expect(m.cli.trim().length, `cli non-empty on ${m.name}`).toBeGreaterThan(0);
    }

    const created = ms.createModel({
      name: 'B03b Custom Model',
      provider: 'claude',
      model_id: 'claude-custom-b03b',
      cli: 'claude',
      display_name: 'B03b Label',
    });
    expect(created.cli).toBe('claude');
    expect(created.display_name).toBe('B03b Label');
    expect(created.slug).toBe(slugifyModelName('B03b Custom Model'));

    const got = ms.getModel(created.id)!;
    expect(got.cli).toBe('claude');
    expect(got.slug).toBe(created.slug);
    expect(got.display_name).toBe('B03b Label');

    const again = ms.listModels().find((m) => m.id === created.id)!;
    expect(again.slug).toBe(created.slug);
    expect(again.display_name).toBe('B03b Label');
    expect(again.cli).toBe('claude');
  });

  it('update rejects empty cli; accepts cli/display_name change', () => {
    const ms = freshService();
    const created = ms.createModel({
      name: 'b03b-upd',
      provider: 'codex',
      model_id: 'gpt-b03b-upd',
      cli: 'codex',
    });
    expect(() => ms.updateModel(created.id, { cli: '' })).toThrow(/cli is required/i);
    expect(() => ms.updateModel(created.id, { cli: '  ' })).toThrow(/cli is required/i);

    const updated = ms.updateModel(created.id, { cli: 'grok', display_name: 'Updated Label' });
    expect(updated.cli).toBe('grok');
    expect(updated.display_name).toBe('Updated Label');
    expect(updated.slug).toBe(created.slug); // slug stable unless explicitly changed
  });
});
