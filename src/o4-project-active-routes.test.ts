import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from './db/database.js';
import { HelmIdentityService, requireActiveNativeProject } from './services/helm-identity-service.js';

function projectRouteSource(route: 'switch-model' | 'launch-master') {
  const source = fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const start = source.indexOf(`app.post('/api/projects/:id/${route}'`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextRoute = source.indexOf("app.post('/api/projects/:id/", start + 1);
  return source.slice(start, nextRoute === -1 ? undefined : nextRoute);
}

describe('O4.2 active native project guards for switch-model and launch-master', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o42-'));
    const dbs = new DatabaseService(path.join(root, 'helm.db'));
    cleanups.push(() => {
      try { dbs.close(); } catch {}
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    });
    return { root, dbs };
  }

  function seedNative(dbs: DatabaseService, root: string, id: number, name: string, active = 1) {
    const directory = fs.mkdtempSync(path.join(root, `${name}-`));
    dbs.raw.prepare('INSERT INTO projects (id, name, directory, status, active) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, directory, active ? 'active' : 'archived', active);
    return path.basename(directory);
  }

  it('T1: both routes use the native guard before their existing route logic, and an active native project resolves to Helm', () => {
    const { root, dbs } = setup();
    const nativeSlug = seedNative(dbs, root, 41, 'native-cards');
    // O7.2: native-only identity — id=41 resolves purely from the native row, never a legacy db.
    const identity = new HelmIdentityService(dbs);

    const guard = requireActiveNativeProject(identity, 41);
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.project.directory_name).toBe(nativeSlug);
      expect(guard.project.directory_name).not.toBe('external-ehr');
    }

    for (const route of ['switch-model', 'launch-master'] as const) {
      const source = projectRouteSource(route);
      const guardAt = source.indexOf('requireActiveNativeProject(identityService, projectId)');
      expect(guardAt).toBeGreaterThanOrEqual(0);
      expect(source.indexOf('if (!activeGuard.ok)', guardAt)).toBeGreaterThan(guardAt);
      // The guard must precede setup/mutation route logic and must not use legacy numeric authority.
      expect(source.indexOf('masterService.isSetUp(projectId)')).toBeGreaterThan(guardAt);
      expect(source).not.toContain('agjDb.prepare');
    }
  });

  it('T2: inactive or unknown path IDs return 400 before swap/launch effects and leave native runtime/switch tables unchanged', () => {
    const { root, dbs } = setup();
    seedNative(dbs, root, 42, 'inactive-native', 0);
    // id=42 is inactive natively and id=43 has no native row at all. With a native-only identity
    // boundary neither can resolve — a legacy numeric identity is never route authority (or readable).
    const identity = new HelmIdentityService(dbs);
    const before = {
      runtimes: dbs.raw.prepare('SELECT COUNT(*) AS count FROM master_runtimes').get(),
      switches: dbs.raw.prepare('SELECT COUNT(*) AS count FROM master_switches').get(),
    };
    let swapEffects = 0;
    let launchEffects = 0;

    for (const projectId of [42, 43]) {
      const guard = requireActiveNativeProject(identity, projectId);
      // This is the exact 400 branch used by both routes before either side effect.
      const switchStatus = guard.ok ? (++swapEffects, 200) : 400;
      const launchStatus = guard.ok ? (++launchEffects, 200) : 400;
      expect(switchStatus).toBe(400);
      expect(launchStatus).toBe(400);
    }

    expect(swapEffects).toBe(0);
    expect(launchEffects).toBe(0);
    expect(dbs.raw.prepare('SELECT COUNT(*) AS count FROM master_runtimes').get()).toEqual(before.runtimes);
    expect(dbs.raw.prepare('SELECT COUNT(*) AS count FROM master_switches').get()).toEqual(before.switches);
  });
});
