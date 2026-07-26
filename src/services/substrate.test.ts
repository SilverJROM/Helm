import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { PROVIDERS } from '../config/providers.js';
import { resolveAgentLaunchSpec } from './provider-resolver-service.js';
import { AgentEventsService } from './agent-events-service.js';
import { AgentEventIngestService, parseGrokStatusFile, parseCallbackLine, correlationId } from './agent-event-ingest.js';
import { roleMatches, workerFaceRole, normalizeRole } from './role-alias.js';

describe('P1-2 engine substrate (providers + resolver + agent_events)', () => {
  let tmpDb: string;
  let db: DatabaseService;
  let events: AgentEventsService;

  beforeEach(() => {
    tmpDb = path.join('/tmp', `helm-p12-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    events = new AgentEventsService(db);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb);
  });

  it('resolver returns correct spec for each real provider (grok/codex/claude)', () => {
    const grok = resolveAgentLaunchSpec({ provider: 'grok', model: 'grok-4.5' });
    expect(grok.provider).toBe('grok');
    expect(grok.launch_cmd).toContain('grok --always-approve');
    expect(grok.bypass_flag).toBe('--always-approve');
    expect(grok.callback_mechanism).toBe('status-file');

    const codex = resolveAgentLaunchSpec({ provider: 'codex', model: 'gpt-5.5' });
    expect(codex.provider).toBe('codex');
    expect(codex.callback_mechanism).toBe('callbacks.md + emit-status');

    const claude = resolveAgentLaunchSpec({ provider: 'claude', model: 'claude-opus-4-8' });
    expect(claude.provider).toBe('claude');
    expect(claude.launch_cmd).toMatch(/^claude /);
    expect(claude.launch_cmd).toContain('--model claude-opus-4-8');
  });

  it('H17 one-edit: add ONLY a registry entry (zero code change elsewhere) and it resolves', () => {
    const dummyDef = {
      provider: 'dummy',
      launch: { defaultMode: 'tui' as const, templates: { tui: 'dummy --model <model>' } },
      bypassFlag: null,
      effort: { mechanism: 'none', flagTemplate: null as string | null },
      callbackMechanism: 'dummy-cb',
      worktree: { supported: false, flag: null as string | null },
      sessionSuffix: 'dummy',
      models: [{ model: 'dummy-model', band: 'mid' as const, eligibleRoles: ['implementer' as const] }]
    };
    (PROVIDERS as any).dummy = dummyDef; // ONLY this "edit" in the test
    const spec = resolveAgentLaunchSpec({ provider: 'dummy', model: 'dummy-model' });
    expect(spec.provider).toBe('dummy');
    expect(spec.launch_cmd).toContain('dummy-model');
    delete (PROVIDERS as any).dummy;
  });

  it('agent_events: write + run_id isolation (run-Y gets nothing from run-X) + carries fields', () => {
    const row = events.recordEvent({
      run_id: 'run-X',
      role: 'implementer',
      batch_id: 'b1',
      type: 'status',
      state: 'DONE',
      source: 'callback',
      correlation_id: 'c1',
      body: { foo: 'bar' }
    });
    expect(row.run_id).toBe('run-X');
    expect(row.role).toBe('implementer');
    expect(row.type).toBe('status');
    expect(row.state).toBe('DONE');
    expect(row.ts).toBeDefined();

    const xs = events.listEvents('run-X');
    expect(xs.length).toBe(1);

    const ys = events.listEvents('run-Y');
    expect(ys.length).toBe(0); // isolation proof
  });

  it('ingest grok status-file sample → correct row (type/state/source); dedupe via correlation', async () => {
    const tmp = `/tmp/grok-s-${Date.now()}.json`;
    fs.writeFileSync(tmp, JSON.stringify({ status: 'DONE', commit: 'abc123', dev_url: 'http://ex', notes: 'ok' }));
    const parsed = await parseGrokStatusFile(tmp);
    expect(parsed?.status).toBe('DONE');

    const row = events.recordEvent({
      run_id: 'r1',
      role: 'implementer',
      batch_id: 'b1',
      type: 'status',
      state: parsed!.status,
      source: 'callback',
      correlation_id: correlationId('r1', 'b1', parsed!.status),
      body: { file: tmp, commit: parsed!.commit }
    });
    expect(row.state).toBe('DONE');
    expect(row.source).toBe('callback');

    // second signal same correlation → dedupe (terminal logic + test count)
    events.recordEvent({
      run_id: 'r1',
      role: 'implementer',
      batch_id: 'b1',
      type: 'status',
      state: parsed!.status,
      source: 'callback',
      correlation_id: correlationId('r1', 'b1', parsed!.status),
      body: { file: tmp }
    });
    const list = events.listEvents('r1');
    expect(list.length).toBe(1);

    fs.unlinkSync(tmp);
  });

  it('parseCallbackLine + correlationId work', () => {
    // v90 accepts only the Helm-native callback prefix.
    const p = parseCallbackLine('[helm callback] implementer b1 STATUS: DONE — note');
    expect(p?.role).toBe('implementer');
    expect(p?.batchId).toBe('b1');
    expect(p?.state).toBe('DONE');
    const cid = correlationId('r', 'b', 'DONE');
    expect(cid).toContain('terminal:r:b:DONE');

    expect(parseCallbackLine('[projcore callback] implementer b1 STATUS: DONE — note')).toBeNull();
    expect(parseCallbackLine('[helm callback] implementer b1 STATUS: REPRO-FAILED — note')).toBeTruthy(); // validator state

    // A shared worker face is preserved until an expected internal role is known.
    expect(parseCallbackLine('[helm callback] helm_pm b1 STATUS: PLAN-READY — ready')?.role).toBe('helm_pm');
    expect(normalizeRole('helm_pm')).toBe('helm_pm');
    expect(workerFaceRole('plancore')).toBe('helm_pm');
    expect(workerFaceRole('ibrain')).toBe('helm_pm');
    expect(roleMatches('plancore', 'helm_pm')).toBe(true);
    expect(roleMatches('ibrain', 'helm_pm')).toBe(true);
    expect(roleMatches('plancore', 'ibrain')).toBe(false);
  });

  it('contextually ingests a helm_pm callback as the expected plancore or ibrain role', async () => {
    const runDir = path.join('/tmp', `helm-role-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(runDir, { recursive: true });
    const callbacksPath = path.join(runDir, 'callbacks.md');
    try {
      fs.writeFileSync(callbacksPath, '[helm callback] helm_pm planning STATUS: PLAN-READY — ready\n');
      const planningIngest = new AgentEventIngestService(events);
      const planningRows = await planningIngest.runIngest({
        runId: 'role-context-planning', batchId: 'planning', runDir, callbacksPath, role: 'plancore'
      });
      expect(planningRows).toHaveLength(1);
      expect(planningRows[0].role).toBe('plancore');

      fs.writeFileSync(callbacksPath, '[helm callback] helm_pm escalation STATUS: DECISION-READY — decide\n');
      const implementationIngest = new AgentEventIngestService(events);
      const implementationRows = await implementationIngest.runIngest({
        runId: 'role-context-implementation', batchId: 'escalation', runDir, callbacksPath, role: 'ibrain'
      });
      expect(implementationRows).toHaveLength(1);
      expect(implementationRows[0].role).toBe('ibrain');

      const ambiguousWithoutMatchingContext = new AgentEventIngestService(events);
      const rejected = await ambiguousWithoutMatchingContext.runIngest({
        runId: 'role-context-discovery', batchId: 'escalation', runDir, callbacksPath, role: 'discovery'
      });
      expect(rejected).toHaveLength(0);
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});
