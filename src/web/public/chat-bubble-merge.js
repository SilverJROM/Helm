// chat-bubble-merge.js
// E7: fixes app.js:3204 — a second, distinct agent reply was overwriting the first because
// every pane-ingest tick unconditionally merged into the last bubble whenever it was an agent
// bubble, with no check for whether the new text was actually the SAME reply continuing to
// grow (correct — that's live streaming) versus a NEW reply starting (a bug — the old reply's
// text was lost).
//
// A reply is "the same reply still forming" only if the last bubble never had real content yet,
// or the incoming text is a growing/shrinking edit of what's already there (prefix match either
// direction, to tolerate capture jitter). Anything else — including a fresh "thinking" tick
// (empty text) arriving after a bubble that already held a completed reply — is a NEW reply and
// must not stomp the old one.

export function isAgentReplyContinuation(lastMessage, nextText) {
  if (!lastMessage || lastMessage.role !== 'agent') return false;
  const prevText = String(lastMessage.text || '');
  const next = String(nextText || '');
  if (!prevText) return true;
  if (!next) return false;
  return next.startsWith(prevText) || prevText.startsWith(next);
}

export default { isAgentReplyContinuation };
