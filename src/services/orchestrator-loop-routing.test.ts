process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import { RoutingConfigService } from './routing-config-service.js';
import { OrchestratorLoop } from './orchestrator-loop.js';
import { FakeTransport } from './fake-transport.js';

/**
 * A4: OrchestratorLoop consults RoutingConfigService (routeFor) as the source of routing decisions,
 * with the hardcoded FSM pair as fallback. HARD REQUIREMENT proven elsewhere (orchestrator-loop.test.ts,
 * unmodified) is zero behavior change on the A3 seed. This file covers the routeFor() resolution logic
 * itself: seed parity, non-core override honored, core transition protected.
 */

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a4-'));
  return {
    dbPath: path.join(dir, 'test.db'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

describe('A4 OrchestratorLoop.routeFor (consult RoutingConfigService; hardcoded FSM as fallback)', () => {
  let dbs: DatabaseService;
  let routingConfig: RoutingConfigService;
  let cleanup: () => void;
  let loop: OrchestratorLoop;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    routingConfig = new RoutingConfigService(dbs);
    loop = new OrchestratorLoop(new FakeTransport(), { runDir: '/tmp/helm-a4-unused', batchId: 'batch-A4', routingConfig });
  });

  afterEach(() => cleanup());

  it('(a) with routingConfig injected + the seed, routeFor returns IDENTICAL pairs to hardcoded for all 9 seeded transitions', () => {
    const seeded: Array<[string, string, string, string]> = [
      ['implementer', 'DONE', 'validator', 'validate'],
      ['implementer', 'BLOCKED', 'ibrain', 'decide'],
      ['validator', 'PASS', 'red-team', 'advance'],
      ['validator', 'FAIL', 'implementer', 'correction'],
      ['validator', 'REVISE', 'implementer', 'correction'],
      ['(algo)', 'rung-attempt-limit', 'ibrain', 'escalate'],
      ['validator', 'REPRO-CONFIRMED', 'implementer', 'fix'],
      ['validator', 'REPRO-FAILED', '(algo)', 'retry-then-defer'],
      ['(algo)', 'no-callback', '(same-role)', 'respawn'],
    ];
    for (const [emitter, status, handler, action] of seeded) {
      const result = loop.routeForTest(emitter, status, handler, action);
      expect(result).toEqual({ handler, action });
    }
  });

  it('no routingConfig injected -> pure hardcoded fallback (legacy/no-op path unaffected)', () => {
    const bareLoop = new OrchestratorLoop(new FakeTransport(), { runDir: '/tmp/helm-a4-unused2', batchId: 'batch-A4b' });
    const result = bareLoop.routeForTest('implementer', 'DONE', 'validator', 'validate');
    expect(result).toEqual({ handler: 'validator', action: 'validate' });
  });

  it('resolve() null (rule disabled/removed) -> hardcoded fallback, never a silent hang', () => {
    // disable the core implementer/DONE rule
    const rows = routingConfig.listRules();
    const core = rows.find(r => r.emitter_role === 'implementer' && r.when_status === 'DONE')!;
    routingConfig.setEnabled(core.id, false);
    const result = loop.routeForTest('implementer', 'DONE', 'validator', 'validate');
    expect(result).toEqual({ handler: 'validator', action: 'validate' });
  });

  it('(b) a NON-core override rule is honored by routeFor', () => {
    // A brand-new (emitter, status) pair outside the seeded 9 — a future JROM-added, non-core rule.
    routingConfig.upsertRule({
      emitter_role: 'validator',
      when_status: 'PARTIAL',
      handler_role: 'qa-bot',
      action: 'triage',
      is_core: 0,
      enabled: 1,
    });
    const result = loop.routeForTest('validator', 'PARTIAL', 'implementer', 'correction');
    // config differs from the caller's hardcoded pair and is NOT core -> config wins (override capability)
    expect(result).toEqual({ handler: 'qa-bot', action: 'triage' });
  });

  it('(c) an is_core rule with a conflicting config value -> hardcoded WINS (protected); warns once', () => {
    const rows = routingConfig.listRules();
    const core = rows.find(r => r.emitter_role === 'implementer' && r.when_status === 'DONE')!;
    // Mutate the core row's route (is_core stays 1 — upsertRule's update path never touches is_core).
    routingConfig.upsertRule({
      id: core.id,
      emitter_role: core.emitter_role,
      when_status: core.when_status,
      handler_role: 'rogue-validator',
      action: 'rogue-validate',
      note: core.note,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loop.routeForTest('implementer', 'DONE', 'validator', 'validate');
    // hardcoded pair wins — the disagreeing config value for a PROTECTED core transition is ignored
    expect(result).toEqual({ handler: 'validator', action: 'validate' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('CORE transition');
    warnSpy.mockRestore();
  });
});
