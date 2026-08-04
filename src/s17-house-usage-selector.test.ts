/**
 * S17 / AC30 — house-scoped usage selector (injected snapshots only).
 * HELM_SESSION_JANITOR must remain 0. No live endpoints, no crew shell.
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageGatewayService } from "./services/usage-gateway-service.js";
import type { UsageSnapshot } from "./services/usage-provider-client.js";
import {
  HOUSE_LADDER_DEFAULT,
  HouseUsageSelector,
  selectHouseUsageRung,
} from "./services/house-usage-selector.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELECTOR_SRC = path.join(REPO_ROOT, "src/services/house-usage-selector.ts");
const GATEWAY_SRC = path.join(REPO_ROOT, "src/services/usage-gateway-service.ts");

function snap(partial: Partial<UsageSnapshot> & { rungs: UsageSnapshot["rungs"] }): UsageSnapshot {
  return {
    ts: Math.floor(Date.now() / 1000),
    stale: false,
    ok: 1,
    errors: [],
    ...partial,
  };
}

function healthy(headroom = 40) {
  return { headroom, depleted: false, worst_bucket: 100 - headroom };
}
function depleted(worst = 98) {
  return { headroom: Math.max(0, 100 - worst), depleted: true, worst_bucket: worst };
}
function unknown() {
  return { headroom: null, depleted: false, worst_bucket: null, unknown: true as const };
}

describe("S17 house usage selector (AC30)", () => {
  beforeAll(() => {
    // HARD SAFETY: never enable janitor in this suite.
    process.env.HELM_SESSION_JANITOR = "0";
  });

  it("source does not shell agent-usage.sh or spawn a parallel usage subsystem", () => {
    const stripComments = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
    const sel = stripComments(fs.readFileSync(SELECTOR_SRC, "utf8"));
    const gw = stripComments(fs.readFileSync(GATEWAY_SRC, "utf8"));
    expect(sel).not.toMatch(/agent-usage\.sh/);
    expect(sel).not.toMatch(/child_process|execFile|spawn\(/);
    expect(gw).not.toMatch(/agent-usage\.sh/);
    expect(HOUSE_LADDER_DEFAULT.map((e) => e.slug)).toEqual(["grok45", "spark", "haiku"]);
  });

  it("mapToRung covers house ladder + retained codex55", () => {
    const gw = new UsageGatewayService({
      fetcher: async () => snap({ rungs: {} }),
    });
    expect(gw.mapToRung("grok", "grok-4.5")).toBe("grok45");
    expect(gw.mapToRung("codex", "gpt-5.3-codex-spark")).toBe("spark");
    expect(gw.mapToRung("claude", "claude-haiku-4-5")).toBe("haiku");
    expect(gw.mapToRung("codex", "gpt-5.5")).toBe("codex55");
    expect(gw.mapToRung("claude", "sonnet")).toBeNull();
    expect(gw.mapToRung("grok", "grok-composer-2.5-fast")).toBeNull();
  });

  it("healthy main wins (grok45) and records choice/reason", async () => {
    const fake: UsageSnapshot = snap({
      rungs: {
        grok45: healthy(50),
        spark: healthy(40),
        haiku: healthy(30),
      },
    });
    const gw = new UsageGatewayService({ fetcher: async () => fake });
    const selector = new HouseUsageSelector({ gateway: gw });
    const result = await selector.select();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe("selected");
    expect(result.slug).toBe("grok45");
    expect(result.provider).toBe("grok");
    expect(result.model).toBe("grok-4.5");
    expect(result.rungIndex).toBe(0);
    expect(result.mappedRung).toBe("grok45");
    expect(result.reason).toBe("main_healthy");
    expect(result.skipped).toEqual([]);
    expect(selector.getLastChoice()).toEqual(result);
  });

  it("depleted main → backup1 spark; reason recorded", async () => {
    const fake: UsageSnapshot = snap({
      rungs: {
        grok45: depleted(99),
        spark: healthy(35),
        haiku: healthy(20),
      },
    });
    const gw = new UsageGatewayService({ fetcher: async () => fake });
    const result = await selectHouseUsageRung(gw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe("spark");
    expect(result.provider).toBe("codex");
    expect(result.model).toBe("gpt-5.3-codex-spark");
    expect(result.rungIndex).toBe(1);
    expect(result.reason).toBe("backup1_after_depleted_main");
    expect(result.skipped).toEqual([
      expect.objectContaining({ slug: "grok45", reason: "depleted", rungIndex: 0 }),
    ]);
  });

  it("two depleted rungs → backup2 haiku; reason recorded", async () => {
    const fake: UsageSnapshot = snap({
      rungs: {
        grok45: depleted(97),
        spark: depleted(96),
        haiku: healthy(55),
      },
    });
    const gw = new UsageGatewayService({ fetcher: async () => fake });
    const result = await selectHouseUsageRung(gw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slug).toBe("haiku");
    expect(result.provider).toBe("claude");
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.rungIndex).toBe(2);
    expect(result.reason).toBe("backup2_after_two_depleted");
    expect(result.skipped.map((s) => s.slug)).toEqual(["grok45", "spark"]);
    expect(result.skipped.every((s) => s.reason === "depleted")).toBe(true);
  });

  it("all depleted → typed no_dispatch with reason", async () => {
    const fake: UsageSnapshot = snap({
      rungs: {
        grok45: depleted(),
        spark: depleted(),
        haiku: depleted(),
      },
    });
    const gw = new UsageGatewayService({ fetcher: async () => fake });
    const result = await selectHouseUsageRung(gw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("no_dispatch");
    expect(result.reason).toBe("all_depleted");
    expect(result.skipped).toHaveLength(3);
  });

  it("all unknown/missing → typed no_dispatch (fail-safe)", async () => {
    const fake: UsageSnapshot = snap({
      rungs: {
        grok45: unknown(),
        // spark missing
        haiku: unknown(),
      },
    });
    const gw = new UsageGatewayService({ fetcher: async () => fake });
    const result = await selectHouseUsageRung(gw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("no_dispatch");
    expect(result.reason).toBe("all_unknown_or_unavailable");
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "unknown",
      "missing_rung",
      "unknown",
    ]);
  });

  it("stale snapshot → no_dispatch reason=stale_usage (fail-safe)", async () => {
    const gw = new UsageGatewayService({
      fetcher: async () => {
        throw new Error("network down");
      },
    });
    const result = await selectHouseUsageRung(gw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("no_dispatch");
    expect(result.reason).toBe("stale_usage");
    expect(result.skipped).toEqual([]);
  });

  it("mixed unavailable (depleted+unknown) still fail-safe no_dispatch when none healthy", async () => {
    const fake: UsageSnapshot = snap({
      rungs: {
        grok45: depleted(),
        spark: unknown(),
        haiku: unknown(),
      },
    });
    const gw = new UsageGatewayService({ fetcher: async () => fake });
    const result = await selectHouseUsageRung(gw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.outcome).toBe("no_dispatch");
    expect(result.reason).toBe("all_unavailable");
  });

  it("isDepleted for unmapped/missing house rung remains null (no false available)", async () => {
    const gw = new UsageGatewayService({
      fetcher: async () =>
        snap({
          rungs: {
            spark: healthy(),
          },
        }),
    });
    // mapped but missing status → null (same fail-safe as pre-S17 for unknown models)
    expect(await gw.isDepleted("grok", "grok-4.5")).toBeNull();
    expect(await gw.isDepleted("claude", "claude-haiku-4-5")).toBeNull();
    expect(await gw.isDepleted("codex", "gpt-5.3-codex-spark")).toBe(false);
  });
});
