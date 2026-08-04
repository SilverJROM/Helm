/**
 * Q-12: Helm owns usage gateway — no shell to crew agent-usage.sh.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageGatewayService } from "./usage-gateway-service.js";
import {
  fetchCodexUsageSnapshot,
  rungFromBuckets,
  type UsageSnapshot,
} from "./usage-provider-client.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GATEWAY_SRC = path.join(REPO_ROOT, "src/services/usage-gateway-service.ts");
const CLIENT_SRC = path.join(REPO_ROOT, "src/services/usage-provider-client.ts");

describe("Q-12 usage gateway: no crew agent-usage.sh shell", () => {
  it("source does not shell agent-usage.sh or ~/.claude/agents/lib", () => {
    const stripComments = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const gw = stripComments(fs.readFileSync(GATEWAY_SRC, "utf8"));
    const client = stripComments(fs.readFileSync(CLIENT_SRC, "utf8"));
    const both = gw + "\n" + client;
    // No live code path to crew script (comments may name it as forbidden).
    expect(both).not.toMatch(/agent-usage\.sh/);
    expect(both).not.toMatch(/\.claude\/agents\/lib/);
    expect(gw).not.toMatch(/execFile|child_process|promisify/);
    expect(client).not.toMatch(/execFile|child_process/);
  });

  it("injectable fake: isDepleted respects rungs without live endpoints", async () => {
    const fakeSnap: UsageSnapshot = {
      ts: Math.floor(Date.now() / 1000),
      stale: false,
      ok: 1,
      errors: [],
      rungs: {
        codex55: { headroom: 2, depleted: true, worst_bucket: 98 },
        spark: { headroom: 40, depleted: false, worst_bucket: 60 },
      },
    };
    const gw = new UsageGatewayService({ fetcher: async () => fakeSnap });
    expect(await gw.isDepleted("codex", "gpt-5.5")).toBe(true);
    expect(await gw.isDepleted("codex", "gpt-5.4")).toBe(true);
    expect(await gw.isDepleted("codex", "gpt-5.3-codex-spark")).toBe(false);
    expect(await gw.isDepleted("grok", "grok-4.5")).toBeNull();
    expect(await gw.isDepleted("codex", "unknown-model")).toBeNull();
  });

  it("deterministic stale path: fetcher throw → stale → isDepleted null", async () => {
    const gw = new UsageGatewayService({
      fetcher: async () => {
        throw new Error("network down");
      },
    });
    const u = await gw.getUsage();
    expect(u.stale).toBe(true);
    expect(u.rungs).toEqual({});
    expect(u.errors?.[0]).toMatch(/network down/);
    expect(await gw.isDepleted("codex", "gpt-5.5")).toBeNull();
  });

  it("mapToRung covers codex55/spark + house ladder (grok45/haiku); unrelated stay null", () => {
    const gw = new UsageGatewayService({
      fetcher: async () => ({ ts: 0, rungs: {}, errors: [], ok: 0 }),
    });
    expect(gw.mapToRung("codex", "gpt-5.5")).toBe("codex55");
    expect(gw.mapToRung("codex", "gpt-5.4")).toBe("codex55");
    expect(gw.mapToRung("codex", "gpt-5.3-codex-spark")).toBe("spark");
    // S17 house ladder
    expect(gw.mapToRung("grok", "grok-4.5")).toBe("grok45");
    expect(gw.mapToRung("claude", "claude-haiku-4-5")).toBe("haiku");
    expect(gw.mapToRung("claude", "sonnet")).toBeNull();
    expect(gw.mapToRung("codex", "gpt-5.3-codex")).toBeNull();
  });

  it("getUsage caches within TTL (single fetcher call)", async () => {
    let calls = 0;
    const gw = new UsageGatewayService({
      cacheTtlMs: 60_000,
      fetcher: async () => {
        calls += 1;
        return {
          ts: 1,
          stale: false,
          ok: 1,
          errors: [],
          rungs: { codex55: { headroom: 10, depleted: false, worst_bucket: 90 } },
        };
      },
    });
    await gw.getUsage();
    await gw.getUsage();
    expect(calls).toBe(1);
  });

  it("rungFromBuckets: depleted at threshold, unknown when empty", () => {
    expect(rungFromBuckets([null, undefined], 95).unknown).toBe(true);
    expect(rungFromBuckets([null, undefined], 95).depleted).toBe(false);
    expect(rungFromBuckets([90, 96], 95)).toMatchObject({
      depleted: true,
      worst_bucket: 96,
      headroom: 4,
    });
    expect(rungFromBuckets([10, 20], 95).depleted).toBe(false);
  });

  it("fetchCodexUsageSnapshot works without crew script (injected auth+fetch)", async () => {
    // Prove production path does not need ~/.claude/agents/lib/agent-usage.sh to exist.
    const crewScript = path.join(
      process.env.HOME || "/tmp",
      ".claude/agents/lib/agent-usage.sh",
    );
    // We do not delete the real crew script; we simply never call it.
    const body = {
      rate_limit: {
        primary_window: { used_percent: 12 },
        secondary_window: { used_percent: 34 },
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            primary_window: { used_percent: 5 },
            secondary_window: { used_percent: 8 },
          },
        },
      ],
      credits: { balance: 0 },
    };
    const snap = await fetchCodexUsageSnapshot({
      readCodexAuth: () => ({ accessToken: "test-token", accountId: "acct" }),
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => body,
        }) as Response) as typeof fetch,
      depletedPct: 95,
      nowSec: () => 1_700_000_000,
    });
    expect(snap.ok).toBe(1);
    expect(snap.rungs.codex55.depleted).toBe(false);
    expect(snap.rungs.codex55.worst_bucket).toBe(34);
    expect(snap.rungs.spark.worst_bucket).toBe(34); // shared fold-in max
    expect(snap.raw?.codex?.spark_weekly).toBe(8);
    expect(snap.errors).toEqual([]);
    // Smoke: gateway using same deps never touches crew path.
    const gw = new UsageGatewayService({
      fetchDeps: {
        readCodexAuth: () => ({ accessToken: "t" }),
        fetchImpl: (async () =>
          ({
            ok: true,
            status: 200,
            json: async () => body,
          }) as Response) as typeof fetch,
      },
    });
    const u = await gw.getUsage();
    expect(u.stale).toBe(false);
    expect(await gw.isDepleted("codex", "gpt-5.5")).toBe(false);
    // crew script may or may not exist on this host — product path must not require it
    void crewScript;
  });

  it("auth/endpoint failure returns ok=0 snapshot (not throw); gateway non-stale unknown rungs", async () => {
    const snap = await fetchCodexUsageSnapshot({
      readCodexAuth: () => null,
      fetchImpl: vi.fn() as any,
    });
    expect(snap.ok).toBe(0);
    expect(snap.errors[0]).toMatch(/codex:/);
    expect(snap.rungs.codex55.unknown).toBe(true);

    const gw = new UsageGatewayService({
      fetcher: async () => snap,
    });
    // non-stale + unknown rung with depleted:false → isDepleted returns false (available)
    expect(await gw.isDepleted("codex", "gpt-5.5")).toBe(false);
  });
});
