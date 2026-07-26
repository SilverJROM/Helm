// F2 round-7 (finding #1): SERVER-AUTHORITATIVE delivery-channel resolution.
// The logical delivery channel (project:<pid> for CC/Discovery, studio:<agentId> for Studio) MUST be derived
// only from the authenticated, route-bound params — never from a client-supplied body/query `channel` key.
// A wrong-channel stream/ack could otherwise receive + auto-ACK ANOTHER project/agent channel and silently
// consume its delivery notifications. This helper reads pid/agentId/sid ONLY, so a body/query channel is
// structurally incapable of influencing the result. Mirrors the POST message-handler derivation exactly, so
// the channel a failure is RECORDED under (POST) always equals the channel it is READ/ACKED under (stream/ack).
export interface DeliveryChannelParams {
  pid?: unknown;
  agentId?: unknown;
  sid?: unknown;
}

export function deliveryChannelFor(params: DeliveryChannelParams | undefined | null): string {
  const p = params || {};
  // project routes (/api/projects/:pid/agent-chat/:sid/...) carry pid, no agentId → project channel.
  if (p.pid !== undefined && p.pid !== null && p.pid !== '') return `project:${p.pid}`;
  // studio routes (/api/agents/:agentId/chat-session/:sid/...) carry agentId, no pid → studio channel.
  if (p.agentId !== undefined && p.agentId !== null && p.agentId !== '') return `studio:${p.agentId}`;
  // fallback (no project/agent scope): key by the session id.
  return `session:${p.sid}`;
}

// F2 round-8 (finding #1): SID↔scope binding. deliveryChannelFor derives the channel from the ROUTE scope
// alone — it never verifies the :sid actually belongs to that scope. So an owner could stream/ack/POST a
// session they own under a FOREIGN project/agent route and read/consume (or mis-record) that other channel.
// The two helpers below bind the route scope to the session BEFORE any channel is selected.

/**
 * Canonical positive-integer parse for a route scope segment (`:pid` / `:agentId`).
 * Accepts ONLY the exact decimal form of a positive integer — rejects leading zeros (`01`),
 * decimals (`1.5`), non-numeric (`abc`), zero, and negatives. Route params arrive as strings; a
 * number is tolerated defensively. Returns the integer, or `null` when the segment is non-canonical.
 */
export function canonicalPositiveInt(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  if (!/^[1-9][0-9]*$/.test(raw)) return null; // no leading zero, no sign, no dot, digits only
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// The metadata a resolved chat session must expose for the scope check — a structural subset of ChatSession
// (avoids importing ChatSessionService here). `projectId` is undefined/null for a Studio (non-fenced) session.
export interface ScopedSessionMeta {
  agentId: number;
  projectId?: number | null;
}

export type ScopedChannelResolution = { ok: true; channel: string } | { ok: false };

/**
 * Bind a scoped chat `:sid` route to its session and return the VALIDATED delivery channel.
 * Rules (sol round-8 finding #1):
 *   1. `session` must exist (caller resolved it via getSession) — else reject.
 *   2. PROJECT route (params.pid present): pid must be a canonical positive int AND `session.projectId === pid`.
 *   3. STUDIO route (params.agentId present): agentId must be a canonical positive int AND
 *      `session.agentId === agentId` AND `session.projectId == null` (a project-scoped SID for the same agent
 *      may NOT be rebound onto the Studio channel).
 *   4. The channel is derived from the VALIDATED NUMERIC scope, never the raw route string.
 * Every rejection returns the SAME opaque `{ ok: false }` so a caller cannot tell "SID does not exist" apart
 * from "SID belongs to another scope" (no cross-scope existence leak).
 */
export function resolveScopedChannel(
  params: DeliveryChannelParams | undefined | null,
  session: ScopedSessionMeta | undefined | null
): ScopedChannelResolution {
  const p = params || {};
  if (!session) return { ok: false }; // rule 1: unknown SID (covers the ACK route that never checked)
  const hasPid = p.pid !== undefined && p.pid !== null && p.pid !== '';
  const hasAgent = p.agentId !== undefined && p.agentId !== null && p.agentId !== '';
  if (hasPid) {
    const pid = canonicalPositiveInt(p.pid); // rule 2: canonical int
    if (pid === null) return { ok: false };
    if (session.projectId !== pid) return { ok: false }; // rule 2: SID must belong to THIS project
    return { ok: true, channel: deliveryChannelFor({ pid }) }; // rule 4: from validated numeric scope
  }
  if (hasAgent) {
    const agentId = canonicalPositiveInt(p.agentId); // rule 3: canonical int
    if (agentId === null) return { ok: false };
    if (session.agentId !== agentId) return { ok: false }; // rule 3: SID must be THIS agent's
    if (session.projectId !== undefined && session.projectId !== null) return { ok: false }; // rule 3: Studio ⇒ unfenced
    return { ok: true, channel: deliveryChannelFor({ agentId }) }; // rule 4: from validated numeric scope
  }
  return { ok: false }; // a scoped :sid route always carries pid or agentId; anything else is not authorized
}

// A structural view of the one ChatSessionService method the pre-handler needs.
export interface ScopedSessionLookup {
  getSession(sessionId: string): ScopedSessionMeta | undefined;
}

/**
 * ONE shared pre-handler for EVERY scoped chat `:sid` route (message / stream / ack / logs / end / clear /
 * compact / terminal, on BOTH the Studio and project scopes) so the SID↔scope check + channel derivation can
 * never drift between verbs. Resolves the session FIRST, validates the route scope against it, and on success
 * stashes the VALIDATED channel (`request.deliveryChannel`) + the resolved session (`request.scopedSession`)
 * for the handler. Any missing SID / non-canonical scope / cross-scope mismatch is a uniform 404 — emitted
 * BEFORE the handler runs, so no message is enqueued, no SSE stream is hijacked, and no ACK mutates the ledger.
 */
export function createScopedChatSidPre(chatSessionService: ScopedSessionLookup) {
  return async (request: any, reply: any) => {
    const sid = request.params?.sid;
    const session = chatSessionService.getSession(sid);
    const res = resolveScopedChannel(request.params, session);
    if (!res.ok) {
      reply.code(404).send({ error: 'unknown session' });
      return; // short-circuits: the route handler never executes
    }
    request.deliveryChannel = res.channel;
    request.scopedSession = session;
  };
}

export default { deliveryChannelFor, canonicalPositiveInt, resolveScopedChannel, createScopedChatSidPre };
