/**
 * B22b — R7.26/R7.27 wired fence: allow src/**, deny the four governed docs at the real
 * agent-launch surface. north-star.md is fenced at the kernel level (tools/helm-sandbox.c
 * omits it from the project rw grant). The three plan/<cycle> docs cannot get the same
 * treatment (siblings in a directory that must stay open to new batch-dir creation — see
 * batch-B22b/changes.md) and are fenced by the userspace guard instead
 * (src/services/doc-path-guard.ts: startGovernedDocGuard), exercised here directly (the same
 * exported function worker-service.ts wires at fenced-session launch).
 *
 * This test also writes durable transcripts under
 * plan/c01-agent-studio-rebuild/validation/b22b/ for R7.27 evidence (not unit-only proof).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveHelmSandboxBin } from './security/landlock-sandbox.js';
import { startGovernedDocGuard } from './services/doc-path-guard.js';

const REPO_ROOT = process.cwd();
const VALIDATION_DIR = path.join(REPO_ROOT, 'plan/c01-agent-studio-rebuild/validation/b22b');
// Deliberately NOT under /tmp or any $HOME/.{config,cache,npm,claude,grok,codex,local} dir —
// those are documented tooling exceptions in helm-sandbox.c with blanket rw, which would mask
// a real denial as a false-negative pass.
const PROJ = path.join(os.homedir(), 'helm-b22b-fence-validation-project');
const CYCLE = 'fake-cycle';

const transcript: Record<string, unknown> = {};

function setupProject() {
  fs.rmSync(PROJ, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJ, 'src/services'), { recursive: true });
  fs.mkdirSync(path.join(PROJ, 'plan', CYCLE), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'north-star.md'), 'GOVERNED north-star v1');
  fs.writeFileSync(path.join(PROJ, 'plan', CYCLE, 'og-requirements.md'), 'GOVERNED og-requirements v1');
  fs.writeFileSync(path.join(PROJ, 'plan', CYCLE, 'plan.md'), 'GOVERNED plan.md v1');
  fs.writeFileSync(path.join(PROJ, 'plan', CYCLE, 'topology.yaml'), 'GOVERNED topology v1');
  fs.writeFileSync(path.join(PROJ, 'src/services/existing.ts'), 'export const existing = 1;\n');
  // FIX1: a real project root always has at least one top-level regular file alongside
  // north-star.md. This is the exact shape that exposed the parent-fallback hole (F1) — the
  // fixture must keep this file present, not the north-star-only shape that concealed it.
  fs.writeFileSync(path.join(PROJ, 'package.json'), '{"name":"fake-project"}\n');
}

function runFenced(bin: string, cmd: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(bin, [PROJ, ...cmd], { encoding: 'utf8', timeout: 5000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('B22b wired fence (real helm-sandbox binary + real userspace guard)', () => {
  const bin = resolveHelmSandboxBin();

  it('the compiled fence binary exists (build the project before running this suite otherwise)', () => {
    expect(fs.existsSync(bin)).toBe(true);
  });

  it('R7.26 positive: a fenced agent CAN write under src/**', () => {
    setupProject();
    const r = runFenced(bin, ['bash', '-c', `echo appended >> "${PROJ}/src/services/existing.ts" && echo OK`]);
    transcript.positive_src_write = r;
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK/);
    expect(fs.readFileSync(path.join(PROJ, 'src/services/existing.ts'), 'utf8')).toMatch(/appended/);
  });

  it('regression guard: a fenced agent can still create a NEW batch dir under plan/<cycle>/ (must not break routine batch-dir creation)', () => {
    const r = runFenced(bin, ['bash', '-c', `mkdir "${PROJ}/plan/${CYCLE}/batch-B99" && echo hi > "${PROJ}/plan/${CYCLE}/batch-B99/changes.md" && echo OK`]);
    transcript.regression_new_batch_dir = r;
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(PROJ, 'plan', CYCLE, 'batch-B99', 'changes.md'))).toBe(true);
  });

  it('R7.26/R7.27 kernel denial: a fenced agent CANNOT write north-star.md (real EPERM, real transcript)', () => {
    const r = runFenced(bin, ['bash', '-c', `echo pwned > "${PROJ}/north-star.md"`]);
    transcript.negative_north_star = r;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/permission denied/i);
    expect(fs.readFileSync(path.join(PROJ, 'north-star.md'), 'utf8')).toBe('GOVERNED north-star v1');
  });

  it('FIX1 regression fixture: north-star.md is still kernel-denied when a sibling top-level FILE (package.json) exists (the real-repo shape that exposed F1)', () => {
    expect(fs.existsSync(path.join(PROJ, 'package.json'))).toBe(true);
    const r = runFenced(bin, ['bash', '-c', `echo pwned > "${PROJ}/north-star.md"`]);
    transcript.fix1_north_star_with_sibling_file = r;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/permission denied/i);
    expect(fs.readFileSync(path.join(PROJ, 'north-star.md'), 'utf8')).toBe('GOVERNED north-star v1');
  });

  it('FIX1: a fenced agent CANNOT delete north-star.md (real EPERM)', () => {
    const r = runFenced(bin, ['bash', '-c', `rm "${PROJ}/north-star.md"`]);
    transcript.fix1_north_star_delete = r;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/permission denied/i);
    expect(fs.existsSync(path.join(PROJ, 'north-star.md'))).toBe(true);
  });

  it('FIX1: a fenced agent CAN still write to an existing top-level FILE (package.json) — file-scoped rw preserved', () => {
    const r = runFenced(bin, ['bash', '-c', `echo appended >> "${PROJ}/package.json" && echo OK`]);
    transcript.fix1_package_json_write = r;
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK/);
    expect(fs.readFileSync(path.join(PROJ, 'package.json'), 'utf8')).toMatch(/appended/);
  });

  it('FIX1 known tradeoff: a fenced agent CANNOT delete an existing top-level FILE, and CANNOT create a brand-new top-level entry (both would require a directory-scope grant on the root, re-covering north-star.md)', () => {
    const rDelete = runFenced(bin, ['bash', '-c', `rm "${PROJ}/package.json"`]);
    transcript.fix1_package_json_delete_denied = rDelete;
    expect(rDelete.status).not.toBe(0);
    expect(fs.existsSync(path.join(PROJ, 'package.json'))).toBe(true);

    const rCreate = runFenced(bin, ['bash', '-c', `echo probe > "${PROJ}/new-top-level-file.txt"`]);
    transcript.fix1_new_top_level_file_denied = rCreate;
    expect(rCreate.status).not.toBe(0);
    expect(fs.existsSync(path.join(PROJ, 'new-top-level-file.txt'))).toBe(false);
  });

  it('R7.26/R7.27 userspace denial: og-requirements.md/plan.md/topology.yaml are detected + reverted by the real startGovernedDocGuard wired at session launch', async () => {
    const handle = startGovernedDocGuard(PROJ, { pollMs: 50 });
    try {
      // The kernel fence does NOT cover these three (documented tradeoff — see changes.md), so
      // the tamper attempt succeeds at the OS level, same as a real fenced agent process could.
      const tamperResults = ['og-requirements.md', 'plan.md', 'topology.yaml'].map((f) => {
        const r = runFenced(bin, ['bash', '-c', `echo pwned > "${PROJ}/plan/${CYCLE}/${f}"`]);
        return { file: f, ...r };
      });
      transcript.negative_plan_docs_kernel_level_write_attempt = tamperResults;
      for (const t of tamperResults) expect(t.status).toBe(0); // kernel allows it; guard must catch it

      // give fs.watch + the 50ms poll fallback a moment to detect and revert
      await new Promise((r) => setTimeout(r, 400));

      transcript.negative_plan_docs_guard_denials = handle.denials;
      expect(handle.denials.length).toBe(3);
      // each governed doc is reverted to its exact original snapshot
      expect(fs.readFileSync(path.join(PROJ, 'plan', CYCLE, 'og-requirements.md'), 'utf8')).toBe('GOVERNED og-requirements v1');
      expect(fs.readFileSync(path.join(PROJ, 'plan', CYCLE, 'plan.md'), 'utf8')).toBe('GOVERNED plan.md v1');
      expect(fs.readFileSync(path.join(PROJ, 'plan', CYCLE, 'topology.yaml'), 'utf8')).toBe('GOVERNED topology v1');
    } finally {
      handle.stop();
    }
  });

  it('FIX1: startGovernedDocGuard restores a governed doc that was UNLINKED (delete leaves no trace under the old code)', async () => {
    setupProject();
    const handle = startGovernedDocGuard(PROJ, { pollMs: 50 });
    try {
      const target = path.join(PROJ, 'plan', CYCLE, 'og-requirements.md');
      const r = runFenced(bin, ['bash', '-c', `rm "${target}"`]);
      transcript.fix1_unlink_og_requirements_kernel_level = r;
      expect(r.status).toBe(0); // kernel allows it (userspace guard's job to catch)
      expect(fs.existsSync(target)).toBe(false);

      await new Promise((res) => setTimeout(res, 400));

      transcript.fix1_unlink_denials = handle.denials;
      expect(handle.denials.length).toBe(1);
      expect(handle.denials[0].relPath).toBe('plan/fake-cycle/og-requirements.md');
      expect(fs.readFileSync(target, 'utf8')).toBe('GOVERNED og-requirements v1');
    } finally {
      handle.stop();
    }
  });

  it('FIX1: startGovernedDocGuard restores a governed doc that was RENAMED away (rename leaves no trace under the old code)', async () => {
    setupProject();
    const handle = startGovernedDocGuard(PROJ, { pollMs: 50 });
    try {
      const target = path.join(PROJ, 'plan', CYCLE, 'plan.md');
      const renamed = path.join(PROJ, 'plan', CYCLE, 'plan.md.bak');
      const r = runFenced(bin, ['bash', '-c', `mv "${target}" "${renamed}"`]);
      transcript.fix1_rename_plan_md_kernel_level = r;
      expect(r.status).toBe(0); // kernel allows it (userspace guard's job to catch)
      expect(fs.existsSync(target)).toBe(false);

      await new Promise((res) => setTimeout(res, 400));

      transcript.fix1_rename_denials = handle.denials;
      expect(handle.denials.length).toBe(1);
      expect(handle.denials[0].relPath).toBe('plan/fake-cycle/plan.md');
      expect(fs.readFileSync(target, 'utf8')).toBe('GOVERNED plan.md v1');
    } finally {
      handle.stop();
    }
  });

  afterAll(() => {
    fs.mkdirSync(VALIDATION_DIR, { recursive: true });
    fs.writeFileSync(path.join(VALIDATION_DIR, 'transcript.json'), JSON.stringify(transcript, null, 2));
    fs.rmSync(PROJ, { recursive: true, force: true });
  });
});

// sol decision-4 fixture split: the describe above is the ROOT-NORTH-STAR-PRESENT fixture
// (protected-root mode) — north-star.md write/delete is kernel-denied AND the known tradeoff holds
// (a brand-new top-level entry is NOT creatable, existing top-level files are NOT deletable). This
// block is the ROOTLESS counterpart: a Helm CC-cycle project whose authoritative north-star.md lives
// NESTED under cycle/<cycle>/ and has NO north-star.md at the project ROOT. The SAME compiled binary
// selects SCAFFOLD MODE for it, so the tradeoff is lifted — from-scratch top-level create/rename/delete
// succeed. (Full conditional-root matrix, incl. symlink-protected + escape probes + strict-read +
// fail-closed, lives in sandbox-scaffold-fence.test.ts.)
const PROJ_ROOTLESS = path.join(os.homedir(), 'helm-b22b-rootless-scaffold-project');
const ROOTLESS_CYCLE = 'fake-cycle';

function setupRootlessProject() {
  fs.rmSync(PROJ_ROOTLESS, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJ_ROOTLESS, 'cycle', ROOTLESS_CYCLE), { recursive: true });
  fs.mkdirSync(path.join(PROJ_ROOTLESS, 'helm_docs'), { recursive: true });
  // authoritative north-star is NESTED (CC-cycle layout), never at the project ROOT.
  fs.writeFileSync(path.join(PROJ_ROOTLESS, 'cycle', ROOTLESS_CYCLE, 'north-star.md'), 'NESTED north-star v1');
}

function runFencedRootless(bin: string, cmd: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(bin, [PROJ_ROOTLESS, ...cmd], { encoding: 'utf8', timeout: 5000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('B22b fixture split — rootless (scaffold) fixture proves from-scratch top-level creation (sol decision-4)', () => {
  const bin = resolveHelmSandboxBin();

  it('the SAME binary, given a root WITHOUT north-star.md, CAN create a brand-new top-level dir + file (tradeoff lifted in scaffold mode)', () => {
    setupRootlessProject();
    const r = runFencedRootless(bin, [
      'bash',
      '-c',
      `mkdir "${PROJ_ROOTLESS}/src" && echo '{}' > "${PROJ_ROOTLESS}/package.json" && echo hi > "${PROJ_ROOTLESS}/src/index.ts" && echo OK`,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK/);
    expect(fs.existsSync(path.join(PROJ_ROOTLESS, 'src', 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(PROJ_ROOTLESS, 'package.json'))).toBe(true);
  });

  it('scaffold mode also permits rename + delete of top-level entries (both DENIED in the north-star-present fixture)', () => {
    const rMv = runFencedRootless(bin, ['bash', '-c', `mv "${PROJ_ROOTLESS}/package.json" "${PROJ_ROOTLESS}/package.json.bak" && echo OK`]);
    expect(rMv.status).toBe(0);
    expect(fs.existsSync(path.join(PROJ_ROOTLESS, 'package.json.bak'))).toBe(true);

    const rRm = runFencedRootless(bin, ['bash', '-c', `rm "${PROJ_ROOTLESS}/package.json.bak" && echo OK`]);
    expect(rRm.status).toBe(0);
    expect(fs.existsSync(path.join(PROJ_ROOTLESS, 'package.json.bak'))).toBe(false);
  });

  afterAll(() => {
    fs.rmSync(PROJ_ROOTLESS, { recursive: true, force: true });
  });
});
