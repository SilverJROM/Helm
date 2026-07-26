import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { runRoot, resolveRunDir } from './run-paths.js';

describe('#46 run-paths', () => {
  const orig = process.env.HELM_RUN_ROOT;
  afterEach(() => { if (orig === undefined) delete process.env.HELM_RUN_ROOT; else process.env.HELM_RUN_ROOT = orig; });

  it('defaults to os.tmpdir() (behavior unchanged)', () => {
    delete process.env.HELM_RUN_ROOT;
    expect(runRoot()).toBe(os.tmpdir());
    expect(resolveRunDir(1, 'batchX')).toBe(`${os.tmpdir()}/helm-run-1-batchX`);
  });

  it('HELM_RUN_ROOT overrides to a durable path', () => {
    process.env.HELM_RUN_ROOT = '/home/agjrom/websites/Helm/data/runs';
    expect(resolveRunDir(7, 'rmr123')).toBe('/home/agjrom/websites/Helm/data/runs/helm-run-7-rmr123');
  });

  it('is stable — same inputs, same path (readers and writers agree)', () => {
    delete process.env.HELM_RUN_ROOT;
    expect(resolveRunDir(3, 'b')).toBe(resolveRunDir(3, 'b'));
  });
});
