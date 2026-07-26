/**
 * B12 / AC-18 / DEC-13 — pre-spawn grok token-expiry availability probe.
 *
 * When a seat's PRIMARY is grok and `~/.grok/auth.json` already has a past `expires_at`,
 * treat grok as UNAVAILABLE so existing backup-selection (TierResolutionService lateral
 * failover, adaptive `resolvePanelWithAvailability` / `applyBackupFallback`) picks the
 * configured backup (codex per DEC-12) instead of spawning grok and tripping the #53
 * post-spawn auth-pause.
 *
 * This is PRE-SPAWN only. Mid-task grok logout remains #53 (fault-class auth /
 * canFailover:false / pause) — this module does NOT touch that path.
 *
 * Auth source: operator `~/.grok/auth.json` (default). Helm agent-home isolation
 * (`agent-home-isolation.ts`) symlinks the same file into the isolated HOME, so the
 * token/expiry is identical either way. We read the real operator path by default.
 *
 * Shape (nested, single auth-domain key):
 *   { "https://auth.x.ai::<uuid>": { expires_at, refresh_token, ... } }
 * Read as `Object.values(authJson)[0].expires_at`.
 *
 * Refresh: we cannot verify silent refresh. Per AC-18 safe behavior, past-expiry is
 * UNAVAILABLE even when a refresh_token string is present (no false-available).
 *
 * Fail-safe: missing file / garbled JSON / no entries / missing or unparseable
 * expires_at ⇒ treat as EXPIRED (unavailable). Prefer false-negative availability over
 * spawning a seat that will pause on auth.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type GrokAuthProbeOptions = {
  /** Epoch milliseconds for the comparison. Inject for tests. Default: Date.now(). */
  now?: number;
  /**
   * Path to auth.json. Used when `authJson` is not provided.
   * Default: `~/.grok/auth.json` (operator real path).
   */
  authPath?: string;
  /**
   * Pre-parsed auth.json object (or a JSON string). When set, no filesystem read.
   * Prefer this injection for unit tests.
   */
  authJson?: unknown;
  /** Optional filesystem reader (tests / alternate IO). Signature matches readFileSync. */
  readFileSync?: (p: string, encoding: 'utf8') => string;
};

/** Operator real grok auth path (also the symlink target of isolated agent homes). */
export function defaultGrokAuthPath(): string {
  return path.join(os.homedir(), '.grok', 'auth.json');
}

/**
 * Parse expires_at into epoch ms.
 * Accepts: ISO-8601 strings (incl. >3 fractional digits / trailing Z), unix seconds, unix ms.
 * Returns null when unparseable (caller treats as unavailable).
 */
export function parseExpiresAt(raw: unknown): number | null {
  if (raw == null) return null;

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Heuristic: values below 1e12 are unix seconds; >= 1e12 are already ms.
    return raw < 1e12 ? Math.trunc(raw * 1000) : Math.trunc(raw);
  }

  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;

    // Pure numeric string → same sec/ms heuristic.
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      return n < 1e12 ? Math.trunc(n * 1000) : Math.trunc(n);
    }

    // ISO: JS Date only handles ms (3 fractional digits). Truncate longer fractions.
    // e.g. 2026-07-22T17:04:11.880687308Z → 2026-07-22T17:04:11.880Z
    const iso = s.replace(/(\.\d{3})\d+(Z|[+-]\d{2}:?\d{2})?$/i, '$1$2');
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  }

  return null;
}

/**
 * Extract expires_at (epoch ms) from the nested auth.json shape.
 * Uses the first auth-domain entry: Object.values(authJson)[0].expires_at.
 */
export function extractGrokExpiresAtMs(authJson: unknown): number | null {
  if (authJson == null) return null;
  let obj: unknown = authJson;
  if (typeof authJson === 'string') {
    try {
      obj = JSON.parse(authJson);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const values = Object.values(obj as Record<string, unknown>);
  if (!values.length) return null;
  const entry = values[0];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  return parseExpiresAt((entry as Record<string, unknown>).expires_at);
}

function loadAuthJson(opts: GrokAuthProbeOptions): unknown | null {
  if (opts.authJson !== undefined) {
    if (typeof opts.authJson === 'string') {
      try {
        return JSON.parse(opts.authJson);
      } catch {
        return null;
      }
    }
    return opts.authJson;
  }
  const authPath = opts.authPath ?? defaultGrokAuthPath();
  const read = opts.readFileSync ?? ((p: string, enc: 'utf8') => fs.readFileSync(p, enc));
  try {
    const raw = read(authPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * True when grok auth is NOT usable for a new spawn (expired / missing / garbled).
 * Pure and unit-testable via injected now + authJson/authPath.
 */
export function isGrokAuthExpired(opts: GrokAuthProbeOptions = {}): boolean {
  const now = opts.now ?? Date.now();
  const auth = loadAuthJson(opts);
  if (auth == null) return true; // fail-safe: missing/garbled ⇒ unavailable
  const expMs = extractGrokExpiresAtMs(auth);
  if (expMs == null) return true; // fail-safe: no/unparseable expires_at
  // Past or equal expiry ⇒ expired. Refresh token is ignored (cannot verify silent refresh).
  return expMs <= now;
}

/** Inverse of isGrokAuthExpired — true when a new grok spawn may proceed. */
export function isGrokAuthAvailable(opts: GrokAuthProbeOptions = {}): boolean {
  return !isGrokAuthExpired(opts);
}

/**
 * Provider-level pre-spawn probe for backup-selection isAvailable callbacks.
 * Non-grok providers are always "auth-available" from this probe's POV
 * (binary/seat checks remain orthogonal).
 */
export function isProviderAuthAvailable(
  provider: string | null | undefined,
  opts: GrokAuthProbeOptions = {},
): boolean {
  if ((provider || '').toLowerCase() !== 'grok') return true;
  return isGrokAuthAvailable(opts);
}

/**
 * Compose a slug-based AvailabilityChecker (TierResolutionService) with the grok
 * pre-spawn probe. Looks up provider via `getProviderForSlug`; unknown slug → no
 * auth block (other checks still apply via base).
 */
export function makeGrokAwareSlugAvailability(
  getProviderForSlug: (slug: string) => string | null | undefined,
  opts: GrokAuthProbeOptions & {
    base?: (slug: string) => boolean | Promise<boolean>;
  } = {},
): (slug: string) => Promise<boolean> {
  const base = opts.base ?? (() => true);
  const probeOpts: GrokAuthProbeOptions = {
    now: opts.now,
    authPath: opts.authPath,
    authJson: opts.authJson,
    readFileSync: opts.readFileSync,
  };
  return async (slug: string) => {
    if (!(await Promise.resolve(base(slug)))) return false;
    const provider = getProviderForSlug(slug);
    return isProviderAuthAvailable(provider, probeOpts);
  };
}

/**
 * Compose a (provider, model) availability probe with the grok pre-spawn check.
 * Used by adaptive-planning resolvePanelWithAvailability / run-orchestrator isModelAvailable.
 */
export function makeGrokAwareProviderModelAvailability(
  base?: (provider: string, model: string) => boolean | Promise<boolean>,
  opts: GrokAuthProbeOptions = {},
): (provider: string, model: string) => Promise<boolean> {
  const inner = base ?? (async () => true);
  return async (provider: string, model: string) => {
    if (!isProviderAuthAvailable(provider, opts)) return false;
    return Promise.resolve(inner(provider, model));
  };
}
