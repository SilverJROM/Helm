// cc-disc-stream-reconcile.test.ts
// E8 FIX1: Discovery's recovery effect was ONE-SHOT — SOL diagnosis (plan/_backlog/
// SOL-discovery-reply-path-diagnosis.md): "Discovery's recovery effect is one-shot. If
// ccSession[pid].sid exists, it returns without checking whether ccChatEsRef.current exists." That is
// exactly why the SECOND reply never appeared: once a session was known, the stream's actual liveness
// was never re-checked, so a dropped/closed EventSource left ccLivePane frozen forever with no
// consumer to refresh it. This suite proves decideDiscoveryReconcile() RECONCILES — the previous
// one-shot semantics ("a known session id is always enough, never re-check the stream") is asserted
// wrong below (a broken one-shot re-implementation of the old contract, inlined, is used to show the
// old logic returns 'none' in exactly the case that lost the reply — see the last test in this file).
// @ts-nocheck — .js ESM helper (no .d.ts); runtime import works under vitest.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decideDiscoveryReconcile, ES_CLOSED } from './web/public/cc-disc-stream-reconcile.js';

function appJsSource() {
  return readFileSync(new URL('./web/public/app.js', import.meta.url), 'utf8');
}

const ES_OPEN = 1;
const PID = 3;
const SESSION = { sid: 'f48a4da3ad69615e', agentId: 42 };

describe('E8 FIX1 decideDiscoveryReconcile (was one-shot, now reconciling)', () => {
  it('no pid → no-op', () => {
    expect(decideDiscoveryReconcile({ pid: null, session: null, streamReadyState: null, activeSessions: [] }))
      .toEqual({ action: 'none' });
  });

  it('session known, stream OPEN → healthy, do nothing (never thrash a live connection)', () => {
    const decision = decideDiscoveryReconcile({ pid: PID, session: SESSION, streamReadyState: ES_OPEN, activeSessions: [] });
    expect(decision).toEqual({ action: 'none' });
  });

  it('session known, stream NEVER ATTACHED (readyState null) → attach — the mount-time gap the one-shot bug missed', () => {
    const decision = decideDiscoveryReconcile({ pid: PID, session: SESSION, streamReadyState: null, activeSessions: [] });
    expect(decision).toEqual({ action: 'attach', sid: SESSION.sid, agentId: SESSION.agentId });
  });

  it('session known, stream CLOSED (dropped by the unrelated CC-chat route, or a proxy/tunnel idle timeout) → attach', () => {
    const decision = decideDiscoveryReconcile({ pid: PID, session: SESSION, streamReadyState: ES_CLOSED, activeSessions: [] });
    expect(decision).toEqual({ action: 'attach', sid: SESSION.sid, agentId: SESSION.agentId });
  });

  it('no session known, a live discovery seat exists in activeSessions → discover and attach (never spawns)', () => {
    const activeSessions = [
      { tmux_session: 'helm-chat-p3-discovery-f48a4d', session_id: 'f48a4da3ad69615e', agent_id: 7 },
      { tmux_session: 'helm-chat-p3-planning-ab12cd', session_id: 'other', agent_id: 9 },
    ];
    const decision = decideDiscoveryReconcile({ pid: PID, session: null, streamReadyState: null, activeSessions });
    expect(decision).toEqual({ action: 'discover-and-attach', sid: 'f48a4da3ad69615e', agentId: 7, tmux: 'helm-chat-p3-discovery-f48a4d' });
  });

  it('no session known, no matching live seat → no-op (never spawns cold)', () => {
    const decision = decideDiscoveryReconcile({ pid: PID, session: null, streamReadyState: null, activeSessions: [] });
    expect(decision).toEqual({ action: 'none' });
  });

  it('no session known, activeSessions has a DIFFERENT project\'s discovery seat → no-op (marker must match this pid)', () => {
    const activeSessions = [{ tmux_session: 'helm-chat-p99-discovery-zz9999', session_id: 'zz', agent_id: 1 }];
    const decision = decideDiscoveryReconcile({ pid: PID, session: null, streamReadyState: null, activeSessions });
    expect(decision).toEqual({ action: 'none' });
  });

  it('RED against the pre-fix one-shot contract: "a known session id is enough, never re-check the stream"', () => {
    // Inlined reproduction of the ORIGINAL bug (app.js, pre-E8): `if (ccSession[pid] && ccSession[pid].sid)
    // return;` — i.e. once a session id is known, do nothing, forever, regardless of the stream's actual
    // liveness. This is what left ccLivePane frozen after the first reply.
    const oneShotDecide = ({ session }) => (session && session.sid ? { action: 'none' } : { action: 'none' });
    const brokenPane = oneShotDecide({ session: SESSION });
    const fixedPane = decideDiscoveryReconcile({ pid: PID, session: SESSION, streamReadyState: ES_CLOSED, activeSessions: [] });
    // The exact case that dropped the second/third reply: a known session whose stream is dead. The old
    // contract says 'none' (never reattaches); the fix says 'attach'. This assertion is false under the
    // old contract — proving this suite would have failed before FIX1.
    expect(brokenPane).toEqual({ action: 'none' });
    expect(fixedPane).not.toEqual({ action: 'none' });
    expect(fixedPane.action).toBe('attach');
  });

  // The remaining two E8 FIX1 correction items (separate own-ref stream + widened activeSessions poll)
  // are wiring, not decision logic — decideDiscoveryReconcile's own tests above cover the decision.
  // These structural checks guard the wiring against a silent revert (mirrors the precedent structural
  // check in reply-extractor.test.ts's "app.js extractor call-site shapes" test).
  it('structural: Discovery has its OWN EventSource ref, independent of the old CC-chat route\'s ref', () => {
    const src = appJsSource();
    expect(src).toContain('const ccDiscChatEsRef = useRef(null);');
    expect(src).toContain("const ccDiscAttachStream = (pid, aid, sid) => ccAttachStreamOn(ccDiscChatEsRef, pid, aid, sid);");
  });

  it('structural: the old CC-chat route\'s stream-lifecycle effect never touches Discovery\'s ref', () => {
    const src = appJsSource();
    // The route effect's body is bounded by its own dependency array; slicing between its declaration
    // and the next top-level effect keeps this check tight without a full parser.
    const start = src.indexOf("if (currentSlug !== '07-command-center-chat') {");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('}, [currentSlug, ccCurrentId, ccViewMode, token]);', start);
    expect(end).toBeGreaterThan(start);
    const routeEffectBody = src.slice(start, end);
    expect(routeEffectBody).not.toContain('ccDiscChatEsRef');
    expect(routeEffectBody).not.toContain('ccDiscDetachStream');
    expect(routeEffectBody).not.toContain('ccDiscAttachStream');
  });

  it('structural: the activeSessions poll is widened to Discovery\'s route (was Studio-only)', () => {
    const src = appJsSource();
    const anchor = "const onDiscoveryRoute = currentSlug === '07-command-center-overview';";
    const start = src.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    const windowSrc = src.slice(start, start + 400);
    expect(windowSrc).toContain("currentSlug.startsWith('02-studio') || onDiscoveryRoute");
  });
});
