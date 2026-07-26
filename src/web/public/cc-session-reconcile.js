// cc-session-reconcile.js
// There is ONE agent-chat session slot per project (ccSession[pid]), shared by the Discovery pane and
// main CC. After BUG-2 the two surfaces default to DIFFERENT agents (Discovery→`discovery`, main→
// `plancore`), so a send from one surface must never bleed into the other's live seat, and a replaced
// seat must be closed rather than orphaned. This pure planner (unit-testable, DOM-free) is the single
// source of truth for that reconciliation; ccEnsureSession + both send paths consume it.

/**
 * Plan how to make the single session slot serve `targetAgentId`.
 * - 'noop'   → no target agent selected.
 * - 'reuse'  → the live session is already this agent; keep it (no bleed, no re-spawn).
 * - 'switch' → the live session is a DIFFERENT agent; close it (closeSid) then spawn the target
 *              (prevents both the cross-surface bleed AND the orphaned server-side session).
 * - 'spawn'  → no live session; spawn the target.
 */
export function seatReconcilePlan(currentSession, targetAgentId) {
  if (!targetAgentId) return { action: 'noop', closeSid: null };
  const cur = currentSession && currentSession.sid ? currentSession : null;
  if (cur && cur.agentId === targetAgentId) return { action: 'reuse', closeSid: null };
  if (cur) return { action: 'switch', closeSid: cur.sid };
  return { action: 'spawn', closeSid: null };
}

/** True when a send must re-ensure the target agent first because the live seat is a DIFFERENT agent. */
export function needsSeatSwitch(currentSession, targetAgentId) {
  return seatReconcilePlan(currentSession, targetAgentId).action === 'switch';
}

/**
 * Serialize the FULL ensure→send critical section on the single per-project slot as a promise CHAIN, so a
 * different-agent switch (which DELETEs the current seat) cannot begin until the PRIOR caller's message POST
 * has landed (the LEASE). The in-flight tail is registered SYNCHRONOUSLY in `inflightMap[pid]`, so a
 * concurrent call observes it and chains after it. Each call:
 *   1) awaits the prior unit's ensure+send (the prior caller keeps the seat leased until it has POSTed),
 *   2) re-reads the current session, plans, and (reuse | switch+spawn) to ITS OWN target agent,
 *   3) runs the caller's `send(session)` — the seat is leased to THIS caller until send resolves.
 * Consequences (no separate agent-key needed — the chain + re-read handle it):
 *   - same-agent concurrent → the later unit sees `reuse` (the earlier already spawned) → ONE spawn; each
 *     still posts its own message, in order;
 *   - different-agent concurrent → each unit switches to ITS agent and POSTs BEFORE the next unit's switch
 *     tears that seat down → every caller posts to its own agent's seat first (no 404 / no post-into-dying
 *     seat / no wrong-agent post); exactly one live seat per slot; no orphan.
 * The normal case is cheap: no prior in flight → prior resolved instantly; reuse → no spawn. No deadlock:
 * every unit completes (its send always settles) and only strictly-prior units are awaited.
 *
 * @param inflightMap  persistent object (a ref's .current) keyed by pid → { tail: Promise }.
 * @param pid          project id (the slot key).
 * @param getCurrent   (pid) => the live session right now (re-read; reflects prior switches).
 * @param targetAgentId  the agent THIS caller wants.
 * @param runSwitchAndSpawn async (plan) => session|null — DELETE (plan.action==='switch' closes plan.closeSid)
 *                     then spawn/attach. Runs AT MOST ONCE per distinct switch.
 * @param send         async (session) => any — the caller's OWN message POST; the seat is leased until it lands.
 * @returns { session, result } — the resolved session and the caller's send() return (undefined if no session).
 */
export async function seatLeaseSendChain(inflightMap, pid, getCurrent, targetAgentId, runSwitchAndSpawn, send) {
  const prevTail = inflightMap[pid] ? inflightMap[pid].tail : null;
  const unit = (async () => {
    if (prevTail) { try { await prevTail; } catch { /* a prior unit's failure must not block ours */ } }
    const cur = getCurrent(pid);
    const plan = seatReconcilePlan(cur, targetAgentId);
    const session = plan.action === 'reuse' ? cur : await runSwitchAndSpawn(plan);
    if (!session || !session.sid) return { session: session || null, result: undefined };
    const result = await send(session); // LEASE held until the caller's POST lands — the next switch waits on this
    return { session, result };
  })();
  inflightMap[pid] = { tail: unit };
  try {
    return await unit;
  } finally {
    if (inflightMap[pid] && inflightMap[pid].tail === unit) delete inflightMap[pid];
  }
}

export default { seatReconcilePlan, needsSeatSwitch, seatLeaseSendChain };
