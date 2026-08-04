import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

import * as AdaptivePlanningModule from './adaptive-planning-phase.js';
import { PlanningPhaseService } from './planning-phase-service.js';

vi.mock('./adaptive-planning-phase.js', () => ({
  runAdaptivePlanningPhase: vi.fn(async () => ({ runId: 'adaptive-run' })),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('runPlanningPhase adaptive scope pin', () => {
  it('returns into adaptive planning before non-adaptive branch when adaptivePlanning is truthy', async () => {
    const runAdaptivePlanningPhase = vi.mocked(AdaptivePlanningModule.runAdaptivePlanningPhase);
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);

    const svc = new PlanningPhaseService({} as any, {} as any, {} as any);
    const result = await svc.runPlanningPhase({
      runDir: '/tmp/p4-scope-pin',
      northStar: 'Adaptive-scope-pin test',
      adaptivePlanning: true,
    } as any);

    expect(result).toEqual({ runId: 'adaptive-run' });
    expect(runAdaptivePlanningPhase).toHaveBeenCalledTimes(1);
    expect(runAdaptivePlanningPhase).toHaveBeenCalledWith(
      { transport: (svc as any).transport, artifacts: (svc as any).artifacts, taskQueue: (svc as any).queue },
      expect.objectContaining({ runDir: '/tmp/p4-scope-pin', northStar: 'Adaptive-scope-pin test', adaptivePlanning: true })
    );
    expect(mkdirSpy).not.toHaveBeenCalled();
  });

  it('documents the R7 scope pin in planning-phase-service.ts', async () => {
    const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'planning-phase-service.ts');
    const source = await fs.readFile(sourcePath, 'utf8');
    expect(source).toContain(
      'R7 explicit scope pin: keep adaptive path fully delegated and defer adaptive co-author contract reconciliation.'
    );
  });
});
