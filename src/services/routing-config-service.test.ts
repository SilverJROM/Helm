import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from '../db/database.js';
import { RoutingConfigService, RoutingCoreProtectedError, RoutingValidationError } from './routing-config-service.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a3-'));
  return {
    dbPath: path.join(dir, 'test.db'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

describe('A3 RoutingConfigService (data model only — OrchestratorLoop not touched)', () => {
  let dbs: DatabaseService;
  let svc: RoutingConfigService;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    svc = new RoutingConfigService(dbs);
  });

  afterEach(() => cleanup());

  it('seeds exactly the 9 core routing rules on fresh init', () => {
    const rules = svc.listRules();
    expect(rules.length).toBe(9);
    expect(rules.every(r => r.is_core === 1)).toBe(true);
    expect(rules.every(r => r.enabled === 1)).toBe(true);
  });

  it('resolve() returns the implementer DONE -> validator/validate rule from the seed', () => {
    const resolved = svc.resolve('implementer', 'DONE');
    expect(resolved).toEqual({ handler_role: 'validator', action: 'validate' });
  });

  it('resolve() covers all 9 seeded transitions verbatim from the OrchestratorLoop FSM', () => {
    expect(svc.resolve('implementer', 'BLOCKED')).toEqual({ handler_role: 'ibrain', action: 'decide' });
    expect(svc.resolve('validator', 'PASS')).toEqual({ handler_role: 'red-team', action: 'advance' });
    expect(svc.resolve('validator', 'FAIL')).toEqual({ handler_role: 'implementer', action: 'correction' });
    expect(svc.resolve('validator', 'REVISE')).toEqual({ handler_role: 'implementer', action: 'correction' });
    expect(svc.resolve('(algo)', 'rung-attempt-limit')).toEqual({ handler_role: 'ibrain', action: 'escalate' });
    expect(svc.resolve('validator', 'REPRO-CONFIRMED')).toEqual({ handler_role: 'implementer', action: 'fix' });
    expect(svc.resolve('validator', 'REPRO-FAILED')).toEqual({ handler_role: '(algo)', action: 'retry-then-defer' });
    expect(svc.resolve('(algo)', 'no-callback')).toEqual({ handler_role: '(same-role)', action: 'respawn' });
  });

  it('resolve() returns null for an unknown emitter/status pair', () => {
    expect(svc.resolve('implementer', 'NOPE')).toBeNull();
  });

  it('validateConfig() is ok on the seed (every core condition has an enabled route, no conflicts)', () => {
    const result = svc.validateConfig();
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('validateConfig() flags a disabled core rule as a problem (no silent pass)', () => {
    const rule = svc.listRules().find(r => r.emitter_role === 'implementer' && r.when_status === 'DONE')!;
    svc.setEnabled(rule.id, false);
    expect(svc.resolve('implementer', 'DONE')).toBeNull();
    const result = svc.validateConfig();
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBe(1);
    expect(result.problems[0]).toMatch(/implementer/);
    expect(result.problems[0]).toMatch(/DONE/);
  });

  it('validateConfig() flags conflicting enabled routes for the same emitter/status', () => {
    svc.upsertRule({ emitter_role: 'implementer', when_status: 'DONE', handler_role: 'ibrain', action: 'decide', is_core: 0, enabled: 1 });
    const result = svc.validateConfig();
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.includes('conflicting enabled routes'))).toBe(true);
  });

  it('getById / upsertRule (insert + update) / setEnabled — thin CRUD for the later Studio-edit batch', () => {
    const created = svc.upsertRule({ emitter_role: 'planner', when_status: 'REVIEW-READY', handler_role: 'ibrain', action: 'resume', note: 'custom' });
    expect(created.id).toBeGreaterThan(0);
    expect(created.is_core).toBe(0);
    expect(svc.getById(created.id)).toEqual(created);

    const updated = svc.upsertRule({ id: created.id, emitter_role: 'planner', when_status: 'REVIEW-READY', handler_role: 'coord', action: 'resume', note: 'updated' });
    expect(updated.handler_role).toBe('coord');
    expect(updated.note).toBe('updated');

    const disabled = svc.setEnabled(created.id, false);
    expect(disabled.enabled).toBe(0);
    expect(svc.getById(999999)).toBeNull();
    expect(() => svc.upsertRule({ id: 999999, emitter_role: 'x', when_status: 'y', handler_role: 'z', action: 'w' })).toThrow(/unknown routing rule/);
    expect(() => svc.setEnabled(999999, true)).toThrow(/unknown routing rule/);
  });
});

describe('A6 RoutingConfigService.addRule/editRule — Studio edit boundary + validate-or-rollback', () => {
  let dbs: DatabaseService;
  let svc: RoutingConfigService;
  let cleanup: () => void;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    svc = new RoutingConfigService(dbs);
  });

  afterEach(() => cleanup());

  it('addRule creates a new custom (is_core=0, enabled=1) rule and it round-trips via listRules/resolve', () => {
    const rule = svc.addRule({ emitter_role: 'planner', when_status: 'REVIEW-READY', handler_role: 'ibrain', action: 'resume', note: 'studio-added' });
    expect(rule.id).toBeGreaterThan(0);
    expect(rule.is_core).toBe(0);
    expect(rule.enabled).toBe(1);
    expect(rule.note).toBe('studio-added');
    expect(svc.resolve('planner', 'REVIEW-READY')).toEqual({ handler_role: 'ibrain', action: 'resume' });
    expect(svc.listRules().some(r => r.id === rule.id)).toBe(true);
  });

  it('editRule edits handler_role/action/note on a non-core rule and persists', () => {
    const rule = svc.addRule({ emitter_role: 'panelist', when_status: 'DONE', handler_role: 'coord', action: 'advance' });
    const edited = svc.editRule(rule.id, { handler_role: 'ibrain', action: 'decide', note: 'retuned' });
    expect(edited.handler_role).toBe('ibrain');
    expect(edited.action).toBe('decide');
    expect(edited.note).toBe('retuned');
    expect(svc.getById(rule.id)!.handler_role).toBe('ibrain');
  });

  it('editRule REJECTS a handler_role/action change on a core rule (RoutingCoreProtectedError), nothing persisted', () => {
    const core = svc.listRules().find(r => r.emitter_role === 'implementer' && r.when_status === 'DONE')!;
    expect(() => svc.editRule(core.id, { handler_role: 'someone-else' })).toThrow(RoutingCoreProtectedError);
    expect(() => svc.editRule(core.id, { action: 'other-action' })).toThrow(RoutingCoreProtectedError);
    // untouched
    expect(svc.getById(core.id)!.handler_role).toBe(core.handler_role);
    expect(svc.getById(core.id)!.action).toBe(core.action);
  });

  it('editRule ALLOWS enabled/note changes on a core rule (just not handler_role/action)', () => {
    const core = svc.listRules().find(r => r.emitter_role === 'validator' && r.when_status === 'PASS')!;
    const edited = svc.editRule(core.id, { note: 'ops note only' });
    expect(edited.note).toBe('ops note only');
    expect(edited.handler_role).toBe(core.handler_role); // unchanged
  });

  it('editRule REJECTS disabling a core rule that would leave its transition unrouted (RoutingValidationError), enabled bit not persisted (no-route = error, not silent-hang)', () => {
    const core = svc.listRules().find(r => r.emitter_role === 'implementer' && r.when_status === 'DONE')!;
    expect(() => svc.editRule(core.id, { enabled: false })).toThrow(RoutingValidationError);
    try {
      svc.editRule(core.id, { enabled: false });
    } catch (e: any) {
      expect(e.problems.some((p: string) => p.includes('implementer') && p.includes('DONE'))).toBe(true);
    }
    // rollback verified: still enabled, still resolves
    expect(svc.getById(core.id)!.enabled).toBe(1);
    expect(svc.resolve('implementer', 'DONE')).toEqual({ handler_role: core.handler_role, action: core.action });
  });

  it('editRule allows a VALID non-core enable/disable toggle to persist', () => {
    const rule = svc.addRule({ emitter_role: 'panelist', when_status: 'REVIEW', handler_role: 'coord', action: 'advance' });
    const disabled = svc.editRule(rule.id, { enabled: false });
    expect(disabled.enabled).toBe(0);
    expect(svc.getById(rule.id)!.enabled).toBe(0);
    expect(svc.resolve('panelist', 'REVIEW')).toBeNull();

    const reenabled = svc.editRule(rule.id, { enabled: true });
    expect(reenabled.enabled).toBe(1);
    expect(svc.resolve('panelist', 'REVIEW')).toEqual({ handler_role: 'coord', action: 'advance' });
  });

  it('addRule REJECTS a new rule that would create a conflicting enabled route for an existing (emitter,status) pair', () => {
    // implementer/DONE already core-routes to validator/validate; adding a conflicting enabled route must roll back.
    expect(() => svc.addRule({ emitter_role: 'implementer', when_status: 'DONE', handler_role: 'coord', action: 'advance' }))
      .toThrow(RoutingValidationError);
    // nothing extra persisted
    expect(svc.listRules().filter(r => r.emitter_role === 'implementer' && r.when_status === 'DONE').length).toBe(1);
  });

  it('editRule throws for unknown rule id', () => {
    expect(() => svc.editRule(999999, { note: 'x' })).toThrow(/unknown routing rule/);
  });
});
