// CC-CHAT-2 R3: GET /chat merge shape — owner transcript + run callbacks.md, time-ordered.
import { describe, it, expect } from 'vitest';
import { parseCallbacksMd, toRunChatMessages, mergeChatMessages, CallbackTsCache, tsToMs } from './run-chat-merge.js';
import { workerFaceRole } from './role-alias.js';

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

  it('maps phase-brain lines to an agent bubble and worker lines to role-chip status messages, batch-keyed chat-<pid>', () => {
    const lines = parseCallbacksMd(CB, 'rsmoke1');
    const ts = lines.map((_, i) => new Date(1000 * (i + 1)).toISOString());
    // A14 (D8/R4.31): no brainDispatches passed here — helm_pm is genuinely ambiguous (shared by
    // plancore AND ibrain) without dispatch/run context, so the honest fallback label is the raw
    // face token itself, never a guessed internal role (see the dedicated A14 tests below for the
    // dispatch-resolved case).
    const msgs = toRunChatMessages(lines, { projectId: 1, runPk: 84, batchId: 'rsmoke1', ts });
    // coordinator face, unresolved without dispatch context -> the honest fallback label
    expect(msgs[0].role).toBe('helm_pm');
    expect(msgs[1].role).toBe('helm_pm');
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
    expect(merged[1].role).toBe('helm_pm'); // A14: honest fallback — no dispatch context passed here
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

  // A14 (D8/R4.31 sole owner): helm_pm is a SHARED face for BOTH plancore and ibrain — a bare
  // string map can never disambiguate it. Resolution uses run/dispatch context (worker_runtimes
  // windows), the same class of fix as agent-event-ingest.ts's roleMatches(run.role, parsed.role).
  describe('A14: helm_pm resolves via run/dispatch context, never a bare map', () => {
    const PLAN_CB = `[helm callback] helm_pm rdispatch1 STATUS: WORKING — planning underway
[helm callback] helm_pm rdispatch1 STATUS: PLAN-READY — plan agreed
[helm callback] helm_pm rdispatch1 STATUS: DECISION-READY — mid-run escalation classified
`;

    it('resolves a face-line to the run canonical role using dispatch windows, never a bare map', () => {
      const lines = parseCallbacksMd(PLAN_CB, 'rdispatch1');
      const ts = [
        '2026-07-10T10:01:00.000Z', // inside the plancore dispatch window
        '2026-07-10T10:02:00.000Z', // inside the plancore dispatch window
        '2026-07-10T10:20:00.000Z', // AFTER plancore ended, inside the ibrain dispatch window
      ];
      const brainDispatches = [
        { role: 'plancore' as const, startedAtMs: Date.parse('2026-07-10T10:00:00.000Z'), endedAtMs: Date.parse('2026-07-10T10:10:00.000Z'), model: 'claude-sonnet', provider: 'claude' },
        { role: 'ibrain' as const, startedAtMs: Date.parse('2026-07-10T10:15:00.000Z'), endedAtMs: null, model: 'grok-4.5', provider: 'grok' },
      ];
      const msgs = toRunChatMessages(lines, { projectId: 1, runPk: 99, batchId: 'rdispatch1', ts, brainDispatches });
      expect(msgs[0].role).toBe('plancore');
      expect(msgs[0].body.model).toBe('claude-sonnet');
      expect(msgs[1].role).toBe('plancore');
      // seeded ibrain wake — labelled ibrain, NOT plancore, even though the raw line is the same
      // shared 'helm_pm' face and the run has no other distinguishing marker on the line itself.
      expect(msgs[2].role).toBe('ibrain');
      expect(msgs[2].body.model).toBe('grok-4.5');
    });

    // Regression: worker_runtimes.started_at/ended_at are SQLite datetime('now') — SECOND
    // granularity — while a callback line's own ts is millisecond-precision. A line genuinely
    // emitted just BEFORE a brand-new dispatch can still land in the exact SAME reported second as
    // that dispatch's (truncated-down) started_at. The caller (index.ts) pads an implicit window
    // boundary (derived from the next dispatch's start, not this row's own ended_at) by just under
    // a second to absorb that — this test proves the resulting overlap resolves to the OLDER,
    // already-active window, not the brand-new one, when a line's ts ties within that pad.
    it('a same-second tie at an IMPLICIT (padded) window boundary resolves to the OLDER window, not the brand-new one', () => {
      const CB = `[helm callback] helm_pm rtie1 STATUS: PLAN-READY — plan agreed\n`;
      const lines = parseCallbacksMd(CB, 'rtie1');
      // ibrain reports started_at truncated to 10:10:00.000 (SQLite second granularity); the line's
      // own ms-precision ts lands 101ms into that SAME reported second — genuinely ambiguous.
      const ibrainStart = Date.parse('2026-07-12T10:10:00.000Z');
      const ts = [new Date(ibrainStart + 101).toISOString()];
      const brainDispatches = [
        // plancore's window end is IMPLICIT (no own endedAtMs) — padded by the caller to
        // ibrainStart + 999, exactly mirroring index.ts's construction.
        { role: 'plancore' as const, startedAtMs: Date.parse('2026-07-12T10:00:00.000Z'), endedAtMs: ibrainStart + 999, model: 'claude-sonnet', provider: 'claude' },
        { role: 'ibrain' as const, startedAtMs: ibrainStart, endedAtMs: null, model: 'grok-4.5', provider: 'grok' },
      ];
      const msgs = toRunChatMessages(lines, { projectId: 3, runPk: 102, batchId: 'rtie1', ts, brainDispatches });
      expect(msgs[0].role).toBe('plancore');
      expect(msgs[0].role).not.toBe('ibrain');
    });

    it('a seeded ibrain wake is labelled ibrain, not plancore (dedicated AC)', () => {
      const IBRAIN_CB = `[helm callback] helm_pm rib1 STATUS: DECISION-READY — mid-run escalation classified\n`;
      const lines = parseCallbacksMd(IBRAIN_CB, 'rib1');
      const ts = ['2026-07-11T12:05:00.000Z'];
      const brainDispatches = [
        { role: 'ibrain' as const, startedAtMs: Date.parse('2026-07-11T12:00:00.000Z'), endedAtMs: null },
      ];
      const msgs = toRunChatMessages(lines, { projectId: 2, runPk: 100, batchId: 'rib1', ts, brainDispatches });
      expect(msgs[0].role).toBe('ibrain');
      expect(msgs[0].role).not.toBe('plancore');
    });

    it('no dispatch context at all -> the honest helm_pm fallback, never a guessed role (rejects the naive helm_pm->plancore replace)', () => {
      const lines = parseCallbacksMd(PLAN_CB, 'rdispatch1');
      const ts = lines.map((_, i) => new Date(2000 * (i + 1)).toISOString());
      const msgs = toRunChatMessages(lines, { projectId: 1, runPk: 99, batchId: 'rdispatch1', ts }); // no brainDispatches
      for (const m of msgs) {
        expect(m.role).toBe('helm_pm');
        expect(m.role).not.toBe('plancore');
      }
    });

    it('a non-coordinator shared face (reviewer\'s own helm_code_review echo) resolves via the unambiguous alias too', () => {
      const REVIEW_CB = `[helm callback] helm_code_review rrev1 STATUS: APPROVE — clean diff\n`;
      const lines = parseCallbacksMd(REVIEW_CB, 'rrev1');
      const ts = ['2026-07-12T09:00:00.000Z'];
      const msgs = toRunChatMessages(lines, { projectId: 1, runPk: 101, batchId: 'rrev1', ts });
      expect(msgs[0].role).toBe('reviewer');
    });

    it('regression: the model-facing brief mask is unaffected — brief-writer/role-alias still show ONLY the face name to the model', () => {
      // The known offender fixed here is a HUMAN-facing display concern (run-chat-merge.ts). The
      // model-facing mask (SD3 permanent safety) must be byte-identical to before this row.
      expect(workerFaceRole('plancore')).toBe('helm_pm');
      expect(workerFaceRole('ibrain')).toBe('helm_pm');
      expect(workerFaceRole('coord')).toBe('helm_pm_fast');
      expect(workerFaceRole('reviewer')).toBe('helm_code_review');
      expect(workerFaceRole('implementer')).toBe('implementer'); // non-colliding roles pass through unchanged
    });
  });
});
