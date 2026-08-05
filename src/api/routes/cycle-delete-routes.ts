/**
 * cycle-branch-lifecycle B13 — R2.1 / R2.4 / R3.2 Delete API.
 *
 *   DELETE /api/cycles/:id              — status IN ('completed','archived') only; 409 otherwise.
 *                                         Composes B12's deleteCycle (worktree+branch+docs; DB history stays).
 *   GET    /api/cycles/:id/delete-preflight — returns the single B5 branchSafetyReport (facts + optional
 *                                         narrative, never a decision). R3.2 call site (a).
 *
 * Extracted as a route module so focused API tests drive the same handlers production runs.
 */
import type { FastifyInstance } from 'fastify';
import type { DatabaseService } from '../../db/database.js';
import type { CycleService } from '../../services/cycle-service.js';
import { branchSafetyReport } from '../../services/branch-safety-report-service.js';

const DELETABLE_STATUSES = new Set(['completed', 'archived']);

export interface CycleDeleteRouteDeps {
  db: DatabaseService;
  cycleService: CycleService;
  authMiddleware: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireOwnerPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
}

/**
 * R2.1: Delete is a terminal-state action only. B12's deleteCycle primitive intentionally has no
 * status gate (confirm/autonomy gating is a caller concern); this is that caller gate.
 */
function assertDeletableStatus(db: DatabaseService, cycleId: number): void {
  const row = db.prepare('SELECT id, status FROM cycles WHERE id = ?').get(cycleId) as
    | { id: number; status: string }
    | undefined;
  if (!row) {
    const err: any = new Error('unknown cycle');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const status = String(row.status);
  if (!DELETABLE_STATUSES.has(status)) {
    const err: any = new Error(
      `cannot delete: cycle ${cycleId} status is '${status}' (only completed or archived cycles may be deleted)`
    );
    err.code = 'CONFLICT';
    throw err;
  }
}

export function registerCycleDeleteRoutes(app: FastifyInstance, deps: CycleDeleteRouteDeps): void {
  const { db, cycleService, authMiddleware, requireOwnerPre } = deps;

  // R2.4 / R3.2(a): preflight always returns the B5 safety report so the confirm step can show it.
  // Read-only; never mutates. 404 on unknown cycle (B5 throws NOT_FOUND).
  app.get(
    '/api/cycles/:id/delete-preflight',
    { preHandler: [authMiddleware, requireOwnerPre] },
    async (request: any, reply: any) => {
      const cycleId = Number(request.params.id);
      try {
        const report = await branchSafetyReport(cycleId, db);
        return { report };
      } catch (e: any) {
        if (e?.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        return reply.code(400).send({ error: e?.message || 'delete preflight failed' });
      }
    }
  );

  // R2.1: DELETE restricted to completed/archived. 409 + no mutation otherwise.
  app.delete(
    '/api/cycles/:id',
    { preHandler: [authMiddleware, requireOwnerPre] },
    async (request: any, reply: any) => {
      const cycleId = Number(request.params.id);
      try {
        assertDeletableStatus(db, cycleId);
        const cycle = await cycleService.deleteCycle(cycleId);
        return { cycle };
      } catch (e: any) {
        if (e?.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        if (e?.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
        if (e?.code === 'FORBIDDEN') return reply.code(403).send({ error: e.message });
        return reply.code(400).send({ error: e?.message || 'delete failed' });
      }
    }
  );
}
