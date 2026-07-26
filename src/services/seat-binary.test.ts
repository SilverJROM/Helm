// Shared seat-binary detection (review #2 + #6): marker-scoped, bin-tied match; NaN-safe clamp.
import { describe, it, expect } from 'vitest';
import { matchSeatBinaryError, clampPositiveInt } from './seat-binary.js';

const M = 'HELM_LAUNCH_abc-123';

describe('matchSeatBinaryError — marker-scoped, bin-tied (review #2)', () => {
  it('catches a fresh post-marker bash "command not found" for the resolved bin', () => {
    const pane = `${M}\nbash: line 1: grok: command not found`;
    expect(matchSeatBinaryError(pane, { marker: M, bin: 'grok' })).toMatch(/command not found/);
  });

  it('catches the helm-sandbox execvp(<bin>) failure line', () => {
    const pane = `${M}\nhelm-sandbox: execvp(codex) failed after successful restrict: No such file or directory`;
    expect(matchSeatBinaryError(pane, { marker: M, bin: 'codex' })).toMatch(/execvp\(codex\) failed/);
  });

  it('does NOT fire on a REUSED session: an OLD command-not-found BEFORE the marker is ignored', () => {
    // historical scrollback (prior use) then a fresh, healthy launch that reaches the composer.
    const pane = `bash: line 9: grok: command not found\n${M}\n❯ bypass permissions on  (composer ready)`;
    expect(matchSeatBinaryError(pane, { marker: M, bin: 'grok' })).toBeNull();
  });

  it('does NOT fire on an unrelated healthy line containing "No such file or directory" (not the bin)', () => {
    const pane = `${M}\nwarn: config /etc/app/opt.json: No such file or directory (using defaults)\n❯ ready`;
    expect(matchSeatBinaryError(pane, { marker: M, bin: 'grok' })).toBeNull();
  });

  it('returns null when the marker is not yet visible (avoids scanning historical output)', () => {
    const pane = `bash: line 9: grok: command not found`; // pre-marker capture
    expect(matchSeatBinaryError(pane, { marker: M, bin: 'grok' })).toBeNull();
  });

  it('strips ANSI before matching', () => {
    const pane = `${M}\n\x1b[31mbash: grok: command not found\x1b[0m`;
    expect(matchSeatBinaryError(pane, { marker: M, bin: 'grok' })).toMatch(/command not found/);
  });

  it('without a bin, generic signatures still match (fallback)', () => {
    const pane = `${M}\nsome-cli: not found`;
    expect(matchSeatBinaryError(pane, { marker: M })).toMatch(/not found/);
  });
});

describe('clampPositiveInt (review #6 — NaN wedge guard)', () => {
  it('nonnumeric → fallback', () => {
    expect(clampPositiveInt('not-a-number', 4000)).toBe(4000);
    expect(clampPositiveInt(undefined, 4000)).toBe(4000);
    expect(clampPositiveInt('', 4000)).toBe(4000);
  });
  it('negative / below-min → fallback', () => {
    expect(clampPositiveInt('-5', 4000, 100)).toBe(4000);
    expect(clampPositiveInt('50', 4000, 100)).toBe(4000);
  });
  it('valid → clamped to max', () => {
    expect(clampPositiveInt('2000', 4000, 100, 60000)).toBe(2000);
    expect(clampPositiveInt('999999', 4000, 100, 60000)).toBe(60000);
  });
});
