/**
 * B1 (R2.12/F6) reboot-class proof — two independent things must both hold, not just "the code would
 * honour HELM_RUN_ROOT if set":
 *   1. Cycle docs (the document view) survive the ephemeral run scratch dir vanishing (a reboot wipes
 *      os.tmpdir()) — they are sourced from the cycle folder, never from runDir.
 *   2. Production actually sets an ABSOLUTE HELM_RUN_ROOT, and that EXACT path is routed through the
 *      Landlock write-fence grant (HELM_SANDBOX_WRITE_ALLOW) — SCOPED TO THE CALLING SEAT'S OWN RUN
 *      DIRECTORY ONLY. A real kernel-backed write inside that seat's own run dir succeeds; a write
 *      into a SIBLING run directory under the SAME shared HELM_RUN_ROOT stays EPERM (send-back
 *      CRITICAL fix — the original version granted the whole shared root, letting any fenced seat
 *      forge/corrupt another run's callbacks.md); and a write fully outside HELM_RUN_ROOT stays EPERM
 *      too. This is a genuine probe against the compiled binary (mirrors
 *      sandbox-scaffold-fence.test.ts), not an assertion about source code.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { CycleDocsService } from './services/cycle-docs-service.js';
import { resolveHelmSandboxBin, getWriteFenceStatus, makeRunRootWriteAllowEnv } from './security/landlock-sandbox.js';

const BIN = resolveHelmSandboxBin();

function requireActiveFence() {
  const fence = getWriteFenceStatus();
  if (fence.status !== 'active') {
    throw new Error(`landlock unavailable in test env (status=${fence.status}, detail=${fence.detail}) — the reboot-class write-grant probe must FAIL (not skip); never green a dead fence`);
  }
}

describe('B1 (1/2): cycle docs survive runDir scratch removal', () => {
  let dbDir: string;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let cycleDocsService: CycleDocsService;
  let projDir: string;

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b1-reboot-'));
    dbs = new DatabaseService(path.join(dbDir, 'test.db'));
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);
    cycleDocsService = new CycleDocsService(cycleService);
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b1-reboot-proj-'));
  });
  afterAll(() => {
    try { dbs.close(); } catch {}
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  it('north-star.md and plan.md still load from the cycle folder after the ephemeral runDir is gone', async () => {
    const proj = projectService.createProject({ name: 'b1-reboot', directory: projDir });
    const cycle = await cycleService.createCycle(proj.id, 'Reboot cycle');
    await cycleDocsService.writeCycleDoc(cycle.id, 'north-star.md', '# North star survives reboot\n');
    const plan = '# Plan\n\n```json\n[{"id":"T1","batch":"B00","title":"vocabulary","req_refs":["R14.46"],"assignee":"terra","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';
    await cycleDocsService.writeCycleDoc(cycle.id, 'plan.md', plan);

    // Simulate the run's tmp scratch dir existing, then a reboot wiping it (os.tmpdir() is NOT durable).
    const scratchRunDir = path.join(os.tmpdir(), `helm-run-${proj.id}-reboot-test-${Date.now()}`);
    fs.mkdirSync(scratchRunDir, { recursive: true });
    fs.writeFileSync(path.join(scratchRunDir, 'plan.json'), '{"tasks":[]}\n', 'utf8');
    fs.rmSync(scratchRunDir, { recursive: true, force: true }); // "reboot"
    expect(fs.existsSync(scratchRunDir)).toBe(false);

    const ns = await cycleDocsService.readCycleDoc(cycle.id, 'north-star.md');
    expect(ns.content).toContain('survives reboot');
    const planDoc = await cycleDocsService.readCycleDoc(cycle.id, 'plan.md');
    expect(planDoc.valid).toBe(true);
  });
});

describe('B1 (2/2): production HELM_RUN_ROOT is absolute and routed through the real Landlock write grant', () => {
  it('ecosystem.config.cjs sets an ABSOLUTE HELM_RUN_ROOT for helm-harness', async () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
    // Node's ESM loader can import a .cjs CommonJS module directly; module.exports lands as .default.
    const mod: any = await import(pathToFileURL(ecosystemPath).href);
    const config = mod.default;
    const app = config.apps.find((a: any) => a.name === 'helm-harness');
    expect(app, 'helm-harness app entry must exist in ecosystem.config.cjs').toBeTruthy();
    const runRoot = app.env.HELM_RUN_ROOT;
    expect(typeof runRoot).toBe('string');
    expect(runRoot.trim().length).toBeGreaterThan(0);
    expect(path.isAbsolute(runRoot)).toBe(true);
  });

  it('makeRunRootWriteAllowEnv fail-closed rejects a non-absolute HELM_RUN_ROOT (never silently grants nothing)', () => {
    expect(() => makeRunRootWriteAllowEnv('/some/run/dir', 'relative/path')).toThrow(/absolute/i);
  });

  it('makeRunRootWriteAllowEnv is a no-op when runDir is absent, HELM_RUN_ROOT is unset, or runDir is not under HELM_RUN_ROOT', () => {
    expect(makeRunRootWriteAllowEnv(undefined, '/some/run/root')).toBe('');
    expect(makeRunRootWriteAllowEnv('/some/run/dir', undefined)).toBe('');
    expect(makeRunRootWriteAllowEnv('/some/run/dir', '')).toBe('');
    expect(makeRunRootWriteAllowEnv('/elsewhere/not-under-root', '/some/run/root')).toBe('');
  });

  it('makeRunRootWriteAllowEnv grants the EXACT runDir, never the shared root itself (send-back CRITICAL fix)', () => {
    const root = '/some/run/root';
    const runDir = '/some/run/root/helm-run-1-batchA';
    const envLine = makeRunRootWriteAllowEnv(runDir, root);
    const m = /^HELM_SANDBOX_WRITE_ALLOW='([^']*)'\s*$/.exec(envLine.trim());
    expect(m, `unexpected env line shape: ${envLine}`).toBeTruthy();
    expect(m![1]).toBe(runDir);
    expect(m![1]).not.toBe(root);
  });

  describe('kernel probe: a fenced write lands in the seat\'s OWN run dir, never a sibling run dir under the same shared root', () => {
    let projDir: string;
    let runRoot: string;
    let ownRunDir: string;
    let siblingRunDir: string;
    let outside: string;

    beforeAll(() => {
      if (!fs.existsSync(BIN)) {
        throw new Error(`reboot-class write-grant probe requires the built binary at ${BIN} (run npm run build first)`);
      }
      requireActiveFence();
      // Fixtures live under $HOME (NOT /tmp, NOT the $HOME dot-dir tooling exceptions — mirrors
      // sandbox-scaffold-fence.test.ts) so a real EACCES/EPERM can never be masked by the hardcoded
      // /tmp write exception: HELM_RUN_ROOT is specifically the durability fix for run roots OUTSIDE
      // /tmp, so a /tmp-based fixture here would make every assertion vacuously true.
      projDir = fs.mkdtempSync(path.join(os.homedir(), 'helm-b1-reboot-kern-proj-'));
      runRoot = fs.mkdtempSync(path.join(os.homedir(), 'helm-b1-reboot-kern-runroot-'));
      // Two DIFFERENT runs' scratch dirs, both genuine children of the SAME shared HELM_RUN_ROOT —
      // exactly the shape a real deployment has (helm-run-<projectId>-<batchId> siblings).
      ownRunDir = path.join(runRoot, 'helm-run-1-owncase');
      siblingRunDir = path.join(runRoot, 'helm-run-2-siblingcase');
      fs.mkdirSync(ownRunDir, { recursive: true });
      fs.mkdirSync(siblingRunDir, { recursive: true });
      fs.writeFileSync(path.join(siblingRunDir, 'callbacks.md'), 'genuine sibling-run callback\n', 'utf8');
      outside = fs.mkdtempSync(path.join(os.homedir(), 'helm-b1-reboot-kern-outside-'));
    });
    afterAll(() => {
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(runRoot, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
    });

    it('the same env prefix the app composes (makeRunRootWriteAllowEnv) grants a real write inside the seat\'s OWN run dir', () => {
      const envLine = makeRunRootWriteAllowEnv(ownRunDir, runRoot);
      const m = /^HELM_SANDBOX_WRITE_ALLOW='([^']*)'\s*$/.exec(envLine.trim());
      expect(m, `unexpected env line shape: ${envLine}`).toBeTruthy();
      expect(m![1]).toBe(ownRunDir);
      const r = spawnSync(BIN, [projDir, 'bash', '-c', `echo appended >> "${ownRunDir}/callbacks.md" && cat "${ownRunDir}/callbacks.md"`], {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, HELM_SANDBOX_WRITE_ALLOW: m![1] },
      });
      expect(r.status, `stderr: ${r.stderr}`).toBe(0);
      expect(r.stdout).toContain('appended');
      expect(fs.readFileSync(path.join(ownRunDir, 'callbacks.md'), 'utf8')).toContain('appended');
    });

    it('SEND-BACK CRITICAL FIX: a write into a SIBLING run dir under the SAME shared HELM_RUN_ROOT stays EPERM — the grant never widens to the shared root', () => {
      const envLine = makeRunRootWriteAllowEnv(ownRunDir, runRoot); // grant is for ownRunDir ONLY
      const m = /^HELM_SANDBOX_WRITE_ALLOW='([^']*)'\s*$/.exec(envLine.trim());
      const r = spawnSync(BIN, [projDir, 'bash', '-c', `echo FORGED >> "${siblingRunDir}/callbacks.md"`], {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, HELM_SANDBOX_WRITE_ALLOW: m![1] },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/permission denied/i);
      expect(fs.readFileSync(path.join(siblingRunDir, 'callbacks.md'), 'utf8')).toBe('genuine sibling-run callback\n');
    });

    it('a path fully OUTSIDE HELM_RUN_ROOT stays EPERM even with the own-run-dir grant active', () => {
      const envLine = makeRunRootWriteAllowEnv(ownRunDir, runRoot);
      const m = /^HELM_SANDBOX_WRITE_ALLOW='([^']*)'\s*$/.exec(envLine.trim());
      const r = spawnSync(BIN, [projDir, 'bash', '-c', `echo pwned > "${outside}/evil.txt"`], {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, HELM_SANDBOX_WRITE_ALLOW: m![1] },
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/permission denied/i);
      expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);
    });

    it('WITHOUT the grant, the same own-run-dir path is EPERM — proves the grant (not luck) makes the difference', () => {
      const r = spawnSync(BIN, [projDir, 'bash', '-c', `echo pwned > "${ownRunDir}/no-grant.txt"`], {
        encoding: 'utf8',
        timeout: 15000,
        env: process.env,
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/permission denied/i);
      expect(fs.existsSync(path.join(ownRunDir, 'no-grant.txt'))).toBe(false);
    });
  });
});
