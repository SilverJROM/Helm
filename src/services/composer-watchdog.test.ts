import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TmuxService } from '../tmux/tmux-service.js';
import { RealTransport } from './real-transport.js';

// R8 (CC-CHAT-3): composer submit watchdog — tmux-free unit tests.
// Live run 80: even sendAndSubmit's ~55s backoff was beaten (the codex Enter-drop window is
// VARIABLE); a manual Enter minutes later submitted instantly. The watchdog primitive
// (RealTransport.resubmitIfComposerHeld, consulted by orchestrator-loop waitForCallback /
// planning waitForFirstCallback / master submitMasterFeed) must:
//  (a) detect the dispatched brief still sitting UN-submitted in the composer (ANSI-stripped,
//      same heuristic as sendAndSubmit's own verification),
//  (b) press Enter only then (never on a clear composer),
//  (c) Esc-dismiss the codex "Create a plan?" nudge first (it swallows C-m).

const BRIEF = 'You are the implementer for batch-T1. Read prompts/implementer.brief.md and follow '
  + 'the Helm callback contract. Append [helm callback] implementer batch-T1 STATUS: DONE when finished.';

describe('CC-CHAT-3 R8 paneHoldsUnsubmittedText (pure heuristic)', () => {
  const svc = new TmuxService();

  it('brief on the ❯ composer line → HELD', () => {
    const pane = `❯ ${BRIEF}\n  bypass permissions on\n`;
    expect(svc.paneHoldsUnsubmittedText(pane, BRIEF)).toBe(true);
  });

  it('long brief below a bare › marker (head scrolled off) → HELD via tail chunk', () => {
    const pane = '› \n  ' + BRIEF.split(' ').slice(8).join(' ') + '\n';
    expect(svc.paneHoldsUnsubmittedText(pane, BRIEF)).toBe(true);
  });

  it('ANSI colour-split composer text → still HELD (stripped before matching)', () => {
    const pane = `❯ \x1b[2mYou are the\x1b[0m implementer \x1b[38;5;5mfor batch-T1.\x1b[39m Read prompts/implementer.brief.md and follow the Helm callback contract. Append [helm callback] implementer batch-T1 STATUS: DONE when finished.\n`;
    expect(svc.paneHoldsUnsubmittedText(pane, BRIEF)).toBe(true);
  });

  it('submitted brief (echoed in scrollback, composer clear) → NOT held', () => {
    const pane = `• Working (12s • esc to interrupt)\n\n› Implement batch-T1\n\n  gpt-5.5 high · ~/websites/cards\n❯ \n`;
    expect(svc.paneHoldsUnsubmittedText(pane, BRIEF)).toBe(false);
  });

  it('empty text → never held', () => {
    expect(svc.paneHoldsUnsubmittedText('❯ something\n', '')).toBe(false);
  });
});

describe('CC-CHAT-3 R8 RealTransport.resubmitIfComposerHeld (stubbed tmux)', () => {
  // RealTransport refuses construction under USE_FAKE_TMUX=1 (batch-A1 guard) — clear it for
  // these unit tests (the injected stub tmux never touches a real tmux server).
  let savedFake: string | undefined;
  beforeAll(() => { savedFake = process.env.USE_FAKE_TMUX; delete process.env.USE_FAKE_TMUX; });
  afterAll(() => { if (savedFake !== undefined) process.env.USE_FAKE_TMUX = savedFake; });

  class StubTmux extends TmuxService {
    pane = '';
    enters = 0;
    keys: string[] = [];
    async capturePane(_target: string, _lines = 200): Promise<string> { return this.pane; }
    async sendEnter(_target: string) { this.enters += 1; return { message: 'enter', blocked: false }; }
    async sendKeys(_target: string, k: string) { this.keys.push(k); return { message: k, blocked: false }; }
  }

  function make() {
    const tmux = new StubTmux();
    const transport = new RealTransport({ tmux });
    return { tmux, transport };
  }

  it('brief still held in the composer → presses Enter, returns true', async () => {
    const { tmux, transport } = make();
    tmux.pane = `❯ ${BRIEF}\n`;
    await expect(transport.resubmitIfComposerHeld('helm-t1-implementer:0.0', BRIEF)).resolves.toBe(true);
    expect(tmux.enters).toBe(1);
    expect(tmux.keys).not.toContain('Escape'); // no nudge visible → no Esc
  });

  it('composer clear (brief submitted) → NO Enter, returns false', async () => {
    const { tmux, transport } = make();
    tmux.pane = '• Working (4s • esc to interrupt)\n\n❯ \n';
    await expect(transport.resubmitIfComposerHeld('helm-t1-implementer:0.0', BRIEF)).resolves.toBe(false);
    expect(tmux.enters).toBe(0);
  });

  it('codex "Create a plan?" nudge (swallows C-m) → Esc-dismiss FIRST, then Enter', async () => {
    const { tmux, transport } = make();
    tmux.pane = `› \n  ${BRIEF}\n\n  \x1b[38;5;5mCreate a plan?\x1b[39m  \x1b[2mshift + tab\x1b[0m use Plan mode   \x1b[2mesc\x1b[0m dismiss\n`;
    await expect(transport.resubmitIfComposerHeld('helm-t1-implementer:0.0', BRIEF)).resolves.toBe(true);
    expect(tmux.keys).toContain('Escape');
    expect(tmux.enters).toBe(1);
  });

  it('capture failure (session gone) → best-effort false, never throws', async () => {
    const { tmux, transport } = make();
    tmux.capturePane = async () => { throw new Error('no such session'); };
    await expect(transport.resubmitIfComposerHeld('helm-t1-implementer:0.0', BRIEF)).resolves.toBe(false);
  });
});
