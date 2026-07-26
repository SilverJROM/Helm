// #47: an unauthenticated seat must ABORT the run, not feed the free-retry/escalation ladder.
//
// Anchor incident (2026-07-20): the grok OAuth token expired mid-session. Seats launched fine (binary
// present, composer ready), then refused the submitted brief with "Authentication required — your
// session has expired". No callback ever arrived, so each seat was reaped at the no-first-callback
// budget and a fresh one spawned. One task burned 6 attempts in ~6 minutes with nothing in the engine
// log, and would have churned to the 80-attempt cap before failing with a misleading reason.
process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OrchestratorLoop, SeatAuthTerminalError, CallbackWaitError } from './orchestrator-loop.js';

const BRIEF = 'Read brief.md and follow its instructions. (dispatch marker: DISPATCH-test-implementer-1)';
const AUTH_PANE = [
  `  ❯ ${BRIEF}`,
  '  ┃  Authentication required — your session has expired or your credentials were rejected. Run /login to re-',
  '  ┃  authenticate, then resend your message.',
  '  Grok 4.5 (medium) · always-approve',
].join('\n');

describe('#47 — unauthenticated seat is terminal, not retryable', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-seatauth-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# seat-auth\n', 'utf8');
  });
  afterEach(async () => {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('an auth-failure pane throws SeatAuthTerminalError naming provider + remedy', async () => {
    let inspectCount = 0;
    const transport: any = {
      spawn: async () => ({ handle: 'h', role: 'implementer' }),
      reap: async () => {},
      inspectSeat: async () => {
        inspectCount += 1;
        return { sessionAlive: true, pane: AUTH_PANE, composerHoldsBrief: false };
      },
    };
    const loop = new OrchestratorLoop(transport, { runDir, batchId: 'batch-AUTH' });

    const err = await (loop as any)
      .waitForCallback('implementer', ['DONE'], { handle: 'h', brief: BRIEF, provider: 'grok' })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(SeatAuthTerminalError);
    // NOT a retryable wait cause — that distinction is the entire point of the fix.
    expect(err).not.toBeInstanceOf(CallbackWaitError);
    expect((err as Error).message).toMatch(/grok login/);
    expect((err as SeatAuthTerminalError).provider).toBe('grok');
    // Detected on the FIRST pane read, not after burning the no-first-callback budget.
    expect(inspectCount).toBeLessThanOrEqual(2);
  });

  it('does NOT fire on a healthy working pane (no false abort)', async () => {
    const healthyPane = [
      `  ❯ ${BRIEF}`,
      '  ◆ Run pusoy-card tests and typecheck',
      '  ✓ tests/pusoy-card.test.ts (18 tests)',
    ].join('\n');
    const transport: any = {
      spawn: async () => ({ handle: 'h', role: 'implementer' }),
      reap: async () => {},
      inspectSeat: async () => ({ sessionAlive: true, pane: healthyPane, composerHoldsBrief: false }),
    };
    const loop = new OrchestratorLoop(transport, { runDir, batchId: 'batch-AUTH' });

    const err = await (loop as any)
      .waitForCallback('implementer', ['DONE'], {
        handle: 'h',
        brief: BRIEF,
        provider: 'grok',
        wallMs: 1200,
        firstCallbackMs: 600,
      })
      .then(() => null, (e: unknown) => e);

    // It should time out on the ordinary retryable path, NEVER as an auth abort.
    expect(err).not.toBeInstanceOf(SeatAuthTerminalError);
  });

  it('ignores a PRE-dispatch auth error left in reused-session scrollback', async () => {
    // The auth error precedes this launch's brief marker → already resolved, must not abort.
    const staleThenHealthy = [
      'Authentication required — your session has expired or your credentials were rejected. Run /login',
      `  ❯ ${BRIEF}`,
      '  ◆ Working on the task',
    ].join('\n');
    const transport: any = {
      spawn: async () => ({ handle: 'h', role: 'implementer' }),
      reap: async () => {},
      inspectSeat: async () => ({ sessionAlive: true, pane: staleThenHealthy, composerHoldsBrief: false }),
    };
    const loop = new OrchestratorLoop(transport, { runDir, batchId: 'batch-AUTH' });

    const err = await (loop as any)
      .waitForCallback('implementer', ['DONE'], {
        handle: 'h',
        brief: BRIEF,
        provider: 'grok',
        wallMs: 1200,
        firstCallbackMs: 600,
      })
      .then(() => null, (e: unknown) => e);

    expect(err).not.toBeInstanceOf(SeatAuthTerminalError);
  });
});
