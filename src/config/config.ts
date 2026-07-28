import dotenv from "dotenv";
import { randomBytes } from "node:crypto";

dotenv.config();

export type HelmSessionJanitorMode = "off" | "shadow" | "on";

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric env var: ${name}`);
  }
  return parsed;
}

function parseJanitorMode(value: string): HelmSessionJanitorMode {
  const normalized = value.trim().toLowerCase();
  if (["off", "0", "false", "disabled", "no"].includes(normalized)) {
    return "off";
  }
  if (["shadow", "1", "warn", "log", "trace"].includes(normalized)) {
    return "shadow";
  }
  if (["on", "2", "true", "enabled", "yes"].includes(normalized)) {
    return "on";
  }
  console.warn(`[config] Invalid HELM_SESSION_JANITOR value "${value}", defaulting to off`);
  return "off";
}

export interface HelmConfig {
  port: number;
  host: string;
  dbPath: string;
  jwtSecret: string;
  agjAssistJwtSecret: string;
  agjAssistDbPath: string;
  WORKER_MAX_CONCURRENT: number;
  WORKER_TIMEOUT_MS: number;
  // P2-3: auto fallback config (per brief; codex-only effective per scope)
  AUTO_FALLBACK_ENABLED: boolean;
  AUTO_FALLBACK_CADENCE_MS: number;
  // P3-1: definition_md size cap (server 400 on exceed; preserve EXACTLY no trim)
  AGENT_DEFINITION_MAX: number;
  // P3-2: toolkit sidecar caps (per-body for create/update; aggregate for composeToolkits JIT at launch/spawn)
  TOOLKIT_BODY_MAX: number;
  TOOLKIT_COMPOSE_MAX: number;
  // B13: project helm_docs write body cap (server 400 on exceed)
  PROJECT_DOC_BODY_MAX: number;
  // C3: write-fence (Landlock) — absolute path override for the compiled binary (e.g. dist/tools/helm-sandbox); empty = auto-resolve (prefers dist/tools for post-build absolute path per refinement)
  HELM_SANDBOX_BIN: string;
  // SL-R3: session-lifecycle janitor — grace TTL (ms) after a session's work is done before it is closed; janitor + startup sweep enable/disable.
  HELM_SESSION_TTL_MS: number;
  HELM_SESSION_JANITOR: HelmSessionJanitorMode;
  HELM_HOUSEKEEPER_SCHEDULER_MS: number;
  HELM_HOUSEKEEPER_COOLDOWN_MS: number;
}

export function loadConfig(): HelmConfig {
  const jwtSecret = (() => {
    const raw = process.env.JWT_SECRET?.trim();
    if (raw) return raw;
    const rnd = randomBytes(32).toString('hex');
    console.warn('JWT_SECRET is not set in the environment. Using a random ephemeral Helm-only secret generated at boot. Helm-issued tokens will not persist across restarts. Set JWT_SECRET in production .env for stable operation.');
    return rnd;
  })();
  const agjAssistJwtSecret = (() => {
    const raw = process.env.AGJASSIST_JWT_SECRET?.trim();
    if (raw) return raw;
    const rnd = randomBytes(32).toString('hex');
    console.warn('AGJASSIST_JWT_SECRET is not set in the environment. Existing AGJAssist tokens will be rejected until the verification secret is configured.');
    return rnd;
  })();
  if (jwtSecret === agjAssistJwtSecret) {
    throw new Error('JWT_SECRET and AGJASSIST_JWT_SECRET must be different so Helm-issued tokens cannot authenticate as AGJAssist tokens');
  }

  return {
    port: optionalNumber("HELM_PORT", 3110),
    host: optional("HELM_HOST", "127.0.0.1"),
    dbPath: optional("HELM_DB_PATH", "data/helm.db"),
    jwtSecret,
    agjAssistJwtSecret,
    agjAssistDbPath: optional("AGJASSIST_DB_PATH", "/home/agjrom/TGBOTS/AGJAssist/data/agjassist.db"),
    WORKER_MAX_CONCURRENT: optionalNumber("WORKER_MAX_CONCURRENT", 5),
    WORKER_TIMEOUT_MS: optionalNumber("WORKER_TIMEOUT_MS", 1800000),
    AUTO_FALLBACK_ENABLED: optional("AUTO_FALLBACK_ENABLED", "true").toLowerCase() === "true",
    AUTO_FALLBACK_CADENCE_MS: optionalNumber("AUTO_FALLBACK_CADENCE_MS", 90000),
    AGENT_DEFINITION_MAX: optionalNumber("AGENT_DEFINITION_MAX", 50000),
    TOOLKIT_BODY_MAX: optionalNumber("TOOLKIT_BODY_MAX", 50000),
    TOOLKIT_COMPOSE_MAX: optionalNumber("TOOLKIT_COMPOSE_MAX", 200000),
    PROJECT_DOC_BODY_MAX: optionalNumber("PROJECT_DOC_BODY_MAX", 1048576),
    // C3
    HELM_SANDBOX_BIN: optional("HELM_SANDBOX_BIN", ""),
    // SL-R3: default off (0); shadow logs would-be actions, on performs reaping.
    HELM_SESSION_TTL_MS: optionalNumber("HELM_SESSION_TTL_MS", 1200000),
    HELM_SESSION_JANITOR: parseJanitorMode(optional("HELM_SESSION_JANITOR", "0")),
    // S18b: housekeeper investigation scheduler is hours-scale and separate from the session janitor.
    HELM_HOUSEKEEPER_SCHEDULER_MS: optionalNumber("HELM_HOUSEKEEPER_SCHEDULER_MS", 6 * 60 * 60 * 1000),
    HELM_HOUSEKEEPER_COOLDOWN_MS: optionalNumber("HELM_HOUSEKEEPER_COOLDOWN_MS", 6 * 60 * 60 * 1000),
  };
}
