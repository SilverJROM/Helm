import type { FastifyInstance } from 'fastify';
import type { ProjectService } from '../../services/project-service.js';
import type { AgentAssignmentService } from '../../services/agent-assignment-service.js';

export interface ProjectRoleRosterRouteDeps {
  projectService: ProjectService;
  assignmentService: AgentAssignmentService;
  authMiddleware: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireOwnerPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireLocalLaunchPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
}

function mapError(msg: string): { status: number; error: string } {
  if (msg === 'unknown project') return { status: 404, error: msg };
  if (
    msg.startsWith('invalid role') ||
    msg.startsWith('only deliberation') ||
    msg.startsWith('unknown model_id') ||
    msg.startsWith('each member') ||
    msg.startsWith('members must')
  ) {
    return { status: 400, error: msg };
  }
  return { status: 400, error: msg };
}

/**
 * B8a / AC-12 + AC-12b:
 * - GET/PUT/DELETE /api/projects/:id/roles/:role/roster — project roster override
 * - DELETE /api/projects/:id/team-bindings/:role — unbind Studio team for role
 */
export function registerProjectRoleRosterRoutes(
  app: FastifyInstance,
  deps: ProjectRoleRosterRouteDeps
): void {
  const {
    projectService,
    assignmentService,
    authMiddleware,
    requireOwnerPre,
    requireLocalLaunchPre,
  } = deps;

  app.get(
    '/api/projects/:id/roles/:role/roster',
    { preHandler: [authMiddleware, requireOwnerPre] },
    async (request: any, reply: any) => {
      const pid = Number(request.params.id);
      const role = String(request.params.role || '');
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      try {
        return assignmentService.getEffectiveRoleRoster(pid, role);
      } catch (e: any) {
        const mapped = mapError(e?.message || String(e));
        return reply.code(mapped.status).send({ error: mapped.error });
      }
    }
  );

  app.put(
    '/api/projects/:id/roles/:role/roster',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (request: any, reply: any) => {
      const pid = Number(request.params.id);
      const role = String(request.params.role || '');
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      const body = request.body || {};
      try {
        return assignmentService.setProjectRoleRoster(pid, role, body.members ?? []);
      } catch (e: any) {
        const mapped = mapError(e?.message || String(e));
        return reply.code(mapped.status).send({ error: mapped.error });
      }
    }
  );

  app.delete(
    '/api/projects/:id/roles/:role/roster',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (request: any, reply: any) => {
      const pid = Number(request.params.id);
      const role = String(request.params.role || '');
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      try {
        return assignmentService.resetProjectRoleRoster(pid, role);
      } catch (e: any) {
        const mapped = mapError(e?.message || String(e));
        return reply.code(mapped.status).send({ error: mapped.error });
      }
    }
  );

  // AC-12b: unbind project team binding (role_team_bindings row).
  app.delete(
    '/api/projects/:id/team-bindings/:role',
    { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] },
    async (request: any, reply: any) => {
      const pid = Number(request.params.id);
      const role = String(request.params.role || '');
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      try {
        assignmentService.unbindProjectTeam(pid, role);
        return {
          ok: true,
          team_bindings: assignmentService.listProjectTeamBindings(pid),
        };
      } catch (e: any) {
        const mapped = mapError(e?.message || String(e));
        return reply.code(mapped.status).send({ error: mapped.error });
      }
    }
  );
}
