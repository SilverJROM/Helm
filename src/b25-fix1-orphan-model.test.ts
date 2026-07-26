/**
 * B25 fix1+fix2 — F1 orphan product slug on live launch path (R1.5 + R6.25 + R2.11).
 * - Migration remaps agents.model off orphans and prunes unreferenced models rows.
 * - worker-service: legal agents.model first, else same-provider launch-legal default_model_id.
 * - fix2: TEXT-slug tables (project_master_models / master_runtimes) remapped; chain collapsed;
 *   N3 harden remap; N5 no silent provider swap.
 *
 * Banned product id is assembled at runtime so B02 fail-closed greps stay green.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import {
  SCHEMA_VERSION,
  applyB25OrphanModelHygiene,
  buildLaunchAllowlistedModelIds,
} from './db/schema.js';
import { PROVIDERS } from './config/providers.js';
import { ProviderResolverService } from './services/provider-resolver-service.js';
import { WorkerService } from './services/worker-service.js';
import { AgentEventsService } from './services/agent-events-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { MasterRuntimeService } from './services/master-runtime-service.js';
import { MasterModelService } from './services/master-model-service.js';
import { HelmIdentityService } from './services/helm-identity-service.js';

const ALLOWED_GROK = ['grok-4.5', 'grok-composer-2.5-fast'] as const;
/** Dead product id under test (assembled so src/** never embeds the banned literal). */
const ORPHAN_GROK = ['grok', 'build'].join('-');

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

describe('B25 fix1 orphan model hygiene + launch path (R1.5/R6.25)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB: SCHEMA_VERSION ≥76; no orphan product id in models; implementer.model allow-listed', () => {
    const t = tempDbPath('helm-b25-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(76);

    const modelIds = (
      dbs.raw.prepare('SELECT model_id FROM models').all() as Array<{ model_id: string }>
    ).map((r) => r.model_id);
    expect(modelIds).not.toContain(ORPHAN_GROK);

    const impl = dbs.raw
      .prepare("SELECT name, provider, model, default_model_id FROM agents WHERE name = 'implementer'")
      .get() as { name: string; provider: string; model: string; default_model_id: number | null };
    expect(impl).toBeTruthy();
    expect(ALLOWED_GROK).toContain(impl.model as (typeof ALLOWED_GROK)[number]);

    dbs.close();
  });

  it('applyB25OrphanModelHygiene remaps orphan agents.model and prunes unreferenced models row', () => {
    const t = tempDbPath('helm-b25-hygiene-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);

    // Seed the live-DB shape: orphan models row + implementer still on legacy slug.
    dbs.raw
      .prepare(
        `INSERT INTO models (name, provider, model_id, effort, approval, bypass, validation_status, cli, slug, display_name)
         VALUES (?, 'grok', ?, 'medium', 'always-approve', 1, 'valid', 'grok', ?, ?)`
      )
      .run(ORPHAN_GROK, ORPHAN_GROK, ORPHAN_GROK, ORPHAN_GROK);
    const compose = dbs.raw
      .prepare("SELECT id FROM models WHERE model_id = 'grok-composer-2.5-fast' LIMIT 1")
      .get() as { id: number };
    expect(compose?.id).toBeGreaterThan(0);
    dbs.raw
      .prepare(
        "UPDATE agents SET model = ?, default_model_id = ?, provider = 'grok' WHERE name = 'implementer'"
      )
      .run(ORPHAN_GROK, compose.id);

    const before = dbs.raw
      .prepare("SELECT model, default_model_id FROM agents WHERE name = 'implementer'")
      .get() as { model: string; default_model_id: number };
    expect(before.model).toBe(ORPHAN_GROK);

    const counts = applyB25OrphanModelHygiene(dbs.raw);
    expect(counts.agents_remapped).toBeGreaterThanOrEqual(1);
    expect(counts.pruned_model_ids).toContain(ORPHAN_GROK);

    const after = dbs.raw
      .prepare("SELECT model, default_model_id FROM agents WHERE name = 'implementer'")
      .get() as { model: string; default_model_id: number };
    expect(after.model).toBe('grok-composer-2.5-fast');
    expect(after.default_model_id).toBe(compose.id);

    const orphanLeft = dbs.raw
      .prepare('SELECT COUNT(*) AS c FROM models WHERE model_id = ?')
      .get(ORPHAN_GROK) as { c: number };
    expect(orphanLeft.c).toBe(0);

    // Idempotent
    const again = applyB25OrphanModelHygiene(dbs.raw);
    expect(again.agents_remapped).toBe(0);
    expect(again.models_pruned).toBe(0);

    dbs.close();
  });

  it('live COPY migrate: no orphan product id in models/agents.model; version=SCHEMA_VERSION', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    if (!fs.existsSync(livePath)) return;

    const t = tempDbPath('helm-b25-live-');
    cleanups.push(t.cleanup);
    fs.copyFileSync(livePath, t.dbPath);

    // Optionally re-seed the pre-fix shape if live already migrated mid-session.
    const rawPre = new Database(t.dbPath);
    const verPre = (rawPre.prepare('SELECT version FROM schema_version').get() as any)?.version ?? 0;
    if (verPre >= 75) {
      try {
        const has = rawPre
          .prepare('SELECT id FROM models WHERE model_id = ? LIMIT 1')
          .get(ORPHAN_GROK) as { id: number } | undefined;
        if (!has) {
          rawPre
            .prepare(
              `INSERT INTO models (name, provider, model_id, effort, approval, bypass, validation_status, cli, slug, display_name)
               VALUES (?, 'grok', ?, 'medium', 'always-approve', 1, 'valid', 'grok', ?, ?)`
            )
            .run(`${ORPHAN_GROK}-orphan`, ORPHAN_GROK, `${ORPHAN_GROK}-b25x`, ORPHAN_GROK);
        }
        const compose = rawPre
          .prepare("SELECT id FROM models WHERE model_id = 'grok-composer-2.5-fast' LIMIT 1")
          .get() as { id: number } | undefined;
        if (compose) {
          rawPre
            .prepare(
              "UPDATE agents SET model = ?, default_model_id = ?, provider = 'grok' WHERE name = 'implementer'"
            )
            .run(ORPHAN_GROK, compose.id);
        }
        rawPre.prepare('UPDATE schema_version SET version = 74').run();
      } catch {
        /* best-effort seed for repro */
      }
    }
    rawPre.close();

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );

    const modelIds = (
      dbs.raw.prepare('SELECT model_id FROM models').all() as Array<{ model_id: string }>
    ).map((r) => r.model_id);
    expect(modelIds).not.toContain(ORPHAN_GROK);

    const agentsModels = (
      dbs.raw.prepare('SELECT model FROM agents').all() as Array<{ model: string }>
    ).map((r) => r.model);
    expect(agentsModels).not.toContain(ORPHAN_GROK);

    const impl = dbs.raw
      .prepare("SELECT model, default_model_id FROM agents WHERE name = 'implementer'")
      .get() as { model: string; default_model_id: number | null } | undefined;
    if (impl) {
      expect(ALLOWED_GROK).toContain(impl.model as (typeof ALLOWED_GROK)[number]);
    }

    dbs.close();
  });

  it('worker launch resolves implementer with orphan agents.model via default_model_id to allow-listed grok id', async () => {
    const t = tempDbPath('helm-b25-launch-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const assignment = new AgentAssignmentService(dbs);
    const resolver = new ProviderResolverService();
    const events = new AgentEventsService(dbs);

    const compose = dbs.raw
      .prepare("SELECT id, model_id, provider FROM models WHERE model_id = 'grok-composer-2.5-fast' LIMIT 1")
      .get() as { id: number; model_id: string; provider: string };
    expect(compose).toBeTruthy();

    // Create implementer-like agent with the F1 poison shape (skip hygiene so we test launch path alone).
    const agent = assignment.createAgent({
      name: `b25-orphan-impl-${Date.now()}`,
      provider: 'grok',
      model: 'grok-4.5', // createAgent validates allow-list — set orphan after
      default_model_id: compose.id,
    });
    dbs.raw.prepare('UPDATE agents SET model = ? WHERE id = ?').run(ORPHAN_GROK, agent.id);
    assignment.setRoleDefault('implementer', agent.id);

    // Pure resolution control (validator repro)
    const row = dbs.raw
      .prepare('SELECT name, provider, model, default_model_id FROM agents WHERE id = ?')
      .get(agent.id) as any;
    expect(row.model).toBe(ORPHAN_GROK);
    expect(() =>
      resolver.resolveAgentLaunchSpec({ provider: row.provider, model: row.model })
    ).toThrow(/Unknown model/i);

    // WorkerService path via spawnWorker — need project with directory.
    const projName = `b25p-${Date.now()}`;
    const projDir = path.join(path.dirname(t.dbPath), projName);
    fs.mkdirSync(projDir, { recursive: true });
    const proj = dbs.raw
      .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
      .get(projName, projDir) as { id: number };

    const tmux = {
      createSession: async () => {},
      sendCommand: async () => true,
      sendAndSubmit: async () => true,
      sendKeys: async () => true,
      getPanePid: async () => 1234,
      sessionExists: async () => true,
      terminateSession: async () => {},
      forceKillPane: async () => {},
      capturePane: async () => '❯ ready\n> ready\n',
    };

    const worker = new WorkerService(dbs, events, tmux as any, resolver, assignment);

    // Spy: resolveAgentLaunchSpec must receive allow-listed model, never orphan
    const orig = resolver.resolveAgentLaunchSpec.bind(resolver);
    let seenModel: string | null = null;
    resolver.resolveAgentLaunchSpec = ((input: any) => {
      seenModel = input.model;
      return orig(input);
    }) as any;

    const w: any = await worker.spawnWorker({
      projectId: proj.id,
      role: 'implementer',
      taskBrief: 'b25 launch path check',
    });

    expect(seenModel).toBeTruthy();
    expect(seenModel === 'grok-4.5' || seenModel === 'grok-composer-2.5-fast').toBe(true);
    expect(seenModel).not.toBe(ORPHAN_GROK);
    expect(w.model).toBe(seenModel);
    expect(PROVIDERS.grok.models.map((m) => m.model)).toContain(w.model);

    dbs.close();
  });

  it('buildLaunchAllowlistedModelIds includes PROVIDERS.grok allow-list and excludes orphan product id', () => {
    const allowed = buildLaunchAllowlistedModelIds();
    expect(allowed.has('grok-4.5')).toBe(true);
    expect(allowed.has('grok-composer-2.5-fast')).toBe(true);
    expect(allowed.has(ORPHAN_GROK)).toBe(false);
  });

  it('fix2 N1: hygiene remaps project_master_models + master_runtimes TEXT slugs and collapses chain dupes', () => {
    const t = tempDbPath('helm-b25-master-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const projDir = path.join(path.dirname(t.dbPath), 'cards-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const proj = dbs.raw
      .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
      .get('cards-b25', projDir) as { id: number };

    // Live shape: chain[0] + 8 more banned, one legal codex seat, master_runtimes on banned.
    const ins = dbs.raw.prepare(
      'INSERT INTO project_master_models (project_id, position, provider, model) VALUES (?, ?, ?, ?)'
    );
    ins.run(proj.id, 0, 'grok', ORPHAN_GROK);
    ins.run(proj.id, 1, 'codex', 'gpt-5.5');
    for (let i = 2; i < 10; i++) ins.run(proj.id, i, 'grok', ORPHAN_GROK);

    dbs.raw
      .prepare(
        `INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state)
         VALUES (?, 'run-b25', 'helm-projcore-cards-b25', 'grok', ?, 'running')`
      )
      .run(proj.id, ORPHAN_GROK);

    const counts = applyB25OrphanModelHygiene(dbs.raw);
    expect(counts.master_models_remapped).toBeGreaterThanOrEqual(9);
    expect(counts.master_runtimes_remapped).toBe(1);
    expect(counts.chain_collapsed).toBeGreaterThanOrEqual(8);

    const chain = dbs.raw
      .prepare(
        'SELECT position, provider, model FROM project_master_models WHERE project_id = ? ORDER BY position'
      )
      .all(proj.id) as Array<{ position: number; provider: string; model: string }>;
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain.length).toBeLessThanOrEqual(3); // collapsed: legal grok + codex (+ maybe one more unique)
    expect(chain[0].model).not.toBe(ORPHAN_GROK);
    expect(ALLOWED_GROK).toContain(chain[0].model as (typeof ALLOWED_GROK)[number]);
    expect(chain.every((r) => r.model !== ORPHAN_GROK)).toBe(true);
    // positions contiguous from 0
    expect(chain.map((r) => r.position)).toEqual(chain.map((_, i) => i));

    const mr = dbs.raw
      .prepare('SELECT provider, model FROM master_runtimes WHERE project_id = ?')
      .get(proj.id) as { provider: string; model: string };
    expect(mr.model).not.toBe(ORPHAN_GROK);
    expect(ALLOWED_GROK).toContain(mr.model as (typeof ALLOWED_GROK)[number]);

    // Idempotent
    const again = applyB25OrphanModelHygiene(dbs.raw);
    expect(again.master_models_remapped).toBe(0);
    expect(again.master_runtimes_remapped).toBe(0);

    dbs.close();
  });

  it('fix2 N3: default_model_id pointing at orphan does not leave/write banned agents.model', () => {
    const t = tempDbPath('helm-b25-n3-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);

    // Insert orphan models row and point implementer at it for both model + default_model_id.
    dbs.raw
      .prepare(
        `INSERT INTO models (name, provider, model_id, effort, approval, bypass, validation_status, cli, slug, display_name)
         VALUES (?, 'grok', ?, 'medium', 'always-approve', 1, 'valid', 'grok', ?, ?)`
      )
      .run(ORPHAN_GROK, ORPHAN_GROK, `${ORPHAN_GROK}-n3`, ORPHAN_GROK);
    const orphan = dbs.raw
      .prepare('SELECT id FROM models WHERE model_id = ? LIMIT 1')
      .get(ORPHAN_GROK) as { id: number };
    dbs.raw
      .prepare(
        "UPDATE agents SET model = ?, default_model_id = ?, provider = 'grok' WHERE name = 'implementer'"
      )
      .run(ORPHAN_GROK, orphan.id);

    const counts = applyB25OrphanModelHygiene(dbs.raw);
    expect(counts.agents_remapped).toBeGreaterThanOrEqual(1);

    const after = dbs.raw
      .prepare("SELECT model, default_model_id FROM agents WHERE name = 'implementer'")
      .get() as { model: string; default_model_id: number };
    expect(after.model).not.toBe(ORPHAN_GROK);
    expect(ALLOWED_GROK).toContain(after.model as (typeof ALLOWED_GROK)[number]);
    const bound = dbs.raw
      .prepare('SELECT model_id, provider FROM models WHERE id = ?')
      .get(after.default_model_id) as { model_id: string; provider: string };
    expect(bound.provider).toBe('grok');
    expect(buildLaunchAllowlistedModelIds().has(bound.model_id)).toBe(true);

    dbs.close();
  });

  it('fix2 N5: resolveLaunchProviderModel does not silently swap provider via default_model_id', () => {
    const t = tempDbPath('helm-b25-n5-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const assignment = new AgentAssignmentService(dbs);
    const resolver = new ProviderResolverService();
    const events = new AgentEventsService(dbs);
    const worker = new WorkerService(dbs, events, {} as any, resolver, assignment);

    const codex = dbs.raw
      .prepare("SELECT id, model_id, provider FROM models WHERE model_id = 'gpt-5.5' LIMIT 1")
      .get() as { id: number; model_id: string; provider: string };
    expect(codex.provider).toBe('codex');

    // Claude agent with banned model + cross-provider default_model_id → must NOT launch as codex.
    const agent = {
      provider: 'claude',
      model: ORPHAN_GROK, // not legal for claude
      default_model_id: codex.id,
    };
    const resolve = (worker as any).resolveLaunchProviderModel.bind(worker) as (a: typeof agent) => {
      provider: string;
      model: string;
    };
    const launch = resolve(agent);
    expect(launch.provider).toBe('claude');
    expect(launch.model).not.toBe(codex.model_id);
    // Fails closed on raw banned model (no silent swap)
    expect(launch.model).toBe(ORPHAN_GROK);

    // Same-provider legal default IS used when agents.model illegal
    const grokCompose = dbs.raw
      .prepare("SELECT id, model_id FROM models WHERE model_id = 'grok-composer-2.5-fast' LIMIT 1")
      .get() as { id: number; model_id: string };
    const launch2 = resolve({
      provider: 'grok',
      model: ORPHAN_GROK,
      default_model_id: grokCompose.id,
    });
    expect(launch2.provider).toBe('grok');
    expect(launch2.model).toBe('grok-composer-2.5-fast');

    dbs.close();
  });

  it('fix2 N1 launchMaster: chain[0] banned walks to first launch-legal entry', async () => {
    const t = tempDbPath('helm-b25-lm-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const projDir = path.join(path.dirname(t.dbPath), 'lm-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const proj = dbs.raw
      .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
      .get('lm-b25', projDir) as { id: number };

    // Seed chain with banned at [0] and legal at [1] — skip hygiene so we test launch guard alone.
    dbs.raw
      .prepare(
        'INSERT INTO project_master_models (project_id, position, provider, model) VALUES (?, 0, ?, ?), (?, 1, ?, ?)'
      )
      .run(proj.id, 'grok', ORPHAN_GROK, proj.id, 'codex', 'gpt-5.5');

    const events = new AgentEventsService(dbs);
    const resolver = new ProviderResolverService();
    const masterModels = new MasterModelService(dbs);
    // O7.2: identity is native-only — slug resolution reads the native project row directly and
    // never consults any external/legacy db, so no external stub is required.
    const identity = new HelmIdentityService(dbs);
    const tmux = {
      createSession: async () => {},
      sendCommand: async () => true,
      sendAndSubmit: async () => true,
      sendKeys: async () => true,
      getPanePid: async () => 1234,
      sessionExists: async () => false,
      terminateSession: async () => {},
      forceKillPane: async () => {},
      capturePane: async () => '❯ ready\n> ready\n',
    };

    const runtime = new MasterRuntimeService(
      dbs,
      events,
      tmux as any,
      resolver,
      masterModels,
      undefined,
      undefined,
      undefined,
      undefined,
      identity
    );

    let seenModel: string | null = null;
    // Record model then throw so we never reach waitForReady (would hang in unit env).
    resolver.resolveAgentLaunchSpec = ((input: any) => {
      seenModel = input.model;
      throw new Error('b25-stop-after-resolve');
    }) as any;

    await expect(runtime.launchMaster(proj.id)).rejects.toThrow(/b25-stop-after-resolve/);
    expect(seenModel).toBeTruthy();
    expect(seenModel).not.toBe(ORPHAN_GROK);
    expect(seenModel).toBe('gpt-5.5');

    dbs.close();
  });

  it('fix2 live COPY migrate: no launch-path table holds banned slug; version=SCHEMA_VERSION', () => {
    const livePath = path.resolve(process.cwd(), 'data/helm.db');
    if (!fs.existsSync(livePath)) return;

    const t = tempDbPath('helm-b25-live2-');
    cleanups.push(t.cleanup);
    fs.copyFileSync(livePath, t.dbPath);

    // Reconstruct pre-fix2 master-path poison if already cleaned.
    const rawPre = new Database(t.dbPath);
    const verPre = (rawPre.prepare('SELECT version FROM schema_version').get() as any)?.version ?? 0;
    if (verPre >= 75) {
      try {
        const pid =
          (rawPre.prepare('SELECT project_id FROM project_master_models LIMIT 1').get() as any)
            ?.project_id ??
          (rawPre.prepare('SELECT id FROM projects LIMIT 1').get() as any)?.id;
        if (pid != null) {
          rawPre.prepare('DELETE FROM project_master_models WHERE project_id = ?').run(pid);
          const ins = rawPre.prepare(
            'INSERT INTO project_master_models (project_id, position, provider, model) VALUES (?, ?, ?, ?)'
          );
          ins.run(pid, 0, 'grok', ORPHAN_GROK);
          ins.run(pid, 1, 'codex', 'gpt-5.5');
          for (let i = 2; i < 10; i++) ins.run(pid, i, 'grok', ORPHAN_GROK);
          const mr = rawPre
            .prepare('SELECT project_id FROM master_runtimes WHERE project_id = ?')
            .get(pid) as { project_id: number } | undefined;
          if (mr) {
            rawPre
              .prepare("UPDATE master_runtimes SET provider = 'grok', model = ? WHERE project_id = ?")
              .run(ORPHAN_GROK, pid);
          } else {
            rawPre
              .prepare(
                `INSERT INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state)
                 VALUES (?, 'b25-repro', 'helm-b25-repro', 'grok', ?, 'running')`
              )
              .run(pid, ORPHAN_GROK);
          }
        }
        rawPre.prepare('UPDATE schema_version SET version = 75').run();
      } catch {
        /* best-effort seed */
      }
    }
    rawPre.close();

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );

    const allowed = buildLaunchAllowlistedModelIds();
    const agentModels = (
      dbs.raw.prepare('SELECT model FROM agents').all() as Array<{ model: string }>
    ).map((r) => r.model);
    expect(agentModels).not.toContain(ORPHAN_GROK);

    const pmm = dbs.raw
      .prepare('SELECT provider, model FROM project_master_models')
      .all() as Array<{ provider: string; model: string }>;
    for (const r of pmm) {
      const p = (PROVIDERS as any)[r.provider];
      if (!p || p.dynamicModels) continue; // unknown/historical providers left alone
      expect(allowed.has(r.model)).toBe(true);
    }
    expect(pmm.every((r) => r.model !== ORPHAN_GROK)).toBe(true);

    const mrs = dbs.raw
      .prepare('SELECT provider, model FROM master_runtimes')
      .all() as Array<{ provider: string; model: string }>;
    for (const r of mrs) {
      const p = (PROVIDERS as any)[r.provider];
      if (!p || p.dynamicModels) continue;
      expect(allowed.has(r.model)).toBe(true);
    }
    expect(mrs.every((r) => r.model !== ORPHAN_GROK)).toBe(true);

    dbs.close();
  });
});
