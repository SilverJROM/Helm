// CC-CHAT-2 R3: make a LIVE RUN's conversation first-class in the Command Center chat.
// Parses the run dir's callbacks.md (the COMPLETE record — the loop only persists terminal
// states to the `callbacks` table, and agent_events never sees run callbacks) into chat-shaped
// messages and merges them time-ordered with the owner transcript from agent_events.
// Read-only + fast: one file read per GET, no polling loops server-side.

import { normalizeRole } from './role-alias.js';

export interface ParsedCallbackLine {
  role: string;      // raw role from the line (helm_pm | plancore | ibrain | implementer | validator | ...)
  batchId: string;
  state: string;     // WORKING | PLAN-READY | DONE | PASS | FAIL | ...
  note: string;      // the free-text after the em-dash (may be '')
  raw: string;
}

// Phase-brain identities render as THE agent bubbles (labelled by their TRUE resolved role);
// everything else (implementer/validator/panelist/...) renders as compact role-chip status
// bubbles. 'helm_pm' stays in this set as the safe fallback label for an unresolvable shared-face
// line (A14) — still a brain bubble, just honestly showing the raw mask instead of a guess.
const COORDINATOR_ROLES = new Set(['helm_pm', 'helm-pm', 'plancore', 'ibrain', 'discovery', 'coord', 'coordinator']);

// A14 (D8/R4.31): `helm_pm` is a SHARED face for BOTH `plancore` and `ibrain` (role-alias.ts) — a
// bare string map can never disambiguate it (that's the point of the mask: SD3 safety for the
// model). Human-facing resolution instead uses run/dispatch context, the same class of fix as
// agent-event-ingest.ts's `roleMatches(run.role, parsed.role)`: each of this run's real plancore/
// ibrain dispatches is a worker_runtimes row with its own [started_at, ended_at) window; the window
// containing a given line's own timestamp tells us which internal role actually emitted it.
export interface BrainDispatchWindow {
  role: 'plancore' | 'ibrain';
  startedAtMs: number;
  endedAtMs: number | null; // null = still the most recent/open dispatch — extends to "now"
  model?: string | null;
  provider?: string | null;
}

// No matching window (missing dispatch context — e.g. a legacy run predating this row, or a
// fixture/test call with no worker_runtimes rows) preserves the RAW ambiguous token verbatim
// rather than guessing. Guessing wrong is exactly the "naive helm_pm->plancore replace" this row
// rejects; showing the honest mask is a truthful degrade, not a wrong answer presented as one.
//
// Iterates OLDEST-first and returns on the FIRST match, not newest-first. The caller (index.ts)
// pads an window's IMPLICIT end (derived from the next dispatch's start, when this row has no own
// recorded ended_at) by just under a second, to absorb SQLite's datetime('now') second-truncation
// against the millisecond-precision line timestamp — this deliberately makes the older and newer
// windows OVERLAP by up to ~1s at the boundary. Oldest-first-match resolves that overlap in favor
// of the already-active window, which is the correct call when a line's true emission time (a
// callback into an existing conversation) is ambiguous by under a second against a brand-new
// dispatch's reported start — never eagerly reattributing established content to a dispatch that
// may not truly have started yet.
function resolveHelmPmRole(
  lineTsMs: number,
  dispatches: BrainDispatchWindow[]
): { role: string; model?: string | null; provider?: string | null } {
  for (let i = 0; i < dispatches.length; i++) {
    const w = dispatches[i];
    if (lineTsMs >= w.startedAtMs && (w.endedAtMs == null || lineTsMs < w.endedAtMs)) {
      return { role: w.role, model: w.model, provider: w.provider };
    }
  }
  return { role: 'helm_pm' };
}

// Matches `[helm callback] <role> <batchId> STATUS: <STATE> — <msg>`.
// `[helm ACK]` lines and retired callback prefixes are skipped.
const CB_LINE_RE = /^\[helm callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+([A-Z][A-Z0-9-]*)(?:\s+[—–-]+\s*(.*))?$/;

export function parseCallbacksMd(content: string, batchIdFilter?: string): ParsedCallbackLine[] {
  const out: ParsedCallbackLine[] = [];
  for (const rawLine of String(content || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = CB_LINE_RE.exec(line);
    if (!m) continue; // skips [helm ACK] + malformed lines
    const [, role, batchId, state, note] = m;
    // partner callbacks use `<batch>-partner`; keep anything scoped to this batch when filtering.
    if (batchIdFilter && !batchId.startsWith(batchIdFilter)) continue;
    out.push({ role, batchId, state, note: (note || '').trim(), raw: line });
  }
  return out;
}

// Normalize sqlite `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC) and ISO strings to epoch ms.
export function tsToMs(ts: unknown): number {
  if (!ts || typeof ts !== 'string') return 0;
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T') + (ts.endsWith('Z') ? '' : 'Z');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export interface RunChatMessageOpts {
  projectId: number;
  runPk: number;          // runs.id (for UI linkage)
  batchId: string;
  ts: string[];           // per-line ISO timestamps (from CallbackTsCache), same length as lines
  /** A14: this run's plancore/ibrain worker_runtimes dispatch windows (any order — sorted here).
   *  The ONLY safe way to resolve which internal role emitted a given helm_pm-faced line. Omit/empty
   *  degrades to the honest 'helm_pm' fallback label, never a guess. */
  brainDispatches?: BrainDispatchWindow[];
}

// Build agent_events-shaped rows so the CC chat renders them with zero special casing on the wire.
// Phase-brain lines -> an agent bubble labelled by their TRUE resolved role (plancore/ibrain/
// discovery/coord, or the honest 'helm_pm' fallback — never a guessed label); worker lines keep
// their own role unchanged and are flagged run_cb for the compact status-bubble style.
export function toRunChatMessages(lines: ParsedCallbackLine[], opts: RunChatMessageOpts): any[] {
  const dispatches = (opts.brainDispatches || []).slice().sort((a, b) => a.startedAtMs - b.startedAtMs);
  return lines.map((l, i) => {
    // normalizeRole resolves the UNAMBIGUOUS aliases (helm_pm_fast->coord, helm_code_review->reviewer)
    // for free and leaves 'helm_pm' deliberately untouched — the one genuinely shared face.
    const normalized = normalizeRole(l.role);
    let resolvedRole = normalized;
    let model: string | null | undefined;
    let provider: string | null | undefined;
    if (normalized === 'helm_pm') {
      const lineTsMs = tsToMs(opts.ts[i] || opts.ts[opts.ts.length - 1] || '');
      const resolved = resolveHelmPmRole(lineTsMs, dispatches);
      resolvedRole = resolved.role;
      model = resolved.model;
      provider = resolved.provider;
    }
    const isCoord = COORDINATOR_ROLES.has(resolvedRole);
    return {
      id: `runcb-${opts.runPk}-${i}`,
      run_id: String(opts.runPk),
      // Always the RESOLVED role, not the raw line — a non-coordinator face (e.g. reviewer's own
      // 'helm_code_review' echo) must show as 'reviewer' too, not leak its raw mask into a status
      // chip. isCoord only selects BUBBLE STYLE below; it never gates which role value is shown.
      role: resolvedRole,
      batch_id: `chat-${opts.projectId}`,
      session: null,
      type: 'status',
      state: l.state,
      source: 'callback',
      correlation_id: `runcb:${opts.batchId}:${i}`,
      body: {
        text: l.note || l.state, cb_role: l.role, state: l.state, run_pk: opts.runPk,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      },
      ts: opts.ts[i] || opts.ts[opts.ts.length - 1] || new Date().toISOString(),
      run_cb: true
    };
  });
}

// Stable time-ordered merge: sort by ts, ties keep source order (owner transcript first, then
// callback file order) so intra-source ordering is never scrambled.
export function mergeChatMessages(ownerEvents: any[], runMessages: any[]): any[] {
  const tagged = [
    ...ownerEvents.map((m, i) => ({ m, ms: tsToMs(m?.ts), pri: 0, i })),
    ...runMessages.map((m, i) => ({ m, ms: tsToMs(m?.ts), pri: 1, i }))
  ];
  tagged.sort((a, b) => (a.ms - b.ms) || (a.pri - b.pri) || (a.i - b.i));
  return tagged.map((t) => t.m);
}

// First-seen timestamp cache for callback lines (they carry no per-line time in the file).
// On the FIRST observation of a run key, all existing lines get the run's started_at (they
// happened between start and now); lines appearing on later reads get "now" — so a live
// viewer sees correct interleaving with mid-run owner messages. In-memory by design: a
// restart degrades ordering gracefully (falls back to started_at), never blocks or writes.
export class CallbackTsCache {
  private readonly seen = new Map<string, string[]>();

  assign(key: string, lineCount: number, initialIso: string): string[] {
    let arr = this.seen.get(key);
    if (!arr) {
      arr = [];
      this.seen.set(key, arr);
      for (let i = 0; i < lineCount; i++) arr.push(initialIso);
    } else if (arr.length < lineCount) {
      const now = new Date().toISOString();
      while (arr.length < lineCount) arr.push(now);
    }
    return arr.slice(0, lineCount);
  }
}
