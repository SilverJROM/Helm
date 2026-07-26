import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { AgentEventsService } from './services/agent-events-service.js';
import { ProviderResolverService } from './services/provider-resolver-service.js';
import { ToolkitService } from './services/toolkit-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';
import { WorkerService } from './services/worker-service.js';
import { MasterModelService } from './services/master-model-service.js';
import { MasterRuntimeService } from './services/master-runtime-service.js';
import { EscalationService } from './services/escalation-service.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9fix2-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function makeFakeTmux(capture: { lastSubmit?: string }) {
  return {
    createSession: vi.fn(async (name: string) => `${name}:0.0`),
    sendCommand: vi.fn(async () => true),
    sendAndSubmit: vi.fn(async (_t: string, text: string) => { capture.lastSubmit = text; return true; }),
    sendKeys: vi.fn(async () => true),
    getPanePid: vi.fn(async () => '12345'),
    sessionExists: vi.fn(async () => false),
    terminateSession: vi.fn(async () => {}),
    capturePane: vi.fn(async () => '❯ ready\n> ready\n'),
    waitForReady: vi.fn(async () => true)
  };
}

describe('B9fix2 single-source dispatch (F2/F3/F4)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let assignment: AgentAssignmentService;
  let pas: ProjectAgentService;
  let toolkits: ToolkitService;
  let pid: number;
  let aid: number;
  let studioModelId: number;
  let projectEscModelId: number;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    assignment = new AgentAssignmentService(dbs);
    pas = new ProjectAgentService(dbs, assignment);
    toolkits = new ToolkitService(dbs);

    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort, definition_md) VALUES (?,?,?,?,?)")
      .run('b9fix2-agent', 'grok', 'grok-4.5', 'medium', '# Studio persona\nSTUDIO-PERSONA');
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)")
      .run('b9fix2-studio-esc', 'claude', 'claude-studio-esc', 'claude', 'b9fix2-studio-esc', 'b9fix2-studio-esc', 'medium');
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)")
      .run('b9fix2-project-esc', 'claude', 'claude-project-esc', 'claude', 'b9fix2-project-esc', 'b9fix2-project-esc', 'high');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)")
      .run('b9fix2-studio-tk', null, 'STUDIO-TOOLKIT-BODY');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)")
      .run('b9fix2-project-tk', null, 'PROJECT-TOOLKIT-BODY');

    aid = (dbs.raw.prepare("SELECT id FROM agents WHERE name='b9fix2-agent'").get() as any).id;
    studioModelId = (dbs.raw.prepare("SELECT id FROM models WHERE name='b9fix2-studio-esc'").get() as any).id;
    projectEscModelId = (dbs.raw.prepare("SELECT id FROM models WHERE name='b9fix2-project-esc'").get() as any).id;
    const studioTk = (dbs.raw.prepare("SELECT id FROM toolkits WHERE name='b9fix2-studio-tk'").get() as any).id;
    const projectTk = (dbs.raw.prepare("SELECT id FROM toolkits WHERE name='b9fix2-project-tk'").get() as any).id;

    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid, studioTk, 1);
    dbs.raw.prepare("INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?,?)")
      .run(aid, 1, studioModelId, 'on-fail');

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9fix2-proj-'));
    dbs.raw.prepare("INSERT INTO projects (name, directory, plancore_session) VALUES (?,?,?)")
      .run('B9fix2-proj', projDir, 'helm-plancore-b9fix2');
    pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='B9fix2-proj'").get() as any).id;

    assignment.setRoleDefault('implementer', aid);
    assignment.setProjectBinding(pid, 'implementer', aid);
    assignment.setProjectBinding(pid, 'plancore', aid);
    pas.addAgent(pid, aid);
    pas.setScalarOverrides(pid, aid, { definition_md_override: '# Project persona\nPROJECT-PERSONA' });
    pas.setProjectAgentToolkits(pid, aid, { overridden: true, toolkits: [{ toolkit_id: projectTk, position: 1 }] });
    pas.setProjectAgentEscalations(pid, aid, {
      overridden: true,
      escalations: [{ position: 2, model_id: projectEscModelId, trigger: 'ibrain' }]
    });
  });

  afterEach(() => { cleanup(); });

  it('F2 worker brief uses effective toolkits + persona (not Studio-only global compose)', async () => {
    const capture: { lastSubmit?: string } = {};
    const tmux = makeFakeTmux(capture);
    const events = new AgentEventsService(dbs);
    const resolver = new ProviderResolverService();
    const worker = new WorkerService(dbs, events, tmux as any, resolver, assignment, toolkits);

    await worker.spawnWorker({ projectId: pid, role: 'implementer', taskBrief: 'TASK-BRIEF-CONTENT' });

    expect(capture.lastSubmit).toContain('PROJECT-PERSONA');
    expect(capture.lastSubmit).toContain('PROJECT-TOOLKIT-BODY');
    expect(capture.lastSubmit).not.toContain('STUDIO-TOOLKIT-BODY');
    expect(capture.lastSubmit).toContain('TASK-BRIEF-CONTENT');
  });

  it('F3 planning master launch uses effective plancore toolkits + persona', async () => {
    const capture: { lastSubmit?: string } = {};
    const tmux = makeFakeTmux(capture);
    const events = new AgentEventsService(dbs);
    const resolver = new ProviderResolverService();
    const masterModels = new MasterModelService(dbs);
    masterModels.setChain(pid, [{ provider: 'grok', model: 'grok-4.5' }]);
    const runtime = new MasterRuntimeService(dbs, events, tmux as any, resolver, masterModels, undefined, assignment, toolkits);

    await runtime.launchMaster(pid);

    expect(capture.lastSubmit).toContain('PROJECT-PERSONA');
    expect(capture.lastSubmit).toContain('PROJECT-TOOLKIT-BODY');
    expect(capture.lastSubmit).not.toContain('STUDIO-TOOLKIT-BODY');
    expect(capture.lastSubmit).toContain('helm_pm');
    expect(capture.lastSubmit).not.toMatch(/\b(?:plancore|ibrain)\b/i);
  });

  it('F4 escalation uses project ladder when projectId present', () => {
    const esc = new EscalationService(dbs, undefined, assignment);
    const rung2 = esc.resolveRungAndModel({ role: 'implementer', explicitRung: 2, projectId: pid });
    expect(rung2.model).toBe('b9fix2-project-esc');
    expect(rung2.source).toBe('explicit-rung-2');
  });

  it('F4 non-project escalation keeps Studio ladder fallback', () => {
    const esc = new EscalationService(dbs, undefined, assignment);
    expect(esc.getModelForRung('implementer', 1)).toBe('codex-5.5');
  });
});
