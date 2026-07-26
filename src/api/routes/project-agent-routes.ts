import type { FastifyInstance } from 'fastify';
import { mapProjectAgentApiError } from '../project-agent-errors.js';
import type { ProjectService } from '../../services/project-service.js';
import type { ProjectAgentService } from '../../services/project-agent-service.js';
import type { AgentAssignmentService } from '../../services/agent-assignment-service.js';

export interface ProjectAgentRouteDeps {
  projectService: ProjectService;
  projectAgentService: ProjectAgentService;
  assignmentService: AgentAssignmentService;
  authMiddleware: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireOwnerPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
  requireLocalLaunchPre: (request: any, reply: any, done?: () => void) => void | Promise<void>;
}

function sendMappedError(reply: any, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const mapped = mapProjectAgentApiError(msg);
  return reply.code(mapped.status).send({ error: mapped.error });
}

export function registerProjectAgentRoutes(app: FastifyInstance, deps: ProjectAgentRouteDeps): void {
  const {
    projectService,
    projectAgentService,
    assignmentService,
    authMiddleware,
    requireOwnerPre,
    requireLocalLaunchPre
  } = deps;

  app.get('/api/projects/:id/agents', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    const pas = projectAgentService.listProjectAgents(pid);
    const bindings = assignmentService.listProjectBindings(pid);
    const projectAgents = pas.map((pa: any) => {
      const b = bindings.find((bb: any) => bb.agent_id === pa.agent_id);
      return { ...pa, role: b ? b.role : null };
    });
    return { projectAgents };
  });

  app.post('/api/projects/:id/agents', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const { agent_id } = request.body || {};
      if (agent_id == null) return reply.code(400).send({ error: 'agent_id required' });
      projectAgentService.addAgent(pid, Number(agent_id));
      return { ok: true };
    } catch (e: any) {
      return sendMappedError(reply, e);
    }
  });

  app.get('/api/projects/:id/agents/:agentId', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    const effective = assignmentService.resolveProjectAgent(pid, aid);
    if (!effective) return reply.code(404).send({ error: 'project agent not found' });
    return { effective };
  });

  app.put('/api/projects/:id/agents/:agentId', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    const body = request.body || {};
    try {
      projectAgentService.applyAgentOverrides(pid, aid, body);
      return { ok: true };
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'no overrides provided') return reply.code(400).send({ error: msg });
      return sendMappedError(reply, e);
    }
  });

  app.delete('/api/projects/:id/agents/:agentId', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    projectAgentService.removeAgent(pid, aid);
    return { ok: true };
  });

  app.get('/api/projects/:id/agents/:agentId/toolkits', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      return projectAgentService.listProjectAgentToolkits(pid, aid);
    } catch (e: any) {
      return sendMappedError(reply, e);
    }
  });

  app.put('/api/projects/:id/agents/:agentId/toolkits', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const body = request.body || {};
      if (typeof body.overridden !== 'boolean') return reply.code(400).send({ error: 'overridden boolean required' });
      return projectAgentService.setProjectAgentToolkits(pid, aid, { overridden: body.overridden, toolkits: body.toolkits || [] });
    } catch (e: any) {
      return sendMappedError(reply, e);
    }
  });

  app.post('/api/projects/:id/agents/:agentId/toolkits', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const body = request.body || {};
      return projectAgentService.attachProjectAgentToolkit(pid, aid, Number(body.toolkit_id), body.position);
    } catch (e: any) {
      return sendMappedError(reply, e);
    }
  });

  app.delete('/api/projects/:id/agents/:agentId/toolkits/:toolkitId', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    const toolkitId = Number(request.params.toolkitId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      return projectAgentService.detachProjectAgentToolkit(pid, aid, toolkitId);
    } catch (e: any) {
      return sendMappedError(reply, e);
    }
  });

  app.get('/api/projects/:id/agents/:agentId/escalations', { preHandler: [authMiddleware, requireOwnerPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      return projectAgentService.listProjectAgentEscalations(pid, aid);
    } catch (e: any) {
      return sendMappedError(reply, e);
    }
  });

  app.put('/api/projects/:id/agents/:agentId/escalations', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      const body = request.body || {};
      if (typeof body.overridden !== 'boolean') return reply.code(400).send({ error: 'overridden boolean required' });
      const escalations = body.escalations !== undefined ? body.escalations : (body.rungs || []);
      return projectAgentService.setProjectAgentEscalations(pid, aid, { overridden: body.overridden, escalations });
    } catch (e: any) {
      return sendMappedError(reply, e);
    }
  });

  app.post('/api/projects/:id/agents/:agentId/escalations', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      return projectAgentService.upsertProjectAgentEscalation(pid, aid, request.body || {});
    } catch (e: any) {
      return sendMappedError(reply, e);
    }
  });

  app.delete('/api/projects/:id/agents/:agentId/escalations/:position', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    const aid = Number(request.params.agentId);
    const position = Number(request.params.position);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    try {
      return projectAgentService.deleteProjectAgentEscalation(pid, aid, position);
    } catch (e: any) {
      return sendMappedError(reply, e);
    }
  });

  app.post('/api/projects/:id/agents/set-default', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    projectAgentService.setAllToDefault(pid);
    return { ok: true };
  });

  app.post('/api/projects/:id/agents/add-all', { preHandler: [authMiddleware, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const pid = Number(request.params.id);
    if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
    projectAgentService.addAllAgents(pid);
    return { ok: true };
  });
}