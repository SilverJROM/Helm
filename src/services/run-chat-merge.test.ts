// CC-CHAT-2 R3: GET /chat merge shape — owner transcript + run callbacks.md, time-ordered.
import { describe, it, expect } from 'vitest';
import { parseCallbacksMd, toRunChatMessages, mergeChatMessages, CallbackTsCache, tsToMs } from './run-chat-merge.js';

const CB = `[helm callback] helm_pm rsmoke1 STATUS: WORKING — beginning north-star interview
[helm callback] helm_pm rsmoke1 STATUS: NORTH-STAR-READY — north-star authored; interview complete

[helm ACK] helm_pm rsmoke1 RECEIVED — ack before reap
[helm callback] implementer rsmoke1 STATUS: WORKING — implementing lib/pingPong.js
[helm callback] implementer rsmoke1 STATUS: DONE — committed abc1234; tests pass
[helm callback] validator rsmoke1 STATUS: PASS — verified ping() returns 'pong'
[projcore callback] projcore rsmoke1 STATUS: PLAN-READY — plan agreed; see plan.json
[helm callback] planner rsmoke1-partner STATUS: VERDICT-READY
[helm callback] implementer otherbatch STATUS: DONE — must be filtered out
not a callback line at all
`;

describe('run-chat-merge (CC-CHAT-2 R3)', () => {
  it('parses Helm-native STATUS lines and rejects the retired callback prefix', () => {
    const lines = parseCallbacksMd(CB, 'rsmoke1');
    expect(lines.map(l => `${l.role}:${l.state}`)).toEqual([
      'helm_pm:WORKING',
      'helm_pm:NORTH-STAR-READY',
      'implementer:WORKING',
      'implementer:DONE',
      'validator:PASS',
      'planner:VERDICT-READY'
    ]);
    expect(lines[0].note).toBe('beginning north-star interview');
    expect(lines[5].note).toBe(''); // no em-dash note
  });

  it('maps phase-brain lines to helm-pm agent bubbles and worker lines to role-chip status messages, batch-keyed chat-<pid>', () => {
    const lines = parseCallbacksMd(CB, 'rsmoke1');
    const ts = lines.map((_, i) => new Date(1000 * (i + 1)).toISOString());
    const msgs = toRunChatMessages(lines, { projectId: 1, runPk: 84, batchId: 'rsmoke1', ts });
    // coordinator face -> the agent
    expect(msgs[0].role).toBe('helm-pm');
    expect(msgs[1].role).toBe('helm-pm');
    // workers keep their role (compact status bubbles in the UI)
    expect(msgs[2].role).toBe('implementer');
    expect(msgs[4].role).toBe('validator');
    for (const m of msgs) {
      expect(m.batch_id).toBe('chat-1');
      expect(m.run_cb).toBe(true);
      expect(m.type).toBe('status');
      expect(typeof m.body.text).toBe('string');
    }
    expect(msgs[3].state).toBe('DONE');
    expect(msgs[3].body.text).toContain('committed abc1234');
  });

  it('merges owner events + run callbacks TIME-ORDERED with stable intra-source order (owner prompt first, mid-run owner message interleaved)', () => {
    const owner = [
      { id: 1, role: 'owner', batch_id: 'chat-1', body: { text: 'Smoke: build pingPong', kind: 'run-prompt' }, ts: '2026-07-02T10:00:00.000Z' },
      { id: 2, role: 'owner', batch_id: 'chat-1', body: { text: 'answer: option 1' }, ts: '2026-07-02T10:05:00.000Z' }
    ];
    const lines = parseCallbacksMd(CB, 'rsmoke1');
    const ts = [
      '2026-07-02T10:01:00.000Z', // helm_pm WORKING (before the mid-run owner msg)
      '2026-07-02T10:06:00.000Z', // NORTH-STAR-READY (after it)
      '2026-07-02T10:07:00.000Z',
      '2026-07-02T10:08:00.000Z',
      '2026-07-02T10:09:00.000Z',
      '2026-07-02T10:10:00.000Z'
    ];
    const cbMsgs = toRunChatMessages(lines, { projectId: 1, runPk: 84, batchId: 'rsmoke1', ts });
    const merged = mergeChatMessages(owner, cbMsgs);
    expect(merged.length).toBe(owner.length + cbMsgs.length);
    // Order: prompt, helm_pm WORKING, owner answer, then the rest in file order.
    expect(merged[0].body.kind).toBe('run-prompt');
    expect(merged[1].state).toBe('WORKING');
    expect(merged[1].role).toBe('helm-pm');
    expect(merged[2].id).toBe(2); // mid-run owner message interleaves by ts
    expect(merged.slice(3).map((m: any) => m.state)).toEqual([
      'NORTH-STAR-READY', 'WORKING', 'DONE', 'PASS', 'VERDICT-READY'
    ]);
    // stable: intra-source relative order preserved
    const cbOnly = merged.filter((m: any) => m.run_cb).map((m: any) => m.correlation_id);
    expect(cbOnly).toEqual(cbMsgs.map((m: any) => m.correlation_id));
  });

  it('mergeChatMessages tolerates sqlite "YYYY-MM-DD HH:MM:SS" timestamps (normalized vs ISO)', () => {
    expect(tsToMs('2026-07-02 10:00:00')).toBe(tsToMs('2026-07-02T10:00:00.000Z'));
    const a = [{ id: 'x', ts: '2026-07-02 10:00:01' }];
    const b = [{ id: 'y', ts: '2026-07-02T10:00:00.000Z' }];
    expect(mergeChatMessages(a, b).map((m: any) => m.id)).toEqual(['y', 'x']);
  });

  it('CallbackTsCache: first observation stamps started_at, later NEW lines stamp now (live interleaving)', () => {
    const cache = new CallbackTsCache();
    const started = '2026-07-02T09:00:00.000Z';
    const first = cache.assign('1:rsmoke1', 3, started);
    expect(first).toEqual([started, started, started]);
    const before = Date.now() - 5;
    const second = cache.assign('1:rsmoke1', 5, started);
    expect(second.slice(0, 3)).toEqual([started, started, started]); // stable for already-seen lines
    expect(tsToMs(second[3])).toBeGreaterThanOrEqual(before);
    expect(second[3]).toBe(second[4]);
    // shrink/re-read never throws or loses stamps
    expect(cache.assign('1:rsmoke1', 4, started).length).toBe(4);
  });
});
