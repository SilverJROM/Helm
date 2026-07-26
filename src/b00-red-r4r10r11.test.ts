import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';

const readSource = (relativePath: string) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('B00.s3 R4/R10/R11 red anchors (failing by intent)', () => {
  it.fails('B00.s3a: dispatch resolution cannot obey live topology drift', async () => {
    // §2 evidence: run-orchestrator-service.ts:191,219,224,253,258 resolves each seat from
    // the mutable assignment service during run start. Flip: B06.s1 (the plan-map owner for
    // frozen dispatch authority must replace this cited live seam).
    const source = await readSource('./services/run-orchestrator-service.ts');
    const resolution = source.slice(
      source.indexOf('// A2b: use resolver'),
      source.indexOf('// B15x-fix1 / I7 (early resolve-time guard)'),
    );
    const dispatchReadsLiveAssignments = (resolution.match(/assignmentService\.resolveProjectRole\(/g) ?? []).length >= 1;

    expect(dispatchReadsLiveAssignments).toBe(false);
  });

  it.fails('B00.s3b: blocker notification cannot page without an owner-gated outbox', async () => {
    // §2 evidence: orchestrator-loop.ts:1286-1293 handles escalate-to-JROM by recording a
    // validation and terminally deferring the run, without paging. Flip: B11.s1.
    const source = await readSource('./services/orchestrator-loop.ts');
    const branchStart = source.indexOf("} else if (decision.action === 'escalate-to-JROM')");
    const jromBranch = source.slice(branchStart, source.indexOf('// re-brief or other:', branchStart));
    const escalatesToJromAsDeferred = /decision\.action\s*===\s*'escalate-to-JROM'[\s\S]*recordValidation\([\s\S]*persistFinal\('DEFERRED'\)[\s\S]*return\s*\{\s*finalStatus:\s*'DEFERRED'/.test(jromBranch);

    expect(escalatesToJromAsDeferred).toBe(false);
  });

  it.fails('B00.s3c: NO_MATERIAL cannot be conflated without a contradiction oracle', async () => {
    // §2 evidence: run-orchestrator-service.ts:712-715 derives terminal completion solely
    // from failed rows, so no contradiction result can block it. B04.s7 owns the oracle;
    // B05.s2 is the terminal-integration seam that must consume it.
    const source = await readSource('./services/run-orchestrator-service.ts');
    const terminal = source.slice(
      source.indexOf('// Terminal: preserve failed/deferred signals'),
      source.indexOf('// D-a3: do NOT reap on completion'),
    );
    const terminalStatus = terminal.match(/const finalRunStatus\s*=\s*([^;]+);/)?.[1] ?? '';
    const completionIgnoresContradiction = terminalStatus === "hadFailed ? 'failed' : 'complete'";

    expect(completionIgnoresContradiction).toBe(false);
  });
});
