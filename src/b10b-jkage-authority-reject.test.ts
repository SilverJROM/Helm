/**
 * B10b — R2.10 / I10: per-surface jkage L0 reject guards.
 * Surfaces from plan/c01-agent-studio-rebuild/validation/b10-approval-surfaces.md
 * (A:4 + B:2 + C:2). No B10c UI badge work.
 *
 * fix1: production transport must mint actor from verified request.user
 * (decisionActorFromRequestUser) and pass it into all 8 guarded call sites.
 * Route evidence hits the same handler shape as src/index.ts (actor from
 * request.user → service → FORBIDDEN→403), not a self-referential hardcode.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { AgentProposalService } from './services/agent-proposal-service.js';
import { MemoryService } from './services/memory-service.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import {
  assertOwnerDecisionAuthority,
  decisionActorFromIngest,
  decisionActorFromRequestUser,
  jkageL0Actor,
  OWNER_AUTHORITY_DENY_RE,
  type DecisionActor,
} from './services/decision-authority.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';

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

const JKAGE = jkageL0Actor();
const OWNER: DecisionActor = { kind: 'owner', role: 'owner' };
const STUDIO = { surface: 'studio' as const };

function expectForbidden(fn: () => unknown) {
  try {
    fn();
    expect.fail('expected FORBIDDEN');
  } catch (e: any) {
    expect(e.code).toBe('FORBIDDEN');
    expect(e.statusCode).toBe(403);
    expect(String(e.message)).toMatch(OWNER_AUTHORITY_DENY_RE);
  }
}

describe('B10b jkage L0 authority reject (R2.10)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function setup() {
    const t = tempDbPath('helm-b10b-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const proposals = new AgentProposalService(dbs, as);
    const memory = new MemoryService(dbs);
    const projects = new ProjectService(dbs);
    const cycles = new CycleService(dbs, projects);

    const proj = projects.createProject({
      name: `b10b-proj-${Math.random().toString(36).slice(2, 8)}`,
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b10b-proj-')),
    });

    const agent = as.createAgent({
      name: `b10b-agent-${Math.random().toString(36).slice(2, 8)}`,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      kind: 'project',
      definition_md: '# original definition',
    }, STUDIO);

    return { dbs, as, proposals, memory, projects, cycles, proj, agent };
  }

  it('decisionActorFromRequestUser: owner vs agent; never body-trusted', () => {
    expect(decisionActorFromRequestUser({ role: 'owner', displayName: 'jrom' })).toEqual({
      kind: 'owner',
      role: 'owner',
    });
    const agent = decisionActorFromRequestUser({
      role: 'agent',
      name: 'jkage',
      agent_id: 7,
    });
    expect(agent.kind).toBe('agent');
    expect(agent.name).toBe('jkage');
    expect(agent.agent_id).toBe(7);
    // body-shaped owner claim without role=owner must not mint owner
    const spoof = decisionActorFromRequestUser({ kind: 'owner', name: 'jkage' });
    expect(spoof.kind).toBe('agent');
    expect(decisionActorFromIngest({ name: 'master-chat' }).kind).toBe('agent');
  });

  it('assertOwnerDecisionAuthority: jkage/L0 denied; owner/omitted allowed', () => {
    expectForbidden(() => assertOwnerDecisionAuthority(JKAGE));
    expectForbidden(() =>
      assertOwnerDecisionAuthority({
        kind: 'agent',
        name: 'jkage',
        definition_md: 'authority: L0\ndecision_authority: none\n',
      })
    );
    expect(() => assertOwnerDecisionAuthority(OWNER)).not.toThrow();
    expect(() => assertOwnerDecisionAuthority(null)).not.toThrow();
    expect(() => assertOwnerDecisionAuthority(undefined)).not.toThrow();
  });

  // AS-A1
  it('AS-A1: jkage cannot approveCycle', () => {
    const { dbs, cycles, proj } = setup();
    const row = dbs
      .prepare(
        `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status, awaiting_approval)
         VALUES (?, 'gate', 'gate_b10b', 'planning', 'pause_after_planning', 'active', 1) RETURNING id`
      )
      .get(proj.id) as { id: number };

    expectForbidden(() => cycles.approveCycle(row.id, { actor: JKAGE }));
    const still = dbs.prepare('SELECT phase, awaiting_approval FROM cycles WHERE id=?').get(row.id) as any;
    expect(still.phase).toBe('planning');
    expect(Number(still.awaiting_approval)).toBe(1);

    const ok = cycles.approveCycle(row.id, { actor: OWNER });
    expect(ok.phase).toBe('implementation');
    dbs.close();
  });

  // AS-A2
  it('AS-A2: jkage cannot approveProposal', () => {
    const { dbs, proposals, agent, as } = setup();
    const p = proposals.createProposal(agent.id, '# proposed by agent');
    expectForbidden(() => proposals.approveProposal(p.id, { actor: JKAGE }));
    const row = dbs.prepare('SELECT status FROM agent_proposals WHERE id=?').get(p.id) as any;
    expect(row.status).toBe('pending');
    expect(as.getAgent(agent.id)?.definition_md).toBe('# original definition');
    dbs.close();
  });

  // AS-A3
  it('AS-A3: jkage cannot approveMemory / set status=approved', () => {
    const { dbs, memory } = setup();
    const proposed = memory.createMemory(
      { scope: 'app', title: 'pending app mem', body: 'x' },
      { approved: false }
    )!;
    expect(proposed.status).toBe('proposed');

    expectForbidden(() => memory.approveMemory(proposed.id, { actor: JKAGE }));
    expectForbidden(() =>
      memory.updateMemory(proposed.id, { status: 'approved' }, { actor: JKAGE })
    );
    expect(memory.getMemory(proposed.id)?.status).toBe('proposed');
    dbs.close();
  });

  // AS-A4
  it('AS-A4: jkage cannot promoteToLong (sets approved)', () => {
    const { dbs, memory } = setup();
    const m = memory.createMemory(
      { scope: 'app', title: 'short keep', body: 'k', horizon: 'short' } as any,
      { approved: true, actor: OWNER }
    )!;
    expectForbidden(() => memory.promoteToLong([m.id], { actor: JKAGE }));
    const after = memory.getMemory(m.id)!;
    expect(after.horizon).toBe('short');
    dbs.close();
  });

  // AS-B1
  it('AS-B1: jkage cannot rejectProposal', () => {
    const { dbs, proposals, agent } = setup();
    const p = proposals.createProposal(agent.id, '# reject me');
    expectForbidden(() => proposals.rejectProposal(p.id, { actor: JKAGE }));
    const row = dbs.prepare('SELECT status FROM agent_proposals WHERE id=?').get(p.id) as any;
    expect(row.status).toBe('pending');
    dbs.close();
  });

  // AS-B2
  it('AS-B2: jkage cannot deleteMemory (reject path)', () => {
    const { dbs, memory } = setup();
    const proposed = memory.createMemory(
      { scope: 'app', title: 'reject candidate', body: 'y' },
      { approved: false }
    )!;
    expectForbidden(() => memory.deleteMemory(proposed.id, { actor: JKAGE }));
    expectForbidden(() => memory.rejectMemory(proposed.id, { actor: JKAGE }));
    expect(memory.getMemory(proposed.id)).not.toBeNull();
    dbs.close();
  });

  // AS-C1
  it('AS-C1: jkage cannot updateAgent (direct definition write)', () => {
    const { dbs, as, agent } = setup();
    expectForbidden(() =>
      as.updateAgent(agent.id, { definition_md: '# hijacked by jkage' }, { surface: 'studio', actor: JKAGE })
    );
    expect(as.getAgent(agent.id)?.definition_md).toBe('# original definition');
    dbs.close();
  });

  // AS-C2
  it('AS-C2: jkage cannot createMemory owner-approved app path', () => {
    const { dbs, memory } = setup();
    expectForbidden(() =>
      memory.createMemory(
        { scope: 'app', title: 'owner-like create', body: 'z' },
        { approved: true, actor: JKAGE }
      )
    );
    const rows = memory.listMemories({ scope: 'app', status: 'approved' });
    expect(rows.find((r) => r.title === 'owner-like create')).toBeUndefined();

    // agent propose path (app → proposed) still allowed without owner gate
    const proposed = memory.createMemory(
      { scope: 'app', title: 'agent propose ok', body: 'p' },
      { approved: false, actor: JKAGE }
    );
    expect(proposed?.status).toBe('proposed');
    dbs.close();
  });

  /**
   * Outcome-shaped route test: same call shape as src/index.ts —
   * decisionActorFromRequestUser(request.user) → service → FORBIDDEN→403.
   * Agent-role user reaches the handler (auth set; requireOwner omitted only to
   * exercise the B10b service layer the way a mis-issued token past preHandler would).
   * Full stack with requireOwnerPre also returns 403 for agent (pre-existing auth).
   */
  it('real index-shaped routes: agent-role token → 403 on approve (AS-A2)', async () => {
    const { dbs, proposals, agent } = setup();
    const p = proposals.createProposal(agent.id, '# via route');

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    const requireLocalLaunchPre = createRequireLocalLaunch();

    // Mirror src/index.ts POST /api/proposals/:id/approve handler body exactly
    // (authMiddleware + requireOwnerPre + requireLocalLaunchPre + actor from request.user).
    const indexShapedApprove = async (request: any, reply: any) => {
      const id = Number(request.params.id);
      try {
        const actor = decisionActorFromRequestUser(request.user);
        const proposal = proposals.approveProposal(id, { actor });
        return { proposal };
      } catch (e: any) {
        if (e.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
        if (/unknown proposal/.test(e.message || '')) return reply.code(404).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    };

    // Path A: full stack — agent role never passes requireOwnerPre
    app.post(
      '/api/proposals/:id/approve',
      {
        preHandler: [
          (req: any, _r: any, done?: () => void) => {
            req.user = { role: 'agent', name: 'jkage', agent_id: agent.id };
            done?.();
          },
          requireOwnerPre,
          requireLocalLaunchPre,
        ],
      },
      indexShapedApprove
    );

    // Path B: mis-issued agent past requireOwnerPre (service layer must still deny)
    app.post(
      '/api/proposals/:id/approve-misissued',
      {
        preHandler: [
          (req: any, _r: any, done?: () => void) => {
            req.user = { role: 'agent', name: 'jkage', agent_id: agent.id };
            done?.();
          },
          requireLocalLaunchPre,
        ],
      },
      indexShapedApprove
    );

    // Owner path still works with trusted actor
    app.post(
      '/api/proposals/:id/approve-owner',
      {
        preHandler: [
          (req: any, _r: any, done?: () => void) => {
            req.user = { role: 'owner' };
            done?.();
          },
          requireOwnerPre,
          requireLocalLaunchPre,
        ],
      },
      indexShapedApprove
    );

    await app.ready();

    try {
      const agentFull = await app.inject({
        method: 'POST',
        url: `/api/proposals/${p.id}/approve`,
        remoteAddress: '127.0.0.1',
      });
      expect(agentFull.statusCode).toBe(403);

      const agentService = await app.inject({
        method: 'POST',
        url: `/api/proposals/${p.id}/approve-misissued`,
        remoteAddress: '127.0.0.1',
      });
      expect(agentService.statusCode).toBe(403);
      expect(agentService.json().error).toMatch(OWNER_AUTHORITY_DENY_RE);
      const still = dbs.prepare('SELECT status FROM agent_proposals WHERE id=?').get(p.id) as any;
      expect(still.status).toBe('pending');

      const ownerOk = await app.inject({
        method: 'POST',
        url: `/api/proposals/${p.id}/approve-owner`,
        remoteAddress: '127.0.0.1',
      });
      expect(ownerOk.statusCode).toBe(200);
      expect(ownerOk.json().proposal.status).toBe('approved');
    } finally {
      await app.close();
      dbs.close();
    }
  });

  /**
   * Negative control: every production call site in src/index.ts must pass
   * `actor` into the guarded service methods. Prevents the exact B10b inert-guard
   * regression (0/8 actor pass-through).
   */
  it('negative control: src/index.ts passes actor to all 8 guarded call sites', () => {
    const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts');
    const src = fs.readFileSync(indexPath, 'utf8');

    // Helper must be imported and used
    expect(src).toMatch(/decisionActorFromRequestUser/);
    expect(src).toMatch(/decisionActorFromIngest/);

    // Exact production call shapes (must stay in sync with index.ts)
    const requiredSnippets = [
      "updateAgent(id, body, { surface: 'studio', actor })",
      'approveCycle(id, { actor })',
      'createMemory(body, { approved: true, actor })',
      'updateMemory(id, body, { actor })',
      'deleteMemory(id, { actor })',
      'promoteToLong(ids.map((x: any) => Number(x)), { actor })',
      'approveProposal(id, { actor })',
      'rejectProposal(id, { actor })',
      // ingest stamps agent actor into createMemory
      'decisionActorFromIngest({ name: \'master-chat\' })',
    ];

    for (const snip of requiredSnippets) {
      expect(src.includes(snip), `index.ts missing: ${snip}`).toBe(true);
    }

    // Count decisionActorFromRequestUser uses at owner-route call sites (≥8)
    const mints = src.match(/decisionActorFromRequestUser\(/g) || [];
    expect(mints.length).toBeGreaterThanOrEqual(8);
  });
});
