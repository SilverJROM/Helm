/**
 * B02 — R1.5 grok-4.5 + R9 claude blank-canvas (tui default).
 * Fail-closed registry invariants for provider templates.
 */
import { describe, it, expect } from 'vitest';
import { PROVIDERS, generateProvidersMarkdown } from './providers.js';
import { resolveAgentLaunchSpec } from '../services/provider-resolver-service.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(__dirname, '..');

function walkTsJs(dir: string, acc: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'dist') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkTsJs(p, acc);
    else if (/\.(ts|js|mjs|html)$/.test(ent.name)) acc.push(p);
  }
  return acc;
}

describe('B02 providers fail-closed (R1.5 + R9)', () => {
  it('R1.5: grok registry has grok-4.5 frontier + grok-composer-2.5-fast; no glm5.2', () => {
    const models = PROVIDERS.grok.models.map((m) => m.model);
    expect(models).toContain('grok-4.5');
    expect(models).toContain('grok-composer-2.5-fast');
    expect(models.some((m) => /glm/i.test(m))).toBe(false);
    const frontier = PROVIDERS.grok.models.find((m) => m.model === 'grok-4.5');
    expect(frontier?.band).toBe('frontier');
    const cmd = resolveAgentLaunchSpec({ provider: 'grok', model: 'grok-4.5' }).launch_cmd;
    expect(cmd).toContain('-m grok-4.5');
    expect(cmd).toMatch(/^grok /);
  });

  it('R9: claude defaultMode is tui; no skill template; tui-interrupt; ❯ readyProbe', () => {
    expect(PROVIDERS.claude.launch.defaultMode).toBe('tui');
    expect(PROVIDERS.claude.launch.templates.tui).toMatch(/^claude /);
    expect((PROVIDERS.claude.launch.templates as any).skill).toBeUndefined();
    expect(PROVIDERS.claude.swap_protocol).toBe('tui-interrupt');
    expect(PROVIDERS.claude.readyProbe?.signal).toBe('❯');
    const spec = resolveAgentLaunchSpec({ provider: 'claude', model: 'claude-opus-5' });
    expect(spec.launch_cmd).toMatch(/^claude /);
    expect(spec.launch_cmd).toContain('--model claude-opus-5');
    expect(spec.launch_cmd).not.toMatch(/^\/[a-z]/); // never slash-skill path
  });

  it('fail-closed: banned model id + banned launch modes absent under src/**', () => {
    // Patterns assembled at runtime so neither this file nor product source embeds banned literals.
    const bannedModel = ['grok', 'build'].join('-');
    const bannedSwap = ['skill', 'reinvoke'].join('-');
    const bannedDefault = 'defaultMode: "' + 'skill' + '"';
    const bannedTemplateDq = '"/' + '<' + 'skill' + '>"';
    const bannedTemplateSq = "'/" + '<' + 'skill' + "'";
    const files = walkTsJs(srcRoot);
    const offenders: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      const rel = path.relative(srcRoot, f);
      if (text.includes(bannedModel)) offenders.push(`${rel}: banned-model`);
      if (text.includes(bannedDefault)) offenders.push(`${rel}: defaultMode-skill`);
      if (text.includes(bannedSwap)) offenders.push(`${rel}: banned-swap`);
      if (text.includes(bannedTemplateDq) || text.includes(bannedTemplateSq)) {
        offenders.push(`${rel}: slash-skill-template`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('generateProvidersMarkdown reflects tui claude + grok-4.5', () => {
    const md = generateProvidersMarkdown();
    expect(md).toContain('grok-4.5');
    expect(md).toMatch(/## claude[\s\S]*Launch mode: tui/);
    expect(md).not.toMatch(/Launch mode: skill/);
  });
});
