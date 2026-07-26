import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { AgentEventsService } from './agent-events-service.js';
import { ProviderResolverService } from './provider-resolver-service.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { MasterModelService } from './master-model-service.js';
import { MasterRuntimeService } from './master-runtime-service.js';
import { WorkerService } from './worker-service.js';
import { HelmIdentityService, requireActiveNativeProject } from './helm-identity-service.js';

function fakeTmux() {
  const created: string[] = [];
  return {
    created,
    sessionExists: async () => false,
    createSession: async (name: string) => { created.push(name); },
    sendCommand: async () => ({ blocked: false, message: 'sent' }),
    sendAndSubmit: async () => true,
    sendEnter: async () => {},
    sendKeys: async () => ({ blocked: false }),
    capturePane: async () => '❯ ready\n',
    terminateSession: async () => {},
    getPanePid: async () => '1234',
    listPanes: async () => [],
    forceKillPane: async () => {},
  } as any;
}

describe('O4.1/O7.2 launch-path identity wiring (MasterModelService + MasterRuntimeService + WorkerService)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function setup() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-o41-'));
    const dbs = new DatabaseService(path.join(tmpRoot, 'helm.db'));
    const events = new AgentEventsService(dbs);
    const resolver = new ProviderResolverService();
    const assignment = new AgentAssignmentService(dbs);
    const agent = assignment.createAgent({ name: 'o41-grok', provider: 'grok', model: 'grok-4.5' });
    assignment.setRoleDefault('implementer', agent.id);
    const cleanup = () => { try { dbs.close(); } catch {}; try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} };
    cleanups.push(cleanup);
    return { tmpRoot, dbs, events, resolver, assignment, cleanup };
  }

  function seedNativeProject(dbs: DatabaseService, tmpRoot: string, id: number, dirPrefix: string, opts?: { active?: number; status?: string }) {
    const dir = fs.mkdtempSync(path.join(tmpRoot, `${dirPrefix}-`));
    dbs.raw.prepare('INSERT INTO projects (id, name, directory, status, active) VALUES (?, ?, ?, ?, ?)')
      .run(id, dirPrefix, dir, opts?.status ?? 'active', opts?.active ?? 1);
    return path.basename(dir);
  }

  it('T1 all three launch-path services resolve the native slug for an active project (AC1/AC3/AC4)', async () => {
    const { tmpRoot, dbs, events, resolver, assignment } = setup();
    // O7.2: identity is native-only — there is no legacy db to read, so the id=1 slug can ONLY be
    // the native project's directory_name ('cards'). The old agjDb-by-id collision is impossible.
    const nativeSlug = seedNativeProject(dbs, tmpRoot, 1, 'cards');
    const identity = new HelmIdentityService(dbs);

    const masterModels = new MasterModelService(dbs, identity);
    expect(() => masterModels.setChain(1, [{ provider: 'grok', model: 'grok-4.5' }])).not.toThrow();

    const tmux1 = fakeTmux();
    const runtime = new MasterRuntimeService(dbs, events, tmux1, resolver, masterModels, undefined, assignment, undefined, undefined, identity);
    const launch = await runtime.launchMaster(1);
    expect(launch.session).toContain(nativeSlug);
    expect(launch.session).not.toContain('EHR');
    expect(tmux1.created.some((n: string) => n.includes(nativeSlug))).toBe(true);
    expect(tmux1.created.some((n: string) => n.includes('EHR'))).toBe(false);

    const tmux2 = fakeTmux();
    const worker = new WorkerService(dbs, events, tmux2, resolver, assignment, undefined, undefined, identity);
    const w: any = await worker.spawnWorker({ projectId: 1, role: 'implementer', taskBrief: 'o4.1 T1' });
    expect(w.session).toContain(nativeSlug);
    expect(w.session).not.toContain('EHR');
    expect(tmux2.created.some((n: string) => n.includes(nativeSlug))).toBe(true);
    expect(tmux2.created.some((n: string) => n.includes('EHR'))).toBe(false);
  });

  it('T2 inactive native project fails closed before any tmux/model-chain/runtime/task mutation (AC2)', async () => {
    const { tmpRoot, dbs, events, resolver, assignment } = setup();
    seedNativeProject(dbs, tmpRoot, 2, 'inactive-proj', { active: 0 });
    const identity = new HelmIdentityService(dbs);

    const masterModels = new MasterModelService(dbs, identity);
    expect(() => masterModels.setChain(2, [{ provider: 'grok', model: 'grok-4.5' }])).toThrow();
    expect(dbs.prepare('SELECT COUNT(*) as c FROM project_master_models WHERE project_id = ?').get(2)).toMatchObject({ c: 0 });

    const tmux1 = fakeTmux();
    const runtime = new MasterRuntimeService(dbs, events, tmux1, resolver, masterModels, undefined, assignment, undefined, undefined, identity);
    await expect(runtime.launchMaster(2)).rejects.toThrow();
    expect(dbs.prepare('SELECT COUNT(*) as c FROM master_runtimes WHERE project_id = ?').get(2)).toMatchObject({ c: 0 });
    expect(tmux1.created.length).toBe(0);

    const tmux2 = fakeTmux();
    const worker = new WorkerService(dbs, events, tmux2, resolver, assignment, undefined, undefined, identity);
    await expect(worker.spawnWorker({ projectId: 2, role: 'implementer', taskBrief: 'o4.1 T2 inactive' })).rejects.toThrow();
    expect(dbs.prepare('SELECT COUNT(*) as c FROM worker_runtimes WHERE project_id = ?').get(2)).toMatchObject({ c: 0 });
    expect(tmux2.created.length).toBe(0);
  });

  it('T2 an id with no native project fails closed before any mutation (AC2/AC4)', async () => {
    const { dbs, events, resolver, assignment } = setup();
    // No native row for id=3 at all. With a native-only identity boundary there is nothing else to
    // read, so it fails closed — the old agjDb-by-id read would have launched a ghost session here.
    const identity = new HelmIdentityService(dbs);

    const masterModels = new MasterModelService(dbs, identity);
    expect(() => masterModels.setChain(3, [{ provider: 'grok', model: 'grok-4.5' }])).toThrow(/unknown OVM project/);
    expect(dbs.prepare('SELECT COUNT(*) as c FROM project_master_models WHERE project_id = ?').get(3)).toMatchObject({ c: 0 });

    const tmux1 = fakeTmux();
    const runtime = new MasterRuntimeService(dbs, events, tmux1, resolver, masterModels, undefined, assignment, undefined, undefined, identity);
    await expect(runtime.launchMaster(3)).rejects.toThrow();
    expect(dbs.prepare('SELECT COUNT(*) as c FROM master_runtimes WHERE project_id = ?').get(3)).toMatchObject({ c: 0 });
    expect(tmux1.created.some((n: string) => n.includes('ghost-legacy-project'))).toBe(false);

    const tmux2 = fakeTmux();
    const worker = new WorkerService(dbs, events, tmux2, resolver, assignment, undefined, undefined, identity);
    await expect(worker.spawnWorker({ projectId: 3, role: 'implementer', taskBrief: 'o4.1 T2 collision' })).rejects.toThrow();
    expect(dbs.prepare('SELECT COUNT(*) as c FROM worker_runtimes WHERE project_id = ?').get(3)).toMatchObject({ c: 0 });
    expect(tmux2.created.some((n: string) => n.includes('ghost-legacy-project'))).toBe(false);
  });

  // T3: the launch ROUTES' active-project gate (switch-model / launch-master in index.ts) must
  // consult the native identity boundary — NOT a direct legacy `agjDb.prepare` numeric-ID read
  // (the validator's O4.1 blocking finding). These drive the REAL guard the routes now call
  // (`requireActiveNativeProject`) against a REAL native-only HelmIdentityService.
  it('T3 route gate resolves the native active project via the identity boundary (AC3)', () => {
    const { tmpRoot, dbs } = setup();
    const nativeSlug = seedNativeProject(dbs, tmpRoot, 1, 'cards');
    const identity = new HelmIdentityService(dbs);

    const guard = requireActiveNativeProject(identity, 1);
    expect(guard.ok).toBe(true);
    if (guard.ok) {
      expect(guard.project.directory_name).toBe(nativeSlug);
      expect(guard.project.directory_name).not.toBe('EHR');
    }
  });

  it('T3 route gate rejects an inactive native project (AC2/AC3) with the 400 message the routes send', () => {
    const { tmpRoot, dbs } = setup();
    seedNativeProject(dbs, tmpRoot, 2, 'inactive-proj', { active: 0 });
    const identity = new HelmIdentityService(dbs);

    expect(requireActiveNativeProject(identity, 2)).toEqual({ ok: false, error: 'unknown or inactive OVM project' });
  });

  it('T3 route gate rejects an id with no native row (AC3/AC4) — no ghost pass', () => {
    const { dbs } = setup();
    // No native row for id=3, and no legacy db exists to resolve it — no ghost switch/launch.
    const identity = new HelmIdentityService(dbs);

    expect(requireActiveNativeProject(identity, 3)).toEqual({ ok: false, error: 'unknown or inactive OVM project' });
  });
});
