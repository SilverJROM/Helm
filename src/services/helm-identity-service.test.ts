import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { HelmIdentityService } from './helm-identity-service.js';

function tempDb(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o31-'));
  return { dbPath: path.join(dir, 'helm.db'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('O3.1/O7.2 HelmIdentityService — native-only identity boundary', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('T1 resolves a complete active native project and user purely from native rows (no external db)', () => {
    const t = tempDb(); cleanups.push(t.cleanup);
    const helm = new DatabaseService(t.dbPath);
    helm.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(11, 'Cards', '/work/cards');
    helm.raw.prepare("INSERT INTO users (id, telegram_id, username, display_name, role) VALUES (?, ?, ?, ?, 'owner')")
      .run(7, 700, 'owner', 'Owner');
    // O7.2: the identity service takes ONLY the native db — there is no second (external) argument.
    const identities = new HelmIdentityService(helm);

    expect(identities.resolveProject(11)).toMatchObject({
      source: 'helm', state: 'resolved', readiness: true,
      project: { id: 11, directory_name: 'cards' },
    });
    expect(identities.resolveUser(7)).toMatchObject({
      source: 'helm', state: 'resolved', readiness: true,
      user: { id: 7, telegramId: 700, role: 'owner' },
    });
    helm.close();
  });

  it('T2 resolves the native project by its OWN id — a numeric id never leaks in from any legacy source', () => {
    const t = tempDb(); cleanups.push(t.cleanup);
    const helm = new DatabaseService(t.dbPath);
    // Native id=1 is 'cards'. There is no external db to collide with: identity is native-only by
    // construction, so an id that only ever existed in a legacy db can never resolve here.
    helm.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?, ?, ?)').run(1, 'Cards', '/work/cards');
    const identity = new HelmIdentityService(helm);

    expect(identity.resolveProject(1)).toMatchObject({
      source: 'helm', state: 'resolved', readiness: true, project: { id: 1, directory_name: 'cards' },
    });
    // An id with no native row fails closed with a null project — no fallback, no ghost.
    expect(identity.resolveProject(999)).toMatchObject({ source: 'none', state: 'missing', readiness: false, project: null });
    helm.close();
  });

  it('T3 denies inactive/missing identities and native read errors without any fallback', () => {
    const t = tempDb(); cleanups.push(t.cleanup);
    const helm = new DatabaseService(t.dbPath);
    helm.raw.prepare('INSERT INTO projects (id, name, directory, active) VALUES (?, ?, ?, 0)').run(4, 'Inactive', '/work/inactive');
    helm.raw.prepare("INSERT INTO users (id, telegram_id, role, active) VALUES (?, ?, 'viewer', 0)").run(9, 900);
    const identities = new HelmIdentityService(helm);

    expect(identities.resolveProject(4)).toMatchObject({ source: 'none', state: 'inactive', readiness: false, project: null });
    expect(identities.resolveProject(404)).toMatchObject({ source: 'none', state: 'missing', readiness: false, project: null });
    expect(identities.resolveUser(9)).toMatchObject({ source: 'none', state: 'inactive', readiness: false });
    helm.raw.exec('DROP TABLE projects');
    expect(identities.resolveProject(4)).toMatchObject({ source: 'none', state: 'error', readiness: false, project: null });
    helm.close();
  });
});
