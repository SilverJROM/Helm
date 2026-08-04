/**
 * S17 / AC30 — house-scoped ordered usage selector (grok45 → spark → haiku).
 *
 * Reuses UsageGatewayService only. Does NOT shell crew agent-usage.sh and does
 * not invent a parallel usage subsystem. Choice + reason are returned on every
 * call for S18a to persist; this module does not spawn or write DB.
 *
 * Fail-safe: stale snapshot, unmapped model, missing rung, or rung.unknown are
 * not selectable. depleted:true skips to the next ladder entry. All skipped →
 * typed no_dispatch.
 */
import type { UsageGatewayService } from "./usage-gateway-service.js";
import type { RungStatus, UsageSnapshot } from "./usage-provider-client.js";

export type HouseLadderEntry = {
  provider: string;
  model: string;
  /** Product slug (matches Studio / seed: grok45, spark, haiku). */
  slug: string;
};

/** Default housekeeper ladder: main → backup1 → backup2. */
export const HOUSE_LADDER_DEFAULT: readonly HouseLadderEntry[] = [
  { provider: "grok", model: "grok-4.5", slug: "grok45" },
  { provider: "codex", model: "gpt-5.3-codex-spark", slug: "spark" },
  { provider: "claude", model: "claude-haiku-4-5", slug: "haiku" },
] as const;

export type HouseSkipReason = "unmapped" | "missing_rung" | "unknown" | "depleted";

export type HouseSkipRecord = {
  provider: string;
  model: string;
  slug: string;
  rungIndex: number;
  mappedRung: string | null;
  reason: HouseSkipReason;
};

export type HouseSelectSelected = {
  ok: true;
  outcome: "selected";
  provider: string;
  model: string;
  slug: string;
  /** 0 = main, 1 = backup1, 2 = backup2, … */
  rungIndex: number;
  mappedRung: string;
  reason: string;
  skipped: HouseSkipRecord[];
};

export type HouseSelectNoDispatch = {
  ok: false;
  outcome: "no_dispatch";
  reason: string;
  skipped: HouseSkipRecord[];
};

export type HouseSelectResult = HouseSelectSelected | HouseSelectNoDispatch;

export type HouseUsageSelectorOptions = {
  gateway: UsageGatewayService;
  ladder?: readonly HouseLadderEntry[];
};

/**
 * Thin wrapper that remembers the last selection for in-process audit.
 * S18a persists the returned result; this does not write DB.
 */
export class HouseUsageSelector {
  private readonly gateway: UsageGatewayService;
  private readonly ladder: readonly HouseLadderEntry[];
  private lastChoice: HouseSelectResult | null = null;

  constructor(opts: HouseUsageSelectorOptions) {
    this.gateway = opts.gateway;
    this.ladder = opts.ladder ?? HOUSE_LADDER_DEFAULT;
  }

  getLastChoice(): HouseSelectResult | null {
    return this.lastChoice;
  }

  async select(): Promise<HouseSelectResult> {
    const result = await selectHouseUsageRung(this.gateway, this.ladder);
    this.lastChoice = result;
    return result;
  }
}

/**
 * Ordered house selection against a single usage snapshot from the gateway.
 * Pure decision after getUsage(); no shell-out, no spawn.
 */
export async function selectHouseUsageRung(
  gateway: UsageGatewayService,
  ladder: readonly HouseLadderEntry[] = HOUSE_LADDER_DEFAULT,
): Promise<HouseSelectResult> {
  const usage = await gateway.getUsage();
  return selectHouseUsageFromSnapshot(gateway, usage, ladder);
}

/** Testable pure path once a snapshot is in hand. */
export function selectHouseUsageFromSnapshot(
  gateway: Pick<UsageGatewayService, "mapToRung">,
  usage: UsageSnapshot,
  ladder: readonly HouseLadderEntry[] = HOUSE_LADDER_DEFAULT,
): HouseSelectResult {
  if (usage.stale === true) {
    return {
      ok: false,
      outcome: "no_dispatch",
      reason: "stale_usage",
      skipped: [],
    };
  }

  const skipped: HouseSkipRecord[] = [];
  const rungs = usage.rungs ?? {};

  for (let i = 0; i < ladder.length; i++) {
    const entry = ladder[i]!;
    const mappedRung = gateway.mapToRung(entry.provider, entry.model);
    if (!mappedRung) {
      skipped.push({
        ...entry,
        rungIndex: i,
        mappedRung: null,
        reason: "unmapped",
      });
      continue;
    }

    const status: RungStatus | undefined = rungs[mappedRung];
    if (!status) {
      skipped.push({
        ...entry,
        rungIndex: i,
        mappedRung,
        reason: "missing_rung",
      });
      continue;
    }
    if (status.unknown === true) {
      skipped.push({
        ...entry,
        rungIndex: i,
        mappedRung,
        reason: "unknown",
      });
      continue;
    }
    if (status.depleted === true) {
      skipped.push({
        ...entry,
        rungIndex: i,
        mappedRung,
        reason: "depleted",
      });
      continue;
    }

    // Known + not depleted → first win.
    const reason = selectionReason(i, skipped);
    return {
      ok: true,
      outcome: "selected",
      provider: entry.provider,
      model: entry.model,
      slug: entry.slug,
      rungIndex: i,
      mappedRung,
      reason,
      skipped,
    };
  }

  return {
    ok: false,
    outcome: "no_dispatch",
    reason: noDispatchReason(skipped),
    skipped,
  };
}

function selectionReason(rungIndex: number, skipped: HouseSkipRecord[]): string {
  if (rungIndex === 0) return "main_healthy";
  if (rungIndex === 1) {
    const depleteCount = skipped.filter((s) => s.reason === "depleted").length;
    if (depleteCount >= 1) return "backup1_after_depleted_main";
    return "backup1_after_unavailable_main";
  }
  if (rungIndex === 2) {
    const depleteCount = skipped.filter((s) => s.reason === "depleted").length;
    if (depleteCount >= 2) return "backup2_after_two_depleted";
    return "backup2_after_prior_unavailable";
  }
  return `selected_rung_${rungIndex}`;
}

function noDispatchReason(skipped: HouseSkipRecord[]): string {
  if (!skipped.length) return "empty_ladder";
  const allUnknown = skipped.every(
    (s) => s.reason === "unknown" || s.reason === "missing_rung" || s.reason === "unmapped",
  );
  if (allUnknown) return "all_unknown_or_unavailable";
  const allDepleted = skipped.every((s) => s.reason === "depleted");
  if (allDepleted) return "all_depleted";
  return "all_unavailable";
}
