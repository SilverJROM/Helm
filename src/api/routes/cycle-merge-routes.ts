/**
 * cycle-branch-lifecycle B18 — R6 UI owner-gated merge HTTP surface.
 *
 *   POST /api/cycles/:id/merge              — explicit "tested — merge it" (B16 mergeCycleBranch).
 *   GET  /api/cycles/:id/merge-conflict-report — B17 persisted conflict report for the panel.
 *
 * No autonomous caller: only the UI confirm button hits POST. Eligibility (awaiting_merge /
 * cleanup_pending, no active run/workers, clean base, …) is enforced inside mergeCycleBranch.
 */
import type { FastifyInstance } from 'fastify';
import type { CycleService } from '../../services/cycle-service.js';
import { MergeConflictError } from '../../services/git-worktree-service.js';

export interface CycleMergeRouteDeps {
  cycleService: CycleService;
  authMiddleware: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireOwnerPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
}

export function registerCycleMergeRoutes(app: FastifyInstance, deps: CycleMergeRouteDeps): void {
  const { cycleService, authMiddleware, requireOwnerPre } = deps;

  // B18 / R6.3: conflict report panel — read-only surface of the B17 JSON next to cycle docs.
  app.get(
    '/api/cycles/:id/merge-conflict-report',
    { preHandler: [authMiddleware, requireOwnerPre] },
    async (request: any, reply: any) => {
      const cycleId = Number(request.params.id);
      try {
        const report = await cycleService.getMergeConflictReport(cycleId);
        if (!report) return reply.code(404).send({ error: 'no merge conflict report for this cycle' });
        return { report };
      } catch (e: any) {
        if (e?.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        return reply.code(400).send({ error: e?.message || 'merge conflict report failed' });
      }
    }
  );

  // B18 / R6.2: owner-only explicit merge action. CAS + revalidation live in mergeCycleBranch.
  app.post(
    '/api/cycles/:id/merge',
    { preHandler: [authMiddleware, requireOwnerPre] },
    async (request: any, reply: any) => {
      const cycleId = Number(request.params.id);
      try {
        const result = await cycleService.mergeCycleBranch(cycleId);
        return { result };
      } catch (e: any) {
        if (e instanceof MergeConflictError || e?.code === 'MERGE_CONFLICT' || e?.name === 'MergeConflictError') {
          let report: Record<string, unknown> | null = null;
          try {
            report = await cycleService.getMergeConflictReport(cycleId);
          } catch {
            /* report is best-effort on the conflict response */
          }
          return reply.code(409).send({
            error: e.message || 'merge conflict',
            code: 'MERGE_CONFLICT',
            conflictedPaths: e.conflictedPaths || [],
            report
          });
        }
        if (e?.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        if (e?.code === 'CONFLICT') return reply.code(409).send({ error: e.message, code: 'CONFLICT' });
        return reply.code(400).send({ error: e?.message || 'merge failed' });
      }
    }
  );
}
