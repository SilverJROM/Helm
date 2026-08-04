// S14a — GET /api/sessions (+owner/status) and POST /api/sessions/:name/close (human-only).
// Extracted for app.inject() API tests (V3). HARD SAFETY: fake tmux only in tests.

import type { FastifyInstance } from 'fastify';
import type { SessionRegistryService } from '../../services/session-registry-service.js';
import type { SessionCloseService } from '../../services/session-close-service.js';
import {
  projectSessionListRow,
  sessionCloseHttpStatus,
} from '../../services/session-close-service.js';

export interface SessionCloseRouteDeps {
  sessionRegistry: SessionRegistryService;
  sessionCloseService: SessionCloseService;
  authMiddleware: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireOwnerPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireLocalLaunchPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
}

export function registerSessionCloseRoutes(app: FastifyInstance, deps: SessionCloseRouteDeps): void {
  const {
    sessionRegistry,
    sessionCloseService,
    authMiddleware,
    requireOwnerPre,
    requireLocalLaunchPre,
  } = deps;

  // SL-R1 / S14a: guarded read of the session-lifecycle registry (owner + status for manual close UI).
  app.get('/api/sessions', { preHandler: [authMiddleware, requireOwnerPre] }, async () => {
    const sessions = sessionRegistry.list().map((s) => projectSessionListRow(s));
    return { sessions };
  });

  // S14a: targeted human-only manual close. owner='human' only.
  // Pre-terminate recheck after @helm_child + atomic claim. Fake tmux in tests only.
  app.post(
    '/api/sessions/:name/close',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (request: any, reply: any) => {
      const name = String(request.params?.name ?? '');
      try {
        const result = await sessionCloseService.closeHumanSession(name);
        if (!result.ok) {
          return reply.code(sessionCloseHttpStatus(result.reason)).send({
            error: result.error,
            reason: result.reason,
          });
        }
        return { ok: true, closed: result.closed, already_reaped: !!result.alreadyReaped };
      } catch (e: any) {
        return reply.code(500).send({ error: e?.message || 'close failed' });
      }
    }
  );
}
