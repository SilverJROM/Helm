import { describe, it, expect } from 'vitest';
import { classifyGateFault, authFault, classifyGitFault } from './fault-class.js';

describe('classifyGateFault — env faults are non-retryable', () => {
  it('exit 127 with a missing project-local binary → env-missing-deps, no failover', () => {
    const f = classifyGateFault(127, 'sh: 1: tsx: not found');
    expect(f).not.toBeNull();
    expect(f!.kind).toBe('env-missing-deps');
    expect(f!.canFailover).toBe(false);
    expect(f!.remedy).toMatch(/npm install/);
  });

  it('exit 127 with a non-toolchain command → env-missing-cmd', () => {
    const f = classifyGateFault(127, 'sh: 1: somebin: not found');
    expect(f!.kind).toBe('env-missing-cmd');
  });

  it('missing-module signature → env-missing-deps even without exit 127', () => {
    expect(classifyGateFault(1, "Error: Cannot find module 'vitest'")!.kind).toBe('env-missing-deps');
    expect(classifyGateFault(1, 'ERR_MODULE_NOT_FOUND')!.kind).toBe('env-missing-deps');
  });

  it('a GENUINE test failure is retryable (returns null) — the ladder must still work', () => {
    expect(classifyGateFault(1, '# fail 3\nAssertionError: expected 4 to be 5\n  at test.ts:12')).toBeNull();
    expect(classifyGateFault(1, 'FAIL src/foo.test.ts > does the thing')).toBeNull();
  });

  it('exit 0 is never a fault', () => {
    expect(classifyGateFault(0, 'all good')).toBeNull();
  });
});

describe('authFault — token-conservation rule', () => {
  it('grok logout names the relogin remedy and forbids failover', () => {
    const f = authFault('grok', 'Authentication required — session expired');
    expect(f.kind).toBe('auth');
    expect(f.canFailover).toBe(false); // never burn codex/claude to cover a grok logout
    expect(f.remedy).toMatch(/grok login/);
    expect(f.remedy).toMatch(/6h/);
  });

  it('per-provider remedies', () => {
    expect(authFault('codex', 'x').remedy).toMatch(/codex login/);
    expect(authFault('claude', 'x').remedy).toMatch(/login/);
    expect(authFault(undefined, 'x').canFailover).toBe(false);
  });
});

describe('classifyGitFault — fence-denied is non-retryable (no worker repo surgery)', () => {
  it('detects a broken/out-of-fence gitdir', () => {
    const f = classifyGitFault('fatal: not a git repository: /tmp/helm-harness/.../gitdir/main_git');
    expect(f).not.toBeNull();
    expect(f!.kind).toBe('fence-denied');
    expect(f!.canFailover).toBe(false);
  });

  it('null on ordinary git output', () => {
    expect(classifyGitFault('[feat/x abc123] committed 3 files')).toBeNull();
  });
});
