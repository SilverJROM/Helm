/**
 * cycle-branch-lifecycle B20 — R7.1 cycle-start branch onboarding HTTP boundary.
 *
 * Cycle start itself (`POST /api/projects/:id/cycles`) triggers the survey through
 * `startCycleWithBranchOnboarding`; these two routes are the rest of the same sequence:
 *   GET  /api/cycles/:id/branch-survey  — the B4/B5 facts discovery presents (R7.2 reads it here)
 *   POST /api/cycles/:id/branch-base    — JROM's live choice, and ONLY THEN B6 runs (R4.2)
 * Extracted as a route module (session-close-routes pattern) so the API tests drive exactly the
 * handlers the server runs.
 */
import type { FastifyInstance } from 'fastify';
import type { DatabaseService } from '../../db/database.js';
import {
  recordCycleBaseChoice,
  surveyCycleBranches,
} from '../../services/cycle-branch-onboarding-service.js';

export interface CycleBranchOnboardingRouteDeps {
  db: DatabaseService;
  authMiddleware: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireOwnerPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireLocalLaunchPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
}

export function registerCycleBranchOnboardingRoutes(
  app: FastifyInstance,
  deps: CycleBranchOnboardingRouteDeps
): void {
  const { db, authMiddleware, requireOwnerPre, requireLocalLaunchPre } = deps;

  // R7.1/R7.2: the survey discovery presents. Read-only and never 500s on a bad repo — a failed
  // survey comes back `degraded: true` so the interview is never blocked behind repo hygiene.
  app.get(
    '/api/cycles/:id/branch-survey',
    { preHandler: [authMiddleware, requireOwnerPre] },
    async (request: any) => {
      const survey = await surveyCycleBranches(Number(request.params.id), db);
      return { survey };
    }
  );

  // R7.1/R4.2: records JROM's live base choice and only then creates the branch + worktree (B6).
  // Owner + local-launch gated: it mutates git state. Omitted/blank base = he took the default main.
  app.post(
    '/api/cycles/:id/branch-base',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (request: any, reply: any) => {
      const cycleId = Number(request.params.id);
      const body = request.body || {};
      try {
        const result = await recordCycleBaseChoice({ cycleId, db, chosenBase: body.base });
        return { cycle: result.cycle, git_identity: result.identity, base: result.base };
      } catch (e: any) {
        if (e?.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        if (e?.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
        return reply.code(400).send({ error: e?.message || 'branch base choice failed' });
      }
    }
  );
}
