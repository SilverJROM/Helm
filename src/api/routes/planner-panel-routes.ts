import type { FastifyInstance } from 'fastify';
import type { ProjectService } from '../../services/project-service.js';
import type { PlannerPanelService } from '../../services/planner-panel-service.js';

export interface PlannerPanelRouteDeps {
  projectService: ProjectService;
  plannerPanelService: PlannerPanelService;
  authMiddleware: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireOwnerPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireLocalLaunchPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
}

function mapError(msg: string): { status: number; error: string } {
  if (msg === 'unknown project') return { status: 404, error: msg };
  if (
    msg.startsWith('at least one') ||
    msg.startsWith('exactly one') ||
    msg.startsWith('each member') ||
    msg.startsWith('each backup') ||
    msg.startsWith('unknown model_id') ||
    msg.startsWith('invalid effort') ||
    msg.startsWith('panel member') ||
    msg.startsWith('panel backup')
  ) {
    return { status: 400, error: msg };
  }
  return { status: 400, error: msg };
}

export function registerPlannerPanelRoutes(app: FastifyInstance, deps: PlannerPanelRouteDeps): void {
  const {
    projectService,
    plannerPanelService,
    authMiddleware,
    requireOwnerPre,
    requireLocalLaunchPre,
  } = deps;

  app.get(
    '/api/projects/:id/planner-panel',
    { preHandler: [authMiddleware, requireOwnerPre] },
    async (request: any, reply: any) => {
      const pid = Number(request.params.id);
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      try {
        return plannerPanelService.getConfig(pid);
      } catch (e: any) {
        const mapped = mapError(e?.message || String(e));
        return reply.code(mapped.status).send({ error: mapped.error });
      }
    },
  );

  app.put(
    '/api/projects/:id/planner-panel',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (request: any, reply: any) => {
      const pid = Number(request.params.id);
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      const body = request.body || {};
      try {
        const config = plannerPanelService.replaceConfig(pid, {
          members: body.members,
          backups: body.backups,
          default_effort: body.default_effort,
        });
        return config;
      } catch (e: any) {
        const mapped = mapError(e?.message || String(e));
        return reply.code(mapped.status).send({ error: mapped.error });
      }
    },
  );
}
