import { describe, it, expect } from 'vitest';
import { matchInterstitial, InterstitialBlockedError, CLI_INTERSTITIALS } from './cli-interstitials.js';

// R1 (CC-CHAT-3): network/tmux-free unit test over the shared CLI-interstitial table.
// Fake pane string in → expected keys/action out. Seeds from live incidents:
//  - codex 0.142.x update nag hijacked a spawn into a failing `npm install` (exit 243) → run stalled
//  - auth/login-expired must be a DISTINCT BLOCKED failure (needs a human), never guessed keys.
describe('CC-CHAT-3 R1 cli-interstitials table', () => {
  const codexUpdatePane = [
    '✨ Update available! 0.142.5 -> 0.143.0',
    '  1. Update now (runs npm install -g @openai/codex)',
    '  2. Skip',
    '  3. Skip until next version',
    '  Press enter to continue',
  ].join('\n');

  it('codex update prompt → Skip-until-next keys (3 + Enter), NEVER Update now', () => {
    const action = matchInterstitial(codexUpdatePane, { provider: 'codex' });
    expect(action).toBeTruthy();
    expect(action!.id).toBe('codex-update-prompt');
    expect(action!.blocked).toBe(false);
    expect(action!.keys).toEqual(['3', 'Enter']);
    expect(action!.keys[0]).not.toBe('1'); // the Update-now option killed a live run
  });

  it('codex update prompt with RENUMBERED menu → resolves the Skip-until-next number from the pane', () => {
    const renumbered = '✨ Update available!\n 1. Update now\n 2. Skip until next version\nPress enter to continue';
    const action = matchInterstitial(renumbered, { provider: 'codex' });
    expect(action!.keys).toEqual(['2', 'Enter']);
  });

  it('ANSI colour-split update prompt still matches (module strips internally)', () => {
    const ansi = '\x1b[95m✨ Update\x1b[39m \x1b[1mavailable!\x1b[0m\n 3. \x1b[2mSkip until next version\x1b[0m\n';
    const action = matchInterstitial(ansi, { provider: 'codex' });
    expect(action?.id).toBe('codex-update-prompt');
    expect(action?.keys).toEqual(['3', 'Enter']);
  });

  it('handled-set guard: the same response is never re-sent in a polling loop', () => {
    const handled = new Set<string>();
    const first = matchInterstitial(codexUpdatePane, { provider: 'codex', handled });
    expect(first?.id).toBe('codex-update-prompt');
    handled.add(first!.id); // callers add after sending keys
    expect(matchInterstitial(codexUpdatePane, { provider: 'codex', handled })).toBeNull();
  });

  it('provider filter: codex update entry does not fire for a grok spawn', () => {
    expect(matchInterstitial(codexUpdatePane, { provider: 'grok' })).toBeNull();
  });

  it('claude trust dialog → safety no-op (no keys, not blocked; pre-accepted via ensureClaudeTrust)', () => {
    const pane = 'Do you trust the files in this folder?\n\n /home/agjrom/websites/cards\n\n ❯ 1. Yes, proceed\n   2. No, exit';
    const action = matchInterstitial(pane, { provider: 'claude' });
    expect(action?.id).toBe('claude-trust-dialog');
    expect(action?.keys).toEqual([]);
    expect(action?.blocked).toBe(false);
  });

  it('auth/login expired (any provider) → BLOCKED action, no keys (needs a human, never guess)', () => {
    for (const pane of [
      'Error: Not logged in. Run codex login to authenticate.',
      'Your session has expired. Please log in again.',
      'Please run /login',
      'authentication failed: token expired',
    ]) {
      const action = matchInterstitial(pane, { provider: 'codex' });
      expect(action?.id, pane).toBe('auth-login-expired');
      expect(action?.blocked, pane).toBe(true);
      expect(action?.keys, pane).toEqual([]);
    }
  });

  it('blocked entries surface even when already in the handled set (caller fails immediately)', () => {
    const handled = new Set<string>(['auth-login-expired']);
    const action = matchInterstitial('Not logged in. Please log in.', { handled });
    expect(action?.blocked).toBe(true);
  });

  it('healthy boot banners do NOT false-positive the auth entry ("Logged in as" regression)', () => {
    for (const pane of [
      'codex-cli 0.142.5 — Logged in as silverjrom@gmail.com\n› ',
      'Grok Build ready. Logged in using ChatGPT plan.\n❯ ',
      'bypass permissions on · shift+tab to cycle\n❯ ',
    ]) {
      expect(matchInterstitial(pane, { provider: 'codex' }), pane).toBeNull();
    }
  });

  it('normal ready panes match nothing (interceptor is inert on the happy path)', () => {
    expect(matchInterstitial('❯ \n  gpt-5.5 high · ~/websites/cards\n', { provider: 'codex' })).toBeNull();
    expect(matchInterstitial('', { provider: 'claude' })).toBeNull();
  });

  it('InterstitialBlockedError carries a distinct, greppable BLOCKED message', () => {
    const err = new InterstitialBlockedError('auth-login-expired', 'auth/login expired — needs a human');
    expect(err.message).toMatch(/BLOCKED/);
    expect(err.message).toMatch(/auth-login-expired/);
    expect(err.interstitialId).toBe('auth-login-expired');
  });

  it('table stays ordered with the broad auth patterns LAST (specific menus claim first)', () => {
    expect(CLI_INTERSTITIALS[CLI_INTERSTITIALS.length - 1].id).toBe('auth-login-expired');
  });
});
