/**
 * S10 — Confirmed-handoff Planning start (existing docs, frozen manifest, no interview).
 * ACs 14-15, 21, 24-26.
 */
process.env.USE_FAKE_TMUX = '1';
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { PlannerPanelService } from './services/planner-panel-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { PlanParserService } from './services/plan-parser-service.js';
import { TaskQueueService } from './services/task-queue-service.js';
import { FakeTransport } from './services/fake-transport.js';
import { EscalationService } from './services/escalation-service.js';
import { PanelService } from './services/panel-service.js';
import {
  RunOrchestratorService,
  ConfirmedHandoffPlanningError,
} from './services/run-orchestrator-service.js';
import {
  DiscoveryHandoffService,
  mintHandoffCredential,
} from './services/discovery-handoff-service.js';
import {
  PlanningStaffingService,
} from './services/planning-staffing-service.js';
import { CANONICAL_CYCLE_ARTIFACTS } from './services/cycle-artifact-paths.js';
import { isAwaitingApproval } from './services/cycle-service.js';

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

describe('S10 startPlanningFromConfirmedHandoff', () => {
  let dir: string;
  let dbs: DatabaseService;
  let projects: ProjectService;
  let cycles: CycleService;
  let assignments: AgentAssignmentService;
  let panel: PlannerPanelService;
  let artifacts: RunArtifactService;
  let handoffs: DiscoveryHandoffService;
  let fakeT: FakeTransport;
  let planningCalls: any[];
  let orch: RunOrchestratorService;
  let projectId: number;
  let cycleId: number;
  let cycleDir: string;
  let staffing: PlanningStaffingService;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s10-'));
    dbs = new DatabaseService(path.join(dir, 't.db'));
    projects = new ProjectService(dbs);
    cycles = new CycleService(dbs, projects);
    assignments = new AgentAssignmentService(dbs);
    panel = new PlannerPanelService(dbs);
    artifacts = new RunArtifactService(dbs);
    handoffs = new DiscoveryHandoffService(dbs);
    fakeT = new FakeTransport();
    planningCalls = [];
    staffing = new PlanningStaffingService(dbs, assignments, panel);

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s10-proj-'));
    const p = projects.createProject({
      name: `s10-${Date.now()}`,
      directory: projDir,
      autonomy_default: 'pause_after_planning',
    } as any);
    projectId = p.id;
    dbs.raw
      .prepare(
        "UPDATE projects SET adaptive_planning = 0, autonomy_default = 'pause_after_planning' WHERE id = ?"
      )
      .run(projectId);

    const opus = seedModel(dbs, 'Opus5', 'claude', 'claude-opus-4-8');
    const codex = seedModel(dbs, 'Codex56Sol', 'codex', 'gpt-5.3-codex');
    panel.replaceConfig(projectId, {
      members: [
        { model_id: opus, is_lead: true, effort: 'high' },
        { model_id: codex, is_lead: false, effort: 'med' },
      ],
    });

    const c = await cycles.createCycle(projectId, 'S10 Cycle');
    cycleId = c.id;
    // Ensure pause_after_planning on cycle
    dbs.raw
      .prepare("UPDATE cycles SET autonomy = 'pause_after_planning', phase = 'discovery' WHERE id = ?")
      .run(cycleId);

    cycleDir = cycles.getCycleDocDir(cycleId);
    await fsp.writeFile(
      path.join(cycleDir, CANONICAL_CYCLE_ARTIFACTS.northStar),
      '# S10 North Star existing bytes\n',
      'utf8'
    );
    await fsp.writeFile(path.join(cycleDir, 'conversation-log.md'), 'S10 conversation existing\n', 'utf8');
    await fsp.mkdir(path.join(cycleDir, 'decisions'), { recursive: true });

    const planningStub = {
      runPlanningPhase: async (opts: any) => {
        planningCalls.push(opts);
        return { runId: opts.runId, agreed: true };
      },
    } as any;

    orch = new RunOrchestratorService({
      artifacts,
      planning: planningStub,
      parser: new PlanParserService(artifacts),
      queue: new TaskQueueService(artifacts),
      transport: fakeT,
      projectService: projects,
      assignmentService: assignments,
      escalationService: new EscalationService(dbs),
      panelService: new PanelService(fakeT, artifacts, 's10'),
      plannerPanelService: panel,
      cycleService: cycles,
      deployRunner: { async runDeploy() { return { success: true, note: 'ok' }; } },
      finalTestRunner: { async runTest() { return { success: true, note: 'ok' }; } },
    });
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

  async function makeStartingHandoff(digestOverride?: string) {
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
      manifestJson: JSON.stringify(manifest),
      manifestDigest: digestOverride ?? manifest.digest,
    });
    expect(handoffs.casTransition(pending.id, 'pending', 'starting')).toBe(1);
    return { handoffId: pending.id, manifest };
  }

  it('test1: confirmed mode plans with existing doc bytes + exact seats; zero Discovery spawn', async () => {
    const { handoffId, manifest } = await makeStartingHandoff();
    const nsBefore = await fsp.readFile(
      path.join(cycleDir, CANONICAL_CYCLE_ARTIFACTS.northStar),
      'utf8'
    );

    const runId = await orch.startPlanningFromConfirmedHandoff({
      projectId,
      cycleId,
      handoffId,
      expectedDigest: manifest.digest,
      batchId: 's10-ok',
    });

    expect(runId).toBeGreaterThan(0);
    expect(planningCalls).toHaveLength(1);
    const call = planningCalls[0];
    expect(call.northStar).toBe(nsBefore);
    expect(call.conversationLog).toContain('S10 conversation existing');
    expect(call.canonicalArtifactRoot).toBe(cycleDir);
    expect(call.coPlannerSeats).toHaveLength(2);
    expect(call.coPlannerSeats.map((s: any) => s.model).sort()).toEqual(
      ['claude-opus-4-8', 'gpt-5.3-codex'].sort()
    );
    // No Discovery interview spawn
    expect(fakeT.spawnCalls.filter((s) => s.role === 'discovery')).toHaveLength(0);

    // Docs not overwritten
    const nsAfter = await fsp.readFile(
      path.join(cycleDir, CANONICAL_CYCLE_ARTIFACTS.northStar),
      'utf8'
    );
    expect(nsAfter).toBe(nsBefore);

    const row = handoffs.getById(handoffId)!;
    expect(row.state).toBe('started');
    expect(row.planning_run_id).toBe(runId);
  });

  it('test2: missing/mismatched handoff or digest creates no run', async () => {
    const runsBefore = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as any).c;

    await expect(
      orch.startPlanningFromConfirmedHandoff({
        projectId,
        cycleId,
        handoffId: 999999,
      })
    ).rejects.toBeInstanceOf(ConfirmedHandoffPlanningError);

    const { handoffId, manifest } = await makeStartingHandoff();
    await expect(
      orch.startPlanningFromConfirmedHandoff({
        projectId,
        cycleId,
        handoffId,
        expectedDigest: 'not-the-real-digest',
      })
    ).rejects.toMatchObject({ code: 'MISMATCH' });

    // Still starting — never advanced; no new run for mismatch path
    expect(handoffs.getById(handoffId)!.state).toBe('starting');
    const runsAfter = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as any).c;
    expect(runsAfter).toBe(runsBefore);
    expect(planningCalls).toHaveLength(0);
  });

  it('test3: pause_after_planning parks only after successful agreement', async () => {
    const { handoffId, manifest } = await makeStartingHandoff();

    // planning stub already returns agreed:true
    const finishSpy = vi.spyOn(cycles, 'finishPlanning');

    const runId = await orch.startPlanningFromConfirmedHandoff({
      projectId,
      cycleId,
      handoffId,
      expectedDigest: manifest.digest,
      batchId: 's10-park',
    });

    expect(planningCalls).toHaveLength(1);
    expect(finishSpy).toHaveBeenCalledWith(cycleId);

    // After finishPlanning, cycle should be awaiting_approval for pause_after_planning
    const crow = dbs.raw
      .prepare('SELECT autonomy, awaiting_approval, phase FROM cycles WHERE id = ?')
      .get(cycleId) as any;
    expect(isAwaitingApproval({
      autonomy: crow.autonomy,
      awaiting_approval: Boolean(Number(crow.awaiting_approval)),
    })).toBe(true);

    const run = dbs.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId) as any;
    // Parked via operator-pause → phase blocked, status paused
    expect(run.phase).toBe('blocked');
    expect(run.status).toBe('paused');
  });
});
