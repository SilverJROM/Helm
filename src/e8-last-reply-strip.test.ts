// e8-last-reply-strip.test.ts
// E8 FIX3: the last-reply STRIP must show the agent's LAST REPLY ONLY, taken from the last complete
// ⟦HELM_REPLY⟧…⟦/HELM_REPLY⟧ pair — never the whole raw pane. Before this fix, app.js's
// ccLiveReplyText() was `stripAnsiForDisplay(ccLivePane[pid] || fallbackPane || '')` — the WHOLE RAW
// PANE — which is why tmux's own pager chrome ("... ctrl+o to expand") showed up in the strip
// (plan/_backlog/SOL-discovery-reply-path-diagnosis.md / /tmp/e8-fix-brief.md, verbatim).
// @ts-nocheck — .js ESM helper (no .d.ts); runtime import works under vitest.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lastCompleteHelmReplyText, HELM_REPLY_OPEN_RE, HELM_REPLY_CLOSE_RE } from './web/public/reply-extractor.js';
import { stripAnsiForDisplay } from './web/public/ansi-strip.js';

function readLivePane() {
  const raw = readFileSync(new URL('./test-fixtures/panes/discovery-live-20260728-2251.txt', import.meta.url), 'utf8');
  return raw.replace(/^# HELM_PROVENANCE: source_session=[^\n]+ capture_date=\d{4}-\d{2}-\d{2}\n/, '');
}

// The pre-fix strip implementation, inlined verbatim — proves this suite goes RED against it.
function preFixStripText(pane, fallbackPane) {
  return stripAnsiForDisplay(pane || fallbackPane || '');
}

describe('E8 FIX3 last-reply strip (lastCompleteHelmReplyText)', () => {
  it('real 3-reply capture: the pre-fix (raw-pane) strip leaks tmux pager chrome — proves the bug existed', () => {
    const pane = readLivePane();
    const preFix = preFixStripText(pane);
    // This is the EXACT symptom JROM reported: "+65 lines (ctrl+o to expand)"-style tmux chrome
    // showing up in the strip. Any pane containing tool calls will trip this under the old code.
    expect(preFix).toContain('ctrl+o to expand');
  });

  it('real 3-reply capture: the FIXED strip shows ONLY the LAST complete reply — no chrome, no earlier reply', () => {
    const pane = readLivePane();
    const stripped = stripAnsiForDisplay(pane);
    const text = lastCompleteHelmReplyText(stripped);
    // Never the raw pane's tool-call chrome.
    expect(text).not.toContain('ctrl+o to expand');
    expect(text).not.toContain('bypass permissions');
    // Never the FIRST (older) reply.
    expect(text).not.toContain('Discovery for cycle 13');
    expect(text).not.toContain('Already settled from your directive');
    // Exactly the LAST (second) reply's content, start to end, markers stripped.
    expect(text.startsWith('Answers recorded in the discovery log.')).toBe(true);
    expect(text).toContain("Reading #2 as no token");
    expect(text.endsWith('stop at the review\n  gate before any code.')).toBe(true);
    expect(text).not.toContain('⟦HELM_REPLY⟧');
    expect(text).not.toContain('⟦/HELM_REPLY⟧');
    // The THIRD turn ("go ahead, write the plan") was never submitted — still sitting in the
    // composer with no reply below it — so it must not appear either.
    expect(text).not.toContain('go ahead, write the plan');
  });

  it('this suite is genuinely RED against the pre-fix implementation for the same pane', () => {
    const pane = readLivePane();
    const preFix = preFixStripText(pane);
    const fixed = lastCompleteHelmReplyText(stripAnsiForDisplay(pane));
    // Same input, different surfaces: the pre-fix strip contains the chrome the fixed one must not.
    expect(preFix).toContain('ctrl+o to expand');
    expect(fixed).not.toContain('ctrl+o to expand');
    expect(preFix).not.toBe(fixed);
  });

  it('no complete reply pair anywhere → empty string, never falls back to raw pane', () => {
    expect(lastCompleteHelmReplyText('')).toBe('');
    expect(lastCompleteHelmReplyText('some raw chrome with no markers at all\n❯ ')).toBe('');
    // An OPEN marker with no matching CLOSE (still generating, or scrolled off) is not "complete" —
    // must not leak the dangling partial text either.
    expect(lastCompleteHelmReplyText('⟦HELM_REPLY⟧\nstill typing')).toBe('');
  });

  it('takes the LAST of multiple complete pairs, not the first', () => {
    const pane = [
      '⟦HELM_REPLY⟧',
      'first reply',
      '⟦/HELM_REPLY⟧',
      'tool noise in between',
      '⟦HELM_REPLY⟧',
      'second reply',
      '⟦/HELM_REPLY⟧',
    ].join('\n');
    expect(lastCompleteHelmReplyText(pane)).toBe('second reply');
  });

  it('a later dangling open after the last complete pair does not override the last complete reply', () => {
    const pane = [
      '⟦HELM_REPLY⟧',
      'completed reply',
      '⟦/HELM_REPLY⟧',
      '⟦HELM_REPLY⟧',
      'still generating, no close yet',
    ].join('\n');
    expect(lastCompleteHelmReplyText(pane)).toBe('completed reply');
  });

  it('legacy [[HELM_REPLY]] bracket form is also recognized (same delimiter alternation as the extractor)', () => {
    const pane = '[[HELM_REPLY]]\nbracket-form reply\n[[/HELM_REPLY]]';
    expect(lastCompleteHelmReplyText(pane)).toBe('bracket-form reply');
  });

  it('structural: app.js ccLiveReplyText derives from lastCompleteHelmReplyText, not the raw pane', () => {
    const src = readFileSync(new URL('./web/public/app.js', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes('const ccLiveReplyText ='));
    expect(line).toBeTruthy();
    expect(line).toContain('lastCompleteHelmReplyText(');
    expect(line).not.toMatch(/=\s*stripAnsiForDisplay\(ccLivePane\[pid\]/);
  });

  it('structural: the last-reply strip renders at the top of Discovery regardless of view mode (mirror or bubbles)', () => {
    // JROM design ruling (settled): "we already have this just place it on the top discovery last
    // reply" + "i can work with the mirror still having my reply ... so we can have both." The strip
    // must render BEFORE the discMirrorMode branch, not only inside the bubbles-mode branch.
    const src = readFileSync(new URL('./web/public/app.js', import.meta.url), 'utf8');
    const stripCall = src.indexOf('${discLiveActive ? renderCcLiveReply(pid, brainName) : null}');
    const mirrorWrap = src.indexOf('data-testid="ws-disc-mirror-wrap"');
    expect(stripCall).toBeGreaterThan(-1);
    expect(mirrorWrap).toBeGreaterThan(-1);
    expect(stripCall).toBeLessThan(mirrorWrap);
  });
});
