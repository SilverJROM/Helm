import { describe, it, expect } from 'vitest';
import { TmuxService } from './tmux-service.js';

// CC-CHAT-1 regression: codex 5.5 "Create a plan?" nudge swallows C-m while the composer holds
// multi-line text rendered WITHOUT a ❯/› prefix — and capture-pane -e colour-splits the nudge
// words ("esc\x1b[0m dismiss"). isTextSubmitted must (a) match on ANSI-stripped text, (b) return
// HELD for the nudge, (c) see long text sitting BELOW a bare ❯/› marker via the tail chunk, and
// (d) keep no-composer boot/capture frames INDETERMINATE rather than falsely submitted.
describe('CC-CHAT-1 sendAndSubmit submission heuristic (codex plan-nudge + ANSI)', () => {
  const svc: any = new TmuxService();
  const msg = 'You are running inside Helm test-chat (test and discuss only). '
    + 'Memory: use Helm app memory. Tools: follow the Helm protocol. '
    + '<!-- HELM_BOOTSTRAP_END:cafebabe -->';
  const chunk = msg.replace(/\s+/g, '').slice(0, 40);
  const tailChunk = msg.replace(/\s+/g, '').slice(-40);

  it('ANSI colour-split plan nudge => NOT submitted (the live CC-CHAT-1 repro)', () => {
    const pane = '  Helm shared memory:\n  - conventions\n\n'
      + '  \u001b[38;5;5mCreate a plan?\u001b[39m  \u001b[2mshift + tab\u001b[0m use Plan mode   \u001b[2mesc\u001b[0m dismiss\n';
    expect(svc.isTextSubmitted(pane, chunk, tailChunk)).toBe('held');
  });

  it('long text sitting below a bare › marker (head scrolled off) => NOT submitted via tail chunk', () => {
    const pane = '› \n  ' + msg.split(' ').slice(10).join(' ') + '\n';
    expect(svc.isTextSubmitted(pane, chunk, tailChunk)).toBe('held');
  });

  it('short text still on the ❯ composer line => NOT submitted (existing heuristic preserved)', () => {
    const short = 'hello are you there?';
    const pane = '❯ hello are you there?\n  bypass permissions on\n';
    expect(svc.isTextSubmitted(pane, short.replace(/\s+/g, '').slice(0, 40), short.replace(/\s+/g, '').slice(-40))).toBe('held');
  });

  it('cleared composer + no nudge => submitted', () => {
    const pane = '• Working (4s • esc to interrupt)\n\n› Implement {feature}\n\n  gpt-5.5 high fast · ~/websites/cards\n';
    expect(svc.isTextSubmitted(pane, chunk, tailChunk)).toBe('submitted');
  });

  it('paste indicator => NOT submitted (pre-existing behavior)', () => {
    expect(svc.isTextSubmitted('❯ [Pasted Content 12 lines]\n', chunk, tailChunk)).toBe('held');
  });

  // F1 (over-broad free-form matching → FALSE-NEGATIVE): confirmation must NOT inspect free-form RESPONSE
  // text. A normal reply that merely ENDS in dialog-shaped words like "Not now" or "Press Enter to confirm"
  // must read as SUBMITTED — we only ever check the composer region for OUR specific text.
  it('F1: reply ending in "Not now" with a cleared composer => submitted (no false negative)', () => {
    const pane = 'Sure — I can take care of that later.\nNot now\n\n❯ \n  bypass permissions on\n';
    expect(svc.composerRegionHoldsText(pane, chunk, tailChunk)).toBe(false);
    expect(svc.isTextSubmitted(pane, chunk, tailChunk)).toBe('submitted');
  });

  it('F1: reply ending in "Press Enter to confirm" with a cleared composer => submitted (no false negative)', () => {
    const pane = 'Done. To apply the change, Press Enter to confirm.\n\n› \n';
    expect(svc.isTextSubmitted(pane, chunk, tailChunk)).toBe('submitted');
  });

  // Mechanism truth table for composerRegionHoldsText (OUR specific text vs the composer region only).
  it('composerRegionHoldsText: our text on the ❯ composer line => held', () => {
    const short = 'hello are you there?';
    const c = short.replace(/\s+/g, '').slice(0, 40);
    const t = short.replace(/\s+/g, '').slice(-40);
    expect(svc.composerRegionHoldsText('❯ hello are you there?\n  bypass permissions on\n', c, t)).toBe(true);
  });

  it('composerRegionHoldsText: no composer region (blank / launch-echo / auth) => not held', () => {
    // These frames have no ❯/› composer line → our text is simply not held here. Whether a send into such
    // a frame counts as delivered is decided by sendAndSubmit's acceptance gate (see tmux-sendsubmit test),
    // NOT by guessing from this single frame.
    expect(svc.composerRegionHoldsText('\n\n', chunk, tailChunk)).toBe(false);
    expect(svc.composerRegionHoldsText('  Starting session…\n  loading model gpt-5.5\n', chunk, tailChunk)).toBe(false);
    expect(svc.composerRegionHoldsText('  Do you trust this folder?\n  Enter to confirm · Esc to cancel\n', chunk, tailChunk)).toBe(false);
  });

  it('BUG-1: blank and boot/auth panes are indeterminate, never submitted', () => {
    expect(svc.isTextSubmitted('\n\n', chunk, tailChunk)).toBe('indeterminate');
    expect(svc.isTextSubmitted('  Starting session…\n  loading model gpt-5.5\n', chunk, tailChunk)).toBe('indeterminate');
    expect(svc.isTextSubmitted('  Do you trust this folder?\n  Enter to confirm · Esc to cancel\n', chunk, tailChunk)).toBe('indeterminate');
  });

  it('BUG-1: this-turn generation below the payload-bearing composer line is submitted', () => {
    const pane = `› ${msg}\n\n• Working (2s • esc to interrupt)\n`;
    expect(svc.isTextSubmitted(pane, chunk, tailChunk)).toBe('submitted');
  });
});
