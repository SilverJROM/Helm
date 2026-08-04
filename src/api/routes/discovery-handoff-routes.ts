/**
 * S09 — Discovery ready-callback HTTP boundary (credential-auth; never starts Planning).
 * S11 — Owner confirm/decline (owner + loopback; CAS + S10 once; 202 after durable run).
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseService } from '../../db/database.js';
import type { AgentAssignmentService } from '../../services/agent-assignment-service.js';
import type { CycleService } from '../../services/cycle-service.js';
import type { PlannerPanelService } from '../../services/planner-panel-service.js';
import type { RunArtifactService } from '../../services/run-artifact-service.js';
import type { RunOrchestratorService } from '../../services/run-orchestrator-service.js';
import { DiscoveryHandoffService } from '../../services/discovery-handoff-service.js';
import {
  processDiscoveryReadyCallback,
  type DiscoveryReadyBody,
} from '../../services/discovery-handoff-ingress.js';
import {
  confirmDiscoveryHandoff,
  declineDiscoveryHandoff,
  ownerBridgeHttpStatus,
} from '../../services/discovery-handoff-owner-bridge.js';
import { buildCycleSeatReadiness } from '../../services/cycle-seat-preview.js';
import { DISCOVERY_READY_ASK } from '../../services/discovery-contract.js';

export interface DiscoveryHandoffRouteDeps {
  db: DatabaseService;
  assignmentService: AgentAssignmentService;
  cycleService: CycleService;
  plannerPanelService?: PlannerPanelService;
  handoffs?: DiscoveryHandoffService;
  /** S11: required for owner confirm/decline routes. */
  artifacts?: RunArtifactService;
  orchestrator?: Pick<RunOrchestratorService, 'startPlanningFromConfirmedHandoff'>;
  authMiddleware?: preHandlerHookHandler | ((...args: any[]) => any);
  requireOwnerPre?: preHandlerHookHandler | ((...args: any[]) => any);
  requireLocalLaunchPre?: preHandlerHookHandler | ((...args: any[]) => any);
  /** Test seam: await S10 inline when false. Default true (202 before model). */
  detachS10?: boolean;
}

export function registerDiscoveryHandoffRoutes(
  app: FastifyInstance,
  deps: DiscoveryHandoffRouteDeps
): void {
  const handoffs = deps.handoffs ?? new DiscoveryHandoffService(deps.db);

  // Callback credential path — deliberately NOT behind owner browser auth.
  // Owner confirm / start-planning remain separate with owner+loopback guards.
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

  // Capture locals so TS narrows optional deps (deps.artifacts stays optional on the bag).
  const authMiddleware = deps.authMiddleware;
  const requireOwnerPre = deps.requireOwnerPre;
  const requireLocalLaunchPre = deps.requireLocalLaunchPre;
  const artifacts = deps.artifacts;
  const orchestrator = deps.orchestrator;

  // S12: owner-read handoff + seat preview for Discovery confirmation UI (no credentials, no write).
  if (authMiddleware && requireOwnerPre) {
    app.get(
      '/api/cycles/:id/discovery-handoff',
      { preHandler: [authMiddleware, requireOwnerPre] as any },
      async (request: any, reply: any) => {
        const cycleId = Number(request.params.id);
        if (!Number.isInteger(cycleId) || cycleId <= 0) {
          return reply.code(400).send({ error: 'invalid cycle id' });
        }
        const cycle: any = deps.db
          .prepare('SELECT id, project_id, phase, status FROM cycles WHERE id = ?')
          .get(cycleId);
        if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
        const projectId = Number(cycle.project_id);

        // Prefer live pending|starting; else latest row for cycle (declined/started/failed).
        let handoff = handoffs.getLive(cycleId);
        if (!handoff) {
          const rows = handoffs.listByCycle(cycleId);
          handoff = rows.length ? rows[rows.length - 1] : null;
        }

        let readiness: ReturnType<typeof buildCycleSeatReadiness> | null = null;
        try {
          readiness = buildCycleSeatReadiness({
            db: deps.db,
            assignments: deps.assignmentService,
            plannerPanel: deps.plannerPanelService,
            cycleId,
            projectId,
            runtimeSeats: [],
          });
        } catch (e: any) {
          readiness = null;
        }

        const handoffDto = handoff
          ? {
              id: handoff.id,
              state: handoff.state,
              digest: handoff.manifest_digest,
              planningRunId: handoff.planning_run_id,
              reason: handoff.reason,
              callbackRole: handoff.callback_role,
              callbackStatus: handoff.callback_status,
            }
          : null;

        // Client-friendly uiState for card rendering (S12).
        let uiState:
          | 'empty'
          | 'pending'
          | 'starting'
          | 'started'
          | 'declined'
          | 'blocked'
          | 'failed' = 'empty';
        if (handoffDto) {
          if (handoffDto.state === 'pending') {
            uiState =
              readiness && readiness.blocked ? 'blocked' : 'pending';
          } else if (handoffDto.state === 'starting') {
            uiState = 'starting';
          } else if (handoffDto.state === 'started') {
            uiState = 'started';
          } else if (handoffDto.state === 'declined') {
            uiState = 'declined';
          } else if (
            handoffDto.state === 'failed' ||
            handoffDto.state === 'quarantined'
          ) {
            uiState = 'failed';
          }
        }

        return reply.code(200).send({
          cycleId,
          projectId,
          phase: cycle.phase,
          ask: DISCOVERY_READY_ASK,
          handoff: handoffDto,
          digest: readiness?.digest ?? handoffDto?.digest ?? null,
          blocked: readiness?.blocked ?? false,
          blockReasons: readiness?.blockReasons ?? [],
          emptyPanelMessage: readiness?.emptyPanelMessage ?? null,
          preview: readiness?.preview ?? { plancore: null, coPlanners: [] },
          uiState,
        });
      }
    );
  }

  // S11 owner confirm / decline — only when auth + bridge deps are fully wired.
  if (
    authMiddleware &&
    requireOwnerPre &&
    requireLocalLaunchPre &&
    artifacts &&
    orchestrator
  ) {
    const ownerPres = [authMiddleware, requireOwnerPre, requireLocalLaunchPre];

    app.post(
      '/api/cycles/:id/discovery-handoff/confirm',
      { preHandler: ownerPres as any },
      async (request: any, reply: any) => {
        // Fail-closed if wiring was stripped after register (should not happen).
        if (!artifacts || !orchestrator) {
          return reply.code(500).send({
            ok: false,
            code: 'INTERNAL',
            error: 'owner confirm bridge not configured (artifacts/orchestrator)',
            runCreated: false,
          });
        }
        const cycleId = Number(request.params.id);
        const body = (request.body || {}) as {
          expectedDigest?: string;
          handoffId?: number;
          batchId?: string;
        };
        const result = await confirmDiscoveryHandoff(
          {
            cycleId,
            expectedDigest: body.expectedDigest,
            handoffId: body.handoffId,
            batchId: body.batchId,
          },
          {
            db: deps.db,
            handoffs,
            cycleService: deps.cycleService,
            artifacts,
            assignments: deps.assignmentService,
            plannerPanel: deps.plannerPanelService,
            orchestrator,
            detachS10: deps.detachS10,
          }
        );
        if (!result.ok) {
          return reply.code(ownerBridgeHttpStatus(result.code)).send({
            ok: false,
            code: result.code,
            error: result.reason,
            handoffId: result.handoffId,
            runCreated: false,
          });
        }
        // 202 after durable run creation — not after model startup (AC30)
        return reply.code(202).send({
          ok: true,
          status: result.state,
          handoffId: result.handoffId,
          runId: result.runId,
          cycleId,
          digest: result.digest,
          already: result.already,
          runCreated: !result.already,
        });
      }
    );

    app.post(
      '/api/cycles/:id/discovery-handoff/decline',
      { preHandler: ownerPres as any },
      async (request: any, reply: any) => {
        const cycleId = Number(request.params.id);
        const body = (request.body || {}) as {
          handoffId?: number;
          reason?: string;
        };
        const result = declineDiscoveryHandoff(
          {
            cycleId,
            handoffId: body.handoffId,
            reason: body.reason,
          },
          { handoffs }
        );
        if (!result.ok) {
          return reply.code(ownerBridgeHttpStatus(result.code)).send({
            ok: false,
            code: result.code,
            error: result.reason,
            handoffId: result.handoffId,
            runCreated: false,
          });
        }
        return reply.code(200).send({
          ok: true,
          status: 'declined',
          handoffId: result.handoffId,
          cycleId,
          runCreated: false,
        });
      }
    );
  }
}
