import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TmuxService } from './tmux-service.js';

// F1/F2 redesign of sendAndSubmit. Confirmation is a per-seat composer TRANSITION, never a match against
// free-form rendered text:
//  - F2 (opt-in `readySignal`, per-seat, master-safe): when the caller passes its provider readyProbe glyph,
//    the seat must PRESENT that signal before we type — a booting / auth / update / launch-echo frame lacks
//    it → NOT delivered (nothing typed, no Enter). Callers that omit it (the master runtime feed; legacy)
//    keep the exact original behavior, so a different-TUI seat is never misjudged.
//  - F1: the "still held?" check is `composerRegionHoldsText` — the composer region + OUR specific text
//    only — so a reply merely ending in "Not now" / "Press Enter to confirm" can't be misread as un-submitted.
//
// The StubTmux drives the mechanism by scripting capturePane frames + recording key sends — no real tmux.
const TARGET = 'helm-stub:0.0';
const BRIEF =
  'You are the implementer for batch-T1. Read prompts/implementer.brief.md and append the Helm callback '
  + 'STATUS: DONE line per the contract when finished.';

class StubTmux extends TmuxService {
  frame = '';
  enters = 0;
  typed: string[] = [];
  keys: string[] = [];
  onType: ((text: string) => void) | null = null;
  onEnter: (() => void) | null = null;
  async capturePane(_target: string, _lines = 200): Promise<string> { return this.frame; }
  async sendLiteralText(_target: string, text: string): Promise<void> { this.typed.push(text); if (this.onType) this.onType(text); }
  async sendEnter(_target: string) { this.enters += 1; if (this.onEnter) this.onEnter(); return { message: 'enter', blocked: false }; }
  async sendKeys(_target: string, k: string) { this.keys.push(k); return { message: k, blocked: false }; }
}

const heldFrame = (text: string) => `❯ ${text}\n  bypass permissions on\n`;
const clearedFrame = '• Working (2s • esc to interrupt)\n\n❯ \n';

// REAL-shaped boot / not-ready frames per provider — none surface the ❯ ready signal yet (blank first paint,
// launch echo, auth, update, startup) across claude-code, codex/sol, and grok.
const BOOT_FRAMES: Record<string, string> = {
  'claude-code blank first paint': '\n\n\n',
  'claude-code update/onboarding screen':
    '  Try the new fullscreen renderer?\n  Enter to confirm · Esc to cancel · Not now\n',
  'codex/sol launch echo':
    '  Starting Codex session…\n  model: gpt-5.5-codex   cwd: ~/websites/cards\n',
  'grok auth / update screen':
    '  Grok CLI — checking for updates…\n  Please authenticate: run `grok auth login`\n',
  'grok startup banner':
    '  ┌ Grok Build ┐\n  Starting session…\n',
};

describe('F2 sendAndSubmit per-seat readiness gate (readySignal) — send before ready is NOT delivered', () => {
  let saved: string | undefined;
  beforeAll(() => { saved = process.env.HELM_TEST_FAST_WD; process.env.HELM_TEST_FAST_WD = '1'; });
  afterAll(() => { if (saved === undefined) delete process.env.HELM_TEST_FAST_WD; else process.env.HELM_TEST_FAST_WD = saved; });

  for (const [name, frame] of Object.entries(BOOT_FRAMES)) {
    it(`NOT delivered into "${name}" (ready signal absent → not typed, not submitted)`, async () => {
      const tmux = new StubTmux();
      tmux.frame = frame;
      const ok = await tmux.sendAndSubmit(TARGET, BRIEF, { readySignal: '❯' });
      expect(ok).toBe(false);             // BUG-1 fix: not falsely declared delivered
      expect(tmux.typed).toHaveLength(0); // never typed into a not-ready seat
      expect(tmux.enters).toBe(0);        // never pressed Enter into the void
    });
  }

  it('master-safe: WITHOUT readySignal, a no-❯ generating frame is delivered (master feed relies on this)', async () => {
    // The master runtime feed omits readySignal; its TUI does not surface ❯ at feed time. The original
    // "our text is not held in the composer region ⇒ submitted" behavior MUST be preserved for it.
    const tmux = new StubTmux();
    tmux.frame = '• Working (2s • esc to interrupt)\n  thinking · gpt/grok-4.5\n';
    const ok = await tmux.sendAndSubmit(TARGET, BRIEF); // no opts → original master-safe path
    expect(ok).toBe(true);
    expect(tmux.typed).toContain(BRIEF);
  });
});

describe('F1/F2 sendAndSubmit transition (held → cleared = submitted)', () => {
  let saved: string | undefined;
  beforeAll(() => { saved = process.env.HELM_TEST_FAST_WD; process.env.HELM_TEST_FAST_WD = '1'; });
  afterAll(() => { if (saved === undefined) delete process.env.HELM_TEST_FAST_WD; else process.env.HELM_TEST_FAST_WD = saved; });

  it('happy path: ready seat holds our text → Enter → text leaves composer → delivered (one Enter)', async () => {
    const tmux = new StubTmux();
    tmux.frame = heldFrame(BRIEF);
    tmux.onEnter = () => { tmux.frame = clearedFrame; };
    const ok = await tmux.sendAndSubmit(TARGET, BRIEF, { readySignal: '❯' });
    expect(ok).toBe(true);
    expect(tmux.enters).toBe(1);
  });

  it('codex Enter-drop: first Enter ignored (composer still holds text), second Enter submits', async () => {
    const tmux = new StubTmux();
    tmux.frame = heldFrame(BRIEF);
    tmux.onEnter = () => { if (tmux.enters >= 2) tmux.frame = clearedFrame; };
    const ok = await tmux.sendAndSubmit(TARGET, BRIEF, { readySignal: '❯' });
    expect(ok).toBe(true);
    expect(tmux.enters).toBeGreaterThanOrEqual(2);
  });

  it('F1: a reply that ENDS in "Not now" after our turn cleared is delivered, not stuck retrying', async () => {
    // The old free-form matcher read "Not now" as un-submitted and retried Enter ~55s; the mechanism does not
    // because it only inspects the composer region for OUR text.
    const tmux = new StubTmux();
    tmux.frame = heldFrame(BRIEF);
    tmux.onEnter = () => { tmux.frame = 'Sure, I can do that later.\nNot now\n\n❯ \n'; };
    const ok = await tmux.sendAndSubmit(TARGET, BRIEF, { readySignal: '❯' });
    expect(ok).toBe(true);
    expect(tmux.enters).toBe(1); // exactly one — no spurious retry against the "Not now" reply
  });

  it('long brief held BELOW a bare › marker (head scrolled off) is submitted via the tail chunk', async () => {
    const tmux = new StubTmux();
    const long = BRIEF + ' ' + 'x'.repeat(120) + ' TAIL-MARKER-END-OF-BRIEF';
    tmux.frame = '› \n  ' + long.split(' ').slice(6).join(' ') + '\n';
    tmux.onEnter = () => { tmux.frame = clearedFrame; };
    const ok = await tmux.sendAndSubmit(TARGET, long, { readySignal: '›' });
    expect(ok).toBe(true);
  });

  it('large multi-line paste stays held, gets Enter-only retry, then clears without duplicate paste', async () => {
    const tmux = new StubTmux();
    const multiline = Array.from({ length: 20 }, (_, i) => `line ${i}: ${BRIEF}`).join('\n');
    tmux.frame = '❯ \n  bypass permissions on\n';
    tmux.onType = () => { tmux.frame = '❯ [Pasted Content 20 lines]\n  bypass permissions on\n'; };
    tmux.onEnter = () => { if (tmux.enters >= 2) tmux.frame = clearedFrame; };
    const ok = await tmux.sendAndSubmit(TARGET, multiline, { readySignal: '❯' });
    expect(ok).toBe(true);
    expect(tmux.typed).toEqual([multiline]);
    expect(tmux.enters).toBe(2);
  });

  it('BUG-1: composer disappearing into a boot frame is indeterminate and fails closed without re-paste', async () => {
    const tmux = new StubTmux();
    tmux.frame = '❯ \n  bypass permissions on\n';
    tmux.onType = () => { tmux.frame = heldFrame(BRIEF); };
    tmux.onEnter = () => { tmux.frame = '  Starting session…\n  checking for updates\n'; };
    const ok = await tmux.sendAndSubmit(TARGET, BRIEF, { readySignal: '❯' });
    expect(ok).toBe(false);
    expect(tmux.typed).toEqual([BRIEF]);
    expect(tmux.enters).toBe(1);
  });

  it('message that stays in the composer is detected and receives bounded Enter-only retries', async () => {
    const tmux = new StubTmux();
    tmux.frame = heldFrame(BRIEF);
    const ok = await tmux.sendAndSubmit(TARGET, BRIEF, { readySignal: '❯' });
    expect(ok).toBe(false);
    expect(tmux.typed).toEqual([BRIEF]);
    expect(tmux.enters).toBeGreaterThan(1);
    expect(tmux.enters).toBeLessThanOrEqual(5);
  });
});

// worker-dispatch-feed (2026-07-16): the live cards2 build stalled with `sendDispatchInstruction returned false
// (feed-failed)` on codex/spark worker seats. DispatchService.start had ALREADY confirmed readiness via
// waitForReady(session, '›') (the error was feed-failed, NOT ready-timeout), then sendDispatchInstruction →
// sendAndSubmit false-negated the SUBMIT: codex/spark echo the just-submitted brief back UNDER a ›-prefixed
// transcript line (no bare empty › composer shows while generating), so composerRegionHoldsText read the echo
// as "our text still held" and reported not-delivered even though the seat had accepted the brief and was
// generating. Fix: worker-dispatch accepts a live GENERATION indicator as submit-proof (mirrors the master-feed
// isMasterFeedSubmitted / chat paneIsGenerating), keyed off provider generation markers, not the composer glyph.
describe('worker-dispatch-feed: codex/spark seat submit-proof via generation indicator (no false feed-failed)', () => {
  let saved: string | undefined;
  beforeAll(() => { saved = process.env.HELM_TEST_FAST_WD; process.env.HELM_TEST_FAST_WD = '1'; });
  afterAll(() => { if (saved === undefined) delete process.env.HELM_TEST_FAST_WD; else process.env.HELM_TEST_FAST_WD = saved; });

  // The real dispatch payload shape (DispatchService.start): a Read-the-brief instruction + dispatch marker.
  const PAYLOAD =
    'Read /home/agjrom/websites/cards2/plan/WK_0715/run/dispatch/batch-T02.implementer.brief.md and follow its '
    + 'instructions. (dispatch marker: DISPATCH-batch-T02-implementer-4242-1700000000)';

  // A real codex/spark seat AFTER the brief was accepted+submitted: codex echoes the submitted user turn back
  // under a › transcript line (the LAST ›/❯ line in the pane — there is NO bare empty › composer below it while
  // it generates) and shows a generation indicator. This is the exact pane that produced the live false-negate:
  // composerRegionHoldsText finds `› Read …(dispatch marker: …)` as the composer line → reports "still held".
  const sparkGeneratingEcho = (payload: string) =>
    `  Reading brief…\n› ${payload}\n\n• Working (3s • esc to interrupt)\n  gpt-5.3-codex-spark   1.2k tokens\n`;
  const sparkReady = '› \n  gpt-5.3-codex-spark   send a message\n';

  // P1 (Gate-A SEND-BACK 1): sol's exact FALSE-POSITIVE pane. The brief is STILL HELD un-submitted in the
  // composer (last › line holds our payload); the only generation token ("esc to interrupt") is STALE
  // scrollback from an EARLIER completed turn, ABOVE the composer line. Correct answer = NOT submitted (false).
  // A whole-pane generation regex matched the stale token anywhere → false-positive (a not-submitted brief
  // reported delivered). The footer-scoped submittedByGeneration requires generation BELOW the held composer.
  const staleGenAboveHeld = (payload: string) =>
    `• Working (completed earlier • esc to interrupt)\n  old response done\n\n› ${payload}\n  gpt-5.3-codex-spark   send a message\n`;

  it('READY codex/spark seat: waitForReady(›) passes, THEN sendDispatchInstruction returns true (no false feed-failed)', async () => {
    const tmux = new StubTmux();
    tmux.frame = sparkReady;                         // › present → the dispatcher's waitForReady + the send gate both pass
    expect(await tmux.waitForReady(TARGET, '›', 1000)).toBe(true); // exact live sequence: readiness confirmed first
    tmux.onEnter = () => { tmux.frame = sparkGeneratingEcho(PAYLOAD); }; // accepted → generating, echoes brief under ›
    const ok = await tmux.sendDispatchInstruction(TARGET, PAYLOAD, '›');
    expect(ok).toBe(true);                           // FAILS pre-fix (composer-echo → false feed-failed); PASSES post-fix
    expect(tmux.typed).toContain(PAYLOAD);           // the brief WAS typed into the ready seat
  });

  it('grok worker seat: ready ❯ passes, generating with echoed › brief after submit → true', async () => {
    const tmux = new StubTmux();
    tmux.frame = heldFrame(PAYLOAD);                 // ❯ ready + our text held
    tmux.onEnter = () => { tmux.frame = `  ┌ Grok Build ┐\n› ${PAYLOAD}\n• Thinking… (esc to interrupt)\n`; };
    const ok = await tmux.sendDispatchInstruction(TARGET, PAYLOAD, '❯');
    expect(ok).toBe(true);                           // same echoed-composer false-negate class, now accepted via generation
  });

  it('claude worker seat: ready ❯ passes, composer clears after submit → true (path stays healthy)', async () => {
    const tmux = new StubTmux();
    tmux.frame = heldFrame(PAYLOAD);
    tmux.onEnter = () => { tmux.frame = clearedFrame; }; // '• Working (2s • esc to interrupt)\n\n❯ \n' (bare ❯ + generating)
    const ok = await tmux.sendDispatchInstruction(TARGET, PAYLOAD, '❯');
    expect(ok).toBe(true);
  });

  it('DEAD seat: ready glyph present but the brief NEVER submits and it never generates → still returns false', async () => {
    const tmux = new StubTmux();
    tmux.frame = sparkReady;                          // gate passes (› present)…
    // …but the brief just sits held in the composer forever, no generation indicator EVER — a genuine feed failure.
    tmux.onEnter = () => { tmux.frame = `› ${PAYLOAD}\n  gpt-5.3-codex-spark   send a message\n`; };
    const ok = await tmux.sendDispatchInstruction(TARGET, PAYLOAD, '›');
    expect(ok).toBe(false);                           // real failure is NOT masked as delivered
  });

  it('BUG-1 chat path: ready → held → this-turn generation verifies as submitted', async () => {
    const tmux = new StubTmux();
    tmux.frame = sparkReady;
    tmux.onEnter = () => { tmux.frame = sparkGeneratingEcho(PAYLOAD); };
    // Footer-scoped generation below the payload-bearing › line proves this exact turn submitted.
    const ok = await tmux.sendAndSubmit(TARGET, PAYLOAD, { readySignal: '›' });
    expect(ok).toBe(true);
    expect(tmux.typed).toContain(PAYLOAD);
  });

  // ---- P1 (Gate-A SEND-BACK 1): footer-scope the generation submit-proof; stale scrollback must NOT count ----

  it('P1 unit: submittedByGeneration is FALSE for stale-gen-ABOVE-held (whole-pane check WOULD have false-positived); TRUE for this-turn generation', () => {
    const tmux = new StubTmux();
    const solPane = staleGenAboveHeld(PAYLOAD);
    // Documents the bug: the OLD whole-pane regex matched the stale token anywhere in the pane → false-positive.
    expect(/esc to interrupt/i.test(solPane)).toBe(true);          // stale token IS present somewhere (whole-pane → true)
    // The corrected footer-scoped method requires the marker BELOW the held composer line → correctly FALSE.
    expect(tmux.submittedByGeneration(solPane)).toBe(false);        // P1 fixed: stale scrollback above the held brief is not submit-proof
    // Genuine THIS-TURN generation (below the echoed composer line) still counts as submit-proof.
    expect(tmux.submittedByGeneration(sparkGeneratingEcho(PAYLOAD))).toBe(true);
  });

  it('P1 flow: STATIC stale-gen-above-held pane → sendDispatchInstruction returns FALSE (single clean send, no re-paste, bounded Enter)', async () => {
    const tmux = new StubTmux();
    tmux.frame = staleGenAboveHeld(PAYLOAD);          // › present → gate passes; brief NEVER clears; only STALE gen above it
    const ok = await tmux.sendDispatchInstruction(TARGET, PAYLOAD, '›');
    expect(ok).toBe(false);                           // INVARIANT: a not-submitted brief is NEVER reported delivered
    expect(tmux.typed).toHaveLength(1);               // exactly one clean send — never a second paste stacked
    expect(tmux.enters).toBeGreaterThan(0);           // Enter WAS re-pressed (submit attempts)…
    expect(tmux.enters).toBeLessThanOrEqual(6);       // …but BOUNDED by the backoff (fast mode: initial + 4 loop presses)
  });
});
