/**
 * B12 / AC-18 — seat resolution: expired grok primary + codex backup available
 * ⇒ LATERAL_FAILOVER to backup (NOT an auth pause).
 *
 * Uses topology seed implementer/L1: primary=grokcompose (grok), backup=spark (codex).
 * #53 post-spawn path is intentionally untouched (see grok-auth-availability.test.ts +
 * fault-class.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ModelService } from './services/model-service.js';
import { TierResolutionService } from './services/tier-resolution-service.js';
import {
  makeGrokAwareSlugAvailability,
  makeGrokAwareProviderModelAvailability,
} from './services/grok-auth-availability.js';
import { resolvePanelWithAvailability } from './services/adaptive-planning-phase.js';
import { authFault } from './services/fault-class.js';

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

function setupDb(prefix: string): { dbs: DatabaseService; cleanup: () => void } {
  const t = tempDbPath(prefix);
  process.env.HELM_DB_PATH = t.dbPath;
  const dbs = new DatabaseService(t.dbPath);
  return { dbs, cleanup: t.cleanup };
}

const DOMAIN = 'https://auth.x.ai::test-b12-uuid';
const NOW_MS = Date.parse('2026-07-22T12:00:00.000Z');

function authJson(expiresAt: string) {
  return {
    [DOMAIN]: {
      refresh_token: 'stc1B--test',
      expires_at: expiresAt,
    },
  };
}

describe('B12 AC-18 seat resolution — grok expiry → backup', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('implementer/L1: expired grok primary + codex backup available ⇒ LATERAL_FAILOVER to spark', async () => {
    const { dbs, cleanup } = setupDb('helm-b12-seat-');
    cleanups.push(cleanup);
    new ModelService(dbs); // ensure B04 seeds present (DatabaseService already seeds; re-entrant ok)

    const providerForSlug = (slug: string): string | null => {
      const row = dbs.raw.prepare('SELECT provider FROM models WHERE slug = ? LIMIT 1').get(slug) as
        | { provider: string }
        | undefined;
      return row?.provider != null ? String(row.provider) : null;
    };

    const isAvailable = makeGrokAwareSlugAvailability(providerForSlug, {
      now: NOW_MS,
      authJson: authJson('2020-01-01T00:00:00.000Z'), // expired
    });

    const svc = new TierResolutionService(dbs, isAvailable);
    const res = await svc.resolveLateral('implementer', 'L1');

    // Topology: L1 primary=grokcompose (grok), backup=spark (codex)
    expect(res.signal_availability).toBe('LATERAL_FAILOVER');
    expect(res.resolved_source).toBe('backup');
    expect(res.resolved_slug).toBe('spark');
    // Explicitly not a pause / NO_SEAT
    expect(res.resolved_slug).not.toBeNull();
    expect(res.signal_availability).not.toBe('NO_SEAT');

    dbs.close();
  });

  it('implementer/L1: future grok expiry ⇒ AS_INTENDED primary (no false failover)', async () => {
    const { dbs, cleanup } = setupDb('helm-b12-seat-ok-');
    cleanups.push(cleanup);
    new ModelService(dbs);

    const providerForSlug = (slug: string): string | null => {
      const row = dbs.raw.prepare('SELECT provider FROM models WHERE slug = ? LIMIT 1').get(slug) as
        | { provider: string }
        | undefined;
      return row?.provider != null ? String(row.provider) : null;
    };

    const isAvailable = makeGrokAwareSlugAvailability(providerForSlug, {
      now: NOW_MS,
      authJson: authJson('2026-12-31T23:59:59.000Z'),
    });

    const svc = new TierResolutionService(dbs, isAvailable);
    const res = await svc.resolveLateral('implementer', 'L1');

    expect(res.signal_availability).toBe('AS_INTENDED');
    expect(res.resolved_source).toBe('primary');
    expect(res.resolved_slug).toBe('grokcompose');

    dbs.close();
  });

  it('adaptive panel: expired grok member ⇒ backup selected via resolvePanelWithAvailability', async () => {
    const panel = {
      size: 2,
      leadModel: 'grok-4.5',
      leadProvider: 'grok',
      memberModels: ['grok-4.5', 'gpt-5.5'],
      memberProviders: ['grok', 'codex'],
      backups: [
        { model: 'gpt-5.5-backup', provider: 'codex' },
      ],
      defaultEffort: 'med',
    };

    const isAvailable = makeGrokAwareProviderModelAvailability(async () => true, {
      now: NOW_MS,
      authJson: authJson('2019-06-01T00:00:00.000Z'),
    });

    const resolved = await resolvePanelWithAvailability(panel, isAvailable);
    // Lead/member0 was grok → swapped to codex backup
    expect(resolved.memberProviders![0]).toBe('codex');
    expect(resolved.memberModels![0]).toBe('gpt-5.5-backup');
    expect(resolved.leadProvider).toBe('codex');
    // Second seat was already codex — stays
    expect(resolved.memberProviders![1]).toBe('codex');
    expect(resolved.memberModels![1]).toBe('gpt-5.5');
  });

  it('#53 post-spawn: authFault still canFailover:false (pause, not backup burn)', () => {
    // Critical: B12 must NOT change mid-task auth behavior. A genuine logout after spawn
    // still classifies as auth / canFailover:false — operator pause, not failover.
    const f = authFault('grok', 'Authentication required — your session has expired');
    expect(f.kind).toBe('auth');
    expect(f.canFailover).toBe(false);
    expect(f.remedy).toMatch(/grok login/);
  });
});
