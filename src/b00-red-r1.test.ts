import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';

const readSource = (relativePath: string) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('B00.s1 R1 red anchors (failing by intent)', () => {
  it.fails('B00.s1a: validator exception cannot be forced to PASS', async () => {
    // §2 evidence: validator exception → forced PASS (orchestrator-loop.ts:1147-1157,1200-1203).
    // Flip: B04.s2.
    const source = await readSource('./services/orchestrator-loop.ts');
    expect(source).not.toContain("this.log('post-gate-val-reviewer-error')");
    expect(source).not.toContain("valRes.state = 'PASS';");
  });

  it.fails('B00.s1b: inconclusive red-team cannot resolve CLEAN', async () => {
    // §2 evidence: inconclusive red-team → advisory CLEAN (panel-service.ts:153-164).
    // Flips: B04.s3 partial (HELM_RECOVERY) and B10.s3 full (brain-edge).
    const source = await readSource('./services/panel-service.ts');
    expect(source).not.toContain("state: 'CLEAN',\n      note: clean ?");
    expect(source).toContain("state: 'HELM_RECOVERY'");
    expect(source).toMatch(/brain[- ]edge/i);
  });

  it.fails('B00.s1c: an empty req-matrix cannot advance Q0', async () => {
    // §2 evidence: empty req-matrix advances (Q0).
    // Flip: B04.s6.
    const source = await readSource('./services/orchestrator-loop.ts');
    const dispatchLoop = source.slice(
      source.indexOf('while (true) {', source.indexOf('async runQueuedTasks')),
      source.indexOf('res = await this.runTask({', source.indexOf('async runQueuedTasks')),
    );
    // The ready task is currently dispatched straight to runTask: no Q0 matrix-enumeration gate exists.
    expect(dispatchLoop).toMatch(
      /(?:assert|ensure|require)[A-Za-z]*(?:Req(?:uirement)?Matrix|Matrix)(?:Enumerated|Enumeration|NonEmpty|Gate)[A-Za-z]*\s*\(/,
    );
  });
});
