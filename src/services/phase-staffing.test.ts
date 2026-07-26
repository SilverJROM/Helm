import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerPhaseAgentRoutes } from '../api/routes/phase-agent-routes.js';
import { DatabaseService } from '../db/database.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { ProjectService } from './project-service.js';
import {
  PHASE_STAFFING,
  PhaseBrainUnavailableError,
  PhaseStaffingService,
} from './phase-staffing.js';

const cleanups: Array<() => void> = [];

function makeServices(label: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `helm-phase-staffing-${label}-`));
  const db = new DatabaseService(path.join(dir, 'helm.db'));
  cleanups.push(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const projects = new ProjectService(db);
  const assignments = new AgentAssignmentService(db);
  const project = projects.createProject({ name: `phase-${label}`, directory: path.join(dir, 'project') });
  return {
    db,
    projects,
    assignments,
    project,
    staffing: new PhaseStaffingService(assignments),
  };
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe.sequential('phase ownership resolver', () => {
  it('publishes the exact Stage 2 phase staffing map', () => {
    expect(PHASE_STAFFING).toEqual({
      discovery: { brain: 'discovery', workers: ['fetcher'] },
      planning: { brain: 'plancore', workers: ['planner'] },
      implementation: { brain: 'ibrain', workers: ['implementer', 'validator'] },
      final_tests: { brain: 'ibrain', workers: ['validator'] },
      complete: {},
    });
  });

  it('resolves discovery, planning, implementation, and final-tests to their declared brains', () => {
    const { staffing, project } = makeServices('canonical');
    const discovery = staffing.resolvePhaseAgents(project.id, 'discovery');
    const planning = staffing.resolvePhaseAgents(project.id, 'planning');
    const implementation = staffing.resolvePhaseAgents(project.id, 'implementation');
    const finalTests = staffing.resolvePhaseAgents(project.id, 'final_tests');

    expect(discovery.brain).toMatchObject({ role: 'discovery', agent: { name: 'discovery' } });
    expect(discovery.brain?.agent.name).not.toBe('plancore');
    expect(discovery.unavailableRoles).toEqual(['fetcher']);
    expect(planning.brain).toMatchObject({ role: 'plancore', agent: { name: 'plancore' } });
    expect(planning.brain?.agent.name).not.toBe('discovery');
    expect(implementation.brain).toMatchObject({ role: 'ibrain', agent: { name: 'ibrain' } });
    expect(finalTests.brain).toMatchObject({ role: 'ibrain', agent: { name: 'ibrain' } });
    expect(implementation.workers.map((seat) => seat.role)).toEqual(['implementer', 'validator']);
    expect(finalTests.workers.map((seat) => seat.role)).toEqual(['validator']);
    expect(staffing.resolvePhaseAgents(project.id, 'complete')).toEqual({
      phase: 'complete', brain: null, workers: [], unavailableRoles: [],
    });
  });

  it('uses project binding before role default, then exact same-name fallback', () => {
    const { db, assignments, staffing, project } = makeServices('precedence');
    const custom = db.raw.prepare(`
      INSERT INTO agents (name, provider, model, default_effort, definition_md, spawn_pref, agent_type)
      VALUES ('project-planning-seat', 'codex', 'gpt-5.4', 'high', '# custom planning seat', 'tmux', 'project')
      RETURNING id
    `).get() as { id: number };
    assignments.setProjectBinding(project.id, 'plancore', custom.id);

    expect(staffing.resolvePhaseAgents(project.id, 'planning').brain).toMatchObject({
      source: 'project-binding',
      agent: { id: custom.id, name: 'project-planning-seat', model: 'gpt-5.4' },
    });

    assignments.setRoleBindings(project.id, 'plancore', []);
    expect(staffing.resolvePhaseAgents(project.id, 'planning').brain).toMatchObject({
      source: 'role-default', agent: { name: 'plancore' },
    });

    db.raw.prepare("DELETE FROM role_defaults WHERE role='plancore'").run();
    expect(staffing.resolvePhaseAgents(project.id, 'planning').brain).toMatchObject({
      source: 'same-name-fallback', agent: { name: 'plancore' },
    });
  });

  it('fails closed when an active phase has no required brain', () => {
    const { db, staffing, project } = makeServices('missing-brain');
    db.raw.prepare("DELETE FROM role_defaults WHERE role='discovery'").run();
    // createProject now seeds role_bindings, and role_bindings.agent_id is ON DELETE RESTRICT — the
    // real delete path (AgentAssignmentService.deleteAgent) refuses a bound agent with a 409, so this
    // raw-SQL fixture has to unbind first, exactly as it already does for role_defaults.
    db.raw.prepare("DELETE FROM role_bindings WHERE agent_id IN (SELECT id FROM agents WHERE name='discovery')").run();
    db.raw.prepare("DELETE FROM agents WHERE name='discovery'").run();
    expect(() => staffing.resolvePhaseAgents(project.id, 'discovery'))
      .toThrow(PhaseBrainUnavailableError);
  });

  it('serves owner-guarded phase seats and rejects invalid phases/unknown projects', async () => {
    const { db, projects, staffing, project } = makeServices('api');
    const app = Fastify({ logger: false });
    const owner = (request: any, _reply: any, done: () => void) => {
      request.user = { role: 'owner' };
      done();
    };
    registerPhaseAgentRoutes(app, {
      projectService: projects,
      phaseStaffingService: staffing,
      authMiddleware: owner,
      requireOwnerPre: owner,
    });
    await app.ready();

    const ok = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/phase-agents/discovery` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().brain).toMatchObject({ role: 'discovery', agent: { name: 'discovery' } });

    const invalid = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/phase-agents/not-a-phase` });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain('invalid project phase');

    const unknown = await app.inject({ method: 'GET', url: '/api/projects/999999/phase-agents/discovery' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'unknown project' });

    await app.close();
  });
});
