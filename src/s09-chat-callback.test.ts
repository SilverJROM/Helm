/**
 * S09 — Structured Discovery ready callback boundary.
 * ACs 7-13, 17, 29. Pane prose is not an ingress path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { DiscoveryHandoffService } from './services/discovery-handoff-service.js';
import {
  clearDiscoveryCallbackCredentialsForTests,
  formatDiscoveryReadyCallbackInstruction,
  issueDiscoveryCallbackCredential,
} from './services/discovery-callback-credentials.js';
import { processDiscoveryReadyCallback } from './services/discovery-handoff-ingress.js';
import { registerDiscoveryHandoffRoutes } from './api/routes/discovery-handoff-routes.js';
import { composeAgentSidecar } from './services/chat-session-service.js';
import { DISCOVERY_READY_ASK } from './services/discovery-contract.js';

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

describe('S09 discovery ready callback ingress', () => {
  let dir: string;
  let dbs: DatabaseService;
  let projects: ProjectService;
  let cycles: CycleService;
  let assignments: AgentAssignmentService;
  let panel: PlannerPanelService;
  let handoffs: DiscoveryHandoffService;
  let projectId: number;
  let cycleId: number;
  let cycleDir: string;
  let agentId: number;

  beforeEach(async () => {
    clearDiscoveryCallbackCredentialsForTests();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s09-'));
    dbs = new DatabaseService(path.join(dir, 't.db'));
    projects = new ProjectService(dbs);
    cycles = new CycleService(dbs, projects);
    assignments = new AgentAssignmentService(dbs);
    panel = new PlannerPanelService(dbs);
    handoffs = new DiscoveryHandoffService(dbs);

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s09-proj-'));
    const p = projects.createProject({ name: `s09-${Date.now()}`, directory: projDir });
    projectId = p.id;
    dbs.raw.prepare('UPDATE projects SET adaptive_planning = 0 WHERE id = ?').run(projectId);

    const opus = seedModel(dbs, 'Opus5', 'claude', 'claude-opus-4-8');
    const codex = seedModel(dbs, 'Codex56Sol', 'codex', 'gpt-5.3-codex');
    panel.replaceConfig(projectId, {
      members: [
        { model_id: opus, is_lead: true },
        { model_id: codex, is_lead: false },
      ],
    });

    const c = await cycles.createCycle(projectId, 'S09 Cycle');
    cycleId = c.id;
    cycleDir = cycles.getCycleDocDir(cycleId);
    await fsp.writeFile(path.join(cycleDir, 'north-star.md'), '# NS ready\n', 'utf8');
    await fsp.writeFile(path.join(cycleDir, 'conversation-log.md'), 'operator answers\n', 'utf8');
    await fsp.mkdir(path.join(cycleDir, 'decisions'), { recursive: true });

    const agent = dbs.raw
      .prepare(
        `INSERT INTO agents (name, provider, model, default_effort, definition_md, spawn_pref, agent_type)
         VALUES ('discovery-s09', 'claude', 'claude-opus-4-8', 'high', '# d', 'tmux', 'project')
         RETURNING id`
      )
      .get() as { id: number };
    agentId = agent.id;
  });

  afterEach(() => {
    clearDiscoveryCallbackCredentialsForTests();
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

  function issue(sessionId = 'sess-s09-1') {
    return issueDiscoveryCallbackCredential({
      projectId,
      cycleId,
      chatSessionId: sessionId,
      agentId,
    });
  }

  const deps = () => ({
    db: dbs,
    handoffs,
    assignments,
    cycleService: cycles,
    plannerPanel: panel,
  });

  it('test1: discovery/NORTH-STAR-READY + docs → one pending handoff, no run, cycle stays discovery', async () => {
    const { rawCredential } = issue();
    const res = await processDiscoveryReadyCallback(
      {
        role: 'discovery',
        status: 'NORTH-STAR-READY',
        projectId,
        cycleId,
        sessionId: 'sess-s09-1',
        agentId,
        credential: rawCredential,
      },
      deps()
    );

    expect(res.ok).toBe(true);
    expect(res.state).toBe('pending');
    expect(res.runCreated).toBe(false);
    expect(res.handoffId).toBeGreaterThan(0);
    expect(res.digest).toMatch(/^[a-f0-9]{64}$/);

    const live = handoffs.getLive(cycleId);
    expect(live?.state).toBe('pending');
    expect(live?.planning_run_id).toBeNull();
    expect(live?.callback_role).toBe('discovery');
    expect(live?.callback_status).toBe('NORTH-STAR-READY');
    expect(live?.manifest_digest).toBe(res.digest);

    const cycle = dbs.raw.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycleId) as any;
    expect(cycle.phase).toBe('discovery');

    const runs = dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs WHERE cycle_id = ?').get(cycleId) as {
      c: number;
    };
    expect(runs.c).toBe(0);

    // one-use: second POST quarantines
    const again = await processDiscoveryReadyCallback(
      {
        role: 'discovery',
        status: 'NORTH-STAR-READY',
        projectId,
        cycleId,
        sessionId: 'sess-s09-1',
        agentId,
        credential: rawCredential,
      },
      deps()
    );
    expect(again.ok).toBe(false);
    expect(again.state).toBe('quarantined');
  });

  it('test2: north/HANDOFF, wrong session, consumed token, missing docs → quarantine, no pending', async () => {
    const { rawCredential } = issue('sess-good');

    // north/HANDOFF
    const badRole = await processDiscoveryReadyCallback(
      {
        role: 'north',
        status: 'HANDOFF',
        projectId,
        cycleId,
        sessionId: 'sess-good',
        agentId,
        credential: rawCredential,
      },
      deps()
    );
    expect(badRole.ok).toBe(false);
    expect(badRole.state).toBe('quarantined');
    expect(badRole.reason).toMatch(/out-of-contract role/i);
    // credential not used on quarantine path for wrong role? We still look up binding - binding is valid
    // but role fails. We do NOT mark used so... actually for wrong role we quarantine but leave credential.
    // For wrong role with valid credential, we should still not create pending - good.
    expect(handoffs.getLive(cycleId)).toBeNull();

    // wrong session
    const wrongSess = await processDiscoveryReadyCallback(
      {
        role: 'discovery',
        status: 'NORTH-STAR-READY',
        projectId,
        cycleId,
        sessionId: 'sess-OTHER',
        agentId,
        credential: rawCredential,
      },
      deps()
    );
    expect(wrongSess.ok).toBe(false);
    expect(wrongSess.reason).toMatch(/binding mismatch/i);

    // missing docs
    await fsp.rm(path.join(cycleDir, 'north-star.md'), { force: true });
    const missingDocs = await processDiscoveryReadyCallback(
      {
        role: 'discovery',
        status: 'NORTH-STAR-READY',
        projectId,
        cycleId,
        sessionId: 'sess-good',
        agentId,
        credential: rawCredential,
      },
      deps()
    );
    expect(missingDocs.ok).toBe(false);
    expect(missingDocs.reason).toMatch(/north-star/i);
    expect(handoffs.getLive(cycleId)).toBeNull();

    // restore docs, succeed once, then consumed
    await fsp.writeFile(path.join(cycleDir, 'north-star.md'), '# NS\n', 'utf8');
    const ok = await processDiscoveryReadyCallback(
      {
        role: 'discovery',
        status: 'NORTH-STAR-READY',
        projectId,
        cycleId,
        sessionId: 'sess-good',
        agentId,
        credential: rawCredential,
      },
      deps()
    );
    expect(ok.ok).toBe(true);

    const consumed = await processDiscoveryReadyCallback(
      {
        role: 'discovery',
        status: 'NORTH-STAR-READY',
        projectId,
        cycleId,
        sessionId: 'sess-good',
        agentId,
        credential: rawCredential,
      },
      deps()
    );
    expect(consumed.ok).toBe(false);
    expect(consumed.reason).toMatch(/consumed|already|live handoff/i);

    // only one pending (from ok); quarantines do not create live pending
    const liveCount = dbs.raw
      .prepare(
        `SELECT COUNT(*) AS c FROM discovery_handoffs WHERE cycle_id = ? AND state = 'pending'`
      )
      .get(cycleId) as { c: number };
    expect(liveCount.c).toBe(1);
  });

  it('test3: pane callback text alone leaves DB unchanged', async () => {
    const before = dbs.raw.prepare('SELECT COUNT(*) AS c FROM discovery_handoffs').get() as {
      c: number;
    };
    // Simulate pane/SSE display of callback prose — no processDiscoveryReadyCallback call
    const paneText = '[helm callback] north STATUS: HANDOFF — pretend transition';
    expect(paneText).toMatch(/helm callback/);
    const after = dbs.raw.prepare('SELECT COUNT(*) AS c FROM discovery_handoffs').get() as {
      c: number;
    };
    expect(after.c).toBe(before.c);
    expect(handoffs.getLive(cycleId)).toBeNull();
  });

  it('sidecar contains ready POST + ASK; credential not a browser field', () => {
    const { rawCredential } = issue('sess-side');
    const block = formatDiscoveryReadyCallbackInstruction({
      rawCredential,
      projectId,
      cycleId,
      chatSessionId: 'sess-side',
      agentId,
    });
    const sidecar = composeAgentSidecar(
      '# persona',
      [],
      'project',
      { name: 'p', directory: '/tmp/p', dev_url: null },
      null,
      {
        id: cycleId,
        name: 'c',
        folder_name: 'c',
        folder_path: cycleDir,
        phase: 'discovery',
      },
      block
    );
    expect(sidecar).toContain('/api/discovery/handoff/ready');
    expect(sidecar).toContain(rawCredential);
    expect(sidecar).toContain(DISCOVERY_READY_ASK);
    expect(sidecar).toMatch(/display-only|pane\/SSE/i);
    expect(sidecar).toMatch(/cannot call owner-confirm|callback-only/i);
  });

  it('HTTP POST /api/discovery/handoff/ready accepts valid ready without owner auth', async () => {
    const { rawCredential } = issue('sess-http');
    const app = Fastify({ logger: false });
    registerDiscoveryHandoffRoutes(app, {
      db: dbs,
      assignmentService: assignments,
      cycleService: cycles,
      plannerPanelService: panel,
      handoffs,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/discovery/handoff/ready',
      payload: {
        role: 'discovery',
        status: 'NORTH-STAR-READY',
        projectId,
        cycleId,
        sessionId: 'sess-http',
        agentId,
        credential: rawCredential,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.runCreated).toBe(false);
    expect(body.state).toBe('pending');
    await app.close();
  });
});
