/**
 * S09 — Discovery ready-callback HTTP boundary.
 * Credential-authenticated only (not owner browser token). Never starts Planning.
 */
import type { FastifyInstance } from 'fastify';
import type { DatabaseService } from '../../db/database.js';
import type { AgentAssignmentService } from '../../services/agent-assignment-service.js';
import type { CycleService } from '../../services/cycle-service.js';
import type { PlannerPanelService } from '../../services/planner-panel-service.js';
import { DiscoveryHandoffService } from '../../services/discovery-handoff-service.js';
import {
  processDiscoveryReadyCallback,
  type DiscoveryReadyBody,
} from '../../services/discovery-handoff-ingress.js';

export interface DiscoveryHandoffRouteDeps {
  db: DatabaseService;
  assignmentService: AgentAssignmentService;
  cycleService: CycleService;
  plannerPanelService?: PlannerPanelService;
  handoffs?: DiscoveryHandoffService;
}

export function registerDiscoveryHandoffRoutes(
  app: FastifyInstance,
  deps: DiscoveryHandoffRouteDeps
): void {
  const handoffs = deps.handoffs ?? new DiscoveryHandoffService(deps.db);

  // Callback credential path — deliberately NOT behind owner browser auth.
  // Owner confirm / start-planning remain separate (S11) with owner+loopback guards.
  app.post('/api/discovery/handoff/ready', async (request: any, reply: any) => {
    const body = (request.body || {}) as DiscoveryReadyBody;
    const result = await processDiscoveryReadyCallback(body, {
      db: deps.db,
      handoffs,
      assignments: deps.assignmentService,
      cycleService: deps.cycleService,
      plannerPanel: deps.plannerPanelService,
    });

    if (result.ok) {
      return reply.code(200).send({
        ok: true,
        state: result.state,
        handoffId: result.handoffId,
        digest: result.digest,
        runCreated: false,
      });
    }

    const status =
      result.state === 'quarantined' ? 403 : result.state === 'rejected' ? 400 : 403;
    return reply.code(status).send({
      ok: false,
      state: result.state,
      handoffId: result.handoffId,
      reason: result.reason,
      runCreated: false,
    });
  });
}
