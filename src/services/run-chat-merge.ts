// CC-CHAT-2 R3: make a LIVE RUN's conversation first-class in the Command Center chat.
// Parses the run dir's callbacks.md (the COMPLETE record — the loop only persists terminal
// states to the `callbacks` table, and agent_events never sees run callbacks) into chat-shaped
// messages and merges them time-ordered with the owner transcript from agent_events.
// Read-only + fast: one file read per GET, no polling loops server-side.

export interface ParsedCallbackLine {
  role: string;      // raw role from the line (helm_pm | plancore | ibrain | implementer | validator | ...)
  batchId: string;
  state: string;     // WORKING | PLAN-READY | DONE | PASS | FAIL | ...
  note: string;      // the free-text after the em-dash (may be '')
  raw: string;
}

// Phase-brain identities render as THE agent ("helm-pm") bubbles; everything else
// (implementer/validator/panelist/...) renders as compact role-chip status bubbles.
const COORDINATOR_ROLES = new Set(['helm_pm', 'helm-pm', 'plancore', 'ibrain', 'discovery', 'coord', 'coordinator']);

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
}

// Build agent_events-shaped rows so the CC chat renders them with zero special casing on the wire.
// Phase-brain lines -> role 'helm-pm' agent bubbles; worker lines keep their role and are
// flagged run_cb for the compact status-bubble style.
export function toRunChatMessages(lines: ParsedCallbackLine[], opts: RunChatMessageOpts): any[] {
  return lines.map((l, i) => {
    const isCoord = COORDINATOR_ROLES.has(l.role.toLowerCase());
    return {
      id: `runcb-${opts.runPk}-${i}`,
      run_id: String(opts.runPk),
      role: isCoord ? 'helm-pm' : l.role,
      batch_id: `chat-${opts.projectId}`,
      session: null,
      type: 'status',
      state: l.state,
      source: 'callback',
      correlation_id: `runcb:${opts.batchId}:${i}`,
      body: { text: l.note || l.state, cb_role: l.role, state: l.state, run_pk: opts.runPk },
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
