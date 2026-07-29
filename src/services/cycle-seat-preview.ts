/**
 * S07 — Cycle seats/readiness preview + runtime roster mapping.
 *
 * Read-only: builds a DTO from PlanningStaffingService (pre-start) and optional
 * worker_runtimes rows (post-start). No spawns, writes, or credentials.
 */
import type { DatabaseService } from '../db/database.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import {
  PlanningStaffingService,
  type PlanningStaffingManifest,
  type StaffingSeat,
  type UnavailableInput,
} from './planning-staffing-service.js';
import type { PlannerPanelService } from './planner-panel-service.js';

export interface SeatPreviewRow {
  role: 'plancore' | 'co-planner';
  slot: number | null;
  provider: string;
  model: string;
  effort: string;
  source: string;
  ready: boolean;
  reason: string | null;
}

export interface RuntimeSeatRow {
  id: number;
  role: string;
  provider: string | null;
  model: string | null;
  session: string | null;
  state: string;
  runId: number;
  batchId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  live?: boolean;
  /** Matched against current preview identity (provider/model). */
  matchesPreview: boolean;
  previewRole: 'plancore' | 'co-planner' | null;
  previewSlot: number | null;
}

export interface CycleSeatReadiness {
  mode: 'preview' | 'runtime' | 'both';
  cycleId: number;
  projectId: number;
  digest: string | null;
  blocked: boolean;
  blockReasons: string[];
  emptyPanelMessage: string | null;
  preview: {
    plancore: SeatPreviewRow | null;
    coPlanners: SeatPreviewRow[];
  };
  runtime: {
    runId: number | null;
    seats: RuntimeSeatRow[];
    digestMatch: boolean | null;
    allIdentitiesMatch: boolean | null;
  };
}

function seatToPreview(s: StaffingSeat): SeatPreviewRow {
  return {
    role: s.role,
    slot: s.slot,
    provider: s.provider,
    model: s.model,
    effort: String(s.effort || ''),
    source: String(s.source || ''),
    ready: s.ready,
    reason: s.blockReason,
  };
}

function identityKey(provider: string | null | undefined, model: string | null | undefined): string {
  return `${String(provider || '').toLowerCase()}/${String(model || '').toLowerCase()}`;
}

/**
 * Map a staffing manifest to the public preview DTO (pure).
 */
export function manifestToSeatPreview(manifest: PlanningStaffingManifest): {
  digest: string;
  blocked: boolean;
  blockReasons: string[];
  emptyPanelMessage: string | null;
  plancore: SeatPreviewRow | null;
  coPlanners: SeatPreviewRow[];
} {
  const empty =
    manifest.panelMemberCount === 0
      ? 'Configure co-planners in Agent Studio'
      : null;
  return {
    digest: manifest.digest,
    blocked: manifest.blocked || manifest.panelMemberCount === 0,
    blockReasons: [...manifest.blockReasons],
    emptyPanelMessage: empty,
    plancore: manifest.plancore ? seatToPreview(manifest.plancore) : null,
    coPlanners: manifest.coPlanners.map(seatToPreview),
  };
}

/**
 * Match runtime worker_runtimes rows against preview identities (pure).
 * Digest match: every ready preview seat has a runtime row with same provider/model
 * (and plancore present when preview has plancore).
 */
export function mapRuntimeToPreview(
  runtimeSeats: Array<Omit<RuntimeSeatRow, 'matchesPreview' | 'previewRole' | 'previewSlot'>>,
  preview: { plancore: SeatPreviewRow | null; coPlanners: SeatPreviewRow[] }
): {
  seats: RuntimeSeatRow[];
  digestMatch: boolean | null;
  allIdentitiesMatch: boolean | null;
  runId: number | null;
} {
  if (!runtimeSeats.length) {
    return { seats: [], digestMatch: null, allIdentitiesMatch: null, runId: null };
  }

  const previewIdentities: Array<{
    key: string;
    role: 'plancore' | 'co-planner';
    slot: number | null;
  }> = [];
  if (preview.plancore) {
    previewIdentities.push({
      key: identityKey(preview.plancore.provider, preview.plancore.model),
      role: 'plancore',
      slot: null,
    });
  }
  for (const c of preview.coPlanners) {
    previewIdentities.push({
      key: identityKey(c.provider, c.model),
      role: 'co-planner',
      slot: c.slot,
    });
  }

  const used = new Set<string>();
  const seats: RuntimeSeatRow[] = runtimeSeats.map((r) => {
    const key = identityKey(r.provider, r.model);
    const match = previewIdentities.find((p) => p.key === key && !used.has(`${p.role}:${p.slot}`));
    if (match) used.add(`${match.role}:${match.slot}`);
    return {
      ...r,
      matchesPreview: !!match,
      previewRole: match?.role ?? null,
      previewSlot: match?.slot ?? null,
    };
  });

  const readyPreview = [
    ...(preview.plancore && preview.plancore.ready ? [preview.plancore] : []),
    ...preview.coPlanners.filter((c) => c.ready),
  ];
  const allIdentitiesMatch =
    readyPreview.length === 0
      ? seats.every((s) => s.matchesPreview)
      : readyPreview.every((p) =>
          seats.some(
            (s) =>
              s.matchesPreview &&
              identityKey(s.provider, s.model) === identityKey(p.provider, p.model)
          )
        );

  const runId = runtimeSeats[runtimeSeats.length - 1]?.runId ?? runtimeSeats[0]?.runId ?? null;

  return {
    seats,
    digestMatch: allIdentitiesMatch,
    allIdentitiesMatch,
    runId,
  };
}

/**
 * Build full cycle seat readiness DTO (read-only; may read DB via staffing resolve).
 */
export function buildCycleSeatReadiness(opts: {
  db: DatabaseService;
  assignments: AgentAssignmentService;
  plannerPanel?: PlannerPanelService;
  cycleId: number;
  projectId: number;
  runtimeSeats: Array<Omit<RuntimeSeatRow, 'matchesPreview' | 'previewRole' | 'previewSlot'>>;
  unavailable?: UnavailableInput;
}): CycleSeatReadiness {
  const staffing = new PlanningStaffingService(opts.db, opts.assignments, opts.plannerPanel);
  let previewBlock: {
    digest: string | null;
    blocked: boolean;
    blockReasons: string[];
    emptyPanelMessage: string | null;
    plancore: SeatPreviewRow | null;
    coPlanners: SeatPreviewRow[];
  };
  try {
    const manifest = staffing.resolveManifest(opts.projectId, {
      throwOnEmpty: false,
      throwOnMismatch: false,
      unavailable: opts.unavailable,
    });
    previewBlock = manifestToSeatPreview(manifest);
  } catch (e: any) {
    previewBlock = {
      digest: null,
      blocked: true,
      blockReasons: [String(e?.message || e)],
      emptyPanelMessage: 'Configure co-planners in Agent Studio',
      plancore: null,
      coPlanners: [],
    };
  }

  const mapped = mapRuntimeToPreview(opts.runtimeSeats, {
    plancore: previewBlock.plancore,
    coPlanners: previewBlock.coPlanners,
  });

  const hasRuntime = opts.runtimeSeats.length > 0;
  const mode: CycleSeatReadiness['mode'] = hasRuntime
    ? previewBlock.plancore || previewBlock.coPlanners.length
      ? 'both'
      : 'runtime'
    : 'preview';

  return {
    mode,
    cycleId: opts.cycleId,
    projectId: opts.projectId,
    digest: previewBlock.digest || null,
    blocked: previewBlock.blocked,
    blockReasons: previewBlock.blockReasons,
    emptyPanelMessage: previewBlock.emptyPanelMessage,
    preview: {
      plancore: previewBlock.plancore,
      coPlanners: previewBlock.coPlanners,
    },
    runtime: {
      runId: mapped.runId,
      seats: mapped.seats,
      digestMatch: mapped.digestMatch,
      allIdentitiesMatch: mapped.allIdentitiesMatch,
    },
  };
}
