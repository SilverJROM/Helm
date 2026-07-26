import { createHash } from 'node:crypto';
import { DatabaseService } from '../db/database.js';

export interface StallLineageInput {
  run_id: string;
  batch_id: string;
  scope_generation: number;
  initial_signature: string;
}

export interface StallLineage extends StallLineageInput {
  stall_lineage_id: string;
  canonical_signature: string;
  status: string;
  class_history: string[];
  class_rounds: BreakerRound[];
  blocker_owner: string | null;
  created_at: string;
  updated_at: string;
}

export interface BreakerRound {
  /** Defect-class signature for this round. */
  signature: string;
  /** Stable mechanism surface; narrowing on one surface is productive honing. */
  surface?: string;
}

export interface BreakerOptions {
  spin_rounds_to_stall?: number;
  new_class_rounds_to_stall?: number;
}

export interface BreakerEvaluation {
  tripped: boolean;
  reason: 'spin' | 'blast' | null;
  consecutive_spin_rounds: number;
  consecutive_new_class_rounds: number;
}

export type BreakerLineageInput =
  | { class_rounds: readonly BreakerRound[] }
  | { class_history: readonly string[] };

type RawStallLineage = Omit<StallLineage, 'class_history' | 'class_rounds'> & { class_history_json: string };

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireText(value: string, field: string): string {
  if (!value || !value.trim()) throw new Error(`${field} is required`);
  if (value.includes('\u0000')) throw new Error(`${field} must not contain NUL`);
  if (hasUnpairedUtf16Surrogate(value)) throw new Error(`${field} must not contain unpaired UTF-16 surrogate`);
  return value;
}

/**
 * Mechanical integration point for the gate/brain layer: pass ordered validator
 * rounds after a lineage is open. A later breaker consumer supplies surface from
 * its defect taxonomy; absent surface conservatively means the signature itself.
 */
export function evaluateBreaker(
  lineageOrRounds: BreakerLineageInput | readonly BreakerRound[],
  options: BreakerOptions = {}
): BreakerEvaluation {
  let rounds: BreakerRound[];
  if (Array.isArray(lineageOrRounds)) {
    rounds = [...(lineageOrRounds as readonly BreakerRound[])];
  } else {
    const lineage = lineageOrRounds as BreakerLineageInput;
    rounds = 'class_rounds' in lineage
      ? [...lineage.class_rounds]
      : lineage.class_history.map((signature: string) => ({ signature }));
  }
  const spinLimit = options.spin_rounds_to_stall ?? 2;
  const blastLimit = options.new_class_rounds_to_stall ?? 2;
  if (!Number.isInteger(spinLimit) || spinLimit < 2) throw new Error('spin_rounds_to_stall must be an integer >= 2');
  if (!Number.isInteger(blastLimit) || blastLimit < 2) throw new Error('new_class_rounds_to_stall must be an integer >= 2');

  let spin = 0;
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    if (index === rounds.length - 1 || rounds[index].signature === rounds[rounds.length - 1].signature) spin += 1;
    else break;
  }
  if (spin >= spinLimit) {
    return { tripped: true, reason: 'spin', consecutive_spin_rounds: spin, consecutive_new_class_rounds: 0 };
  }

  let blast = 0;
  // The initial signature opens the lineage; only subsequent newly observed
  // classes contribute to the early blast counter.
  const seenEarlier = new Set<string>(rounds.length > 0 ? [rounds[0].signature] : []);
  const seenSurfaces = new Set<string>(rounds.length > 0 ? [rounds[0].surface ?? rounds[0].signature] : []);
  for (let index = 1; index < rounds.length; index += 1) {
    const round = rounds[index];
    const surface = round.surface ?? round.signature;
    const isNewClass = !seenEarlier.has(round.signature);
    const hasNewSurface = !seenSurfaces.has(surface);
    blast = isNewClass && hasNewSurface ? blast + 1 : 0;
    seenEarlier.add(round.signature);
    seenSurfaces.add(surface);
  }
  return {
    tripped: blast >= blastLimit,
    reason: blast >= blastLimit ? 'blast' : null,
    consecutive_spin_rounds: spin,
    consecutive_new_class_rounds: blast,
  };
}

/** Canonical SHA-256 lineage key; scope generation begins at 0. */
export function computeLineageId(input: StallLineageInput): string {
  if (!Number.isInteger(input.scope_generation) || input.scope_generation < 0) {
    throw new Error('scope_generation must be a non-negative integer');
  }
  return createHash('sha256')
    .update(`${requireText(input.run_id, 'run_id')}\u0000${requireText(input.batch_id, 'batch_id')}\u0000${input.scope_generation}\u0000${requireText(input.initial_signature, 'initial_signature')}`)
    .digest('hex');
}

function parseRow(row: RawStallLineage): StallLineage {
  let classRounds: BreakerRound[] = [];
  try {
    const parsed = JSON.parse(row.class_history_json);
    if (Array.isArray(parsed)) {
      classRounds = parsed.map((item) => {
        if (typeof item === 'string') return { signature: item };
        if (item && typeof item === 'object' && typeof (item as any).signature === 'string') {
          return { signature: (item as any).signature, surface: typeof (item as any).surface === 'string' ? (item as any).surface : undefined };
        }
        throw new Error('invalid round');
      });
    }
  } catch {
    throw new Error(`invalid class_history_json for lineage ${row.stall_lineage_id}`);
  }
  return {
    stall_lineage_id: row.stall_lineage_id,
    run_id: row.run_id,
    batch_id: row.batch_id,
    scope_generation: row.scope_generation,
    initial_signature: row.initial_signature,
    canonical_signature: row.canonical_signature,
    status: row.status,
    class_history: classRounds.map((round) => round.signature),
    class_rounds: classRounds,
    blocker_owner: row.blocker_owner,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Scope generation is bumped only for redesign, split, or requirements-scope
 * change. This service deliberately does not implement breaker arithmetic.
 */
export class StallLineageService {
  constructor(private readonly db: DatabaseService) {}

  openOrGetLineage(input: StallLineageInput): StallLineage {
    const stallLineageId = computeLineageId(input);
    let row = this.db.prepare('SELECT * FROM stall_lineages WHERE stall_lineage_id = ?').get(stallLineageId) as RawStallLineage | undefined;
    if (!row) {
      this.db.prepare(`
        INSERT INTO stall_lineages (
          stall_lineage_id, run_id, batch_id, scope_generation, initial_signature, canonical_signature, class_history_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(stallLineageId, input.run_id, input.batch_id, input.scope_generation, input.initial_signature, input.initial_signature, JSON.stringify([{ signature: input.initial_signature }]));
      row = this.db.prepare('SELECT * FROM stall_lineages WHERE stall_lineage_id = ?').get(stallLineageId) as RawStallLineage;
    }
    return parseRow(row);
  }

  /** Appends every observed validation round without changing the frozen lineage identity. */
  recordRound(stallLineageId: string, signature: string, surface?: string): StallLineage {
    requireText(stallLineageId, 'stall_lineage_id');
    requireText(signature, 'signature');
    if (surface !== undefined) requireText(surface, 'surface');
    const existing = this.db.prepare('SELECT * FROM stall_lineages WHERE stall_lineage_id = ?').get(stallLineageId) as RawStallLineage | undefined;
    if (!existing) throw new Error(`unknown stall lineage: ${stallLineageId}`);
    const lineage = parseRow(existing);
    const history = [...lineage.class_rounds, { signature, surface }];
    this.db.prepare("UPDATE stall_lineages SET class_history_json = ?, updated_at = datetime('now') WHERE stall_lineage_id = ?")
      .run(JSON.stringify(history), stallLineageId);
    return parseRow(this.db.prepare('SELECT * FROM stall_lineages WHERE stall_lineage_id = ?').get(stallLineageId) as RawStallLineage);
  }

  /** Backward-compatible shorthand for a round without an explicit surface. */
  recordClass(stallLineageId: string, signature: string): StallLineage {
    return this.recordRound(stallLineageId, signature);
  }
}
