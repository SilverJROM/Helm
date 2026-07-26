/**
 * B7 / AC-11 — Start rung follows task difficulty tag (track A dispatch).
 *
 * Mechanism (not “token savings”): plan/task `recommended_rung` must drive the
 * FIRST implementer spawn model via the existing start-rung path:
 *
 *   plan-parser (`recommended_rung` 0..3)
 *     → run-orchestrator (`explicitRung` preflight + `recommendedRung` into runTask)
 *     → orchestrator-loop `runTask` (`config.recommendedRung`
 *         → EscalationService.resolveRungAndModel({ explicitRung })
 *         → startRung → this.currentRung
 *         → implementer spawn model via getModelForRung / getLaunchableModel)
 *
 * Field under test: PlannedTask.recommended_rung / runTask config.recommendedRung
 * Function under test: OrchestratorLoop.runTask start-rung resolve + first implementer spawn
 *
 * Track A only (agent_escalations). No role_tiers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { EscalationService } from './services/escalation-service.js';
import { PlanParserService } from './services/plan-parser-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { FakeTransport } from './services/fake-transport.js';
import { OrchestratorLoop } from './services/orchestrator-loop.js';

function tempDbPath(prefix: string): { dbPath: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  return {
    dbPath,
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('B7 / AC-11 start-rung follows recommended_rung (mechanism)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function seedFullL1L3(dbs: DatabaseService, as: AgentAssignmentService) {
    const impl = dbs.raw.prepare("SELECT id FROM agents WHERE name='implementer'").get() as { id: number };
    const val = dbs.raw.prepare("SELECT id FROM agents WHERE name='validator'").get() as { id: number };
    const codex = dbs.raw
      .prepare("SELECT id, name, model_id FROM models WHERE name='codex-5.5' OR model_id='gpt-5.5' LIMIT 1")
      .get() as { id: number; name: string; model_id: string };
    const opus = dbs.raw
      .prepare("SELECT id, name, model_id FROM models WHERE name='claude-opus' LIMIT 1")
      .get() as { id: number; name: string; model_id: string };
    expect(impl && val && codex && opus).toBeTruthy();

    // Full L1–L3: position 1 = L2, position 2 = L3 (rung 0 = agent default = L1)
    for (const agentId of [impl.id, val.id]) {
      as.setAgentEscalations(agentId, [
        { position: 1, model_id: codex.id, trigger: 'on-fail' },
        { position: 2, model_id: opus.id, trigger: 'on-fail' },
      ]);
    }

    const l1 = dbs.raw
      .prepare(
        `SELECT m.name, m.model_id FROM agents a
         LEFT JOIN models m ON a.default_model_id = m.id
         WHERE a.name='implementer'`
      )
      .get() as { name: string; model_id: string };
    return {
      l1Display: l1.name,
      l1Launchable: l1.model_id || l1.name,
      l2Display: codex.name,
      l2Launchable: codex.model_id || codex.name,
      l3Display: opus.name,
      l3Launchable: opus.model_id || opus.name,
    };
  }

  async function runOnce(
    esc: EscalationService,
    svc: RunArtifactService,
    batchId: string,
    config: { recommendedRung?: number; brief?: string }
  ): Promise<{ transport: FakeTransport; loop: OrchestratorLoop; firstImpl: any }> {
    process.env.USE_FAKE_TMUX = '1';
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b7-run-'));
    cleanups.push(() => {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    fs.writeFileSync(path.join(runDir, 'callbacks.md'), `# ${batchId}\n`, 'utf8');

    const transport = new FakeTransport();
    const loop = new OrchestratorLoop(transport, {
      runDir,
      batchId,
      artifactService: svc,
      escalationService: esc,
    });

    const p = loop.runTask({
      brief: config.brief || `AC-11 ${batchId}`,
      recommendedRung: config.recommendedRung,
      taskType: 'feature',
    });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.promises.appendFile(cbp, `[helm callback] implementer ${batchId} STATUS: DONE — ok\n`);
    await sleep(20);
    await fs.promises.appendFile(cbp, `[helm callback] validator ${batchId} STATUS: PASS — ok\n`);
    await sleep(20);
    const res = await p;
    expect(res.finalStatus).toBe('PASS');

    const implSpawns = transport.spawnCalls.filter((s) => s.role === 'implementer');
    expect(implSpawns.length).toBeGreaterThanOrEqual(1);
    return { transport, loop, firstImpl: implSpawns[0] as any };
  }

  it('plan-parser preserves recommended_rung=2 (field under test)', () => {
    const t = tempDbPath('helm-b7-parse-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const art = new RunArtifactService(dbs);
    const parser = new PlanParserService(art);

    const plan = parser.parsePlanFromJson(
      JSON.stringify({
        tasks: [
          {
            task_key: 'AC11-L3',
            atomic_work: 'hard slice starting at L3',
            complexity: 'low',
            recommended_rung: 2,
            task_type: 'feature',
            validation_criteria: 'first spawn is L3 model',
          },
        ],
      })
    );
    expect(plan.tasks[0].recommended_rung).toBe(2);
    dbs.close();
  });

  it('recommended_rung=2 + full L1–L3 ladder → FIRST implementer spawn uses L3 model (not L1)', async () => {
    const t = tempDbPath('helm-b7-r2-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const esc = new EscalationService(dbs, undefined, as);
    const svc = new RunArtifactService(dbs);
    const ladder = seedFullL1L3(dbs, as);

    // Preflight: resolve explicit rung 2 is L3 display model
    const resolved = esc.resolveRungAndModel({ role: 'implementer', explicitRung: 2 });
    expect(resolved.rung).toBe(2);
    expect(resolved.model).toBe(ladder.l3Display);
    expect(resolved.model).not.toBe(ladder.l1Display);

    const { firstImpl, loop } = await runOnce(esc, svc, 'batch-B7-r2', { recommendedRung: 2 });

    // Mechanism: startRung → currentRung → first spawn
    expect(loop.getCurrentRung()).toBe(2);
    expect(firstImpl.rung).toBe(2);
    // Spawn model is launchable id (R6 mapping); must be L3, never L1
    expect(firstImpl.model).toBe(ladder.l3Launchable);
    expect(firstImpl.model).not.toBe(ladder.l1Launchable);
    expect(String(firstImpl.model)).toMatch(/opus/i);
    expect(String(firstImpl.model)).not.toMatch(/grok/i);

    dbs.close();
  });

  it('recommended_rung=0 starts at L1 (today default)', async () => {
    const t = tempDbPath('helm-b7-r0-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const esc = new EscalationService(dbs, undefined, as);
    const svc = new RunArtifactService(dbs);
    const ladder = seedFullL1L3(dbs, as);

    const { firstImpl, loop } = await runOnce(esc, svc, 'batch-B7-r0', { recommendedRung: 0 });

    expect(loop.getCurrentRung()).toBe(0);
    expect(firstImpl.rung).toBe(0);
    expect(firstImpl.model).toBe(ladder.l1Launchable);
    expect(firstImpl.model).not.toBe(ladder.l3Launchable);

    dbs.close();
  });

  it('recommended_rung unset starts at L1 (today default)', async () => {
    const t = tempDbPath('helm-b7-unset-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const esc = new EscalationService(dbs, undefined, as);
    const svc = new RunArtifactService(dbs);
    const ladder = seedFullL1L3(dbs, as);

    // omit recommendedRung entirely
    const { firstImpl, loop } = await runOnce(esc, svc, 'batch-B7-unset', {});

    expect(loop.getCurrentRung()).toBe(0);
    expect(firstImpl.rung).toBe(0);
    expect(firstImpl.model).toBe(ladder.l1Launchable);
    expect(firstImpl.model).not.toBe(ladder.l3Launchable);

    dbs.close();
  });

  it('with L4 present, recommended_rung=3 → FIRST implementer spawn uses L4 model', async () => {
    const t = tempDbPath('helm-b7-r3-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const esc = new EscalationService(dbs, undefined, as);
    const svc = new RunArtifactService(dbs);

    const impl = dbs.raw.prepare("SELECT id FROM agents WHERE name='implementer'").get() as { id: number };
    const val = dbs.raw.prepare("SELECT id FROM agents WHERE name='validator'").get() as { id: number };
    const codex = dbs.raw
      .prepare("SELECT id FROM models WHERE name='codex-5.5' OR model_id='gpt-5.5' LIMIT 1")
      .get() as { id: number };
    const opus = dbs.raw.prepare("SELECT id FROM models WHERE name='claude-opus' LIMIT 1").get() as { id: number };
    // Distinct L4 model (not L1/L2/L3): use a different grok display if available, else codex-5.4
    const l4Row = dbs.raw
      .prepare(
        "SELECT id, name, model_id FROM models WHERE name='codex-5.4' OR model_id='gpt-5.4' LIMIT 1"
      )
      .get() as { id: number; name: string; model_id: string };
    expect(impl && val && codex && opus && l4Row).toBeTruthy();

    for (const agentId of [impl.id, val.id]) {
      as.setAgentEscalations(agentId, [
        { position: 1, model_id: codex.id, trigger: 'on-fail' },
        { position: 2, model_id: opus.id, trigger: 'on-fail' },
        { position: 3, model_id: l4Row.id, trigger: 'on-fail' },
      ]);
    }

    const resolved = esc.resolveRungAndModel({ role: 'implementer', explicitRung: 3 });
    expect(resolved.rung).toBe(3);
    expect(resolved.model).toBe(l4Row.name);

    const { firstImpl, loop } = await runOnce(esc, svc, 'batch-B7-r3', { recommendedRung: 3 });

    expect(loop.getCurrentRung()).toBe(3);
    expect(firstImpl.rung).toBe(3);
    const l4Launchable = l4Row.model_id || l4Row.name;
    expect(firstImpl.model).toBe(l4Launchable);
    // Not L1
    expect(String(firstImpl.model)).not.toMatch(/^grok-4\.5$/);

    dbs.close();
  });
});
