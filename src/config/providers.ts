export const PROVIDER_BANDS = ["cheap-fast", "mid", "frontier", "auditor"] as const;
export type ProviderBand = (typeof PROVIDER_BANDS)[number];

export const PROVIDER_ROLES = [
  "discovery",
  "plancore",
  "ibrain",
  "coord",
  "implementer",
  "validator",
  "deliberation",
  "red-team",
  "planner",
  "routine-implementer",
  "panelist",
  "branch-safety"
] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

export interface ProviderModelDefinition {
  model: string;
  band: ProviderBand;
  eligibleRoles: ProviderRole[];
  sessionSuffix?: string;
}

export interface ProviderLaunchDefinition {
  defaultMode: "tui" | "headless";
  templates: {
    tui?: string;
    headless?: string;
  };
}

export interface ProviderEffortDefinition {
  mechanism: string;
  flagTemplate: string | null;
  allowedValues?: string[];
}

export interface ProviderWorktreeDefinition {
  supported: boolean;
  flag: string | null;
}

export interface ProviderDefinition {
  provider: string;
  launch: ProviderLaunchDefinition;
  bypassFlag: string | null;
  approvalModes?: string[];
  effort: ProviderEffortDefinition;
  callbackMechanism: string;
  worktree: ProviderWorktreeDefinition;
  sessionSuffix: string;
  models: ProviderModelDefinition[];
  readyProbe?: { signal: string; timeoutMs?: number };
  exitSequence?: string;
  swap_protocol?: 'tui-interrupt';
  /** B1 (kloo/D1): models discovered at runtime (not enumerated in `models[]`). Resolver/validator
   * must treat a dynamic provider's model list as empty-by-design, not as "no models configured". */
  dynamicModels?: boolean;
}

export type ProviderRegistry = Record<string, ProviderDefinition>;

export const PROVIDERS = {
  // Deterministic scenario-harness provider (nested-projcore Phase-2). Launches tools/stub-agent.js
  // which reaches ready (STUB-READY) and emits scripted callbacks from /tmp/stub-control/<role>.json.
  // Used ONLY to force helm-algo branches on the real transport seam without burning real-model tokens.
  stub: {
    provider: "stub",
    launch: {
      defaultMode: "tui",
      templates: {
        tui: "node /home/agjrom/TGBOTS/Helm/tools/stub-agent.js <model>",
        headless: "node /home/agjrom/TGBOTS/Helm/tools/stub-agent.js <model>"
      }
    },
    bypassFlag: null,
    approvalModes: ["default"],
    effort: {
      mechanism: "--effort",
      flagTemplate: "--effort <effort>",
      allowedValues: ["low", "medium", "high", "xhigh", "max"]
    },
    callbackMechanism: "status-file",
    worktree: { supported: false, flag: "" },
    sessionSuffix: "stub",
    readyProbe: { signal: "STUB-READY", timeoutMs: 20000 },
    exitSequence: "C-c",
    swap_protocol: "tui-interrupt",
    models: [
      { model: "stub-implementer", band: "cheap-fast", eligibleRoles: ["implementer", "routine-implementer"] },
      { model: "stub-validator", band: "cheap-fast", eligibleRoles: ["validator"] },
      { model: "stub-phase-brain", band: "cheap-fast", eligibleRoles: ["discovery", "plancore", "ibrain", "planner", "deliberation", "coord"] },
      { model: "stub-panelist", band: "cheap-fast", eligibleRoles: ["red-team", "panelist", "deliberation"] }
    ]
  },
  grok: {
    provider: "grok",
    launch: {
      defaultMode: "tui",
      templates: {
        // BLANK-CANVAS HARDENING: strip grok's native agent subsystems so Helm's own definitions/
        // orchestration govern — grok must act as a plain LLM, never spawn its own subagents, plan
        // mode, cross-session memory, or web tools. Hard flags (not a prompt) so it can't leak.
        // --no-subagents = no built-in agents · --no-plan · --no-memory · --disable-web-search.
        tui: "grok --always-approve --no-subagents --no-plan --no-memory --disable-web-search -m <model> --effort <effort>",
        headless: "grok -p <prompt> --no-subagents --no-plan --no-memory --disable-web-search -m <model>"
      }
    },
    bypassFlag: "--always-approve",
    approvalModes: ["default", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions", "always-approve"],
    effort: {
      mechanism: "--effort",
      flagTemplate: "--effort <effort>",
      allowedValues: ["low", "medium", "high", "xhigh", "max"]
    },
    callbackMechanism: "status-file",
    worktree: {
      supported: true,
      flag: "-w"
    },
    sessionSuffix: "grok",
    readyProbe: { signal: "❯", timeoutMs: 60000 },
    exitSequence: "C-c",
    swap_protocol: "tui-interrupt",
    models: [
      {
        // R1.5: CLI-real frontier id. Keep grok-composer-2.5-fast. No glm5.2 in registry.
        model: "grok-4.5",
        band: "frontier",
        eligibleRoles: ["implementer", "validator", "deliberation", "red-team", "planner", "coord", "discovery", "plancore", "ibrain"],
        sessionSuffix: "grok45"
      },
      {
        model: "grok-composer-2.5-fast",
        band: "cheap-fast",
        eligibleRoles: ["routine-implementer", "panelist"]
      }
    ]
  },
  codex: {
    provider: "codex",
    launch: {
      defaultMode: "tui",
      templates: {
        // BLANK-CANVAS HARDENING: codex ships a full agentic subsystem ON by default (verified via
        // `codex features list`) — multi_agent (its own sub-agents), goals, personality, plugins,
        // apps, hooks, browser_use, computer_use. Left on, it surfaces ITS built-in agents/skills
        // instead of Helm's definitions (observed on lokalspeak 2026-07-06). Hard-disable each via
        // `--disable <feature>` (== `-c features.<name>=false`) so codex acts as a plain LLM Helm drives.
        tui: "codex -m <model> --disable multi_agent --disable goals --disable personality --disable plugins --disable apps --disable hooks --disable browser_use --disable computer_use --dangerously-bypass-approvals-and-sandbox"
      }
    },
    bypassFlag: "--dangerously-bypass-approvals-and-sandbox",
    approvalModes: ["untrusted", "on-request", "on-failure", "never", "bypass"],
    effort: {
      mechanism: "-m / /model",
      flagTemplate: "-m <model>"
    },
    callbackMechanism: "callbacks.md + emit-status",
    worktree: {
      supported: false,
      flag: null
    },
    sessionSuffix: "codex",
    readyProbe: { signal: "›", timeoutMs: 60000 },
    exitSequence: "C-c",
    swap_protocol: "tui-interrupt",
    models: [
      {
        model: "gpt-5.5",
        band: "auditor",
        eligibleRoles: ["validator", "coord", "deliberation", "planner", "red-team", "discovery", "plancore", "ibrain"],
        sessionSuffix: "codex55"
      },
      {
        model: "gpt-5.6-sol",
        band: "auditor",
        eligibleRoles: ["validator", "coord", "deliberation", "planner", "red-team", "discovery", "plancore", "ibrain"]
      },
      {
        model: "gpt-5.6-terra",
        band: "frontier",
        eligibleRoles: ["implementer", "validator", "deliberation", "planner"]
      },
      {
        model: "gpt-5.6-luna",
        band: "cheap-fast",
        eligibleRoles: ["implementer", "routine-implementer", "panelist"]
      },
      {
        model: "gpt-5.4",
        band: "mid",
        eligibleRoles: ["implementer", "validator", "deliberation", "planner"]
      },
      {
        model: "gpt-5.3-codex-spark",
        band: "cheap-fast",
        eligibleRoles: ["implementer", "panelist", "routine-implementer"]
      },
      {
        model: "gpt-5.2-codex",
        band: "mid",
        eligibleRoles: ["implementer", "validator", "deliberation"]
      },
      {
        model: "gpt-5.1-codex-max",
        band: "auditor",
        eligibleRoles: ["validator", "deliberation", "red-team", "planner"]
      },
      {
        model: "gpt-5.1-codex",
        band: "mid",
        eligibleRoles: ["implementer", "validator"]
      },
      {
        model: "gpt-5.1-codex-mini",
        band: "cheap-fast",
        eligibleRoles: ["routine-implementer", "panelist"]
      }
    ]
  },
  claude: {
    provider: "claude",
    launch: {
      // R9 blank-canvas: default is real `claude` TUI — never load external ~/.claude skills.
      defaultMode: "tui",
      templates: {
        // B2 (WRK1 + MDL3): direct `claude` CLI tui template for WorkerService (tmux spawn); <model> filled by resolver.
        // TEXT-ONLY relay: every Helm claude agent talks to the operator via the text chat relay / callbacks.md,
        // which cannot render or answer Claude Code's interactive menus. Disable the keyboard-navigation tools
        // (AskUserQuestion multiple-choice, ExitPlanMode plan-approval prompt) so questions come back as PLAIN
        // TEXT the operator can type a reply to — otherwise the pane hangs on an un-answerable menu.
        tui: "claude --model <model> --dangerously-skip-permissions --disallowedTools AskUserQuestion ExitPlanMode"
      }
    },
    bypassFlag: null,
    approvalModes: ["default", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"],
    effort: {
      mechanism: "thinking markers",
      flagTemplate: "thinking:<effort>"
    },
    callbackMechanism: "callbacks.md + emit-status",
    worktree: {
      supported: false,
      flag: null
    },
    sessionSuffix: "claude",
    // R9: claude TUI composer prompt is ❯ (same family as grok); genuine-ready also checks footer in runtime.
    readyProbe: { signal: "❯", timeoutMs: 60000 },
    exitSequence: "C-d",
    swap_protocol: "tui-interrupt",
    models: [
      {
        model: "claude-opus-5",
        band: "auditor",
        eligibleRoles: ["coord", "validator", "deliberation", "red-team", "planner", "discovery", "plancore", "ibrain"],
        sessionSuffix: "opus"
      },
      {
        model: "claude-opus-4-7",
        band: "auditor",
        eligibleRoles: ["coord", "validator", "deliberation", "red-team", "planner", "discovery", "plancore", "ibrain"],
        sessionSuffix: "opus"
      },
      {
        model: "claude-opus-4-6",
        band: "auditor",
        eligibleRoles: ["coord", "validator", "deliberation", "red-team", "planner", "discovery", "plancore", "ibrain"],
        sessionSuffix: "opus"
      },
      {
        model: "claude-opus-4-5",
        band: "auditor",
        eligibleRoles: ["coord", "validator", "deliberation", "red-team", "planner", "discovery", "plancore", "ibrain"],
        sessionSuffix: "opus"
      },
      {
        model: "claude-sonnet-4-6",
        band: "mid",
        eligibleRoles: ["implementer", "validator", "deliberation"],
        sessionSuffix: "sonnet"
      },
      {
        model: "claude-sonnet-5",
        band: "mid",
        // #48: 'discovery' added — JROM asked for sonnet-5 discovery and the registry rejected it.
        eligibleRoles: ["implementer", "validator", "deliberation", "discovery", "plancore", "ibrain"],
        sessionSuffix: "sonnet"
      },
      {
        model: "claude-sonnet-4-5",
        band: "mid",
        eligibleRoles: ["implementer", "validator", "deliberation"],
        sessionSuffix: "sonnet"
      },
      {
        model: "claude-haiku-4-5",
        band: "cheap-fast",
        eligibleRoles: ["panelist", "routine-implementer"],
        sessionSuffix: "haiku"
      },
      {
        model: "claude-fable-5",
        band: "cheap-fast",
        eligibleRoles: ["panelist", "routine-implementer"]
      }
    ]
  },
  // B1 (kloo/D1): dynamic provider — routes + models are discovered at runtime (B2), not enumerated here.
  // Empty `models[]` is intentional (dynamicModels: true). readyProbe.signal is a PROVISIONAL placeholder
  // pending the real kloo TUI ready marker (confirm in B4 spawn batch); do not treat "❯" as final.
  kloo: {
    provider: "kloo",
    launch: {
      defaultMode: "tui",
      templates: {
        tui: "kloo --provider <route> --model <model> --ctx <ctx>"
      }
    },
    bypassFlag: null,
    approvalModes: ["default"],
    effort: {
      mechanism: "--effort",
      flagTemplate: null
    },
    callbackMechanism: "status-file",
    worktree: {
      supported: false,
      flag: null
    },
    sessionSuffix: "kloo",
    // B4: confirmed live — kloo's composer placeholder "type a task…" (U+2026 ellipsis) is the real
    // ready marker; it never emits "❯" (that was a placeholder guess from providers this registry
    // already tracks). Verified via a real tmux boot + round-trip (openrouter/deepseek-v4-flash).
    readyProbe: { signal: "type a task…", timeoutMs: 30000 },
    exitSequence: "C-d",
    swap_protocol: "tui-interrupt",
    dynamicModels: true,
    models: []
  }
} satisfies ProviderRegistry;

/**
 * The composer READY signal for an interactive SEAT of this provider — the exact glyph/marker the seat's
 * readyProbe waits for (claude/grok → "❯", codex → "›", kloo → "type a task…"). This is the provider-correct
 * per-seat "ready to accept input" signal that SEAT callers pass to `sendAndSubmit({ readySignal })` so a
 * boot/auth/update/launch frame that lacks it is NOT falsely marked delivered (F2). Returns undefined for an
 * unknown provider (→ the send stays ungated, i.e. original behavior — never gate out an unmodeled seat).
 * MASTER/feed callers deliberately do NOT use this (their TUI does not surface the seat glyph at feed time).
 */
export function seatReadySignal(provider: string | undefined | null): string | undefined {
  if (!provider) return undefined;
  return (PROVIDERS as Record<string, { readyProbe?: { signal?: string } }>)[provider]?.readyProbe?.signal;
}

export function generateProvidersMarkdown(registry: ProviderRegistry = PROVIDERS): string {
  const lines = [
    "# PROVIDERS Registry",
    "",
    "Derived from `src/config/providers.ts`, which is the single source of truth for provider launch behavior.",
    "Regenerate this document from the typed registry when the registry changes; resolver behavior does not parse this file.",
    ""
  ];

  for (const provider of Object.values(registry)) {
    lines.push(`## ${provider.provider}`, "");
    lines.push(`- Launch mode: ${provider.launch.defaultMode}`);
    for (const [mode, template] of Object.entries(provider.launch.templates)) {
      if (template) lines.push(`- ${mode} launch: \`${template}\``);
    }
    lines.push(`- Bypass flag: ${formatNullable(provider.bypassFlag)}`);
    lines.push(`- Effort: ${provider.effort.mechanism}`);
    lines.push(`- Effort flag: ${formatNullable(provider.effort.flagTemplate)}`);
    if (provider.effort.allowedValues?.length) {
      lines.push(`- Effort values: ${provider.effort.allowedValues.join(", ")}`);
    }
    lines.push(`- Callback: ${provider.callbackMechanism}`);
    lines.push(
      `- Worktree: ${provider.worktree.supported ? `supported (${provider.worktree.flag})` : "not supported"}`
    );
    lines.push(`- Session suffix: ${provider.sessionSuffix}`, "");
    lines.push("| Model | Band | Eligible roles | Session suffix |");
    lines.push("| --- | --- | --- | --- |");
    for (const model of provider.models) {
      lines.push(
        `| ${model.model} | ${model.band} | ${model.eligibleRoles.join(", ")} | ${
          model.sessionSuffix ?? provider.sessionSuffix
        } |`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function formatNullable(value: string | null): string {
  return value === null ? "none" : `\`${value}\``;
}

/**
 * B3 (MDL2): render flags from structured approval config (approval_policy / sandbox_mode / permission_mode / bypass).
 * Used by model seeds + later launch/refresh. Matches agent-studio-models-spec dropdown + CLI mappings (2026-06-15).
 * Provider-specific; bypass takes precedence.
 */
export function getApprovalFlags(
  provider: string,
  approvalPolicy?: string | null,
  sandboxMode?: string | null,
  permissionMode?: string | null,
  bypass?: boolean | number | null
): string | null {
  const b = bypass ? 1 : 0;
  if (b) {
    if (provider === 'codex') return '--dangerously-bypass-approvals-and-sandbox';
    if (provider === 'claude') return '--dangerously-skip-permissions';
    if (provider === 'grok') return '--always-approve';
  }
  if (permissionMode) {
    return `--permission-mode ${permissionMode}`;
  }
  if (provider === 'codex' && approvalPolicy && sandboxMode) {
    return `-a ${approvalPolicy} -s ${sandboxMode}`;
  }
  if (provider === 'grok' && approvalPolicy === 'always-approve') {
    return '--always-approve';
  }
  return null;
}
