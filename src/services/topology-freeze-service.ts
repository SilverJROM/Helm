/**
 * B19 / R5.22 — Freeze complete: Studio→Project→Cycle collapses into a frozen snapshot at cycle
 * start. Editing the Studio (or a project override) after freeze must not change a running cycle's
 * team. Single writer (`freezeForCycle`), called from exactly one place in CycleService for every
 * path that transitions a cycle into `implementation` (writer exclusivity — see cycle-service.ts).
 *
 * Immutability + a second layer of writer exclusivity are enforced at the schema level:
 * `cycle_topology_freezes.cycle_id` is UNIQUE (a second INSERT for the same cycle fails), and
 * BEFORE UPDATE/DELETE triggers RAISE(ABORT) so no code path — this service included — can ever
 * mutate a stamped freeze.
 */
import { DatabaseService } from '../db/database.js';
import { assertEffectiveRoleTiersInvariants } from '../db/role-tier-invariants.js';
import { InheritanceService, type EffectiveTopology } from './inheritance-service.js';

export interface CycleTopologyFreeze {
  cycle_id: number;
  project_id: number;
  snapshot: EffectiveTopology;
  frozen_at: string;
}

function rowToFreeze(row: any): CycleTopologyFreeze {
  return {
    cycle_id: Number(row.cycle_id),
    project_id: Number(row.project_id),
    snapshot: JSON.parse(String(row.snapshot_json)),
    frozen_at: String(row.frozen_at),
  };
}

export class TopologyFreezeService {
  private readonly inheritance: InheritanceService;

  constructor(private readonly db: DatabaseService) {
    this.inheritance = new InheritanceService(db);
  }

  getFreeze(cycleId: number): CycleTopologyFreeze | null {
    const row = this.db
      .prepare(`SELECT * FROM cycle_topology_freezes WHERE cycle_id = ?`)
      .get(cycleId) as any;
    return row ? rowToFreeze(row) : null;
  }

  /**
   * Cycle-start writer: compose the project-effective topology, re-validate R3.16 over the full
   * composed set (B18-fix1 carry-forward — catches violations no single mutation-site check can
   * see, from clearProjectRoleTier or a studio edit made after project overrides were set), and
   * write an immutable stamp. Throws (blocking cycle-start) if already frozen or if the composed
   * topology violates R3.16 — the caller must not flip the cycle's phase on failure.
   */
  freezeForCycle(cycleId: number): CycleTopologyFreeze {
    const cycle = this.db
      .prepare('SELECT id, project_id FROM cycles WHERE id = ?')
      .get(cycleId) as { id: number; project_id: number } | undefined;
    if (!cycle) {
      const err: any = new Error(`unknown cycle: ${cycleId}`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (this.getFreeze(cycleId)) {
      const err: any = new Error(`cycle ${cycleId} topology is already frozen`);
      err.code = 'CONFLICT';
      throw err;
    }

    const topo = this.inheritance.resolveForProject(Number(cycle.project_id));
    assertEffectiveRoleTiersInvariants(this.db, topo.role_tiers);

    const snapshot: EffectiveTopology = { ...topo, cycle_id: cycleId };
    const row = this.db
      .prepare(
        `INSERT INTO cycle_topology_freezes (cycle_id, project_id, snapshot_json)
         VALUES (?, ?, ?) RETURNING *`
      )
      .get(cycleId, cycle.project_id, JSON.stringify(snapshot)) as any;
    return rowToFreeze(row);
  }

  /** R5.22: frozen snapshot once present; else the live Studio→Project→Cycle read (pre-freeze, R5.21). */
  getEffectiveTopology(cycleId: number): EffectiveTopology {
    const frozen = this.getFreeze(cycleId);
    if (frozen) return frozen.snapshot;
    return this.inheritance.resolveForCycle(cycleId);
  }
}
