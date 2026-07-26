import {
  AgentAssignmentService,
  type AgentDefinition,
  type EffectiveProjectAgent,
} from './agent-assignment-service.js';

export const PHASE_STAFFING = {
  discovery: {
    brain: 'discovery',
    workers: ['fetcher'],
  },
  planning: {
    brain: 'plancore',
    workers: ['planner'],
  },
  implementation: {
    brain: 'ibrain',
    workers: ['implementer', 'validator'],
  },
  final_tests: {
    brain: 'ibrain',
    workers: ['validator'],
  },
  complete: {},
} as const;

export type ProjectPhase = keyof typeof PHASE_STAFFING;
export type PhaseAgentSource = 'project-binding' | 'role-default' | 'same-name-fallback';

export interface ResolvedPhaseAgent {
  role: string;
  source: PhaseAgentSource;
  agent: AgentDefinition;
  effective_project_agent: EffectiveProjectAgent | null;
}

export interface ResolvedPhaseAgents {
  phase: ProjectPhase;
  brain: ResolvedPhaseAgent | null;
  workers: ResolvedPhaseAgent[];
  unavailableRoles: string[];
}

export class InvalidProjectPhaseError extends Error {
  constructor(phase: string) {
    super(`invalid project phase: ${phase}`);
    this.name = 'InvalidProjectPhaseError';
  }
}

export class PhaseBrainUnavailableError extends Error {
  constructor(public readonly phase: ProjectPhase, public readonly role: string) {
    super(`required brain unavailable for phase ${phase}: ${role}`);
    this.name = 'PhaseBrainUnavailableError';
  }
}

function applyEffectiveAgent(agent: AgentDefinition, effective: EffectiveProjectAgent | null): AgentDefinition {
  if (!effective) return agent;
  const model = effective.model.type === 'dynamic'
    ? 'dynamic'
    : (effective.model.model_id ?? agent.model);
  return {
    ...agent,
    provider: effective.model.provider ?? agent.provider,
    model,
    default_effort: effective.effort,
    backup_model_id: effective.backup_model_id,
    spawn_pref: effective.spawn_pref,
    definition_md: effective.definition_md,
    in_development: effective.in_development,
  };
}

/**
 * One phase-to-seat resolver shared by HTTP/UI and orchestration boundaries.
 * The only name lookup is the exact canonical same-role fallback required for
 * old projects that predate an explicit binding/default; there is no fuzzy name matching.
 */
export class PhaseStaffingService {
  constructor(private readonly assignments: AgentAssignmentService) {}

  resolvePhaseAgents(projectId: number, phaseInput: string): ResolvedPhaseAgents {
    if (!Object.prototype.hasOwnProperty.call(PHASE_STAFFING, phaseInput)) {
      throw new InvalidProjectPhaseError(phaseInput);
    }
    const phase = phaseInput as ProjectPhase;
    const config = PHASE_STAFFING[phase] as { brain?: string; workers?: readonly string[] };
    const unavailableRoles: string[] = [];

    const resolveRole = (role: string): ResolvedPhaseAgent | null => {
      try {
        const resolved = this.assignments.resolveProjectRole(projectId, role);
        if (resolved?.agent) {
          return {
            role,
            source: resolved.source === 'binding' ? 'project-binding' : 'role-default',
            agent: resolved.agent,
            effective_project_agent: resolved.effective_project_agent ?? null,
          };
        }
      } catch (error: any) {
        // A declared on-demand worker (currently fetcher) may not yet be a bindable
        // role. Continue to the exact same-name fallback; all other resolver errors
        // remain fail-loud.
        if (!String(error?.message || error).startsWith('invalid role:')) throw error;
      }

      const sameNamed = this.assignments.listAgents().find(
        (agent) => agent.kind === 'project' && agent.name === role
      );
      if (!sameNamed) return null;
      const effective = this.assignments.resolveProjectAgent(projectId, sameNamed.id);
      return {
        role,
        source: 'same-name-fallback',
        agent: applyEffectiveAgent(sameNamed, effective),
        effective_project_agent: effective,
      };
    };

    const brain = config.brain ? resolveRole(config.brain) : null;
    if (config.brain && !brain) {
      throw new PhaseBrainUnavailableError(phase, config.brain);
    }

    const workers: ResolvedPhaseAgent[] = [];
    for (const role of config.workers ?? []) {
      const worker = resolveRole(role);
      if (worker) workers.push(worker);
      else unavailableRoles.push(role);
    }

    return { phase, brain, workers, unavailableRoles };
  }
}

export function resolvePhaseAgents(
  assignments: AgentAssignmentService,
  projectId: number,
  phase: string
): ResolvedPhaseAgents {
  return new PhaseStaffingService(assignments).resolvePhaseAgents(projectId, phase);
}
