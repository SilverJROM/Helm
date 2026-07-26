/**
 * B08 — R2.6 Agent = prompt identity.
 * Identity is definition_md (prompt body), not name/role label alone.
 * Models attach via L1/L2/L3 tiers (default_model_id + agent_escalations).
 * No B07a/b/c fence reopen.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import {
  AgentAssignmentService,
  getAgentPromptIdentity,
  assertRegistryEditable,
} from './services/agent-assignment-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';

const STUDIO = { surface: 'studio' as const };

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

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

function modelIds(dbs: DatabaseService): { m1: number; m2: number; m3: number; m4: number } {
  const rows = dbs.raw.prepare('SELECT id FROM models ORDER BY id LIMIT 4').all() as Array<{ id: number }>;
  expect(rows.length).toBeGreaterThanOrEqual(4);
  return { m1: rows[0].id, m2: rows[1].id, m3: rows[2].id, m4: rows[3].id };
}

describe('B08 agent prompt identity + tier model bindings (R2.6)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const t = tempDbPath('helm-b08-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    return { dbs, as, ...modelIds(dbs) };
  }

  it('identity is definition_md (prompt), not name/model alone', () => {
    const { dbs, as } = setup();
    const prompt = '# implementer\n\nYou build exactly the brief.\n';
    const agent = as.createAgent({
      name: `b08-id-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'grok',
      model: 'grok-4.5',
      definition_md: prompt,
    }, STUDIO);

    expect(getAgentPromptIdentity(agent)).toBe(prompt);
    expect(agent.definition_md).toBe(prompt);
    // name is a label; identity is the prompt body
    expect(getAgentPromptIdentity(agent)).not.toBe(agent.name);
    expect(getAgentPromptIdentity(agent)).not.toBe(agent.model);

    // missing / empty identity → fail-closed
    const bare = as.createAgent({
      name: `b08-bare-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'grok',
      model: 'grok-4.5',
    });
    expect(() => getAgentPromptIdentity(bare)).toThrow(/no prompt identity|definition_md empty/i);
    expect(() => as.createAgent({
      name: `b08-empty-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'grok',
      model: 'grok-4.5',
      definition_md: '   ',
    }, STUDIO)).toThrow(/definition_md is required for agent identity/i);
    expect(() => as.updateAgent(agent.id, { definition_md: '' }, STUDIO)).toThrow(
      /definition_md is required for agent identity/i
    );

    dbs.close();
  });

  it('models attach via L1/L2/L3 tiers; bind does not change prompt identity', () => {
    const { dbs, as, m1, m2, m3, m4 } = setup();
    const prompt = '# single implementer prompt\n\nOne identity; tiers are model bindings.\n';
    const agent = as.createAgent({
      name: `b08-tiers-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'grok',
      model: 'grok-4.5',
      definition_md: prompt,
    }, STUDIO);

    const bound = as.bindAgentTierModels(agent.id, {
      L1: m1,
      L1_backup: m2,
      L2: m3,
      L3: m4,
    });

    expect(bound.identity).toBe(prompt);
    expect(getAgentPromptIdentity(as.getAgent(agent.id)!)).toBe(prompt);

    const l1 = as.resolveAgentTierModel(agent.id, 'L1');
    expect(l1.source).toBe('default_model_id');
    expect(l1.model_id).toBe(m1);
    expect(l1.backup_model_id).toBe(m2);
    expect(l1.provider).toBeTruthy();
    expect(l1.model_ref).toBeTruthy();

    const l2 = as.resolveAgentTierModel(agent.id, 'L2');
    expect(l2.source).toBe('agent_escalations');
    expect(l2.model_id).toBe(m3);

    const l3 = as.resolveAgentTierModel(agent.id, 'L3');
    expect(l3.source).toBe('agent_escalations');
    expect(l3.model_id).toBe(m4);

    // re-bind L1 only — identity and L2/L3 preserved
    const rebound = as.bindAgentTierModels(agent.id, { L1: m2 });
    expect(rebound.identity).toBe(prompt);
    expect(rebound.tiers.L1.model_id).toBe(m2);
    expect(rebound.tiers.L2.model_id).toBe(m3);
    expect(rebound.tiers.L3.model_id).toBe(m4);

    // updateAgent model binding fields must not wipe identity
    as.updateAgent(agent.id, { default_model_id: m1 });
    expect(as.getAgent(agent.id)!.definition_md).toBe(prompt);

    // two agents can share model tiers but differ by prompt identity
    const otherPrompt = '# other role prompt\n\nDifferent identity.\n';
    const other = as.createAgent({
      name: `b08-other-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'grok',
      model: 'grok-4.5',
      definition_md: otherPrompt,
      default_model_id: m1,
    }, STUDIO);
    as.bindAgentTierModels(other.id, { L2: m3, L3: m4 });
    expect(getAgentPromptIdentity(other)).toBe(otherPrompt);
    expect(getAgentPromptIdentity(other)).not.toBe(getAgentPromptIdentity(agent));
    expect(as.resolveAgentTierModel(other.id, 'L1').model_id).toBe(m1);
    expect(as.resolveAgentTierModel(other.id, 'L2').model_id).toBe(m3);

    dbs.close();
  });

  it('API: GET agent returns identity + tiers; PUT /tiers binds models without touching definition_md', async () => {
    const { dbs, as, m1, m2, m3 } = setup();
    const prompt = '# api identity\n\nPrompt body.\n';
    const agent = as.createAgent({
      name: `b08-api-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      definition_md: prompt,
    }, STUDIO);

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    const requireLocalLaunchPre = createRequireLocalLaunch();
    const authMiddleware = ownerAuth;

    app.get('/api/agents/:id', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
      const id = Number(request.params.id);
      const a = as.getAgent(id);
      if (!a) return reply.code(404).send({ error: 'unknown agent' });
      return { agent: a, identity: a.definition_md, tiers: as.listAgentTierModels(id) };
    });
    app.get('/api/agents/:id/tiers', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
      const id = Number(request.params.id);
      const a = as.getAgent(id);
      if (!a) return reply.code(404).send({ error: 'unknown agent' });
      return { agent_id: id, identity: a.definition_md, tiers: as.listAgentTierModels(id) };
    });
    app.put(
      '/api/agents/:id/tiers',
      { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
      async (request: any, reply: any) => {
        const id = Number(request.params.id);
        if (!as.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
        try {
          const body = request.body || {};
          const partial: { L1?: number | null; L2?: number | null; L3?: number | null } = {};
          if ('L1' in body) partial.L1 = body.L1 == null ? null : Number(body.L1);
          if ('L2' in body) partial.L2 = body.L2 == null ? null : Number(body.L2);
          if ('L3' in body) partial.L3 = body.L3 == null ? null : Number(body.L3);
          return as.bindAgentTierModels(id, partial);
        } catch (e: any) {
          return reply.code(400).send({ error: e.message });
        }
      }
    );

    const getRes = await app.inject({ method: 'GET', url: `/api/agents/${agent.id}`, remoteAddress: '127.0.0.1' });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json();
    expect(getBody.identity).toBe(prompt);
    expect(getBody.agent.definition_md).toBe(prompt);
    expect(getBody.tiers.L1.source).toBe('none');

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/agents/${agent.id}/tiers`,
      remoteAddress: '127.0.0.1',
      payload: { L1: m1, L2: m2, L3: m3 },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = putRes.json();
    expect(putBody.identity).toBe(prompt);
    expect(putBody.tiers.L1.model_id).toBe(m1);
    expect(putBody.tiers.L2.model_id).toBe(m2);
    expect(putBody.tiers.L3.model_id).toBe(m3);
    expect(as.getAgent(agent.id)!.definition_md).toBe(prompt);

    const tiersRes = await app.inject({
      method: 'GET',
      url: `/api/agents/${agent.id}/tiers`,
      remoteAddress: '127.0.0.1',
    });
    expect(tiersRes.statusCode).toBe(200);
    expect(tiersRes.json().identity).toBe(prompt);
    expect(tiersRes.json().tiers.L1.model_id).toBe(m1);

    await app.close();
    dbs.close();
  });

  it('does not reopen B07 fences (house registry-edit still denied on project surface)', () => {
    const { dbs, as, m1 } = setup();
    const house = as.createAgent({
      name: `b08-house-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      kind: 'house',
      definition_md: '# house prompt',
    }, STUDIO);
    expect(() => assertRegistryEditable(house, 'project')).toThrow(
      /project surface cannot edit house\/registry agent definitions/i
    );
    expect(() =>
      as.bindAgentTierModels(house.id, { L1: m1 }, { surface: 'project' })
    ).toThrow(/project surface cannot edit house\/registry agent definitions/i);
    // studio still allowed
    const ok = as.bindAgentTierModels(house.id, { L1: m1 }, { surface: 'studio' });
    expect(ok.identity).toBe('# house prompt');
    expect(ok.tiers.L1.model_id).toBe(m1);
    dbs.close();
  });
});
