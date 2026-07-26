import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';

const readSource = (relativePath: string) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('B00.s2 R2/R3 red anchors (failing by intent)', () => {
  it.fails('B00.s2a: a deferred pre-live row cannot complete the run', async () => {
    // §2 evidence: run-orchestrator-service.ts:620-633 records deferred rows, but 712-715
    // still derives completion solely from failed rows. Flip: B05.s4.
    const source = await readSource('./services/run-orchestrator-service.ts');
    const terminal = source.slice(
      source.indexOf('// Terminal: preserve failed/deferred signals'),
      source.indexOf('// D-a3: do NOT reap on completion'),
    );

    const terminalStatus = terminal.match(/const finalRunStatus\s*=\s*([^;]+);/)?.[1] ?? '';
    const ignoresDeferredAtTerminal =
      terminalStatus === "hadFailed ? 'failed' : 'complete'" && !terminalStatus.includes('hadDeferred');

    // Pin the present failure mode, not B05.s4's future implementation shape. B05.s4 must
    // update this anchor if its guarded terminal transaction relocates the terminal seam.
    expect(ignoresDeferredAtTerminal).toBe(false);
  });

  it('B00.s2b: a deadline breach survives as a typed event through reap/finalization', async () => {
    const source = await readSource('./services/orchestrator-loop.ts');
    const waitLoop = source.slice(
      source.indexOf("const recordResult = (outcome: 'callback' | 'reap'"),
      source.indexOf('// small helpers for FIX-B'),
    );
    const timeoutHandler = source.slice(
      source.indexOf("const waitCause = e instanceof CallbackWaitError"),
      source.indexOf("if (role === 'implementer') this.log('done');"),
    );

    const persistsTypedBreach =
      /recordRunEvent\(this\.runId, 'CALLBACK_WAIT_RESULT'/.test(waitLoop) &&
      /recordResult\('reap', cause\)/.test(waitLoop) &&
      /throw new CallbackWaitError\(cause, role, detail\)/.test(waitLoop);
    const reapsByTypedCause =
      /const waitCause = e instanceof CallbackWaitError \? e\.waitCause : 'wait-failed';/.test(timeoutHandler) &&
      /this\.transport\.reap\(handle, `\$\{role\}-\$\{waitCause\}-reaped`\)/.test(timeoutHandler) &&
      /this\.finalizeWorkerRuntime\(workerRuntimeId, 'failed', `\$\{role\}-\$\{waitCause\}`\)/.test(timeoutHandler);

    expect(persistsTypedBreach).toBe(true);
    expect(reapsByTypedCause).toBe(true);
  });
});
