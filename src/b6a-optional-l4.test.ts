/**
 * B6a / AC-9 — Optional L4 on per-agent ladder (track A only).
 * Lift positions {1,2} → {1,2,3}; TOP_RUNG 2→3; plan domain 0..3.
 * Absent position-3 must match pre-B6a (tops at rung 2). No role_tiers / schema change.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';
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

describe('B6a optional L4 (track A — agent_escalations)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('studio setAgentEscalations: accepts position 3, ignores/skips position 4', () => {
    const t = tempDbPath('helm-b6a-studio-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);

    const impl = dbs.raw.prepare("SELECT id FROM agents WHERE name='implementer'").get() as { id: number };
    const codex = dbs.raw.prepare("SELECT id FROM models WHERE name='codex-5.5' OR model_id='gpt-5.5' LIMIT 1").get() as { id: number };
    const opus = dbs.raw.prepare("SELECT id FROM models WHERE name LIKE '%opus%' LIMIT 1").get() as { id: number };
    const grok = dbs.raw.prepare("SELECT id FROM models WHERE name LIKE '%grok%' LIMIT 1").get() as { id: number };
    expect(impl && codex && opus && grok).toBeTruthy();

    const set = as.setAgentEscalations(impl.id, [
      { position: 1, model_id: codex.id, trigger: 'on-fail' },
      { position: 2, model_id: opus.id, trigger: 'on-fail' },
      { position: 3, model_id: grok.id, trigger: 'on-fail' },
      { position: 4, model_id: grok.id, trigger: 'on-fail' }, // silently skipped (out of domain)
    ]);
    expect(set.map((e: any) => e.position).sort()).toEqual([1, 2, 3]);
    expect(set.find((e: any) => e.position === 3)?.model_id).toBe(grok.id);

    dbs.close();
  });

  it('project requireEscalationPosition: accepts 3, rejects 4', () => {
    const t = tempDbPath('helm-b6a-proj-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const pas = new ProjectAgentService(dbs, as);

    const impl = dbs.raw.prepare("SELECT id FROM agents WHERE name='implementer'").get() as { id: number };
    const codex = dbs.raw.prepare("SELECT id FROM models WHERE name='codex-5.5' OR model_id='gpt-5.5' LIMIT 1").get() as { id: number };
    const opus = dbs.raw.prepare("SELECT id FROM models WHERE name LIKE '%opus%' LIMIT 1").get() as { id: number };
    const grok = dbs.raw.prepare("SELECT id FROM models WHERE name LIKE '%grok%' LIMIT 1").get() as { id: number };
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6a-projdir-'));
    cleanups.push(() => {
      try {
        fs.rmSync(projDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const pid = Number(
      (dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?,?) RETURNING id').get(`b6a-${Date.now()}`, projDir) as any).id
    );
    pas.addAgent(pid, impl.id);

    const set = pas.setProjectAgentEscalations(pid, impl.id, {
      overridden: true,
      escalations: [
        { position: 1, model_id: codex.id, trigger: 'on-fail' },
        { position: 2, model_id: opus.id, trigger: 'on-fail' },
        { position: 3, model_id: grok.id, trigger: 'on-fail' },
      ],
    });
    expect(set.escalations.map((e: any) => e.position).sort()).toEqual([1, 2, 3]);

    expect(() =>
      pas.setProjectAgentEscalations(pid, impl.id, {
        overridden: true,
        escalations: [{ position: 4, model_id: grok.id, trigger: 'on-fail' }],
      })
    ).toThrow(/invalid escalation position/);

    dbs.close();
  });

  it('plan-parser: recommended_rung 3 accepted; 4 rejected', () => {
    const t = tempDbPath('helm-b6a-plan-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const art = new RunArtifactService(dbs);
    const parser = new PlanParserService(art);

    const base = {
      task_key: 'T-L4',
      atomic_work: 'use L4',
      complexity: 'high' as const,
      task_type: 'feature' as const,
      validation_criteria: 'ok',
    };
    const ok = parser.parsePlanFromJson(JSON.stringify({
      tasks: [{ ...base, recommended_rung: 3, validator_rung: 3 }],
    }));
    expect(ok.tasks[0].recommended_rung).toBe(3);
    expect(ok.tasks[0].validator_rung).toBe(3);

    expect(() =>
      parser.parsePlanFromJson(JSON.stringify({
        tasks: [{ ...base, recommended_rung: 4 }],
      }))
    ).toThrow(/recommended_rung invalid/);

    expect(() =>
      parser.parsePlanFromJson(JSON.stringify({
        tasks: [{ ...base, validator_rung: 4 }],
      }))
    ).toThrow(/validator_rung invalid/);

    dbs.close();
  });

  it('resolve/dispatch reaches rung 3 when position-3 is set (full L1–L4 ladder)', async () => {
    process.env.USE_FAKE_TMUX = '1';
    const t = tempDbPath('helm-b6a-l4-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const esc = new EscalationService(dbs, undefined, as);
    const svc = new RunArtifactService(dbs);

    const impl = dbs.raw.prepare("SELECT id FROM agents WHERE name='implementer'").get() as { id: number };
    const val = dbs.raw.prepare("SELECT id FROM agents WHERE name='validator'").get() as { id: number };
    const codex = dbs.raw.prepare("SELECT id FROM models WHERE name='codex-5.5' OR model_id='gpt-5.5' LIMIT 1").get() as { id: number };
    const opus = dbs.raw.prepare("SELECT id FROM models WHERE name LIKE '%opus%' LIMIT 1").get() as { id: number };
    const grok = dbs.raw.prepare("SELECT id FROM models WHERE name LIKE '%grok%' LIMIT 1").get() as { id: number };
    expect(impl && val && codex && opus && grok).toBeTruthy();

    // Full L1–L4 for both roles (validator inherits implementer rung when no explicit validator_rung)
    for (const agentId of [impl.id, val.id]) {
      as.setAgentEscalations(agentId, [
        { position: 1, model_id: codex.id, trigger: 'on-fail' },
        { position: 2, model_id: opus.id, trigger: 'on-fail' },
        { position: 3, model_id: grok.id, trigger: 'on-fail', effort: agentId === impl.id ? 'xhigh' : null },
      ]);
    }

    const r3 = esc.resolveRungAndModel({ role: 'implementer', explicitRung: 3 });
    expect(r3.rung).toBe(3);
    expect(r3.model).toBeTruthy();
    expect(r3.effort).toBe('xhigh');
    expect(esc.getMaxResolvableRung('implementer')).toBe(3);
    expect(esc.getModelForRung('implementer', 3)).toBe(r3.model);
    expect(esc.getMaxResolvableRung('validator')).toBe(3);

    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6a-run-'));
    cleanups.push(() => {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    fs.writeFileSync(path.join(runDir, 'callbacks.md'), '# B6a L4 callbacks\n', 'utf8');

    const transport = new FakeTransport();
    const loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B6a',
      artifactService: svc,
      escalationService: esc,
    });

    const p = loop.runTask({
      brief: 'B6a L4 dispatch',
      recommendedRung: 3,
      effort: 'low',
      taskType: 'feature',
    });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.promises.appendFile(cbp, `[helm callback] implementer batch-B6a STATUS: DONE — l4\n`);
    await sleep(20);
    await fs.promises.appendFile(cbp, `[helm callback] validator batch-B6a STATUS: PASS — ok\n`);
    await sleep(20);
    const res = await p;

    expect(res.finalStatus).toBe('PASS');
    expect(loop.getCurrentRung()).toBe(3);
    const implSpawns = transport.spawnCalls.filter((s) => s.role === 'implementer');
    expect(implSpawns.length).toBeGreaterThanOrEqual(1);
    expect((implSpawns[0] as any).rung).toBe(3);
    // B5 effort threading: position-3 effort=xhigh wins over plan low
    expect((implSpawns[0] as any).effort).toBe('xhigh');

    dbs.close();
  });

  it('ABSENT-L4 regression: no position-3 → max resolvable 2; top-rung exhaust at 2 (byte-identical to today)', async () => {
    process.env.USE_FAKE_TMUX = '1';
    const t = tempDbPath('helm-b6a-no-l4-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const esc = new EscalationService(dbs, undefined, as);
    const svc = new RunArtifactService(dbs);

    // Default seeds: positions 1+2 only — no position 3
    const positions = (
      dbs.raw
        .prepare(
          `SELECT e.position FROM agent_escalations e
           JOIN agents a ON a.id = e.agent_id WHERE a.name='implementer' ORDER BY e.position`
        )
        .all() as { position: number }[]
    ).map((r) => r.position);
    expect(positions).toEqual([1, 2]);

    expect(esc.getMaxResolvableRung('implementer')).toBe(2);
    expect(esc.resolveRungAndModel({ role: 'implementer', explicitRung: 2 }).rung).toBe(2);
    expect(() => esc.resolveRungAndModel({ role: 'implementer', explicitRung: 3 })).toThrow(/NO_RUNG_3/);
    expect(() => esc.resolveRungAndModel({ role: 'implementer', explicitRung: 4 })).toThrow(/INVALID_RUNG/);

    // Top-rung exhaustion at recommendedRung=2 must still BLOCK without consulting higher (L4 absent)
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6a-nol4-run-'));
    cleanups.push(() => {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    fs.writeFileSync(path.join(runDir, 'callbacks.md'), '# B6a absent-L4\n', 'utf8');

    const transport = new FakeTransport();
    const loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B6a-nil',
      artifactService: svc,
      escalationService: esc,
    });
    (loop as any).MAX_TASK_ATTEMPTS = 3;

    const p = loop.runTask({
      brief: 'absent L4 top exhaust',
      recommendedRung: 2,
      taskType: 'feature',
      taskKey: 'NO-L4-EXHAUST',
    });
    const cbp = path.join(runDir, 'callbacks.md');
    for (let i = 1; i <= 3; i++) {
      await fs.promises.appendFile(cbp, `[helm callback] implementer batch-B6a-nil STATUS: DONE — r2-${i}\n`);
      await sleep(10);
      await fs.promises.appendFile(cbp, `[helm callback] validator batch-B6a-nil STATUS: FAIL — r2 diag ${i}\n`);
      await sleep(10);
    }
    const res = await p;
    expect(res.finalStatus).toBe('BLOCKED');
    expect(loop.getCurrentRung()).toBe(2);
    expect(loop.getTransitions()).toContain('rung2-exhaust-block');
    // Must not have climbed past 2
    const rungs = transport.spawnCalls.filter((s) => s.role === 'implementer').map((s: any) => s.rung);
    expect(rungs.every((r: number) => r <= 2)).toBe(true);

    dbs.close();
  });
});
