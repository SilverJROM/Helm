/**
 * B24 / Q-08 — Contract v2 topology export (export-only).
 *
 * Produces a v2-shaped topology document from a v1 (or v1-compatible) stamp.
 * Does NOT mutate the live run stamp: projcore validates fail-closed against v1 for
 * this cycle. The tool cannot be rebuilt while it is holding itself.
 *
 * v2 shape deltas vs v1 (north-star / plan):
 * - contract_version: 2
 * - planners.min ≥ 1 (v1 required exactly 2 co_planners)
 * - per-tier implementer backup (+ backup_launch when present) preserved
 * - explicit escalation / AVAILABILITY stamping fields (I6: AVAILABILITY ≠ DIFFICULTY)
 *
 * R8: no routing/plumbing imports.
 */
import fs from 'node:fs';

export type TierId = 'L1' | 'L2' | 'L3';

export interface TierSeat {
  model: string;
  backup?: string;
  launch?: string;
  backup_launch?: string;
}

export interface CoPlanner {
  id: string;
  model: string;
  launch?: string;
}

/** Minimal v1 fields required for export. Extra keys are ignored. */
export interface TopologyV1Like {
  contract_version: number;
  run_id?: string;
  project?: string;
  north_star_ref?: string;
  cycle_north_star_ref?: string;
  stamped_by?: string;
  stamped_at?: string;
  base_commit?: string;
  base_branch?: string;
  planning_criticality?: string;
  coordinator_session?: string;
  co_planners: CoPlanner[];
  implementer: Record<TierId, TierSeat>;
  validator: Record<TierId, TierSeat>;
  deliberation_panel?: unknown;
  redteam_panel?: unknown;
  routing_notes?: unknown;
  known_registry_defects?: unknown;
}

export interface TopologyV2Export {
  contract_version: 2;
  /** Explicit v2 marker (redundant with contract_version; stable for greppable asserts). */
  contract_v2: true;
  /** v2 rule: planners ≥ 1 (relaxed from v1 exactly-2). */
  planners: {
    min: number;
    rule: string;
  };
  run_id?: string;
  project?: string;
  north_star_ref?: string;
  cycle_north_star_ref?: string;
  stamped_by?: string;
  stamped_at?: string;
  base_commit?: string;
  base_branch?: string;
  planning_criticality?: string;
  coordinator_session?: string;
  co_planners: CoPlanner[];
  implementer: Record<TierId, TierSeat>;
  validator: Record<TierId, TierSeat>;
  /**
   * AVAILABILITY stamping / escalation-reason schema for contract v2.
   * Lateral (same-tier backup) is AVAILABILITY; vertical climb is DIFFICULTY.
   */
  escalation: {
    lateral_cause: 'AVAILABILITY';
    vertical_cause: 'DIFFICULTY';
    stamp_reasons: ReadonlyArray<'AS_INTENDED' | 'AVAILABILITY' | 'DIFFICULTY' | 'COUPLING'>;
    availability_not_difficulty: true;
    dual_unavailable: 'stall_and_flag_jrom';
  };
  export_meta: {
    source_contract_version: number;
    export_kind: 'contract_v2_shape';
    exported_at: string;
    source_path?: string;
  };
  deliberation_panel?: unknown;
  redteam_panel?: unknown;
  routing_notes?: unknown;
  known_registry_defects?: unknown;
}

const TIERS: TierId[] = ['L1', 'L2', 'L3'];

const STAMP_REASONS = ['AS_INTENDED', 'AVAILABILITY', 'DIFFICULTY', 'COUPLING'] as const;

export function assertV1Like(doc: TopologyV1Like): void {
  if (doc.contract_version !== 1) {
    throw new Error(
      `exportTopologyContractV2 expects source contract_version 1, got ${doc.contract_version}`
    );
  }
  if (!Array.isArray(doc.co_planners) || doc.co_planners.length < 1) {
    throw new Error('v1 topology must have at least one co_planner to export');
  }
  for (const t of TIERS) {
    const seat = doc.implementer?.[t];
    if (!seat?.model) throw new Error(`implementer.${t}.model required`);
  }
  for (const t of TIERS) {
    const seat = doc.validator?.[t];
    if (!seat?.model) throw new Error(`validator.${t}.model required`);
  }
}

/**
 * Pure export: v1-like stamp → contract v2 shape.
 * Does not write files; does not mutate the input object.
 */
export function exportTopologyContractV2(
  v1: TopologyV1Like,
  opts?: { exportedAt?: string; sourcePath?: string }
): TopologyV2Export {
  assertV1Like(v1);

  const implementer = {} as Record<TierId, TierSeat>;
  for (const t of TIERS) {
    const src = v1.implementer[t];
    const seat: TierSeat = { model: src.model };
    if (src.backup !== undefined) seat.backup = src.backup;
    if (src.launch !== undefined) seat.launch = src.launch;
    if (src.backup_launch !== undefined) seat.backup_launch = src.backup_launch;
    implementer[t] = seat;
  }

  const validator = {} as Record<TierId, TierSeat>;
  for (const t of TIERS) {
    const src = v1.validator[t];
    const seat: TierSeat = { model: src.model };
    if (src.launch !== undefined) seat.launch = src.launch;
    // validator is backup-less by design; do not invent backups
    validator[t] = seat;
  }

  const out: TopologyV2Export = {
    contract_version: 2,
    contract_v2: true,
    planners: {
      min: 1,
      rule: 'planners >= 1 (v2; v1 required exactly 2 co_planners)',
    },
    co_planners: v1.co_planners.map((p) => ({
      id: p.id,
      model: p.model,
      ...(p.launch !== undefined ? { launch: p.launch } : {}),
    })),
    implementer,
    validator,
    escalation: {
      lateral_cause: 'AVAILABILITY',
      vertical_cause: 'DIFFICULTY',
      stamp_reasons: [...STAMP_REASONS],
      availability_not_difficulty: true,
      dual_unavailable: 'stall_and_flag_jrom',
    },
    export_meta: {
      source_contract_version: v1.contract_version,
      export_kind: 'contract_v2_shape',
      exported_at: opts?.exportedAt ?? new Date().toISOString(),
      ...(opts?.sourcePath ? { source_path: opts.sourcePath } : {}),
    },
  };

  // Optional identity / panel passthrough (present on live c01 stamp).
  for (const k of [
    'run_id',
    'project',
    'north_star_ref',
    'cycle_north_star_ref',
    'stamped_by',
    'stamped_at',
    'base_commit',
    'base_branch',
    'planning_criticality',
    'coordinator_session',
  ] as const) {
    if (v1[k] !== undefined) (out as any)[k] = v1[k];
  }
  if (v1.deliberation_panel !== undefined) out.deliberation_panel = v1.deliberation_panel;
  if (v1.redteam_panel !== undefined) out.redteam_panel = v1.redteam_panel;
  if (v1.routing_notes !== undefined) out.routing_notes = v1.routing_notes;
  if (v1.known_registry_defects !== undefined) {
    out.known_registry_defects = v1.known_registry_defects;
  }

  return out;
}

/** Unquote a YAML scalar (double/single/plain). */
function unquoteScalar(raw: string): string {
  const s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  // strip inline comments for plain scalars (not inside quotes)
  const hash = s.indexOf(' #');
  return (hash >= 0 ? s.slice(0, hash) : s).trim();
}

/**
 * Minimal topology.yaml loader for the c01 v1 stamp shape.
 * Not a general YAML parser — sufficient for Q-08 export of known structure.
 */
export function parseTopologyYamlMinimal(text: string): TopologyV1Like {
  const lines = text.split(/\r?\n/);

  const topScalars: Record<string, string> = {};
  const coPlanners: CoPlanner[] = [];
  const implementer: Partial<Record<TierId, TierSeat>> = {};
  const validator: Partial<Record<TierId, TierSeat>> = {};

  type Mode =
    | 'top'
    | 'co_planners'
    | 'implementer'
    | 'validator'
    | 'skip_block';
  let mode: Mode = 'top';
  let currentPlanner: CoPlanner | null = null;
  let currentTier: TierId | null = null;
  let skipIndent = 0;

  const topKeys = new Set([
    'contract_version',
    'run_id',
    'project',
    'north_star_ref',
    'cycle_north_star_ref',
    'stamped_by',
    'stamped_at',
    'base_commit',
    'base_branch',
    'planning_criticality',
    'coordinator_session',
  ]);

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '' || line.trim() === '---') continue;

    const indent = line.match(/^ */)?.[0].length ?? 0;
    const trimmed = line.trim();

    if (mode === 'skip_block') {
      if (indent <= skipIndent && !trimmed.startsWith('-') && /^[a-zA-Z_]/.test(trimmed)) {
        mode = 'top';
        // fall through to reprocess this line as top-level
      } else {
        continue;
      }
    }

    // Section headers at indent 0
    if (indent === 0) {
      // flush open co_planner before leaving the list section
      if (mode === 'co_planners' && currentPlanner) {
        coPlanners.push(currentPlanner);
        currentPlanner = null;
      }
      currentTier = null;
      if (trimmed.startsWith('co_planners:')) {
        mode = 'co_planners';
        continue;
      }
      if (trimmed.startsWith('implementer:')) {
        mode = 'implementer';
        continue;
      }
      if (trimmed.startsWith('validator:')) {
        mode = 'validator';
        continue;
      }
      if (
        trimmed.startsWith('deliberation_panel:') ||
        trimmed.startsWith('redteam_panel:') ||
        trimmed.startsWith('routing_notes:') ||
        trimmed.startsWith('known_registry_defects:')
      ) {
        mode = 'skip_block';
        skipIndent = 0;
        continue;
      }
      mode = 'top';
      const m = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(trimmed);
      if (m && topKeys.has(m[1])) {
        topScalars[m[1]] = unquoteScalar(m[2]);
      }
      continue;
    }

    if (mode === 'co_planners') {
      if (/^-\s+id:\s*/.test(trimmed)) {
        if (currentPlanner) coPlanners.push(currentPlanner);
        currentPlanner = { id: unquoteScalar(trimmed.replace(/^-\s+id:\s*/, '')), model: '' };
        continue;
      }
      if (currentPlanner) {
        const mm = /^(model|launch):\s*(.*)$/.exec(trimmed);
        if (mm) {
          const val = unquoteScalar(mm[2]);
          if (mm[1] === 'model') currentPlanner.model = val;
          else currentPlanner.launch = val;
        }
      }
      continue;
    }

    if (mode === 'implementer' || mode === 'validator') {
      const tierMatch = /^(L[123]):\s*$/.exec(trimmed);
      if (tierMatch && indent === 2) {
        currentTier = tierMatch[1] as TierId;
        const seat: TierSeat = { model: '' };
        if (mode === 'implementer') implementer[currentTier] = seat;
        else validator[currentTier] = seat;
        continue;
      }
      if (currentTier) {
        const km = /^(model|backup|launch|backup_launch):\s*(.*)$/.exec(trimmed);
        if (km) {
          const seat =
            mode === 'implementer' ? implementer[currentTier]! : validator[currentTier]!;
          const val = unquoteScalar(km[2]);
          if (km[1] === 'model') seat.model = val;
          else if (km[1] === 'backup') seat.backup = val;
          else if (km[1] === 'launch') seat.launch = val;
          else if (km[1] === 'backup_launch') seat.backup_launch = val;
        }
      }
      continue;
    }
  }
  if (currentPlanner) coPlanners.push(currentPlanner);

  const cv = Number(topScalars.contract_version);
  if (!Number.isFinite(cv)) {
    throw new Error('parseTopologyYamlMinimal: missing contract_version');
  }

  const doc: TopologyV1Like = {
    contract_version: cv,
    co_planners: coPlanners,
    implementer: implementer as Record<TierId, TierSeat>,
    validator: validator as Record<TierId, TierSeat>,
  };
  for (const k of topKeys) {
    if (k === 'contract_version') continue;
    if (topScalars[k] !== undefined) (doc as any)[k] = topScalars[k];
  }
  return doc;
}

function yamlQuote(s: string): string {
  if (/[:#\[\]{},&*!|>'"%@`]|^\s|\s$/.test(s) || s === '' || /^(true|false|null)$/i.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function emitSeat(lines: string[], seat: TierSeat, indent: string): void {
  lines.push(`${indent}model: ${yamlQuote(seat.model)}`);
  if (seat.backup !== undefined) lines.push(`${indent}backup: ${yamlQuote(seat.backup)}`);
  if (seat.launch !== undefined) lines.push(`${indent}launch: ${yamlQuote(seat.launch)}`);
  if (seat.backup_launch !== undefined) {
    lines.push(`${indent}backup_launch: ${yamlQuote(seat.backup_launch)}`);
  }
}

/** Serialize a v2 export to a readable YAML document (no external deps). */
export function serializeTopologyV2Yaml(doc: TopologyV2Export): string {
  const lines: string[] = [];
  lines.push('--- # Team Topology Contract v2 shape export (Q-08 / B24)');
  lines.push('# EXPORT ONLY — not the live run stamp. Live topology.yaml stays contract_version: 1.');
  lines.push('');
  lines.push(`contract_version: ${doc.contract_version}`);
  lines.push('contract_v2: true');
  lines.push('planners:');
  lines.push(`  min: ${doc.planners.min}`);
  lines.push(`  rule: ${yamlQuote(doc.planners.rule)}`);
  lines.push('');

  const passthrough = [
    'run_id',
    'project',
    'north_star_ref',
    'cycle_north_star_ref',
    'stamped_by',
    'stamped_at',
    'base_commit',
    'base_branch',
    'planning_criticality',
    'coordinator_session',
  ] as const;
  for (const k of passthrough) {
    const v = (doc as any)[k];
    if (v !== undefined) lines.push(`${k}: ${yamlQuote(String(v))}`);
  }
  lines.push('');

  lines.push('co_planners:');
  for (const p of doc.co_planners) {
    lines.push(`  - id: ${yamlQuote(p.id)}`);
    lines.push(`    model: ${yamlQuote(p.model)}`);
    if (p.launch !== undefined) lines.push(`    launch: ${yamlQuote(p.launch)}`);
  }
  lines.push('');

  lines.push('implementer:');
  for (const t of TIERS) {
    lines.push(`  ${t}:`);
    emitSeat(lines, doc.implementer[t], '    ');
  }
  lines.push('');

  lines.push('validator:');
  for (const t of TIERS) {
    lines.push(`  ${t}:`);
    emitSeat(lines, doc.validator[t], '    ');
  }
  lines.push('');

  lines.push('escalation:');
  lines.push(`  lateral_cause: ${doc.escalation.lateral_cause}`);
  lines.push(`  vertical_cause: ${doc.escalation.vertical_cause}`);
  lines.push(
    `  stamp_reasons: [${doc.escalation.stamp_reasons.map((r) => yamlQuote(r)).join(', ')}]`
  );
  lines.push('  availability_not_difficulty: true');
  lines.push(`  dual_unavailable: ${yamlQuote(doc.escalation.dual_unavailable)}`);
  lines.push('');

  lines.push('export_meta:');
  lines.push(`  source_contract_version: ${doc.export_meta.source_contract_version}`);
  lines.push(`  export_kind: ${yamlQuote(doc.export_meta.export_kind)}`);
  lines.push(`  exported_at: ${yamlQuote(doc.export_meta.exported_at)}`);
  if (doc.export_meta.source_path) {
    lines.push(`  source_path: ${yamlQuote(doc.export_meta.source_path)}`);
  }
  lines.push('');

  return lines.join('\n') + '\n';
}

/**
 * Read a v1 topology.yaml path and return the v2 export object + yaml text.
 * Never writes/mutates the source path.
 */
export function exportTopologyV2FromFile(
  sourcePath: string,
  opts?: { exportedAt?: string }
): { doc: TopologyV2Export; yaml: string } {
  const text = fs.readFileSync(sourcePath, 'utf8');
  const v1 = parseTopologyYamlMinimal(text);
  const doc = exportTopologyContractV2(v1, {
    exportedAt: opts?.exportedAt,
    sourcePath,
  });
  return { doc, yaml: serializeTopologyV2Yaml(doc) };
}

/** Write export YAML to destPath only (source remains untouched). */
export function writeTopologyV2Export(
  sourcePath: string,
  destPath: string,
  opts?: { exportedAt?: string }
): TopologyV2Export {
  const { doc, yaml } = exportTopologyV2FromFile(sourcePath, opts);
  fs.writeFileSync(destPath, yaml, 'utf8');
  return doc;
}
