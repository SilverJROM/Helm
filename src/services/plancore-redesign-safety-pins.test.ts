import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function readFile(relPath: string): string {
  return fs.readFileSync(relPath, 'utf8');
}

function listProductionTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === 'dist') continue;
      out.push(...listProductionTypeScriptFiles(full));
      continue;
    }
    if (!item.isFile() || !item.name.endsWith('.ts') || item.name.endsWith('.test.ts')) continue;
    out.push(full);
  }

  return out;
}

describe('S0 safety pins before plancore redesign edits', () => {
  it('pins planMdPathForRaceGuard count at 3', () => {
    const src = readFile('src/services/planning-phase-service.ts');
    const count = (src.match(/planMdPathForRaceGuard/g) || []).length;
    expect(count).toBe(3);
  });

  it('keeps HELM_SESSION_JANITOR pinned/ defaulted to 0', () => {
    const pinnedSources = [
      { relPath: '.env', pattern: /HELM_SESSION_JANITOR\s*=\s*0\b/ },
      { relPath: '.env.cards2', pattern: /HELM_SESSION_JANITOR\s*=\s*0\b/ },
      { relPath: 'ecosystem.config.cjs', pattern: /HELM_SESSION_JANITOR\s*:\s*"0"/ },
      {
        relPath: 'src/config/config.ts',
        pattern: /HELM_SESSION_JANITOR:\s*parseJanitorMode\(optional\("HELM_SESSION_JANITOR",\s*"0"\)\)/,
      },
      {
        relPath: 'src/config/config.ts',
        pattern: /HELM_SESSION_JANITOR\s*:\s*parseJanitorMode\(optional\("HELM_SESSION_JANITOR",\s*"0"\)\)/,
      },
    ];

    for (const pin of pinnedSources) {
      const body = readFile(pin.relPath);
      expect(body).toMatch(pin.pattern);
    }

    const cfgSrc = readFile('src/config/config.ts');
    expect(cfgSrc).toContain('HELM_SESSION_JANITOR: HelmSessionJanitorMode;');
  });

  it('keeps generateBrainBrief present with Wakes plancore revise slice wording', () => {
    const src = readFile('src/services/brief-writer-service.ts');

    expect(src).toContain('generateBrainBrief(params:');
    expect(src).toContain('Wakes plancore to surgically revise THIS slice');
  });

  it('allows worker-runtime-finalize imports only from currently sanctioned production modules', () => {
    const files = listProductionTypeScriptFiles(path.join(ROOT, 'src'));
    const importPattern = /(?:from\s+['\"][^'"]*worker-runtime-finalize(?:\.js)?['\"]|import\(\s*['\"][^'"]*worker-runtime-finalize(?:\.js)?['\"]\s*\))/g;
    const importers = files
      .map((abs) => readFile(abs))
      .map((content, idx) => ({ content, rel: path.relative(ROOT, files[idx]).replace(/\\/g, '/') }))
      .filter((entry) => importPattern.test(entry.content))
      .map((entry) => entry.rel)
      .sort();

    expect(importers).toEqual([
      'src/index.ts',
      'src/services/orchestrator-loop.ts',
      'src/services/planning-phase-service.ts',
      'src/services/run-orchestrator-service.ts',
      'src/services/worker-service.ts',
    ]);
  });
});
