import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import { ModelService } from './model-service.js';
import { ModelValidationService, classifyPane, type CommandRunner } from './model-validation-service.js';
import { HELM_ENVELOPE_DIRECTIVE } from './envelope-isolation.js';

const execFileAsyncMvs = promisify(execFile);
// SL-R5 teardown fix: these tests inject a fake tmux (no real session), but validateModel's real
// path names sessions helm-val-codex-*. Best-effort sweep of any that leaked (e.g. a real
// validation run) so the suite never leaves them on the box. Never throws.
async function sweepValLeakedSessions(): Promise<void> {
  try {
    const { stdout } = await execFileAsyncMvs('tmux', ['ls', '-F', '#{session_name}']);
    const names = stdout.split('\n').map((s) => s.trim()).filter((n) => /^helm-val-codex-/.test(n));
    for (const n of names) {
      await execFileAsyncMvs('tmux', ['kill-session', '-t', n]).catch(() => {});
    }
  } catch {
    // no server / no sessions — nothing to sweep
  }
}
// File-level afterAll (runs once after all describes in this file).
afterAll(async () => { await sweepValLeakedSessions(); });

// ---------------------------------------------------------------------------
// Fake CommandRunner factory — returns scripted output; NO real CLI spawned.
// ---------------------------------------------------------------------------
type RunnerCall = { cmd: string; args: string[]; opts: { timeoutMs: number; env?: any } };

function makeFakeRunner(scripted: { stdout: string; stderr: string; code: number } | 'timeout'): {
  runner: CommandRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (scripted === 'timeout') throw new Error('timeout: child killed after 60000ms');
    return scripted;
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b2iter2-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

// ---------------------------------------------------------------------------
// 1. Classifier unit tests — pure function, no runner, no DB
// ---------------------------------------------------------------------------
describe('B2 classifyPane — error-pattern classifier unit tests (no runner, no DB)', () => {
  it('invalid_model: "invalid model"', () => {
    const r = classifyPane('Error: invalid model specified.', 'HELM_VALID_aabb');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^invalid_model:/);
  });

  it('invalid_model: "model not found"', () => {
    const r = classifyPane('model not found in registry.', 'HELM_VALID_1122');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^invalid_model:/);
  });

  it('invalid_model: "unknown model"', () => {
    const r = classifyPane('unknown model: grok-xyz', 'HELM_VALID_3344');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^invalid_model:/);
  });

  it('invalid_model: "does not exist"', () => {
    const r = classifyPane('The specified model does not exist.', 'HELM_VALID_5566');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^invalid_model:/);
  });

  it('auth: "api key"', () => {
    const r = classifyPane('Authentication failed: api key is invalid.', 'HELM_VALID_aabb');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^auth:/);
  });

  it('auth: "unauthorized"', () => {
    const r = classifyPane('Request failed: 401 unauthorized.', 'HELM_VALID_ccdd');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^auth:/);
  });

  it('auth: "login required"', () => {
    const r = classifyPane('Please login required to continue.', 'HELM_VALID_eeff');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^auth:/);
  });

  it('auth: "credentials"', () => {
    const r = classifyPane('Invalid credentials provided.', 'HELM_VALID_0011');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^auth:/);
  });

  it('quota: "rate limit"', () => {
    const r = classifyPane('Rate limit exceeded. Retry after 60s.', 'HELM_VALID_2233');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^quota:/);
  });

  it('quota: "billing"', () => {
    const r = classifyPane('Billing issue: insufficient credits.', 'HELM_VALID_4455');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^quota:/);
  });

  it('quota: "usage limit"', () => {
    const r = classifyPane('usage limit reached for today.', 'HELM_VALID_6677');
    expect(r!.status).toBe('invalid');
    expect(r!.detail).toMatch(/^quota:/);
  });

  it('null: no error pattern in output (caller decides valid vs unknown)', () => {
    expect(classifyPane('Hello world, processing...', 'HELM_VALID_aabb')).toBeNull();
  });

  it('null: empty pane', () => {
    expect(classifyPane('', 'HELM_VALID_0000')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Service integration tests — injectable CommandRunner, NO real CLI
// ---------------------------------------------------------------------------
describe('B2 ModelValidationService — service tests (injectable CommandRunner, no real CLI)', () => {
  let dbPath: string;
  let cleanupDb: () => void;
  let db: DatabaseService;
  let ms: ModelService;

  beforeEach(() => {
    const t = makeTempDb();
    dbPath = t.dbPath;
    cleanupDb = t.cleanup;
    db = new DatabaseService(dbPath);
    ms = new ModelService(db);
  });

  afterEach(() => {
    cleanupDb();
  });

  // ---- valid: exit 0 + marker in stdout ----
  it('valid path (grok): exit0 + marker in stdout → status=valid, DB row updated', async () => {
    const model = ms.createModel({ cli: 'grok', name: 'b2-valid-grok', provider: 'grok', model_id: 'grok-composer-2.5-fast' });

    let capturedArgs: string[] = [];
    const { runner, calls } = makeFakeRunner({ stdout: '', stderr: '', code: 0 }); // placeholder
    // Override to capture args and inject dynamic marker
    const dynamicRunner: CommandRunner = async (cmd, args, opts) => {
      capturedArgs = args;
      // Extract the nonce marker from the prompt arg (args[1] = '-p' value)
      const prompt = args[1]; // ['-p', prompt, '-m', modelId]
      const m = prompt.match(/HELM_VALID_[a-f0-9]+/);
      const marker = m ? m[0] : '';
      return { stdout: marker, stderr: '', code: 0 };
    };

    const svc = new ModelValidationService(db, dynamicRunner, { hardWallMs: 5_000 });
    const result = await svc.validate(model.id);

    expect(result.status).toBe('valid');
    expect(result.detail).toBe('valid: headless marker echoed');

    const updated = ms.getModel(model.id)!;
    expect(updated.validation_status).toBe('valid');
    expect(updated.validated_at).not.toBeNull();
    expect(updated.validation_detail).toBe('valid: headless marker echoed');

    // Verify correct grok command: 'grok', ['-p', prompt, '-m', modelId]
    expect(capturedArgs[0]).toBe('-p');
    expect(capturedArgs[2]).toBe('-m');
    expect(capturedArgs[3]).toBe('grok-composer-2.5-fast');
  });

  it('valid path (claude): runner called with correct claude args', async () => {
    const model = ms.createModel({ cli: 'claude', name: 'b2-valid-claude', provider: 'claude', model_id: 'claude-sonnet-4-6' });

    let capturedCmd = '';
    let capturedArgs: string[] = [];
    const dynamicRunner: CommandRunner = async (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      const prompt = args[1]; // ['-p', prompt, '--model', modelId, '--dangerously-skip-permissions']
      const m = prompt.match(/HELM_VALID_[a-f0-9]+/);
      const marker = m ? m[0] : '';
      return { stdout: marker, stderr: '', code: 0 };
    };

    const svc = new ModelValidationService(db, dynamicRunner, { hardWallMs: 5_000 });
    const result = await svc.validate(model.id);

    expect(result.status).toBe('valid');
    // Verify exact claude args (B4-T03: now includes envelope isolation from shared helper)
    expect(capturedCmd).toBe('claude');
    expect(capturedArgs[0]).toBe('-p');
    expect(capturedArgs[2]).toBe('--model');
    expect(capturedArgs[3]).toBe('claude-sonnet-4-6');
    expect(capturedArgs[4]).toBe('--dangerously-skip-permissions');
    // B4-T03 isolation assertions on direct claude CLI spawn (even unfenced probe)
    expect(capturedArgs).toContain('--setting-sources');
    expect(capturedArgs).toContain('');
    expect(capturedArgs).toContain('--append-system-prompt');
    expect(capturedArgs).toContain(HELM_ENVELOPE_DIRECTIVE);
    expect(capturedArgs.join(' ')).not.toContain('--bare');
    expect(capturedArgs.join(' ')).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('valid path (codex): tmux session spawned with correct launch cmd, marker returned, status=valid', async () => {
    const model = ms.createModel({ cli: 'codex', name: 'b2-valid-codex', provider: 'codex', model_id: 'gpt-5.3-codex-spark' });

    let launchCmd = '';
    let paneContent = '';
    const fakeTmux = {
      createSession: async () => 'helm-val-codex-test:0.0',
      sendCommand: async (_t: string, cmd: string) => { launchCmd = cmd; return { message: '', blocked: false }; },
      waitForReady: async () => true,
      sendAndSubmit: async (_t: string, text: string) => {
        const m = text.match(/HELM_VALID_[a-f0-9]+/);
        paneContent = m ? m[0] : '';
        return true;
      },
      capturePane: async () => paneContent,
      terminateSession: async () => {},
    } as any;

    const svc = new ModelValidationService(db, undefined, { hardWallMs: 5_000 }, fakeTmux);
    const result = await svc.validate(model.id);

    expect(result.status).toBe('valid');
    expect(result.detail).toBe('valid: headless marker echoed');

    const updated = ms.getModel(model.id)!;
    expect(updated.validation_status).toBe('valid');
    expect(updated.validated_at).not.toBeNull();

    expect(launchCmd).toContain('codex');
    expect(launchCmd).toContain('-m');
    expect(launchCmd).toContain('gpt-5.3-codex-spark');
    expect(launchCmd).toContain('--dangerously-bypass-approvals-and-sandbox');
    // B4-T03: codex isolation via shared helper (even in unfenced validation probe)
    expect(launchCmd).toContain('-c project_doc_max_bytes=0');
  });

  // ---- invalid_model: error pattern in output ----
  it('invalid_model path: error pattern in stdout → status=invalid, detail=invalid_model:...', async () => {
    const model = ms.createModel({ cli: 'grok', name: 'b2-bad-model', provider: 'grok', model_id: 'grok-bogus' });
    const { runner } = makeFakeRunner({ stdout: 'Error: invalid model specified.', stderr: '', code: 1 });

    const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 });
    const result = await svc.validate(model.id);

    expect(result.status).toBe('invalid');
    expect(result.detail).toMatch(/^invalid_model:/);

    const updated = ms.getModel(model.id)!;
    expect(updated.validation_status).toBe('invalid');
    expect(updated.validated_at).not.toBeNull();
    expect(updated.validation_detail).toMatch(/^invalid_model:/);
  });

  // ---- auth: pattern in stderr ----
  it('auth path: auth pattern in stderr → status=invalid, detail=auth:...', async () => {
    const model = ms.createModel({ cli: 'claude', name: 'b2-auth', provider: 'claude', model_id: 'claude-sonnet-4-6' });
    const { runner } = makeFakeRunner({ stdout: '', stderr: 'Authentication failed: api key is invalid.', code: 1 });

    const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 });
    const result = await svc.validate(model.id);

    expect(result.status).toBe('invalid');
    expect(result.detail).toMatch(/^auth:/);

    const updated = ms.getModel(model.id)!;
    expect(updated.validation_status).toBe('invalid');
    expect(updated.validation_detail).toMatch(/^auth:/);
  });

  // ---- quota ----
  it('quota path: rate-limit pattern → status=invalid, detail=quota:...', async () => {
    const model = ms.createModel({ cli: 'grok', name: 'b2-quota', provider: 'grok', model_id: 'grok-4.5' });
    const { runner } = makeFakeRunner({ stdout: 'Rate limit exceeded. Retry after 60 seconds.', stderr: '', code: 1 });

    const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 });
    const result = await svc.validate(model.id);

    expect(result.status).toBe('invalid');
    expect(result.detail).toMatch(/^quota:/);
  });

  // ---- timeout: runner throws ----
  it('timeout path: runner rejects → status=invalid, detail=timeout:...', async () => {
    const model = ms.createModel({ cli: 'grok', name: 'b2-timeout', provider: 'grok', model_id: 'grok-4.5' });
    const { runner } = makeFakeRunner('timeout');

    const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 });
    const result = await svc.validate(model.id);

    expect(result.status).toBe('invalid');
    expect(result.detail).toMatch(/^timeout:/);
    expect(result.detail).toContain('no response after');

    const updated = ms.getModel(model.id)!;
    expect(updated.validation_status).toBe('invalid');
    expect(updated.validated_at).not.toBeNull();
    expect(updated.validation_detail).toMatch(/^timeout:/);
  });

  // ---- cli_error: nonzero exit, no pattern ----
  it('cli_error path: nonzero exit + no error pattern → status=invalid, detail=cli_error:...', async () => {
    const model = ms.createModel({ cli: 'grok', name: 'b2-cli-err', provider: 'grok', model_id: 'grok-4.5' });
    const { runner } = makeFakeRunner({ stdout: 'Something went wrong unexpectedly.', stderr: '', code: 2 });

    const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 });
    const result = await svc.validate(model.id);

    expect(result.status).toBe('invalid');
    expect(result.detail).toMatch(/^cli_error:/);
    expect(result.detail).toContain('exit 2');
  });

  // ---- no_valid_marker: exit 0, no marker, no pattern ----
  it('no_valid_marker path: exit0 + no marker + no pattern → status=invalid, detail=no_valid_marker:...', async () => {
    const model = ms.createModel({ cli: 'grok', name: 'b2-no-marker', provider: 'grok', model_id: 'grok-4.5' });
    const { runner } = makeFakeRunner({ stdout: 'Sure thing! I processed your request.', stderr: '', code: 0 });

    const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 });
    const result = await svc.validate(model.id);

    expect(result.status).toBe('invalid');
    expect(result.detail).toMatch(/^no_valid_marker:/);
  });

  // ---- concurrent guard ----
  it('concurrent guard: second call for same modelId returns immediately, runner called only once', async () => {
    const model = ms.createModel({ cli: 'grok', name: 'b2-concurrent', provider: 'grok', model_id: 'grok-4.5' });
    let runnerCallCount = 0;
    // Slow runner to keep first in-flight
    const slowRunner: CommandRunner = async (cmd, args, opts) => {
      runnerCallCount++;
      await new Promise(r => setTimeout(r, 200));
      const prompt = args[1];
      const m = prompt.match(/HELM_VALID_[a-f0-9]+/);
      const marker = m ? m[0] : '';
      return { stdout: marker, stderr: '', code: 0 };
    };

    const svc = new ModelValidationService(db, slowRunner, { hardWallMs: 5_000 });
    const first = svc.validate(model.id);
    const second = await svc.validate(model.id);

    expect(second.status).toBe('invalid');
    expect(second.detail).toContain('concurrent');

    await first;
    expect(runnerCallCount).toBe(1); // only one real runner call
  });

  // ---- unknown model throws ----
  it('unknown model: throws (not soft invalid)', async () => {
    const { runner } = makeFakeRunner({ stdout: '', stderr: '', code: 0 });
    const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 });
    await expect(svc.validate(999999)).rejects.toThrow(/unknown model/);
  });

  // ---- runner receives prompt as array arg (never shell-interpolated) ----
  it('prompt passed as args array element (index 1) — never shell string', async () => {
    const model = ms.createModel({ cli: 'grok', name: 'b2-array-arg', provider: 'grok', model_id: 'grok-4.5' });
    const captured: { cmd: string; args: string[] }[] = [];
    const runner: CommandRunner = async (cmd, args) => {
      captured.push({ cmd, args });
      const prompt = args[1];
      const m = prompt.match(/HELM_VALID_[a-f0-9]+/);
      return { stdout: m ? m[0] : '', stderr: '', code: 0 };
    };

    const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 });
    await svc.validate(model.id);

    expect(captured.length).toBe(1);
    // args must be an actual array with the prompt as a discrete element — never a shell string
    expect(Array.isArray(captured[0].args)).toBe(true);
    expect(captured[0].args[0]).toBe('-p');
    expect(captured[0].args[1]).toMatch(/^Reply with exactly HELM_VALID_[a-f0-9]+ and no other text\.$/);
  });
});

// ---------------------------------------------------------------------------
// 2b. Kloo discovery-based validation — injected KlooValidator stub, NO network
// ---------------------------------------------------------------------------
describe('Kloo ModelValidationService — discovery-based validation (injected stub, no network)', () => {
  let dbPath: string;
  let cleanupDb: () => void;
  let db: DatabaseService;
  let ms: ModelService;

  beforeEach(() => {
    const t = makeTempDb();
    dbPath = t.dbPath;
    cleanupDb = t.cleanup;
    db = new DatabaseService(dbPath);
    ms = new ModelService(db);
  });

  afterEach(() => {
    cleanupDb();
  });

  it('present model (discovery.ok=true) → status=valid, DB updated, NO runner/network', async () => {
    const model = ms.createModel({ cli: 'kloo', name: 'kloo-present', provider: 'kloo', model_id: 'deepseek/deepseek-v4-flash', route: 'openrouter' });
    const calls: { route: string; model: string }[] = [];
    const stubDisc = { validate: async (route: string, m: string) => { calls.push({ route, model: m }); return { ok: true }; } };
    let runnerCalled = false;
    const runner: CommandRunner = async () => { runnerCalled = true; return { stdout: '', stderr: '', code: 0 }; };

    const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 }, undefined, stubDisc);
    const result = await svc.validate(model.id);

    expect(result.status).toBe('valid');
    expect(result.detail).toContain('openrouter');
    expect(result.detail).toContain('deepseek/deepseek-v4-flash');
    expect(runnerCalled).toBe(false);
    expect(calls).toEqual([{ route: 'openrouter', model: 'deepseek/deepseek-v4-flash' }]);

    const updated = ms.getModel(model.id)!;
    expect(updated.validation_status).toBe('valid');
    expect(updated.validated_at).not.toBeNull();
  });

  it('absent model (discovery.ok=false) → status=invalid with reason', async () => {
    const model = ms.createModel({ cli: 'kloo', name: 'kloo-absent', provider: 'kloo', model_id: 'ghost/no-such-model', route: 'openrouter' });
    const stubDisc = { validate: async () => ({ ok: false, reason: 'model not found on route openrouter' }) };

    const svc = new ModelValidationService(db, undefined, { hardWallMs: 5_000 }, undefined, stubDisc);
    const result = await svc.validate(model.id);

    expect(result.status).toBe('invalid');
    expect(result.detail).toContain('model not found');

    const updated = ms.getModel(model.id)!;
    expect(updated.validation_status).toBe('invalid');
    expect(updated.validated_at).not.toBeNull();
  });

  it('no route set → status=invalid, discovery never called', async () => {
    const model = ms.createModel({ cli: 'kloo', name: 'kloo-noroute', provider: 'kloo', model_id: 'deepseek/deepseek-v4-flash', route: null });
    let discCalled = false;
    const stubDisc = { validate: async () => { discCalled = true; return { ok: true }; } };

    const svc = new ModelValidationService(db, undefined, { hardWallMs: 5_000 }, undefined, stubDisc);
    const result = await svc.validate(model.id);

    expect(result.status).toBe('invalid');
    expect(result.detail).toMatch(/no route set/);
    expect(discCalled).toBe(false);
  });

  it('discovery throws unexpectedly → status=invalid (never throws)', async () => {
    const model = ms.createModel({ cli: 'kloo', name: 'kloo-throw', provider: 'kloo', model_id: 'deepseek/deepseek-v4-flash', route: 'openrouter' });
    const stubDisc = { validate: async () => { throw new Error('boom'); } };

    const svc = new ModelValidationService(db, undefined, { hardWallMs: 5_000 }, undefined, stubDisc);
    const result = await svc.validate(model.id);

    expect(result.status).toBe('invalid');
    expect(result.detail).toMatch(/kloo validation error: boom/);
  });
});

// ---------------------------------------------------------------------------
// 3. B5 validateAll — sequential backfill (no real CLI)
// ---------------------------------------------------------------------------
describe('B5 ModelValidationService.validateAll — sequential backfill (no real CLI)', () => {
  let dbPath: string;
  let cleanupDb: () => void;
  let db: DatabaseService;
  let ms: ModelService;

  beforeEach(() => {
    const t = makeTempDb();
    dbPath = t.dbPath;
    cleanupDb = t.cleanup;
    db = new DatabaseService(dbPath);
    // B5 test isolation: mark seeded models (17 from applyFreshDbExtras) as 'valid' so only explicitly created 'untested' models participate in validateAll()
    db.prepare("UPDATE models SET validation_status='valid'").run();
    ms = new ModelService(db);
  });

  afterEach(() => {
    cleanupDb();
  });

  it('validateAll marks all untested models valid when runner succeeds', async () => {
    const m1 = ms.createModel({ cli: 'grok', name: 'va-grok-1', provider: 'grok', model_id: 'grok-4.5' });
    const m2 = ms.createModel({ cli: 'claude', name: 'va-claude-2', provider: 'claude', model_id: 'claude-sonnet-4-6' });
    const m3 = ms.createModel({ cli: 'codex', name: 'va-codex-3', provider: 'codex', model_id: 'gpt-5.5' });

    const markerRunner: CommandRunner = async (_cmd, args) => {
      const prompt = args[1] ?? '';
      const m = prompt.match(/HELM_VALID_[a-f0-9]+/);
      return { stdout: m ? m[0] : '', stderr: '', code: 0 };
    };
    let paneContentVA = '';
    const fakeTmuxVA = {
      createSession: async () => 'helm-val-codex-va:0.0',
      sendCommand: async () => ({ message: '', blocked: false }),
      waitForReady: async () => true,
      sendAndSubmit: async (_t: string, text: string) => {
        const m = text.match(/HELM_VALID_[a-f0-9]+/);
        paneContentVA = m ? m[0] : '';
        return true;
      },
      capturePane: async () => paneContentVA,
      terminateSession: async () => {},
    } as any;
    const svc = new ModelValidationService(db, markerRunner, { hardWallMs: 5_000 }, fakeTmuxVA);

    const result = await svc.validateAll();

    expect(result.considered).toBe(3);
    expect(result.validated).toBe(3);
    expect(result.valid).toBe(3);
    expect(result.invalid).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    for (const id of [m1.id, m2.id, m3.id]) {
      expect(ms.getModel(id)!.validation_status).toBe('valid');
    }
  });

  it('validateAll handles one runner failure and continues, marking others valid', async () => {
    const m1 = ms.createModel({ cli: 'grok', name: 'va-ok-1', provider: 'grok', model_id: 'grok-4.5' });
    const m2 = ms.createModel({ cli: 'grok', name: 'va-fail-2', provider: 'grok', model_id: 'bad-model' });
    const m3 = ms.createModel({ cli: 'claude', name: 'va-ok-3', provider: 'claude', model_id: 'claude-sonnet-4-6' });

    let callIdx = 0;
    const partialRunner: CommandRunner = async (_cmd, args) => {
      callIdx++;
      if (callIdx === 2) {
        return { stdout: 'invalid model specified.', stderr: '', code: 1 };
      }
      const prompt = args[1] ?? '';
      const match = prompt.match(/HELM_VALID_[a-f0-9]+/);
      return { stdout: match ? match[0] : '', stderr: '', code: 0 };
    };
    const svc = new ModelValidationService(db, partialRunner, { hardWallMs: 5_000 });

    const result = await svc.validateAll();

    expect(result.considered).toBe(3);
    expect(result.validated).toBe(3);
    expect(result.valid).toBe(2);
    expect(result.invalid).toBe(1);
    expect(result.skipped).toBe(0);
    expect(ms.getModel(m1.id)!.validation_status).toBe('valid');
    expect(ms.getModel(m2.id)!.validation_status).toBe('invalid');
    expect(ms.getModel(m3.id)!.validation_status).toBe('valid');
  });

  it('validateAll is a no-op when no untested models exist', async () => {
    const m1 = ms.createModel({ cli: 'grok', name: 'va-already-1', provider: 'grok', model_id: 'grok-4.5' });
    const m2 = ms.createModel({ cli: 'claude', name: 'va-already-2', provider: 'claude', model_id: 'claude-sonnet-4-6' });
    db.prepare("UPDATE models SET validation_status='valid' WHERE id IN (?, ?)").run(m1.id, m2.id);

    let runnerCalled = false;
    const noopRunner: CommandRunner = async () => {
      runnerCalled = true;
      return { stdout: '', stderr: '', code: 0 };
    };
    const svc = new ModelValidationService(db, noopRunner, { hardWallMs: 5_000 });

    const result = await svc.validateAll();

    expect(result.considered).toBe(0);
    expect(result.validated).toBe(0);
    expect(runnerCalled).toBe(false);
  });
});
