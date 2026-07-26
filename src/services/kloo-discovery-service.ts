import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// B2 (kloo/D3+D5): runtime discovery of kloo's routes (~/.config/kloo/profiles.json
// `providers` block) + live per-route model catalog (GET <endpoint>/models). Never
// throws — every method returns a shape the caller can render, falling back to
// profiles.json `models{}` (or empty) when a route is offline.
// ---------------------------------------------------------------------------

export interface KlooRoute {
  name: string;
  endpoint: string;
}

export interface KlooModelsResult {
  models: string[];
  cached: boolean;
  note?: string;
}

export interface KlooValidateResult {
  ok: boolean;
  reason?: string;
}

interface KlooDiscoveryOpts {
  profilesPath?: string;
  ttlMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface CacheEntry {
  models: string[];
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 4_000;

export class KlooDiscoveryService {
  private readonly profilesPath: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(opts: KlooDiscoveryOpts = {}) {
    this.profilesPath =
      opts.profilesPath ??
      process.env.KLOO_PROFILES_PATH ??
      path.join(os.homedir(), '.config', 'kloo', 'profiles.json');
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  }

  // Never throws — absent/unreadable/malformed profiles.json → null.
  private _readProfiles(): any | null {
    try {
      const raw = fs.readFileSync(this.profilesPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  // D3: routes = keys of the `providers` block in profiles.json. Absent file → [].
  listRoutes(): KlooRoute[] {
    const profiles = this._readProfiles();
    const providers = profiles?.providers;
    if (!providers || typeof providers !== 'object') return [];
    return Object.entries(providers)
      .map(([name, cfg]: [string, any]) => ({ name, endpoint: String(cfg?.endpoint ?? '') }))
      .filter(r => r.endpoint);
  }

  // D5: expand `${OPENROUTER_API_KEY}` (and any other ${VAR} placeholder) against
  // process.env. Helm's .env loads `openrouter_api` (lowercase) via dotenv; that IS
  // the OpenRouter key, so OPENROUTER_API_KEY falls back to it when not already set.
  private _resolveApiKey(raw: unknown): string | undefined {
    if (typeof raw !== 'string' || !raw) return undefined;
    const m = raw.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
    if (!m) return raw;
    const varName = m[1];
    if (varName === 'OPENROUTER_API_KEY') {
      return process.env.OPENROUTER_API_KEY || process.env.openrouter_api || undefined;
    }
    return process.env[varName];
  }

  private _fallbackModels(routeCfg: any, note: string): KlooModelsResult {
    const configured = routeCfg?.models && typeof routeCfg.models === 'object'
      ? Object.keys(routeCfg.models)
      : [];
    return { models: configured, cached: false, note: configured.length > 0 ? `${note} — showing configured models` : note };
  }

  // D3: live GET <endpoint>/models with the route's resolved key. ~5min TTL cache
  // per route, `refresh` bypasses it. NEVER throws — errors/timeouts fall back to
  // profiles.json's route `models{}` (if present) or [] + an offline note.
  async listModels(route: string, opts: { refresh?: boolean } = {}): Promise<KlooModelsResult> {
    const now = Date.now();
    if (!opts.refresh) {
      const cached = this.cache.get(route);
      if (cached && now - cached.fetchedAt < this.ttlMs) {
        return { models: cached.models, cached: true };
      }
    }

    const profiles = this._readProfiles();
    const routeCfg = profiles?.providers?.[route];
    if (!routeCfg || !routeCfg.endpoint) {
      return { models: [], cached: false, note: 'route offline / server not running' };
    }

    const apiKey = this._resolveApiKey(routeCfg.apiKey);
    const url = `${String(routeCfg.endpoint).replace(/\/+$/, '')}/models`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const body: any = await res.json();
      const models = this._parseModelsBody(body);
      this.cache.set(route, { models, fetchedAt: now });
      return { models, cached: false };
    } catch {
      return this._fallbackModels(routeCfg, 'route offline / server not running');
    } finally {
      clearTimeout(timer);
    }
  }

  private _parseModelsBody(body: any): string[] {
    // OpenAI-style: { data: [{ id: string }, ...] }
    if (body && Array.isArray(body.data)) {
      return body.data.map((m: any) => String(m?.id ?? m?.model ?? '')).filter(Boolean);
    }
    if (Array.isArray(body)) {
      return body.map((m: any) => (typeof m === 'string' ? m : String(m?.id ?? m?.model ?? ''))).filter(Boolean);
    }
    return [];
  }

  // D7: "valid" = route reachable AND model present in that route's live catalog.
  // Reuses listModels (incl. its cache + fallback), so validate() never throws either.
  async validate(route: string, model: string): Promise<KlooValidateResult> {
    if (!this.listRoutes().some(r => r.name === route)) {
      return { ok: false, reason: `unknown route: ${route}` };
    }
    const result = await this.listModels(route);
    if (!result.models.includes(model)) {
      return { ok: false, reason: result.note ? result.note : `model not found on route ${route}` };
    }
    return { ok: true };
  }
}
