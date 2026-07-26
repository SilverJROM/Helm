import type { FastifyInstance } from 'fastify';
import type { ProjectService } from '../../services/project-service.js';
import type { PhaseStaffingService } from '../../services/phase-staffing.js';

export function registerPhaseAgentRoutes(app: FastifyInstance, deps: {
  projectService: ProjectService;
  phaseStaffingService: PhaseStaffingService;
  authMiddleware: any;
  requireOwnerPre: any;
}): void {
  app.get('/api/projects/:id/phase-agents/:phase', {
    preHandler: [deps.authMiddleware, deps.requireOwnerPre],
  }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    if (!deps.projectService.getProject(projectId)) {
      return reply.code(404).send({ error: 'unknown project' });
    }
    try {
      return deps.phaseStaffingService.resolvePhaseAgents(projectId, String(request.params.phase || ''));
    } catch (error: any) {
      const message = String(error?.message || error);
      const status = message.startsWith('invalid project phase:') ? 400 : 409;
      return reply.code(status).send({ error: message });
    }
  });
}
