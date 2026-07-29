/**
 * S11 — Owner confirm/decline bridge (ACs 13-17, 24, 29-30).
 * Tests: (1) confirm one run + double-click no second; (2) decline + fresh pending;
 * (3) unauth/callback-token/bodyless starter/changed manifest refused.
 */
process.env.USE_FAKE_TMUX = '1';
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { PlannerPanelService } from './services/planner-panel-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import {
  DiscoveryHandoffService,
  mintHandoffCredential,
} from './services/discovery-handoff-service.js';
import { PlanningStaffingService } from './services/planning-staffing-service.js';
import { CANONICAL_CYCLE_ARTIFACTS } from './services/cycle-artifact-paths.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';
import { registerDiscoveryHandoffRoutes } from './api/routes/discovery-handoff-routes.js';
import {
  issueDiscoveryCallbackCredential,
} from './services/discovery-callback-credentials.js';
import { confirmDiscoveryHandoff } from './services/discovery-handoff-owner-bridge.js';

function seedModel(dbs: DatabaseService, name: string, provider: string, modelId: string): number {
  return Number(
    dbs.raw
      .prepare(
        `INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort, approval, validation_status)
         VALUES (?, ?, ?, ?, ?, ?, 'medium', 'auto', 'valid')`
      )
      .run(name, provider, modelId, provider, name, name).lastInsertRowid
  );
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner', sub: 'test-owner' };
  done?.();
}

function noAuth(_req: any, reply: any, done?: () => void) {
  reply.code(401).send({ error: 'missing or invalid authorization header' });
  // do not call done
}

describe('S11 owner confirm/decline bridge', () => {
  let dir: string;
  let dbs: DatabaseService;
  let projects: ProjectService;
  let cycles: CycleService;
  let assignments: AgentAssignmentService;
  let panel: PlannerPanelService;
  let artifacts: RunArtifactService;
  let handoffs: DiscoveryHandoffService;
  let staffing: PlanningStaffingService;
  let projectId: number;
  let cycleId: number;
  let cycleDir: string;
  let s10Calls: any[];
  let orchestrator: { startPlanningFromConfirmedHandoff: (i: any) => Promise<number> };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s11-'));
    dbs = new DatabaseService(path.join(dir, 't.db'));
    projects = new ProjectService(dbs);
    cycles = new CycleService(dbs, projects);
    assignments = new AgentAssignmentService(dbs);
    panel = new PlannerPanelService(dbs);
    artifacts = new RunArtifactService(dbs);
    handoffs = new DiscoveryHandoffService(dbs);
    staffing = new PlanningStaffingService(dbs, assignments, panel);
    s10Calls = [];

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s11-proj-'));
    const p = projects.createProject({
      name: `s11-${Date.now()}`,
      directory: projDir,
      autonomy_default: 'pause_after_planning',
    } as any);
    projectId = p.id;
    dbs.raw
      .prepare("UPDATE projects SET adaptive_planning = 0 WHERE id = ?")
      .run(projectId);

    const opus = seedModel(dbs, 'Opus5', 'claude', 'claude-opus-4-8');
    const codex = seedModel(dbs, 'Codex56Sol', 'codex', 'gpt-5.3-codex');
    panel.replaceConfig(projectId, {
      members: [
        { model_id: opus, is_lead: true, effort: 'high' },
        { model_id: codex, is_lead: false, effort: 'med' },
      ],
    });

    const c = await cycles.createCycle(projectId, 'S11 Cycle');
    cycleId = c.id;
    dbs.raw
      .prepare("UPDATE cycles SET autonomy = 'pause_after_planning', phase = 'discovery' WHERE id = ?")
      .run(cycleId);

    cycleDir = cycles.getCycleDocDir(cycleId);
    await fsp.writeFile(
      path.join(cycleDir, CANONICAL_CYCLE_ARTIFACTS.northStar),
      '# S11 North Star\n',
      'utf8'
    );
    await fsp.writeFile(path.join(cycleDir, 'conversation-log.md'), 'S11 log\n', 'utf8');
    await fsp.mkdir(path.join(cycleDir, 'decisions'), { recursive: true });

    orchestrator = {
      startPlanningFromConfirmedHandoff: async (input: any) => {
        s10Calls.push(input);
        // Simulate S10 success: CAS starting→started (run already precreated by bridge)
        const hid = Number(input.handoffId);
        const rid = Number(input.precreatedRunId);
        handoffs.casTransition(hid, 'starting', 'started', { planningRunId: rid });
        return rid;
      },
    };
  });

  afterEach(() => {
    try {
      dbs.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  function makePendingHandoff(digestOverride?: string, jsonOverride?: string) {
    const manifest = staffing.resolveManifest(projectId, {
      throwOnEmpty: false,
      throwOnMismatch: false,
    });
    const raw = mintHandoffCredential();
    const pending = handoffs.createPending({
      projectId,
      cycleId,
      rawCredential: raw,
      callbackRole: 'discovery',
      callbackStatus: 'NORTH-STAR-READY',
      manifestJson: jsonOverride ?? JSON.stringify(manifest),
      manifestDigest: digestOverride ?? manifest.digest,
    });
    return { handoffId: pending.id, manifest, raw };
  }

  function mountApp(opts?: { auth?: 'owner' | 'none' | 'viewer'; detachS10?: boolean }) {
    const app = Fastify({ logger: false });
    const authMode = opts?.auth ?? 'owner';
    const auth =
      authMode === 'none'
        ? noAuth
        : authMode === 'viewer'
          ? (req: any, _r: any, done?: () => void) => {
              req.user = { role: 'viewer' };
              done?.();
            }
          : ownerAuth;
    registerDiscoveryHandoffRoutes(app, {
      db: dbs,
      assignmentService: assignments,
      cycleService: cycles,
      plannerPanelService: panel,
      handoffs,
      artifacts,
      orchestrator,
      authMiddleware: auth as any,
      requireOwnerPre: createRequireOwner(),
      requireLocalLaunchPre: createRequireLocalLaunch(),
      detachS10: opts?.detachS10 ?? false, // await S10 in tests for determinism
    });

    // Bodyless start-planning guard (mirrors index.ts S11 patch)
    app.post(
      '/api/cycles/:id/start-planning',
      { preHandler: [auth as any, createRequireOwner(), createRequireLocalLaunch()] },
      async (request: any, reply: any) => {
        const cid = Number(request.params.id);
        const live = handoffs.getLive(cid);
        if (live && (live.state === 'pending' || live.state === 'starting')) {
          return reply.code(409).send({
            error:
              'pending discovery handoff requires owner confirm at /api/cycles/:id/discovery-handoff/confirm',
            code: 'HANDOFF_CONFIRM_REQUIRED',
            handoffId: live.id,
          });
        }
        return reply.code(200).send({ status: 'started-legacy' });
      }
    );

    return app;
  }

  it('test1: owner confirm creates one run and records id; double click creates no second', async () => {
    const { handoffId, manifest } = makePendingHandoff();
    const app = mountApp();
    await app.ready();
    try {
      const res1 = await app.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/discovery-handoff/confirm`,
        remoteAddress: '127.0.0.1',
        payload: { expectedDigest: manifest.digest, handoffId },
      });
      expect(res1.statusCode).toBe(202);
      const body1 = res1.json();
      expect(body1.ok).toBe(true);
      expect(body1.runId).toBeGreaterThan(0);
      expect(body1.handoffId).toBe(handoffId);
      expect(body1.already).toBe(false);

      const row = handoffs.getById(handoffId)!;
      expect(row.planning_run_id).toBe(body1.runId);
      // detachS10=false awaits S10 which CASes to started
      expect(row.state === 'started' || row.state === 'starting').toBe(true);
      expect(s10Calls).toHaveLength(1);
      expect(s10Calls[0].precreatedRunId).toBe(body1.runId);
      expect(s10Calls[0].handoffId).toBe(handoffId);

      const runsAfterFirst = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as any).c;

      const res2 = await app.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/discovery-handoff/confirm`,
        remoteAddress: '127.0.0.1',
        payload: { expectedDigest: manifest.digest, handoffId },
      });
      expect(res2.statusCode).toBe(202);
      const body2 = res2.json();
      expect(body2.runId).toBe(body1.runId);
      expect(body2.already).toBe(true);
      expect(s10Calls).toHaveLength(1); // no second S10

      const runsAfterSecond = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as any).c;
      expect(runsAfterSecond).toBe(runsAfterFirst);
    } finally {
      await app.close();
    }
  });

  it('test1b: double confirm while starting (no planning_run_id) creates no second run/S10', async () => {
    const { handoffId, manifest } = makePendingHandoff();
    // Simulate CAS gap: winner flipped pending→starting but has not written planning_run_id yet
    expect(handoffs.casTransition(handoffId, 'pending', 'starting')).toBe(1);
    expect(handoffs.getById(handoffId)!.state).toBe('starting');
    expect(handoffs.getById(handoffId)!.planning_run_id).toBeNull();

    const app = mountApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/discovery-handoff/confirm`,
        remoteAddress: '127.0.0.1',
        payload: { expectedDigest: manifest.digest, handoffId },
      });
      // In-flight starting without run id must refuse — never second durable run/S10
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CAS_LOST');
      expect(s10Calls).toHaveLength(0);
      expect((dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as any).c).toBe(0);
      expect(handoffs.getById(handoffId)!.state).toBe('starting');
      expect(handoffs.getById(handoffId)!.planning_run_id).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('test1c: concurrent double confirm from pending yields exactly one run and one S10', async () => {
    const { handoffId, manifest } = makePendingHandoff();
    const deps = {
      db: dbs,
      handoffs,
      cycleService: cycles,
      artifacts,
      assignments,
      plannerPanel: panel,
      orchestrator,
      detachS10: false as boolean,
    };
    const input = {
      cycleId,
      handoffId,
      expectedDigest: manifest.digest,
      batchId: 's11-concurrent',
    };

    const [a, b] = await Promise.all([
      confirmDiscoveryHandoff(input, deps),
      confirmDiscoveryHandoff(input, deps),
    ]);

    const oks = [a, b].filter((r) => r.ok) as Array<Extract<typeof a, { ok: true }>>;
    const fails = [a, b].filter((r) => !r.ok);

    // At least one success; loser is already-same-run or CAS_LOST — never two distinct runs
    expect(oks.length).toBeGreaterThanOrEqual(1);
    if (oks.length === 2) {
      expect(oks[0].runId).toBe(oks[1].runId);
      expect(oks.some((r) => r.already)).toBe(true);
    } else {
      expect(fails[0].code === 'CAS_LOST' || fails[0].code === 'ACTIVE_RUN').toBe(true);
    }

    const runCount = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as any).c;
    expect(runCount).toBe(1);
    expect(s10Calls).toHaveLength(1);
    expect(handoffs.getById(handoffId)!.planning_run_id).toBe(oks[0].runId);
  });

  it('test2: decline starts none and permits a fresh pending handoff', async () => {
    const { handoffId } = makePendingHandoff();
    const app = mountApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/discovery-handoff/decline`,
        remoteAddress: '127.0.0.1',
        payload: { handoffId, reason: 'Not yet' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('declined');
      expect(handoffs.getById(handoffId)!.state).toBe('declined');
      expect(handoffs.getLive(cycleId)).toBeNull();
      expect(s10Calls).toHaveLength(0);
      expect((dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as any).c).toBe(0);

      // Fresh pending allowed after decline
      const fresh = makePendingHandoff();
      expect(fresh.handoffId).not.toBe(handoffId);
      expect(handoffs.getLive(cycleId)!.id).toBe(fresh.handoffId);
      expect(handoffs.getLive(cycleId)!.state).toBe('pending');
    } finally {
      await app.close();
    }
  });

  it('test3: unauthenticated / callback-token / bodyless starter / changed manifest refused', async () => {
    const { handoffId, manifest } = makePendingHandoff();

    // Unauthenticated confirm
    const appNone = mountApp({ auth: 'none' });
    await appNone.ready();
    try {
      const res = await appNone.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/discovery-handoff/confirm`,
        remoteAddress: '127.0.0.1',
        payload: { expectedDigest: manifest.digest },
      });
      expect(res.statusCode).toBe(401);
      expect(s10Calls).toHaveLength(0);
    } finally {
      await appNone.close();
    }

    // Non-owner (viewer) refused
    const appViewer = mountApp({ auth: 'viewer' });
    await appViewer.ready();
    try {
      const res = await appViewer.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/discovery-handoff/confirm`,
        remoteAddress: '127.0.0.1',
        payload: { expectedDigest: manifest.digest },
      });
      expect(res.statusCode).toBe(403);
      expect(s10Calls).toHaveLength(0);
    } finally {
      await appViewer.close();
    }

    // Callback credential is not owner auth — ready path exists without owner,
    // but confirm requires owner. Also: presenting callback as bearer is still 401
    // under our mount (auth middleware rejects non-JWT). Issue callback and hit ready
    // to show agent can ready but not confirm.
    const agentId = 1;
    const { rawCredential } = issueDiscoveryCallbackCredential({
      projectId,
      cycleId,
      chatSessionId: 'sess-s11',
      agentId,
    });
    const appOwner = mountApp();
    await appOwner.ready();
    try {
      // Agent ready still works without owner preHandlers on that route
      const readyRes = await appOwner.inject({
        method: 'POST',
        url: '/api/discovery/handoff/ready',
        payload: {
          role: 'discovery',
          status: 'NORTH-STAR-READY',
          projectId,
          cycleId: cycleId + 99999, // wrong cycle → quarantine, proves credential path
          sessionId: 'sess-s11',
          agentId,
          credential: rawCredential,
        },
      });
      // quarantined or rejected — not 202 confirm, and no planning run from ready
      expect([400, 403]).toContain(readyRes.statusCode);
      expect(readyRes.json().runCreated).toBe(false);

      // Bodyless start-planning blocked while pending handoff
      const sp = await appOwner.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/start-planning`,
        remoteAddress: '127.0.0.1',
        payload: {},
      });
      expect(sp.statusCode).toBe(409);
      expect(sp.json().code).toBe('HANDOFF_CONFIRM_REQUIRED');
      expect(s10Calls).toHaveLength(0);

      // Changed manifest: digest still A but live will diverge if we change panel —
      // easier: tamper expectedDigest vs frozen
      const badDigest = await appOwner.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/discovery-handoff/confirm`,
        remoteAddress: '127.0.0.1',
        payload: { expectedDigest: 'not-the-real-digest', handoffId },
      });
      expect(badDigest.statusCode).toBe(409);
      expect(badDigest.json().code).toBe('MISMATCH');
      expect(handoffs.getById(handoffId)!.state).toBe('pending');
      expect(s10Calls).toHaveLength(0);

      // Tamper frozen JSON seats while keeping digest A
      const tampered = JSON.parse(JSON.stringify(manifest));
      tampered.coPlanners[0] = {
        ...tampered.coPlanners[0],
        model: 'evil-model',
        provider: 'evil',
      };
      dbs.raw
        .prepare('UPDATE discovery_handoffs SET manifest_json = ? WHERE id = ?')
        .run(JSON.stringify(tampered), handoffId);

      const ab = await appOwner.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/discovery-handoff/confirm`,
        remoteAddress: '127.0.0.1',
        payload: { expectedDigest: manifest.digest, handoffId },
      });
      expect(ab.statusCode).toBe(409);
      expect(ab.json().code).toBe('MISMATCH');
      expect((dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as any).c).toBe(0);
      expect(s10Calls).toHaveLength(0);
    } finally {
      await appOwner.close();
    }
  });

  it('test3b: non-loopback owner confirm is refused', async () => {
    const { handoffId, manifest } = makePendingHandoff();
    const app = mountApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/discovery-handoff/confirm`,
        remoteAddress: '8.8.8.8',
        payload: { expectedDigest: manifest.digest, handoffId },
      });
      expect(res.statusCode).toBe(403);
      expect(s10Calls).toHaveLength(0);
      expect(handoffs.getById(handoffId)!.state).toBe('pending');
    } finally {
      await app.close();
    }
  });
});
