// cc-session-reconcile.test.ts
// F3: the single per-project agent-chat session slot is shared by the Discovery pane and main CC. After
// BUG-2 they default to different agents (Discovery→`discovery`, main→`plancore`). A send from one surface
// must NOT bleed into the other's live seat, and a replaced seat must be CLOSED, not orphaned.
// @ts-nocheck — .js ESM helper (no .d.ts); runtime import works under vitest.
import { describe, it, expect } from 'vitest';
import { seatReconcilePlan, needsSeatSwitch, seatLeaseSendChain } from './web/public/cc-session-reconcile.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const sess = (agentId, sid = 's-' + agentId) => ({ sid, agentId });
const PLANCORE = 10;
const DISCOVERY = 11;

describe('F3 cc-session-reconcile (no cross-surface bleed, no orphaned seat)', () => {
  it('reuse: session already bound to the target agent → keep it (no re-spawn)', () => {
    expect(seatReconcilePlan(sess(PLANCORE), PLANCORE)).toEqual({ action: 'reuse', closeSid: null });
    expect(needsSeatSwitch(sess(PLANCORE), PLANCORE)).toBe(false);
  });

  it('spawn: no live session → spawn the target (nothing to close)', () => {
    expect(seatReconcilePlan(null, DISCOVERY)).toEqual({ action: 'spawn', closeSid: null });
    expect(seatReconcilePlan({ sid: null, agentId: DISCOVERY }, DISCOVERY)).toEqual({ action: 'spawn', closeSid: null });
    expect(needsSeatSwitch(null, DISCOVERY)).toBe(false);
  });

  it('switch: live session is a DIFFERENT agent → close the replaced seat, then spawn the target', () => {
    const plan = seatReconcilePlan(sess(DISCOVERY, 's-disc'), PLANCORE);
    expect(plan.action).toBe('switch');
    expect(plan.closeSid).toBe('s-disc'); // the replaced session is closed (no orphan)
    expect(needsSeatSwitch(sess(DISCOVERY, 's-disc'), PLANCORE)).toBe(true);
  });

  it('noop: no target agent selected', () => {
    expect(seatReconcilePlan(sess(PLANCORE), null)).toEqual({ action: 'noop', closeSid: null });
    expect(needsSeatSwitch(sess(PLANCORE), undefined)).toBe(false);
  });

  it('repro: main(plancore) → Discovery send(discovery) → back to main send(plancore) — each send owns its agent, replaced seat closed', () => {
    // main CC selected plancore, a session is live for plancore.
    let live = sess(PLANCORE, 's-plancore');

    // Discovery sends → must switch to `discovery` and CLOSE the plancore seat (not orphan it).
    const toDisc = seatReconcilePlan(live, DISCOVERY);
    expect(toDisc.action).toBe('switch');
    expect(toDisc.closeSid).toBe('s-plancore');
    live = sess(DISCOVERY, 's-discovery'); // after switch, the discovery seat is live

    // Back in main CC with plancore still selected → send must NOT go to the discovery seat; it switches
    // back to plancore and closes the discovery seat. (Before the fix, main CC sent into 's-discovery'.)
    expect(needsSeatSwitch(live, PLANCORE)).toBe(true);
    const backToMain = seatReconcilePlan(live, PLANCORE);
    expect(backToMain.action).toBe('switch');
    expect(backToMain.closeSid).toBe('s-discovery'); // discovery seat closed → no orphan, no bleed
  });
});

describe('F3 seatLeaseSendChain (lease the seat through the caller\'s POST — serialize ensure→send)', () => {
  // Harness modelling the single per-project slot: `slot` is the live session; getCurrent re-reads it; a
  // per-call runSwitchAndSpawn closes the replaced seat (on switch), spawns THIS call's target agent, and
  // updates the slot; a per-call `send` models the caller's own message POST. `events` records the REAL
  // ordering of close / spawn / send so we can assert A's POST lands BEFORE B tears A's seat down.
  function harness(initial) {
    let slot = initial;
    let n = 0;
    const events = [];
    const getCurrent = () => slot;
    const mkRun = (targetAid, sidLabel) => async (plan) => {
      if (plan.action === 'switch') { events.push('close:' + plan.closeSid); await delay(10); }
      const next = { sid: sidLabel + '#' + (++n), agentId: targetAid };
      events.push('spawn:' + next.sid); slot = next; await delay(10);
      return next;
    };
    const mkSend = (label) => async (session) => { events.push('send:' + label + '@' + session.sid); await delay(10); return 'ok:' + label; };
    return { getCurrent, mkRun, mkSend, events, get slot() { return slot; } };
  }
  const spawnCount = (h) => h.events.filter((e) => e.startsWith('spawn')).length;
  const idx = (h, prefix) => h.events.findIndex((e) => e.startsWith(prefix));

  it('same-agent concurrent → one spawn (reuse), each posts its own message, in order', async () => {
    const inflight = {};
    const h = harness(sess(DISCOVERY, 's-discovery'));
    const [a, b] = await Promise.all([
      seatLeaseSendChain(inflight, 42, h.getCurrent, PLANCORE, h.mkRun(PLANCORE, 'plancore'), h.mkSend('A')),
      seatLeaseSendChain(inflight, 42, h.getCurrent, PLANCORE, h.mkRun(PLANCORE, 'plancore'), h.mkSend('B')),
    ]);
    expect(spawnCount(h)).toBe(1);          // ONE plancore spawn (B saw reuse)
    expect(a.session.sid).toBe(b.session.sid); // both on the same seat
    expect(a.session.agentId).toBe(PLANCORE);
    expect(a.result).toBe('ok:A'); expect(b.result).toBe('ok:B'); // each posted its own message
    expect(idx(h, 'send:A')).toBeLessThan(idx(h, 'send:B')); // ordered
    expect(inflight[42]).toBeUndefined();
  });

  it('LEASE: two different-agent sends → A POSTS before B DELETEs A\'s seat; each on its own agent; no orphan', async () => {
    const inflight = {};
    const h = harness(sess(999, 's-old'));
    const [a, b] = await Promise.all([
      seatLeaseSendChain(inflight, 1, h.getCurrent, PLANCORE, h.mkRun(PLANCORE, 'plancore'), h.mkSend('A')),
      seatLeaseSendChain(inflight, 1, h.getCurrent, DISCOVERY, h.mkRun(DISCOVERY, 'discovery'), h.mkSend('B')),
    ]);
    // Each caller landed on — and POSTed to — its OWN agent.
    expect(a.session.agentId).toBe(PLANCORE); expect(a.result).toBe('ok:A');
    expect(b.session.agentId).toBe(DISCOVERY); expect(b.result).toBe('ok:B');
    expect(a.session.sid).not.toBe(b.session.sid);
    // THE LEASE: A's POST to plancore happens BEFORE B's close (DELETE) of plancore — no 404, no post-into-dying-seat.
    const iSendA = idx(h, 'send:A@');
    const iClosePlancore = h.events.findIndex((e) => e.startsWith('close:') && e.includes('plancore'));
    expect(iSendA).toBeGreaterThanOrEqual(0);
    expect(iClosePlancore).toBeGreaterThan(iSendA);
    expect(h.slot.agentId).toBe(DISCOVERY); // exactly one live seat (the last)
    expect(spawnCount(h)).toBe(2);
    expect(inflight[1]).toBeUndefined();
  });

  it('LEASE: THREE different-agent sends → each POSTs to its own seat before the next teardown', async () => {
    const inflight = {};
    const h = harness(sess(999, 's-old'));
    const [a, b, c] = await Promise.all([
      seatLeaseSendChain(inflight, 2, h.getCurrent, PLANCORE, h.mkRun(PLANCORE, 'plancore'), h.mkSend('A')),
      seatLeaseSendChain(inflight, 2, h.getCurrent, DISCOVERY, h.mkRun(DISCOVERY, 'discovery'), h.mkSend('B')),
      seatLeaseSendChain(inflight, 2, h.getCurrent, 777, h.mkRun(777, 'third'), h.mkSend('C')),
    ]);
    expect(a.session.agentId).toBe(PLANCORE); expect(b.session.agentId).toBe(DISCOVERY); expect(c.session.agentId).toBe(777);
    expect([a.result, b.result, c.result]).toEqual(['ok:A', 'ok:B', 'ok:C']); // all three posted
    // Strict lease ordering across the whole chain: spawn→send→close→spawn→send→close→spawn→send.
    expect(h.events).toEqual([
      'close:s-old', 'spawn:plancore#1', 'send:A@plancore#1',
      'close:plancore#1', 'spawn:discovery#2', 'send:B@discovery#2',
      'close:discovery#2', 'spawn:third#3', 'send:C@third#3',
    ]);
    expect(h.slot.agentId).toBe(777);
    expect(spawnCount(h)).toBe(3);
  });

  it('arrival right AS the lock releases → a fresh leased switch runs (lock does not stick)', async () => {
    const inflight = {};
    const h = harness(sess(DISCOVERY, 's-1'));
    const r1 = await seatLeaseSendChain(inflight, 9, h.getCurrent, PLANCORE, h.mkRun(PLANCORE, 'plancore'), h.mkSend('A'));
    expect(inflight[9]).toBeUndefined(); // released
    const r2 = await seatLeaseSendChain(inflight, 9, h.getCurrent, DISCOVERY, h.mkRun(DISCOVERY, 'discovery'), h.mkSend('B'));
    expect(r1.session.agentId).toBe(PLANCORE);
    expect(r2.session.agentId).toBe(DISCOVERY);
    expect(spawnCount(h)).toBe(2);
  });

  it('reuse (no switch) is cheap: single send to the already-live agent → no spawn, posts once', async () => {
    const inflight = {};
    const h = harness(sess(PLANCORE, 's-p'));
    const r = await seatLeaseSendChain(inflight, 5, h.getCurrent, PLANCORE, h.mkRun(PLANCORE, 'plancore'), h.mkSend('A'));
    expect(spawnCount(h)).toBe(0);
    expect(r.session.agentId).toBe(PLANCORE);
    expect(r.result).toBe('ok:A');
    expect(inflight[5]).toBeUndefined();
  });
});
