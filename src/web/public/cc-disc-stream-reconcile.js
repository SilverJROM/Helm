// cc-disc-stream-reconcile.js
// E8 FIX1: pure decision logic for Discovery's OWN EventSource reconciliation, extracted out of the
// giant app.js component so the "was one-shot, now reconciles" fix is unit-testable without a
// browser DOM/EventSource harness. No DOM, no browser globals — self-contained for vitest.
//
// SOL diagnosis (plan/_backlog/SOL-discovery-reply-path-diagnosis.md): the pre-fix recovery effect
// returned early FOREVER once a session id existed, without ever checking whether the EventSource
// that fed it was still alive — so a dropped/closed stream left ccLivePane frozen with no consumer
// to ever refresh it again. decideDiscoveryReconcile() below is called on mount, on route change,
// AND on a timer (app.js), so it keeps re-evaluating instead of deciding once.

// Mirrors the browser's EventSource.CLOSED (=2) so this module stays DOM-free / import-free.
export const ES_CLOSED = 2;

/**
 * @param {object} input
 * @param {number|string|null|undefined} input.pid - the Discovery workspace's active project id
 * @param {{sid?: string, agentId?: number}|null|undefined} input.session - the known ccSession[pid] (if any)
 * @param {number|null|undefined} input.streamReadyState - ccDiscChatEsRef.current?.readyState, or
 *   null/undefined if no stream has ever been attached
 * @param {Array<{tmux_session?: string, session_id?: string, agent_id?: number}>|null|undefined} input.activeSessions
 * @returns {{action: 'none'} | {action: 'attach', sid: string, agentId: number} | {action: 'discover-and-attach', sid: string, agentId: number, tmux: string|null}}
 */
export function decideDiscoveryReconcile({ pid, session, streamReadyState, activeSessions }) {
  if (!pid) return { action: 'none' };

  if (session && session.sid) {
    // A session is already known — the ONLY question that matters (and the one the one-shot bug
    // never asked) is whether OUR OWN stream is actually still delivering for it.
    const alive = streamReadyState != null && streamReadyState !== ES_CLOSED;
    if (alive) return { action: 'none' };
    return { action: 'attach', sid: session.sid, agentId: session.agentId };
  }

  // No session known yet in this browser — match the live discovery seat by its tmux name
  // (helm-chat-p<pid>-discovery-*), same lookup the original one-shot effect used. Never spawns.
  const marker = `helm-chat-p${pid}-discovery`;
  const live = (activeSessions || []).find(
    (s) => s && s.tmux_session && s.tmux_session.includes(marker)
  );
  if (live && live.session_id && live.agent_id != null) {
    return { action: 'discover-and-attach', sid: live.session_id, agentId: live.agent_id, tmux: live.tmux_session || null };
  }
  return { action: 'none' };
}

export default { ES_CLOSED, decideDiscoveryReconcile };
