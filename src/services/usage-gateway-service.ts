/**
 * Usage gateway (Q-12): Helm-owned headroom/depleted reads for auto-fallback.
 *
 * Does NOT shell `~/.claude/agents/lib/agent-usage.sh` (crew scaffolding).
 * Live path: provider usage API via usage-provider-client.
 * Tests: inject fetcher / fetchDeps (fake + deterministic stale).
 */
import {
  fetchCodexUsageSnapshot,
  type UsageFetchDeps,
  type UsageSnapshot,
} from "./usage-provider-client.js";

export type { UsageSnapshot };

export type UsageGatewayOptions = {
  /** Full override of the snapshot pull (unit tests / fakes). */
  fetcher?: () => Promise<UsageSnapshot>;
  /** Partial deps for the default Codex client (auth/fetch/threshold). */
  fetchDeps?: UsageFetchDeps;
  /** Cache TTL; default 60s. */
  cacheTtlMs?: number;
};

export class UsageGatewayService {
  private cache: UsageSnapshot | null = null;
  private lastTs = 0;
  private readonly CACHE_TTL_MS: number;
  private readonly fetcher?: () => Promise<UsageSnapshot>;
  private readonly fetchDeps: UsageFetchDeps;

  constructor(opts?: UsageGatewayOptions) {
    this.fetcher = opts?.fetcher;
    this.fetchDeps = opts?.fetchDeps ?? {};
    this.CACHE_TTL_MS = opts?.cacheTtlMs ?? 60_000;
  }

  async getUsage(): Promise<UsageSnapshot> {
    const now = Date.now();
    if (this.cache && now - this.lastTs < this.CACHE_TTL_MS) {
      return this.cache;
    }
    try {
      const parsed = this.fetcher
        ? await this.fetcher()
        : await fetchCodexUsageSnapshot(this.fetchDeps);
      // Mark non-stale on a successful pull (even if ok=0 / unknown rungs).
      // Hard failures go through the catch → stale:true (fail-safe for isDepleted).
      const snap: UsageSnapshot = {
        ...parsed,
        stale: parsed.stale === true ? true : false,
        refreshed: true,
      };
      this.cache = snap;
      this.lastTs = now;
      return snap;
    } catch (e: any) {
      const safe: UsageSnapshot = {
        ts: Math.floor(now / 1000),
        stale: true,
        rungs: {},
        errors: [String(e?.message || e)],
        ok: 0,
      };
      this.cache = safe;
      this.lastTs = now;
      return safe;
    }
  }

  async isDepleted(provider: string, model: string): Promise<boolean | null> {
    const usage = await this.getUsage();
    if (usage && usage.stale) return null;
    const rung = this.mapToRung(provider, model);
    if (!rung) return null;
    const r = usage && usage.rungs ? usage.rungs[rung] : null;
    if (!r) return null;
    return !!r.depleted;
  }

  /** Exposed for tests; same mapping as private product path. */
  mapToRung(provider: string, model: string): string | null {
    // Per consensus + prior scope: codex only effective for auto-fallback today.
    if (provider !== "codex") return null;
    if (model === "gpt-5.5" || model === "gpt-5.4") return "codex55";
    if (model === "gpt-5.3-codex-spark") return "spark";
    return null;
  }
}
