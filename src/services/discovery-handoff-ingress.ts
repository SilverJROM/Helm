/**
 * S09 — Discovery ready-callback ingress (structured boundary).
 *
 * Validates credential binding, role/status, cycle phase, and canonical docs; then
 * creates a pending S08 handoff with frozen S05 manifest — or quarantines. Never
 * starts a run or changes cycle phase. Pane prose is not an input here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseService } from '../db/database.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import {
  DiscoveryHandoffConflictError,
  DiscoveryHandoffService,
  hashHandoffCredential,
} from './discovery-handoff-service.js';
import {
  lookupDiscoveryCallbackCredential,
  markDiscoveryCallbackCredentialUsed,
} from './discovery-callback-credentials.js';
import { DISCOVERY_ROLE, isDiscoveryPhase } from './discovery-contract.js';
import { PlanningStaffingService } from './planning-staffing-service.js';
import type { PlannerPanelService } from './planner-panel-service.js';
import type { CycleService } from './cycle-service.js';

export interface DiscoveryReadyBody {
  role?: string;
  status?: string;
  projectId?: number;
  cycleId?: number;
  sessionId?: string;
  agentId?: number;
  credential?: string;
}

export interface DiscoveryReadyResult {
  ok: boolean;
  state: 'pending' | 'quarantined' | 'rejected';
  handoffId?: number;
  digest?: string | null;
  reason?: string;
  /** Always false for S09 — ready never starts Planning. */
  runCreated: false;
}

export interface DiscoveryHandoffIngressDeps {
  db: DatabaseService;
  handoffs: DiscoveryHandoffService;
  assignments: AgentAssignmentService;
  cycleService: CycleService;
  plannerPanel?: PlannerPanelService;
}

async function validateDiscoveryDocs(
  cycleDocDir: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const nsPath = path.join(cycleDocDir, 'north-star.md');
  const logPath = path.join(cycleDocDir, 'conversation-log.md');
  const decisionsPath = path.join(cycleDocDir, 'decisions');

  try {
    const ns = await fs.readFile(nsPath, 'utf8');
    if (!ns.trim()) {
      return { ok: false, reason: 'north-star.md is empty' };
    }
  } catch {
    return { ok: false, reason: 'north-star.md missing or unreadable' };
  }

  try {
    const log = await fs.readFile(logPath, 'utf8');
    if (!log.trim()) {
      return { ok: false, reason: 'conversation-log.md is empty' };
    }
  } catch {
    return { ok: false, reason: 'conversation-log.md missing or unreadable' };
  }

  // decisions/ must be path-safe: if present, must be a real directory under the cycle root
  try {
    const st = await fs.lstat(decisionsPath);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return { ok: false, reason: 'decisions/ is not a safe directory' };
    }
    const realCycle = await fs.realpath(cycleDocDir);
    const realDec = await fs.realpath(decisionsPath);
    if (realDec !== realCycle && !realDec.startsWith(realCycle + path.sep)) {
      return { ok: false, reason: 'decisions/ escapes cycle folder' };
    }
  } catch {
    // missing decisions/ is acceptable (optional tree); path-safe check only when present
  }

  return { ok: true };
}

/**
 * Process a structured Discovery ready callback. Pure of HTTP; no Planning start.
 */
export async function processDiscoveryReadyCallback(
  body: DiscoveryReadyBody,
  deps: DiscoveryHandoffIngressDeps
): Promise<DiscoveryReadyResult> {
  const raw = String(body.credential || '');
  const role = String(body.role || '')
    .trim()
    .toLowerCase();
  const status = String(body.status || '')
    .trim()
    .toUpperCase();
  const projectId = Number(body.projectId);
  const cycleId = Number(body.cycleId);
  const sessionId = String(body.sessionId || '');
  const agentId = Number(body.agentId);

  const quarantine = (reason: string, extra?: Partial<DiscoveryReadyBody>) => {
    try {
      const row = deps.handoffs.quarantine({
        projectId: Number.isFinite(projectId) ? projectId : 0,
        cycleId: Number.isFinite(cycleId) ? cycleId : 0,
        chatSessionId: sessionId || null,
        agentId: Number.isFinite(agentId) ? agentId : null,
        callbackRole: extra?.role ?? body.role ?? null,
        callbackStatus: extra?.status ?? body.status ?? null,
        reason,
        credentialHash: raw ? hashHandoffCredential(raw) : null,
      });
      return {
        ok: false as const,
        state: 'quarantined' as const,
        handoffId: row.id,
        reason,
        runCreated: false as const,
      };
    } catch (e: any) {
      return {
        ok: false as const,
        state: 'rejected' as const,
        reason: `${reason}; quarantine-failed: ${e?.message || e}`,
        runCreated: false as const,
      };
    }
  };

  if (!raw) {
    return quarantine('missing callback credential');
  }

  const binding = lookupDiscoveryCallbackCredential(raw);
  if (!binding) {
    return quarantine('unknown or invalid callback credential');
  }
  if (binding.usedAt) {
    return quarantine('callback credential already consumed');
  }

  // Binding must match body exactly
  if (
    binding.projectId !== projectId ||
    binding.cycleId !== cycleId ||
    binding.chatSessionId !== sessionId ||
    binding.agentId !== agentId
  ) {
    return quarantine('session/cycle/project/agent binding mismatch');
  }

  if (role !== DISCOVERY_ROLE) {
    return quarantine(`out-of-contract role: ${role || '(empty)'} (expected discovery)`);
  }
  if (status !== 'NORTH-STAR-READY') {
    return quarantine(`out-of-contract status: ${status || '(empty)'} (expected NORTH-STAR-READY)`);
  }

  // Cycle must still be discovery
  let cycle: any;
  try {
    cycle = deps.db
      .prepare('SELECT id, project_id, phase, status FROM cycles WHERE id = ?')
      .get(cycleId);
  } catch {
    cycle = null;
  }
  if (!cycle || Number(cycle.project_id) !== projectId) {
    return quarantine('unknown cycle or project mismatch');
  }
  if (!isDiscoveryPhase(cycle.phase)) {
    return quarantine(`cycle phase is ${cycle.phase}, not discovery`);
  }
  if (String(cycle.status) === 'completed') {
    return quarantine('cycle is completed');
  }

  let cycleDocDir: string;
  try {
    cycleDocDir = deps.cycleService.getCycleDocDir(cycleId);
  } catch (e: any) {
    return quarantine(`cycle doc dir unavailable: ${e?.message || e}`);
  }

  const docs = await validateDiscoveryDocs(cycleDocDir);
  if (!docs.ok) {
    return quarantine(docs.reason);
  }

  // S05 staffing freeze
  let manifestJson: string | null = null;
  let manifestDigest: string | null = null;
  try {
    const staffing = new PlanningStaffingService(
      deps.db,
      deps.assignments,
      deps.plannerPanel
    );
    const manifest = staffing.resolveManifest(projectId, {
      throwOnEmpty: false,
      throwOnMismatch: false,
    });
    manifestJson = JSON.stringify(manifest);
    manifestDigest = manifest.digest;
  } catch (e: any) {
    return quarantine(`staffing resolve failed: ${e?.message || e}`);
  }

  try {
    const pending = deps.handoffs.createPending({
      projectId,
      cycleId,
      chatSessionId: sessionId,
      agentId,
      rawCredential: raw,
      callbackRole: DISCOVERY_ROLE,
      callbackStatus: 'NORTH-STAR-READY',
      manifestJson,
      manifestDigest,
    });
    // One-use: mark credential used and consume on the handoff row
    markDiscoveryCallbackCredentialUsed(raw);
    deps.handoffs.consumeCredential(pending.id, raw);

    // Verify no run was created by this path (caller asserts); we never touch runs.
    return {
      ok: true,
      state: 'pending',
      handoffId: pending.id,
      digest: manifestDigest,
      runCreated: false,
    };
  } catch (e: any) {
    if (e instanceof DiscoveryHandoffConflictError) {
      return quarantine(`live handoff already exists: ${e.message}`);
    }
    return quarantine(`failed to create pending handoff: ${e?.message || e}`);
  }
}
