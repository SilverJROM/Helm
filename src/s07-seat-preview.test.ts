/**
 * S07 — Pre-start seat readiness API (S05 preview + post-start roster).
 * ACs 22-25.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { PlannerPanelService } from './services/planner-panel-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import {
  buildCycleSeatReadiness,
  mapRuntimeToPreview,
  manifestToSeatPreview,
} from './services/cycle-seat-preview.js';
import { PlanningStaffingService } from './services/planning-staffing-service.js';

function seedModel(
  dbs: DatabaseService,
  name: string,
  provider: string,
  modelId: string
): number {
  return Number(
    dbs.raw
      .prepare(
        `INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort, approval, validation_status)
         VALUES (?, ?, ?, ?, ?, ?, 'medium', 'auto', 'valid')`
      )
      .run(name, provider, modelId, provider, name, name).lastInsertRowid
  );
}

describe('S07 cycle seat readiness', () => {
  let dbPath: string;
  let dbs: DatabaseService;
  let projects: ProjectService;
  let cycles: CycleService;
  let assignments: AgentAssignmentService;
  let panel: PlannerPanelService;
  let artifacts: RunArtifactService;
  let projectId: number;
  let cycleId: number;
  let opusId: number;
  let codexId: number;

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s07-'));
    dbPath = path.join(dir, 't.db');
    dbs = new DatabaseService(dbPath);
    projects = new ProjectService(dbs);
    cycles = new CycleService(dbs, projects);
    assignments = new AgentAssignmentService(dbs);
    panel = new PlannerPanelService(dbs);
    artifacts = new RunArtifactService(dbs);

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s07-proj-'));
    const p = projects.createProject({ name: `s07-${Date.now()}`, directory: projDir });
    projectId = p.id;
    dbs.raw.prepare('UPDATE projects SET adaptive_planning = 0 WHERE id = ?').run(projectId);

    opusId = seedModel(dbs, 'Opus5', 'claude', 'claude-opus-4-8');
    codexId = seedModel(dbs, 'Codex56Sol', 'codex', 'gpt-5.3-codex');

    const c = await cycles.createCycle(projectId, 'S07 Cycle');
    cycleId = c.id;
  });

  afterEach(() => {
    try {
      dbs.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('test1: no-run cycle returns plancore+configured preview, not empty', () => {
    panel.replaceConfig(projectId, {
      members: [
        { model_id: opusId, is_lead: true, effort: 'high' },
        { model_id: codexId, is_lead: false, effort: 'med' },
      ],
      default_effort: 'med',
    });

    const readiness = buildCycleSeatReadiness({
      db: dbs,
      assignments,
      plannerPanel: panel,
      cycleId,
      projectId,
      runtimeSeats: [],
    });

    expect(readiness.mode).toBe('preview');
    expect(readiness.preview.plancore).toBeTruthy();
    expect(readiness.preview.plancore!.role).toBe('plancore');
    expect(readiness.preview.coPlanners).toHaveLength(2);
    expect(readiness.preview.coPlanners.map((s) => s.model).sort()).toEqual(
      ['claude-opus-4-8', 'gpt-5.3-codex'].sort()
    );
    expect(readiness.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(readiness.emptyPanelMessage).toBeNull();
    expect(readiness.runtime.seats).toHaveLength(0);
  });

  it('test2: unavailable slot returns typed block, no invented seat', () => {
    panel.replaceConfig(projectId, {
      members: [
        { model_id: opusId, is_lead: true },
        { model_id: codexId, is_lead: false },
      ],
      // no backups
      default_effort: 'med',
    });

    const readiness = buildCycleSeatReadiness({
      db: dbs,
      assignments,
      plannerPanel: panel,
      cycleId,
      projectId,
      runtimeSeats: [],
      unavailable: new Set(['claude/claude-opus-4-8']),
    });

    const blockedSlot = readiness.preview.coPlanners.find((s) => s.slot === 0);
    expect(blockedSlot).toBeTruthy();
    expect(blockedSlot!.ready).toBe(false);
    expect(blockedSlot!.reason).toMatch(/unavailable|backup/i);
    // still the configured primary model — not an invented substitute
    expect(blockedSlot!.model).toBe('claude-opus-4-8');
    expect(readiness.preview.coPlanners.every((s) => s.model !== 'gpt-5.5')).toBe(true);
    expect(readiness.blocked).toBe(true);
  });

  it('test3: after seeded runtimes, roster mapped against digest/identities', () => {
    panel.replaceConfig(projectId, {
      members: [
        { model_id: opusId, is_lead: true },
        { model_id: codexId, is_lead: false },
      ],
      default_effort: 'med',
    });

    const staffing = new PlanningStaffingService(dbs, assignments, panel);
    const manifest = staffing.resolveManifest(projectId);
    const preview = manifestToSeatPreview(manifest);

    const runId = artifacts.createRun(projectId, 's07-batch', null, cycleId);
    // Seed worker_runtimes matching plancore + two co-planners
    const ins = dbs.raw.prepare(
      `INSERT INTO worker_runtimes (project_id, role, provider, model, session, state, run_id, correlation_id)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`
    );
    ins.run(projectId, 'plancore', manifest.plancore.provider, manifest.plancore.model, 'sess-pc', runId, 's07-batch');
    ins.run(projectId, 'planner', 'claude', 'claude-opus-4-8', 'sess-p1', runId, 's07-batch-partner');
    ins.run(projectId, 'planner', 'codex', 'gpt-5.3-codex', 'sess-p2', runId, 's07-batch-partner-2');

    const rows = dbs.raw
      .prepare(
        `SELECT wr.id, wr.role, wr.provider, wr.model, wr.session, wr.state,
                wr.run_id AS runId, wr.correlation_id AS batchId,
                wr.started_at AS startedAt, wr.ended_at AS endedAt
         FROM worker_runtimes wr WHERE wr.run_id = ? ORDER BY wr.id`
      )
      .all(runId) as any[];

    const runtimeSeats = rows.map((r) => ({
      id: r.id,
      role: r.role,
      provider: r.provider,
      model: r.model,
      session: r.session,
      state: r.state,
      runId: r.runId,
      batchId: r.batchId,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      live: true,
    }));

    const mapped = mapRuntimeToPreview(runtimeSeats, {
      plancore: preview.plancore,
      coPlanners: preview.coPlanners,
    });
    expect(mapped.seats).toHaveLength(3);
    expect(mapped.seats.every((s) => s.matchesPreview)).toBe(true);
    expect(mapped.allIdentitiesMatch).toBe(true);
    expect(mapped.digestMatch).toBe(true);

    const readiness = buildCycleSeatReadiness({
      db: dbs,
      assignments,
      plannerPanel: panel,
      cycleId,
      projectId,
      runtimeSeats,
    });
    expect(readiness.mode).toBe('both');
    expect(readiness.digest).toBe(manifest.digest);
    expect(readiness.runtime.digestMatch).toBe(true);
    expect(readiness.runtime.seats).toHaveLength(3);
  });

  it('HTTP GET /api/cycles/:id/seats returns preview when no run (owner)', async () => {
    panel.replaceConfig(projectId, {
      members: [
        { model_id: opusId, is_lead: true },
        { model_id: codexId, is_lead: false },
      ],
    });

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.addHook('onRequest', async (req: any) => {
      req.user = { role: 'owner' };
    });

    // Minimal mirror of S07 handler shape (uses real builder)
    app.get('/api/cycles/:id/seats', { preHandler: [requireOwnerPre] }, async (request: any, reply: any) => {
      const id = Number(request.params.id);
      const cycle: any = dbs.raw.prepare('SELECT id, project_id FROM cycles WHERE id = ?').get(id);
      if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
      const readiness = buildCycleSeatReadiness({
        db: dbs,
        assignments,
        plannerPanel: panel,
        cycleId: id,
        projectId: Number(cycle.project_id),
        runtimeSeats: [],
      });
      return {
        seats: [],
        mode: readiness.mode,
        digest: readiness.digest,
        blocked: readiness.blocked,
        preview: readiness.preview,
        runtime: readiness.runtime,
        emptyPanelMessage: readiness.emptyPanelMessage,
      };
    });

    const res = await app.inject({ method: 'GET', url: `/api/cycles/${cycleId}/seats` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('preview');
    expect(body.preview.coPlanners.length).toBe(2);
    expect(body.digest).toBeTruthy();
    await app.close();
  });
});
