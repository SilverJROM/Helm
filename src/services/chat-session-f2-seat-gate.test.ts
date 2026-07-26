// F2 TERMINAL acceptance matrix (round-6). Contract: "an accepted message's uncertain delivery status may
// never disappear without EITHER an exact failure event OR a visible gap." Delivery failures are keyed by a
// LOGICAL CHANNEL (project:<pid> / studio:<agentId>), decoupled from session lifecycle; each channel owns its
// own seq/cursor; every destructive retention path degrades to a gap (never a silent loss); memory is bounded;
// cursors are epoch-aware. Drives the REAL TmuxService.sendAndSubmit via a scripted pane where a real send is
// needed; models the HTTP handler's fire-and-forget.
process.env.USE_FAKE_TMUX = '1';
process.env.HELM_TEST_FAST_WD = '1';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChatSessionService } from './chat-session-service.js';
import { TmuxService } from '../tmux/tmux-service.js';

class SeatStubTmux extends TmuxService {
  typed: string[] = [];
  events: string[] = [];
  captures = 0;
  bootUntilCapture = Infinity;
  bootFrame = '  Claude Code starting…\n  checking for updates\n  Please authenticate\n';
  readyFrame = '';
  onEnter: (() => void) | null = null;
  async capturePane(_t: string, _l = 200): Promise<string> { this.captures += 1; return this.captures <= this.bootUntilCapture ? this.bootFrame : this.readyFrame; }
  async sessionExists(_t: string): Promise<boolean> { return true; }
  async terminateSession(_n: string): Promise<void> { /* no real tmux */ }
  async waitForReady(_t: string, _signal = '❯', _timeoutMs = 30000): Promise<boolean> { this.events.push('composer-ready'); return true; }
  async sendLiteralText(_t: string, text: string): Promise<void> { this.events.push('paste'); this.typed.push(text); }
  async sendEnter(_t: string) { if (this.onEnter) this.onEnter(); return { message: 'enter', blocked: false }; }
  async sendKeys(_t: string, k: string) { return { message: k, blocked: false }; }
}

function makeSvc(tmux: any): ChatSessionService {
  return new ChatSessionService({ tmux, modelService: {} as any, assignmentService: {} as any, resolverService: {} as any });
}
const SID = 'seat-1';
const CH = 'project:1';
function injectSession(svc: ChatSessionService, sid = SID, provider = 'claude', model = 'claude-opus-4-8') {
  (svc as any).sessions.set(sid, {
    agentId: 1, tmuxSession: 'helm-seat', paneTarget: `helm-${sid}:0.0`, lastSnapshot: '',
    createdAt: Date.now(), bootstrapSent: true, bootstrapEndMarker: '<!-- x -->', bootstrapMarkerSeen: true,
    spawnProvider: provider, spawnModel: model,
  });
}
// Directly seed a channel ledger entry (for prune / cap / gap tests that would otherwise need thousands of sends).
function seedChannel(svc: ChatSessionService, channel: string, opts: { seq?: number; msgIds?: string[]; evictedThrough?: number; ackedThrough?: number; updatedAt?: number }) {
  const msgIds = opts.msgIds ?? [];
  (svc as any).channelLedger.set(channel, {
    seq: opts.seq ?? msgIds.length,
    failures: msgIds.map((m, i) => ({ seq: i + 1, msgId: m, text: 't', reason: 'r' })),
    evictedThrough: opts.evictedThrough ?? 0,
    ackedThrough: opts.ackedThrough ?? 0,
    emittedThrough: (opts as any).emittedThrough ?? (opts.seq ?? msgIds.length), // round-7: seeded failures treated as already emitted
    updatedAt: opts.updatedAt ?? Date.now(),
  });
}

describe('F2 TERMINAL acceptance matrix (channel-keyed, degradation-to-gap, epoch-aware)', () => {
  let sFake: string | undefined; let sFast: string | undefined;
  beforeAll(() => { sFake = process.env.USE_FAKE_TMUX; sFast = process.env.HELM_TEST_FAST_WD; process.env.USE_FAKE_TMUX = '1'; process.env.HELM_TEST_FAST_WD = '1'; });
  afterAll(() => { if (sFake === undefined) delete process.env.USE_FAKE_TMUX; else process.env.USE_FAKE_TMUX = sFake; if (sFast === undefined) delete process.env.HELM_TEST_FAST_WD; else process.env.HELM_TEST_FAST_WD = sFast; });

  it('BUG-1 relay re-checks this user send for composer-ready before it pastes', async () => {
    const tmux = new SeatStubTmux(); const svc = makeSvc(tmux);
    injectSession(svc, SID, 'stub', 'stub-model');
    tmux.bootUntilCapture = 0;
    tmux.readyFrame = 'STUB-READY\n❯ \n';

    await svc.sendMessage(SID, 'ready-gated relay message', 'ui-ready', CH);

    expect(tmux.events).toContain('composer-ready');
    expect(tmux.events.indexOf('composer-ready')).toBeLessThan(tmux.events.indexOf('paste'));
    expect(tmux.typed).toEqual(['ready-gated relay message']);
    expect(svc.getDeliveryFailuresSince(CH, 0).failures).toHaveLength(0);
  });

  it('baseline: permanent boot seat → NOT dropped; surfaced under its CHANNEL with the stable msgId; delivered-once-ready records nothing', async () => {
    const tmux = new SeatStubTmux(); const svc = makeSvc(tmux); injectSession(svc);
    tmux.bootUntilCapture = Infinity;
    await svc.sendMessage(SID, 'permanent', 'ui-1', CH);
    const { failures } = svc.getDeliveryFailuresSince(CH, 0);
    expect(failures.map(f => f.msgId)).toEqual(['ui-1']);
    // delivered path records nothing:
    const tmux2 = new SeatStubTmux(); const svc2 = makeSvc(tmux2); injectSession(svc2);
    const text = 'hi'; tmux2.readyFrame = `❯ ${text}\n  bypass permissions on\n`; tmux2.bootUntilCapture = 2;
    tmux2.onEnter = () => { tmux2.readyFrame = '• Working (1s • esc to interrupt)\n\n❯ \n'; };
    await svc2.sendMessage(SID, text, 'ui-ok', CH);
    expect(tmux2.typed).toContain(text);
    expect(svc2.getDeliveryFailuresSince(CH, 0).failures).toHaveLength(0);
  });

  it('(a) an accepted OLD-sid failure arrives on the REPLACEMENT sid stream with the SAME msgId (channel survives terminate)', async () => {
    const tmux = new SeatStubTmux(); const svc = makeSvc(tmux); injectSession(svc, 'old-sid');
    tmux.bootUntilCapture = Infinity;
    await svc.sendMessage('old-sid', 'msg on old sid', 'ui-a', CH); // fails → recorded under CH
    await svc.terminate('old-sid'); // F3 switch closes the old sid
    expect((svc as any).sessions.get('old-sid')).toBeUndefined();
    // The REPLACEMENT sid's stream reads the SAME channel → still surfaces the failure with its msgId.
    const { failures } = svc.getDeliveryFailuresSince(CH, 0);
    expect(failures.map(f => f.msgId)).toEqual(['ui-a']);
  });

  it('(b) channel A high cursor cannot suppress channel B (independent per-channel seq/cursor)', () => {
    const svc = makeSvc(new SeatStubTmux());
    seedChannel(svc, 'project:A', { msgIds: ['a1'] });
    seedChannel(svc, 'project:B', { msgIds: ['b1'] });
    // A cursor of 100 on A must not affect B; B's own seq-1 failure is still delivered from B's cursor 0.
    expect(svc.getDeliveryFailuresSince('project:A', 100).failures).toHaveLength(0); // A suppressed at its own cursor
    expect(svc.getDeliveryFailuresSince('project:B', 0).failures.map(f => f.msgId)).toEqual(['b1']); // B unaffected
  });

  it('(c) no-ack TTL expiry → GAP tombstone; an ACKNOWLEDGED TTL entry cleans silently', () => {
    const svc = makeSvc(new SeatStubTmux());
    const old = Date.now() - 31 * 60 * 1000; // past the 30-min TTL
    seedChannel(svc, 'project:unacked', { seq: 3, msgIds: ['u1', 'u2', 'u3'], updatedAt: old, ackedThrough: 0 });
    seedChannel(svc, 'project:acked', { seq: 2, msgIds: ['k1', 'k2'], updatedAt: old, ackedThrough: 2 }); // fully acked
    (svc as any).pruneChannelLedger(Date.now());
    // unacked expired → compacted to a gap tombstone (payloads gone, but a GAP remains — not silent).
    const un = svc.getDeliveryFailuresSince('project:unacked', 0);
    expect(un.gapThroughSeq).toBe(3);
    expect(un.failures).toHaveLength(0);
    // acked expired → silently removed (no gap, no entry).
    const ak = svc.getDeliveryFailuresSince('project:acked', 0);
    expect(ak.gapThroughSeq).toBeNull();
    expect(ak.failures).toHaveLength(0);
    expect((svc as any).channelLedger.has('project:acked')).toBe(false);
  });

  it('(d) 501 payloads on a channel → a channel GAP (evictedThrough advanced), not a silent drop', async () => {
    const tmux = new SeatStubTmux(); const svc = makeSvc(tmux); injectSession(svc);
    tmux.bootUntilCapture = Infinity;
    // 501 permanently-failing sends on ONE channel → cap 500 → seq 1 evicted.
    await Promise.all(Array.from({ length: 501 }, (_, i) => svc.sendMessage(SID, `m${i}`, `ui-${i}`, CH)));
    const { gapThroughSeq, failures } = svc.getDeliveryFailuresSince(CH, 0);
    expect(gapThroughSeq).toBe(1);           // the oldest (seq 1) was compacted to a gap
    expect(failures).toHaveLength(500);       // the rest retained (never a silent loss)
    expect(failures[0].seq).toBe(2);
  });

  it('(e) 2001 unacknowledged channels → within the hard cap AND the sticky global lossGeneration is raised', () => {
    const svc = makeSvc(new SeatStubTmux());
    for (let i = 0; i < 2001; i++) seedChannel(svc, `project:c${i}`, { seq: 1, msgIds: [`m${i}`], updatedAt: Date.now() + i });
    expect((svc as any).channelLedger.size).toBe(2001);
    expect(svc.deliveryLossGeneration).toBe(0);
    (svc as any).pruneChannelLedger(Date.now());
    expect((svc as any).channelLedger.size).toBeLessThanOrEqual(2000); // hard cap held
    expect(svc.deliveryLossGeneration).toBeGreaterThanOrEqual(1);       // loss → app-wide visible gap (sticky)
  });

  it('(f) epoch replacement → a stale cross-epoch cursor does NOT suppress a new low-seq failure', async () => {
    const tmux = new SeatStubTmux(); const svc = makeSvc(tmux); injectSession(svc);
    tmux.bootUntilCapture = Infinity;
    await svc.sendMessage(SID, 'first this process', 'ui-r1', CH); // seq 1 in THIS epoch
    const epoch = svc.deliveryEpochToken;
    // A client holding a HIGH cursor (100) minted in a PRIOR process (different epoch): seq 1 STILL delivered.
    const stale = svc.getDeliveryFailuresSince(CH, 100, 'prior-process-epoch');
    expect(stale.epoch).toBe(epoch);
    expect(stale.failures.map(f => f.msgId)).toContain('ui-r1');
    // Same-epoch high cursor legitimately means already-seen → not re-delivered.
    expect(svc.getDeliveryFailuresSince(CH, 100, epoch).failures).toHaveLength(0);
  });

  it('(bounded ACK) an out-of-range / racing ack cannot poison the watermark or silently drop a later failure', async () => {
    const tmux = new SeatStubTmux(); const svc = makeSvc(tmux); injectSession(svc);
    tmux.bootUntilCapture = Infinity;
    // seq 1..3 permanently fail on the channel and the server EMITS them to a consumer.
    await svc.sendMessage(SID, 'a', 'ui-1', CH);
    await svc.sendMessage(SID, 'b', 'ui-2', CH);
    await svc.sendMessage(SID, 'c', 'ui-3', CH);
    const seen = svc.getDeliveryFailuresSince(CH, 0); // server hands out seq 1..3 → emittedThrough=3
    expect(seen.failures.map(f => f.seq)).toEqual([1, 2, 3]);
    // The probe: ACK 999 against seq 1..3. It must clamp to the emitted watermark (3), NOT poison it to 999.
    svc.ackDelivery(CH, 999);
    const entry = () => (svc as any).channelLedger.get(CH);
    expect(entry().ackedThrough).toBe(3);
    // seq 4 fails AFTER the bogus ack — it must NOT be pre-classified "acknowledged".
    await svc.sendMessage(SID, 'd', 'ui-4', CH);
    expect(svc.getDeliveryFailuresSince(CH, 3).failures.map(f => f.msgId)).toEqual(['ui-4']); // delivered, not dropped
    // and if seq 4 later TTL-expires still unacknowledged, it degrades to a VISIBLE gap (never a silent loss).
    entry().updatedAt = Date.now() - 31 * 60 * 1000;
    (svc as any).pruneChannelLedger(Date.now());
    const exp = svc.getDeliveryFailuresSince(CH, 3);
    expect(exp.gapThroughSeq).toBe(4);          // visible gap
    expect(svc.deliveryLossGeneration).toBe(0); // a normal per-channel gap, not a hard-cap loss
  });

  it('(bounded ACK) a non-finite ack and an ack ahead of any emit are ignored (no watermark advance)', async () => {
    const tmux = new SeatStubTmux(); const svc = makeSvc(tmux); injectSession(svc);
    tmux.bootUntilCapture = Infinity;
    await svc.sendMessage(SID, 'x', 'ui-x', CH); // seq 1 recorded, but NOTHING emitted yet (emittedThrough=0)
    svc.ackDelivery(CH, 1);   // ahead of emit → clamped to 0 → no advance, failure retained
    svc.ackDelivery(CH, NaN); // non-finite → ignored
    const entry = (svc as any).channelLedger.get(CH);
    expect(entry.ackedThrough).toBe(0);
    expect(svc.getDeliveryFailuresSince(CH, 0).failures.map(f => f.msgId)).toEqual(['ui-x']); // still surfaced
  });

  it('duplicate-text by msgId; reconnect resumes from last seq; ack frees delivered payloads', async () => {
    const tmux = new SeatStubTmux(); const svc = makeSvc(tmux); injectSession(svc);
    tmux.bootUntilCapture = Infinity;
    await Promise.all([svc.sendMessage(SID, 'same', 'ui-A', CH), svc.sendMessage(SID, 'same', 'ui-B', CH)]);
    const all = svc.getDeliveryFailuresSince(CH, 0);
    expect(all.failures.map(f => f.msgId).sort()).toEqual(['ui-A', 'ui-B']); // distinct ids, not conflated by text
    const lastSeq = all.failures[all.failures.length - 1].seq;
    expect(svc.getDeliveryFailuresSince(CH, lastSeq).failures).toHaveLength(0); // reconnect → no replay
    // explicit ack frees delivered payloads (not by an SSE write alone).
    svc.ackDelivery(CH, lastSeq);
    const entry = (svc as any).channelLedger.get(CH);
    expect(entry.failures).toHaveLength(0);
    expect(entry.ackedThrough).toBe(lastSeq);
  });
});
