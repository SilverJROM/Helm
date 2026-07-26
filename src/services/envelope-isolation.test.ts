import { describe, it, expect } from 'vitest';
import { applyEnvelopeIsolation, HELM_ENVELOPE_DIRECTIVE } from './envelope-isolation.js';

describe('B4-T01: envelope-isolation (byte-identical extraction, auth-preserving)', () => {
  const sampleClaude = 'claude --model claude-sonnet-4-6';
  const sampleCodex = 'codex';
  const sampleGrok = 'grok tui --model grok-4.5';
  const sampleStub = 'stub --foo bar';
  const sampleKloo = 'kloo --route cloud';

  it('claude returns the 3 disable-envs in envPrefix and --setting-sources + --append-system-prompt in launchCmd', () => {
    const result = applyEnvelopeIsolation('claude', sampleClaude);
    expect(result.envPrefix).toBe('CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1 ');
    expect(result.launchCmd).toContain("--setting-sources ''");
    expect(result.launchCmd).toContain(`--append-system-prompt '${HELM_ENVELOPE_DIRECTIVE}'`);
    // AUTH-PRESERVING negative checks (JROM-locked, security-critical)
    expect(result.launchCmd).not.toContain('--bare');
    expect(result.launchCmd).not.toContain('CLAUDE_CONFIG_DIR');
    expect(result.envPrefix).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('codex sets a blank CODEX_HOME (no operator skills) + appends -c project_doc_max_bytes=0', () => {
    const result = applyEnvelopeIsolation('codex', sampleCodex);
    expect(result.envPrefix).toMatch(/^CODEX_HOME='[^']*helm-agent-homes\/codex' $/);
    expect(result.launchCmd).toBe(`${sampleCodex} -c project_doc_max_bytes=0`);
    expect(result.launchCmd).toContain('-c project_doc_max_bytes=0');
  });

  it('grok sets a blank HOME (no operator agents/skills); stub unchanged', () => {
    const grokResult = applyEnvelopeIsolation('grok', sampleGrok);
    expect(grokResult.envPrefix).toMatch(/^HOME='[^']*helm-agent-homes\/grok' $/);
    expect(grokResult.launchCmd).toBe(sampleGrok); // launch command itself unchanged

    const stubResult = applyEnvelopeIsolation('stub', sampleStub);
    expect(stubResult.envPrefix).toBe('');
    expect(stubResult.launchCmd).toBe(sampleStub);
  });

  it('exports HELM_ENVELOPE_DIRECTIVE (used by claude path)', () => {
    expect(HELM_ENVELOPE_DIRECTIVE).toContain('worker dispatched by the Helm orchestrator');
    expect(HELM_ENVELOPE_DIRECTIVE).toContain('report via callbacks.md');
  });

  it('kloo preserves launchCmd; may inject OPENROUTER_API_KEY prefix when present (byte-identical branch)', () => {
    // Without key in this env: empty prefix
    const result = applyEnvelopeIsolation('kloo', sampleKloo);
    expect(result.launchCmd).toBe(sampleKloo);
    // envPrefix is either '' or the key form; behavior matches old private impl exactly
    expect(result.envPrefix === '' || result.envPrefix.startsWith("OPENROUTER_API_KEY='")).toBe(true);
  });
});
