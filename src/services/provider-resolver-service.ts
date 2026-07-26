import {
  PROVIDERS,
  ProviderBand,
  ProviderDefinition,
  ProviderRegistry,
  ProviderRole
} from "../config/providers.js";

export interface AgentLaunchRequest {
  provider: string;
  model: string;
  effort?: string | null;
  agent?: string;
  prompt?: string;
  skill?: string;
  mode?: "tui" | "headless";
  /** B1 (kloo/D4): kloo route (e.g. "openrouter"), fills `<route>` in dynamic-provider templates. */
  route?: string;
  /** B1 (kloo/D4): context window size, fills `<ctx>` in dynamic-provider templates. */
  ctx?: string;
}

export interface ProviderLaunchSpec {
  provider: string;
  model: string;
  launch_cmd: string;
  bypass_flag: string | null;
  effort_flag: string | null;
  callback_mechanism: string;
  session_suffix: string;
  worktree_support: {
    supported: boolean;
    flag: string | null;
  };
}

export interface RoleBandRequest {
  role: ProviderRole;
  band: ProviderBand;
}

export interface ProviderModelSelection {
  provider: string;
  model: string;
}

export class ProviderResolverService {
  constructor(private readonly registry: ProviderRegistry = PROVIDERS) {}

  resolveAgentLaunchSpec(input: AgentLaunchRequest): ProviderLaunchSpec {
    const provider = this.requireProvider(input.provider);
    const staticModel = provider.models.find((candidate) => candidate.model === input.model);
    if (!staticModel && !((provider as any).dynamicModels && input.model)) {
      throw new Error(`Unknown model for provider ${input.provider}: ${input.model}`);
    }
    // Dynamic provider (kloo): models are discovered at runtime, so the static models[] is empty and the
    // requested id won't be found — synthesize a minimal entry from the bound id instead of throwing.
    const model = staticModel ?? ({ model: input.model } as (typeof provider.models)[number]);

    const mode = input.mode ?? provider.launch.defaultMode;
    const template = provider.launch.templates[mode];
    if (!template) {
      throw new Error(`Provider ${input.provider} does not define a ${mode} launch template`);
    }

    return {
      provider: provider.provider,
      model: model.model,
      launch_cmd: fillTemplate(template, {
        agent: input.agent ?? '', // vestigial for --agent (H7: model id now via -m <model> for grok tui)
        effort: normalizeEffort(input.effort),
        model: model.model,
        prompt: input.prompt ?? "",
        skill: roleSkillForModel(model.model),
        route: input.route ?? '',   // B1 (kloo/D4): <route> in dynamic-provider templates
        ctx: input.ctx ?? ''        // B1 (kloo/D4): <ctx> in dynamic-provider templates
      }),
      bypass_flag: provider.bypassFlag,
      effort_flag: renderEffortFlag(provider, model.model, input.effort),
      callback_mechanism: provider.callbackMechanism,
      session_suffix: model.sessionSuffix ?? provider.sessionSuffix,
      worktree_support: { ...provider.worktree }
    };
  }

  resolveProviderModelForRoleBand(input: RoleBandRequest): ProviderModelSelection {
    for (const provider of Object.values(this.registry)) {
      const model = provider.models.find(
        (candidate) =>
          candidate.band === input.band && candidate.eligibleRoles.includes(input.role)
      );
      if (model) {
        return {
          provider: provider.provider,
          model: model.model
        };
      }
    }

    throw new Error(`No provider model is eligible for role ${input.role} at band ${input.band}`);
  }

  /**
   * POCFIX5: resolve binding model name (e.g. 'claude-sonnet' or null) to concrete launchable model id for the provider.
   * exact match → startsWith (for alias like claude-sonnet → claude-sonnet-4-6, first listed) →
   * if modelName null/empty use provider's first/default → else throw clear error (no silent grok).
   */
  resolveConcreteModel(providerId: string, modelName: string | null | undefined): string {
    const provider = this.requireProvider(providerId);
    if ((provider as any).dynamicModels) {
      // C0 (kloo): dynamic providers discover models at runtime — the static models[] is intentionally
      // empty (dynamicModels: true), so any explicitly-bound model id is valid; pass it through without
      // static-list validation. Static providers (grok/codex/claude) skip this and hit the exact/prefix search.
      if (modelName) return modelName;
      throw new Error(`dynamic provider '${providerId}' requires an explicit model`);
    }
    if (modelName) {
      let m = provider.models.find((candidate) => candidate.model === modelName);
      if (m) return m.model;
      m = provider.models.find((candidate) => candidate.model.startsWith(modelName));
      if (m) return m.model;
      // modelName provided but no exact or prefix match
      throw new Error(`no model '${modelName}' for provider '${providerId}'`);
    }
    // null/empty: provider's default/first
    if (provider.models.length > 0) {
      return provider.models[0].model;
    }
    throw new Error(`no model '${modelName || ""}' for provider '${providerId}'`);
  }

  private requireProvider(providerId: string): ProviderDefinition {
    const provider = this.registry[providerId];
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return provider;
  }
}

export function resolveAgentLaunchSpec(
  input: AgentLaunchRequest,
  registry: ProviderRegistry = PROVIDERS
): ProviderLaunchSpec {
  return new ProviderResolverService(registry).resolveAgentLaunchSpec(input);
}

export function resolveProviderModelForRoleBand(
  input: RoleBandRequest,
  registry: ProviderRegistry = PROVIDERS
): ProviderModelSelection {
  return new ProviderResolverService(registry).resolveProviderModelForRoleBand(input);
}

function renderEffortFlag(
  provider: ProviderDefinition,
  model: string,
  effortInput?: string | null
): string | null {
  if (!provider.effort.flagTemplate) return null;
  const effort = normalizeEffort(effortInput);

  if (provider.effort.allowedValues?.length && !provider.effort.allowedValues.includes(effort)) {
    throw new Error(
      `Invalid effort for provider ${provider.provider}: ${effort}. Expected one of ${provider.effort.allowedValues.join(", ")}`
    );
  }

  return fillTemplate(provider.effort.flagTemplate, {
    agent: model,
    effort,
    model,
    prompt: "",
    skill: roleSkillForModel(model)
  });
}

function normalizeEffort(effort?: string | null): string {
  if (!effort) return "medium";
  const e = effort.toLowerCase().trim();
  if (["low", "medium", "high", "xhigh", "max"].includes(e)) return e;
  return "medium";
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/<(\w+)>/g, (_, k: string) => vars[k] ?? "");
}

function roleSkillForModel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return model;
}
