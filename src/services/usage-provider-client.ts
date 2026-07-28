/**
 * Helm-owned provider usage client (Q-12).
 *
 * Reads Codex usage from the provider's wham/usage endpoint using local Codex
 * auth. Does NOT shell out to crew scaffolding (~/.claude/agents/lib/agent-usage.sh).
 *
 * Product rungs (see UsageGatewayService.mapToRung): codex55, spark (live Codex
 * fetch); house ladder also normalizes grok45 + haiku (S17/AC30 — injected or
 * future provider clients; this file still only fetches Codex).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type RungStatus = {
  headroom: number | null;
  depleted: boolean;
  worst_bucket: number | null;
  unknown?: boolean;
};

export type UsageSnapshot = {
  ts: number;
  rungs: Record<string, RungStatus>;
  raw?: {
    codex?: {
      shared_5h: number | null;
      shared_weekly: number | null;
      spark_5h: number | null;
      spark_weekly: number | null;
      credits?: unknown;
    };
  };
  errors: string[];
  ok: number;
  age_min?: number;
  refreshed?: boolean;
  stale?: boolean;
};

export type CodexAuth = { accessToken: string; accountId?: string };

export type UsageFetchDeps = {
  fetchImpl?: typeof fetch;
  readCodexAuth?: () => CodexAuth | null;
  depletedPct?: number;
  nowSec?: () => number;
  usageUrl?: string;
};

const DEFAULT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function usedPercent(d: unknown, ...keys: string[]): number | null {
  let cur: any = d;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[k];
  }
  if (cur && typeof cur === "object") {
    if ("used_percent" in cur && cur.used_percent != null) return Number(cur.used_percent);
    if ("utilization" in cur && cur.utilization != null) return Number(cur.utilization);
  }
  return null;
}

/** Worst-bucket headroom/depleted for a set of utilization percentages. */
export function rungFromBuckets(
  buckets: Array<number | null | undefined>,
  depletedPct: number,
): RungStatus {
  const vals = buckets.filter((v): v is number => v != null && !Number.isNaN(Number(v))).map(Number);
  if (!vals.length) {
    return { headroom: null, depleted: false, worst_bucket: null, unknown: true };
  }
  const worst = Math.max(...vals);
  return {
    headroom: Math.round((100 - worst) * 10) / 10,
    depleted: worst >= depletedPct,
    worst_bucket: Math.round(worst * 10) / 10,
  };
}

/** Load Codex OAuth tokens from CODEX_HOME/auth.json (or ~/.codex/auth.json). */
export function defaultReadCodexAuth(): CodexAuth | null {
  const authPath = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "auth.json",
  );
  try {
    const a = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const tok = (a?.tokens && a.tokens.access_token) || a?.access_token;
    if (!tok) return null;
    const acct = (a?.tokens && a.tokens.account_id) || a?.account_id;
    return { accessToken: String(tok), accountId: acct ? String(acct) : undefined };
  } catch {
    return null;
  }
}

/**
 * Pull Codex usage and compute product rungs (codex55, spark).
 * Never throws on endpoint/auth failure — returns snapshot with errors[] and ok=0.
 *
 * Spark rung currently includes shared codex windows for behavioural parity with the
 * old crew gateway (documented Q-01 suspect fold-in). Fixing that fold is a separate
 * product decision, not this ownership move.
 */
export async function fetchCodexUsageSnapshot(deps: UsageFetchDeps = {}): Promise<UsageSnapshot> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const readAuth = deps.readCodexAuth ?? defaultReadCodexAuth;
  const depletedPct = deps.depletedPct ?? Number(process.env.HELM_USAGE_DEPLETED_PCT || 95);
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const usageUrl = deps.usageUrl ?? DEFAULT_USAGE_URL;
  const errors: string[] = [];

  let codex: any = null;
  try {
    const auth = readAuth();
    if (!auth?.accessToken) {
      throw new Error("no codex access token");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      "User-Agent": "helm-usage-gateway",
    };
    if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

    const res = await fetchImpl(usageUrl, { headers });
    if (!res.ok) {
      throw new Error(`wham/usage HTTP ${res.status}`);
    }
    codex = await res.json();
  } catch (e: any) {
    errors.push(`codex: ${String(e?.message || e)}`);
  }

  const cx_5h = codex ? usedPercent(codex, "rate_limit", "primary_window") : null;
  const cx_wk = codex ? usedPercent(codex, "rate_limit", "secondary_window") : null;
  let spark_5h: number | null = null;
  let spark_wk: number | null = null;
  if (codex) {
    for (const ar of codex.additional_rate_limits || []) {
      if (String(ar?.limit_name || "").toLowerCase().startsWith("gpt-5.3-codex-spark")) {
        spark_5h = usedPercent(ar, "rate_limit", "primary_window");
        spark_wk = usedPercent(ar, "rate_limit", "secondary_window");
      }
    }
  }

  return {
    ts: nowSec(),
    rungs: {
      codex55: rungFromBuckets([cx_5h, cx_wk], depletedPct),
      // Q-01 parity: shared windows folded into spark (crew gateway did the same).
      spark: rungFromBuckets([cx_5h, cx_wk, spark_5h, spark_wk], depletedPct),
    },
    raw: {
      codex: {
        shared_5h: cx_5h,
        shared_weekly: cx_wk,
        spark_5h,
        spark_weekly: spark_wk,
        credits: codex?.credits?.balance,
      },
    },
    errors,
    ok: codex ? 1 : 0,
  };
}
