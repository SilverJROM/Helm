/**
 * B21 — R6.24–R6.25 read-only recon smoke.
 * Runs scripts/r6-recon.mjs against real schema + scaffolding, asserts report
 * sections, and proves agent-usage.sh / topology.yaml hashes are unchanged.
 * R8: does not import or touch routing-config-service / plumbing-watcher-service.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts/r6-recon.mjs');
const SCHEMA = path.join(REPO, 'src/db/schema.ts');
const USAGE = path.join(os.homedir(), '.claude/agents/lib/agent-usage.sh');
const TOPOLOGY = path.join(REPO, 'plan/c01-agent-studio-rebuild/topology.yaml');
const R8_BANNED = [
  path.join(REPO, 'src/services/routing-config-service.ts'),
  path.join(REPO, 'src/services/plumbing-watcher-service.ts'),
];

function sha256(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('B21 R6 recon (read-only)', () => {
  it('script exists and is non-empty', () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
    expect(fs.statSync(SCRIPT).size).toBeGreaterThan(500);
  });

  it('runs recon, writes report with required sections, leaves scaffolding untouched', () => {
    expect(fs.existsSync(SCHEMA)).toBe(true);
    expect(fs.existsSync(USAGE)).toBe(true);
    expect(fs.existsSync(TOPOLOGY)).toBe(true);

    const usagePre = sha256(USAGE);
    const topoPre = sha256(TOPOLOGY);
    const r8Pre = R8_BANNED.filter((p) => fs.existsSync(p)).map((p) => ({ p, h: sha256(p) }));

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b21-recon-'));
    try {
      const res = spawnSync(
        process.execPath,
        [
          SCRIPT,
          '--repo',
          REPO,
          '--usage',
          USAGE,
          '--topology',
          TOPOLOGY,
          '--out',
          outDir,
        ],
        { encoding: 'utf8', timeout: 30_000 }
      );
      expect(res.status, `stderr=${res.stderr}\nstdout=${res.stdout}`).toBe(0);

      const mdPath = path.join(outDir, 'B21-r6-recon-report.md');
      const jsonPath = path.join(outDir, 'B21-r6-recon-report.json');
      expect(fs.existsSync(mdPath)).toBe(true);
      expect(fs.existsSync(jsonPath)).toBe(true);

      const md = fs.readFileSync(mdPath, 'utf8');
      for (const section of [
        '# B21 — R6 recon report',
        '## Matches',
        '## Mismatches / drift',
        '## Recommended JROM-owned edits',
        '## Read-only guarantee',
      ]) {
        expect(md, `missing section ${section}`).toContain(section);
      }
      expect(md).toMatch(/read-only/i);
      expect(md).toMatch(/OPEN-BY-JROM/);

      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      // FIX-Q13-COUNTS: never pin seed cardinality (was 10). Property-validate derived seeds.
      expect(json.helm.seeds.length).toBeGreaterThan(0);
      expect(json.helm.seeds.length).toBe(json.helm.slugs.length);
      expect(new Set(json.helm.slugs).size).toBe(json.helm.slugs.length);
      for (const s of json.helm.seeds) {
        expect(s.slug).toBeTruthy();
        expect(s.model_id).toBeTruthy();
        expect(s.provider).toBeTruthy();
        expect(s.cli).toBeTruthy();
        expect(s.display_name).toBeTruthy();
      }
      expect(json.helm.slugs).toEqual(
        expect.arrayContaining([
          'opus4.8',
          'sonnet5',
          'haiku',
          'codex55',
          'spark',
          'grok45',
          'grokcompose',
        ])
      );
      expect(json.usage.rung_keys.length).toBeGreaterThanOrEqual(4);
      expect(json.meta.read_only_ok).toBe(true);
      expect(json.comparison.matches.length + json.comparison.alias_matches.length).toBeGreaterThan(
        0
      );
      // recommendations exist but apply:false
      expect(json.comparison.recommendations.length).toBeGreaterThan(0);
      for (const r of json.comparison.recommendations) {
        expect(r.apply).toBe(false);
      }

      // stdout summary
      const summary = JSON.parse(res.stdout);
      expect(summary.ok).toBe(true);
      expect(summary.read_only_ok).toBe(true);
    } finally {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }

    expect(sha256(USAGE)).toBe(usagePre);
    expect(sha256(TOPOLOGY)).toBe(topoPre);
    for (const { p, h } of r8Pre) {
      expect(sha256(p), `R8 file mutated: ${p}`).toBe(h);
    }
  });

  it('default out path is plan validation dir; R8 services never imported', () => {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('plan/c01-agent-studio-rebuild/validation');
    expect(src).toContain('B21-r6-recon-report.md');
    expect(src).toMatch(/refusing banned write target/);
    // R8: ban-list / prose may name the files; must not import or require them
    expect(src).not.toMatch(/from\s+['"].*routing-config-service/);
    expect(src).not.toMatch(/from\s+['"].*plumbing-watcher-service/);
    expect(src).not.toMatch(/require\s*\(\s*['"].*routing-config-service/);
    expect(src).not.toMatch(/require\s*\(\s*['"].*plumbing-watcher-service/);
    // script must not open usage DB write paths for mutation
    expect(src).not.toMatch(/PROJCORE_DB/);
    expect(src).not.toMatch(/projcore\.db/);
  });
});
