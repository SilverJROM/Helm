/**
 * S16 — GATE-ATOMIC: house + tiered Studio tier editor persistence (AC28/29/31).
 *
 * Temp-DB service/API harness only. Proves main + two backups + definition_md
 * round-trip for the seeded housekeeper without live DB mutation.
 * HELM_SESSION_JANITOR must stay 0.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';
import { HOUSEKEEPER_DEFINITION_MD } from './db/schema.js';

const STUDIO = { surface: 'studio' as const };
const LIVE_DB = path.join(process.cwd(), 'data', 'helm.db');

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-s16-${process.pid}.db`);
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

function liveDbMeta(): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(LIVE_DB);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function modelIdBySlug(dbs: DatabaseService, slugRe: RegExp): number {
  const rows = dbs.raw
    .prepare('SELECT id, slug, name, model_id FROM models ORDER BY id')
    .all() as Array<{ id: number; slug: string | null; name: string; model_id: string }>;
  const hit = rows.find((r) => slugRe.test(r.slug || r.name || r.model_id));
  expect(hit, `expected a model matching ${slugRe}`).toBeTruthy();
  return hit!.id;
}

describe('S16 house+tiered Studio persistence (AC28/29/31)', () => {
  const cleanups: Array<() => void> = [];
  const prevJanitor = process.env.HELM_SESSION_JANITOR;
  let liveBefore: { mtimeMs: number; size: number } | null;

  beforeEach(() => {
    process.env.HELM_SESSION_JANITOR = '0';
    liveBefore = liveDbMeta();
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    if (prevJanitor === undefined) delete process.env.HELM_SESSION_JANITOR;
    else process.env.HELM_SESSION_JANITOR = prevJanitor;
    const liveAfter = liveDbMeta();
    if (liveBefore && liveAfter) {
      expect(liveAfter.mtimeMs).toBe(liveBefore.mtimeMs);
      expect(liveAfter.size).toBe(liveBefore.size);
    }
  });

  it('service: change backup-2 + definition_md then reload housekeeper main+2', () => {
    const t = tempDbPath('helm-s16-svc-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);

    const hk = as.listAgents().find((a) => a.name === 'housekeeper');
    expect(hk, 'housekeeper seed required').toBeTruthy();
    expect(hk!.agent_type).toBe('house');
    expect(hk!.kind).toBe('house');
    expect(hk!.classification).toBe('tiered');
    expect(hk!.default_model_id).toBeTruthy();
    expect(String(hk!.definition_md || '')).toMatch(/keep-biased/i);

    const esc0 = as.listAgentEscalations(hk!.id);
    expect(esc0.map((e) => e.position).sort()).toEqual([1, 2]);
    const pos1Model = Number(esc0.find((e) => Number(e.position) === 1)!.model_id);
    const mainBefore = hk!.default_model_id;

    // Alternate backup-2 (position=2) to a distinct seeded model (not haiku if possible).
    const altBackup2 = modelIdBySlug(dbs, /sonnet|opus|codex/i);
    expect(altBackup2).not.toBe(Number(esc0.find((e) => Number(e.position) === 2)!.model_id));

    const customMd =
      '# S16 studio-edited housekeeper prompt\n\nKeep-biased + needs-human guardrail still present.\n';
    as.updateAgent(
      hk!.id,
      {
        definition_md: customMd,
        classification: 'tiered',
        default_model_id: mainBefore,
      },
      STUDIO
    );
    as.setAgentEscalations(
      hk!.id,
      [
        { position: 1, model_id: pos1Model, trigger: 'on-fail' },
        { position: 2, model_id: altBackup2, trigger: 'on-fail' },
      ],
      STUDIO
    );

    const reloaded = as.getAgent(hk!.id)!;
    expect(reloaded.agent_type).toBe('house');
    expect(reloaded.classification).toBe('tiered');
    expect(reloaded.default_model_id).toBe(mainBefore);
    expect(reloaded.definition_md).toBe(customMd);

    const esc1 = as.listAgentEscalations(hk!.id);
    expect(esc1).toHaveLength(2);
    expect(Number(esc1.find((e) => Number(e.position) === 1)!.model_id)).toBe(pos1Model);
    expect(Number(esc1.find((e) => Number(e.position) === 2)!.model_id)).toBe(altBackup2);

    // Seed text still available for empty-fill path; user edit not clobbered by re-read.
    expect(HOUSEKEEPER_DEFINITION_MD).toMatch(/Keep-biased/i);
    expect(process.env.HELM_SESSION_JANITOR).toBe('0');
    dbs.close();
  });

  it('API inject: PUT agent definition_md + PUT escalations backup-2 for house+tiered', async () => {
    const t = tempDbPath('helm-s16-api-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const hk = as.listAgents().find((a) => a.name === 'housekeeper')!;
    expect(hk.agent_type).toBe('house');
    expect(hk.classification).toBe('tiered');

    const esc0 = as.listAgentEscalations(hk.id);
    const pos1 = Number(esc0.find((e) => Number(e.position) === 1)!.model_id);
    const pos2Before = Number(esc0.find((e) => Number(e.position) === 2)!.model_id);
    const altBackup2 = modelIdBySlug(dbs, /sonnet|opus|codex/i);
    expect(altBackup2).not.toBe(pos2Before);
    const customMd = '# S16 API-edited housekeeper\n\nEvidence recorded; helm-owned only.\n';

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    const requireLocalLaunchPre = createRequireLocalLaunch();
    const authMiddleware = ownerAuth;

    // Production-shaped routes (mirror index.ts agent PUT + escalations PUT/GET).
    app.get('/api/agents/:id', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
      const id = Number(request.params.id);
      const agent = as.getAgent(id);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      return { agent, identity: agent.definition_md, tiers: as.listAgentTierModels(id) };
    });
    app.put(
      '/api/agents/:id',
      { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
      async (request: any, reply: any) => {
        const id = Number(request.params.id);
        if (!as.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
        try {
          const agent = as.updateAgent(id, request.body || {}, { surface: 'studio' });
          return { agent };
        } catch (e: any) {
          return reply.code(400).send({ error: e.message });
        }
      }
    );
    app.get(
      '/api/agents/:id/escalations',
      { preHandler: [authMiddleware, requireOwnerPre] },
      async (request: any, reply: any) => {
        const id = Number(request.params.id);
        if (!as.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
        return { escalations: as.listAgentEscalations(id) };
      }
    );
    app.put(
      '/api/agents/:id/escalations',
      { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
      async (request: any, reply: any) => {
        const id = Number(request.params.id);
        if (!as.getAgent(id)) return reply.code(404).send({ error: 'unknown agent' });
        try {
          const body = request.body || {};
          const rungs = body.rungs !== undefined ? body.rungs : body || [];
          return { escalations: as.setAgentEscalations(id, rungs) };
        } catch (e: any) {
          return reply.code(400).send({ error: e.message });
        }
      }
    );
    await app.ready();

    const putAgent = await app.inject({
      method: 'PUT',
      url: `/api/agents/${hk.id}`,
      remoteAddress: '127.0.0.1',
      payload: {
        definition_md: customMd,
        classification: 'tiered',
        default_model_id: hk.default_model_id,
        spawn_pref: 'tmux',
      },
    });
    expect(putAgent.statusCode).toBe(200);
    expect(putAgent.json().agent.definition_md).toBe(customMd);
    expect(putAgent.json().agent.agent_type).toBe('house');
    expect(putAgent.json().agent.classification).toBe('tiered');

    const putEsc = await app.inject({
      method: 'PUT',
      url: `/api/agents/${hk.id}/escalations`,
      remoteAddress: '127.0.0.1',
      payload: {
        rungs: [
          { position: 1, model_id: pos1, trigger: 'on-fail' },
          { position: 2, model_id: altBackup2, trigger: 'on-fail' },
        ],
      },
    });
    expect(putEsc.statusCode).toBe(200);
    const escBody = putEsc.json().escalations as Array<{ position: number; model_id: number }>;
    expect(escBody.map((e) => Number(e.position)).sort()).toEqual([1, 2]);
    expect(Number(escBody.find((e) => Number(e.position) === 2)!.model_id)).toBe(altBackup2);

    const getAgent = await app.inject({
      method: 'GET',
      url: `/api/agents/${hk.id}`,
      remoteAddress: '127.0.0.1',
    });
    expect(getAgent.statusCode).toBe(200);
    const body = getAgent.json();
    expect(body.agent.definition_md).toBe(customMd);
    expect(body.agent.default_model_id).toBe(hk.default_model_id);
    expect(body.agent.agent_type).toBe('house');
    expect(body.agent.classification).toBe('tiered');

    const getEsc = await app.inject({
      method: 'GET',
      url: `/api/agents/${hk.id}/escalations`,
      remoteAddress: '127.0.0.1',
    });
    expect(getEsc.statusCode).toBe(200);
    const reEsc = getEsc.json().escalations as Array<{ position: number; model_id: number }>;
    expect(Number(reEsc.find((e) => Number(e.position) === 1)!.model_id)).toBe(pos1);
    expect(Number(reEsc.find((e) => Number(e.position) === 2)!.model_id)).toBe(altBackup2);

    expect(process.env.HELM_SESSION_JANITOR).toBe('0');
    await app.close();
    dbs.close();
  });
});
