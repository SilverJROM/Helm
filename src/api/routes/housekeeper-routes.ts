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

  // S18a: manual one-shot investigation dispatch. No scheduler/cooldown/apply path in this slice.
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
}
