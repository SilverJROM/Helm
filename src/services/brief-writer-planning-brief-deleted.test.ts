/**
 * B4 / R1.1 / R1.3: generatePlanningBrief is deleted (not repurposed). Plancore is not an
 * authoring seat. generateBrainBrief (mid-implementation escalation) survives untouched.
 * Token-free: production src has no generatePlanningBrief method definition.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BriefWriterService } from './brief-writer-service.js';

const REPO_ROOT = process.cwd();
const SERVICE_REL = 'src/services/brief-writer-service.ts';

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === 'dist') continue;
      out.push(...listProductionTsFiles(full));
      continue;
    }
    if (!item.isFile() || !item.name.endsWith('.ts') || item.name.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('B4 — generatePlanningBrief deleted (R1.1); generateBrainBrief survives (R1.3)', () => {
  it('BriefWriterService has no generatePlanningBrief method', () => {
    const writer = new BriefWriterService();
    expect(typeof (writer as { generatePlanningBrief?: unknown }).generatePlanningBrief).toBe(
      'undefined',
    );
    expect('generatePlanningBrief' in writer).toBe(false);
  });

  it('brief-writer-service.ts source has no generatePlanningBrief method definition', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, SERVICE_REL), 'utf8');
    // Method def form: generatePlanningBrief(params
    expect(src).not.toMatch(/\bgeneratePlanningBrief\s*\(/);
    expect(src).not.toMatch(/\bgeneratePlanningBrief\s*[:=]/);
  });

  it('production src/ has zero generatePlanningBrief call sites or method defs (comments only OK)', () => {
    const files = listProductionTsFiles(path.join(REPO_ROOT, 'src'));
    const offenders: string[] = [];
    for (const abs of files) {
      const body = fs.readFileSync(abs, 'utf8');
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('generatePlanningBrief')) continue;
        // Allow historical comments / block-comment history only
        const trimmed = line.trim();
        const isComment =
          trimmed.startsWith('//') ||
          trimmed.startsWith('*') ||
          trimmed.startsWith('/*') ||
          trimmed.includes('// ') && !/\bgeneratePlanningBrief\s*\(/.test(line);
        // Method call or def is never allowed in production
        if (/\bgeneratePlanningBrief\s*[\(:=]/.test(line)) {
          offenders.push(`${path.relative(REPO_ROOT, abs)}:${i + 1}: ${trimmed}`);
          continue;
        }
        if (!isComment && trimmed.includes('generatePlanningBrief')) {
          // bare identifier not in comment
          const codeOnly = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
          if (codeOnly.includes('generatePlanningBrief')) {
            offenders.push(`${path.relative(REPO_ROOT, abs)}:${i + 1}: ${trimmed}`);
          }
        }
      }
    }
    expect(offenders, `production generatePlanningBrief residues:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });

  it('generateBrainBrief remains present and still wakes plancore for slice revise (R1.3)', () => {
    const writer = new BriefWriterService();
    expect(typeof writer.generateBrainBrief).toBe('function');
    const brief = writer.generateBrainBrief({
      batchId: 'b4-brain',
      ledger: { attempts: [] },
      projectDir: '/tmp/b4-proj',
      callbacksFile: '/tmp/b4-run/callbacks.md',
    });
    expect(brief).toContain('Wakes plancore to surgically revise THIS slice');
    expect(brief).toContain('DECISION-READY');
  });
});
