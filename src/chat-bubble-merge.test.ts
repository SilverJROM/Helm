// chat-bubble-merge.test.ts
// E7 required test: two consecutive agent replies must both survive (app.js:3204 fix).
// isAgentReplyContinuation is the merge/append decision extracted out of ingestPaneForThread.

// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { isAgentReplyContinuation } from './web/public/chat-bubble-merge.js';

describe('E7 chat-bubble-merge (app.js:3204 append-vs-replace fix)', () => {
  it('no last message -> not a continuation (append)', () => {
    expect(isAgentReplyContinuation(null, 'Hello')).toBe(false);
  });

  it('last message is from the user -> not a continuation (new agent bubble)', () => {
    expect(isAgentReplyContinuation({ role: 'user', text: 'hi' }, 'Hello')).toBe(false);
  });

  it('last agent bubble still empty (thinking) -> continuation (same reply forming)', () => {
    expect(isAgentReplyContinuation({ role: 'agent', text: '' }, '')).toBe(true);
    expect(isAgentReplyContinuation({ role: 'agent', text: '' }, 'Hello wor')).toBe(true);
  });

  it('growing text within the same reply -> continuation (merge in place)', () => {
    expect(isAgentReplyContinuation({ role: 'agent', text: 'Hello' }, 'Hello world')).toBe(true);
  });

  it('shrinking text (capture jitter) within the same reply -> continuation (merge in place)', () => {
    expect(isAgentReplyContinuation({ role: 'agent', text: 'Hello world' }, 'Hello')).toBe(true);
  });

  it('a second, distinct, unrelated reply -> NOT a continuation (must append, not overwrite)', () => {
    const last = { role: 'agent', text: 'Diwa v1 from cycle 11 is complete and clean on main.' };
    const next = 'Status: INTERVIEWING — I need three things from you before planning.';
    expect(isAgentReplyContinuation(last, next)).toBe(false);
  });

  it('a completed reply followed by a fresh "thinking" tick (empty text) -> NOT a continuation', () => {
    const last = { role: 'agent', text: 'Diwa v1 from cycle 11 is complete and clean on main.' };
    expect(isAgentReplyContinuation(last, '')).toBe(false);
  });

  it('end-to-end: appending via the merge decision keeps both replies as separate bubbles', () => {
    function appendAgentBubble(prev, bubble) {
      const last = prev[prev.length - 1];
      if (isAgentReplyContinuation(last, bubble.text)) {
        return [...prev.slice(0, -1), { ...last, ...bubble, id: last.id }];
      }
      return [...prev, bubble];
    }

    let thread = [{ id: 'u1', role: 'user', text: 'go' }];
    thread = appendAgentBubble(thread, { id: 'a1', role: 'agent', text: '' }); // thinking
    thread = appendAgentBubble(thread, { id: 'a2', role: 'agent', text: 'First reply complete.' });
    // second turn starts with no interleaving user message (autonomous continuation)
    thread = appendAgentBubble(thread, { id: 'a3', role: 'agent', text: '' }); // thinking again
    thread = appendAgentBubble(thread, { id: 'a4', role: 'agent', text: 'Second reply complete.' });

    const agentBubbles = thread.filter((m) => m.role === 'agent');
    expect(agentBubbles).toHaveLength(2);
    expect(agentBubbles[0].text).toBe('First reply complete.');
    expect(agentBubbles[1].text).toBe('Second reply complete.');
  });
});
