import type { FastifyInstance } from 'fastify';
import type { HousekeeperService } from '../../services/housekeeper-service.js';

export interface HousekeeperRouteDeps {
  housekeeperService: HousekeeperService;
  authMiddleware: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireOwnerPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireLocalLaunchPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
}

export function registerHousekeeperRoutes(app: FastifyInstance, deps: HousekeeperRouteDeps): void {
  const { housekeeperService, authMiddleware, requireOwnerPre, requireLocalLaunchPre } = deps;

  // S18a/S18b: manual one-shot investigation dispatch/apply.
  app.post(
    '/api/housekeeper/dispatch',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (_request: any, reply: any) => {
      try {
        return await housekeeperService.dispatchOnce();
      } catch (e: any) {
        return reply.code(500).send({ error: e?.message || 'housekeeper dispatch failed' });
      }
    }
  );

  app.post(
    '/api/housekeeper/investigations/:id/apply',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (request: any, reply: any) => {
      try {
        const id = Number(request.params.id);
        if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid investigation id' });
        const body = request.body ?? {};
        const result = housekeeperService.applyCallback(id, {
          verdict: body.verdict,
          evidence: body.evidence ?? '',
          rationale: body.rationale ?? '',
        });
        if (!result.ok && result.outcome === 'invalid_verdict') return reply.code(400).send(result);
        if (!result.ok && result.outcome === 'not_found') return reply.code(404).send(result);
        if (!result.ok && result.outcome === 'owner_recheck_failed') return reply.code(409).send(result);
        return result;
      } catch (e: any) {
        return reply.code(500).send({ error: e?.message || 'housekeeper apply failed' });
      }
    }
  );
}
