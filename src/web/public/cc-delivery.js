// cc-delivery.js
// F2: correlate a `delivery-failed` SSE event to the EXACT optimistic user bubble by its STABLE msgId (the
// bubble's `id` threaded end-to-end: optimistic UI bubble → POST → queue → deliverOne → delivery-failed SSE).
// NEVER by text — duplicate text would mis-mark the wrong bubble, and a reconnect replay would re-mark
// another same-text message. Pure + unit-testable (mirrors the reply-extractor.js pattern).

/**
 * Return a copy of `bubbles` with the newest still-"delivered" user bubble whose id === msgId marked
 * delivered=false. Idempotent: an unknown/already-marked/replayed msgId matches nothing → the array is
 * returned unchanged (so a spurious SSE replay never re-marks a same-text message).
 */
export function markUndeliveredById(bubbles, msgId) {
  if (!msgId || !Array.isArray(bubbles)) return bubbles;
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    if (b && b.role === 'user' && b.id === msgId && b.delivered !== false) {
      const arr = bubbles.slice();
      arr[i] = { ...b, delivered: false };
      return arr;
    }
  }
  return bubbles;
}

/**
 * Round-7 finding #3 (render-before-ack + prior-seat): apply a `delivery-failed` event to the LIVE thread and
 * report whether a matching optimistic user bubble was PRESENT. `matched=false` means the failure belongs to a
 * PRIOR seat — the old sid's bubble was cleared on an F3 switch — so the caller must surface a channel-level
 * prior-seat GAP (never a silent no-op) and ACK only AFTER that visible transition. `matched` is existence-based
 * (present even if already marked), so a duplicate event on a present bubble is NOT mistaken for a prior seat.
 * @returns {{ bubbles: any[], matched: boolean }}
 */
export function applyDeliveryFailedById(bubbles, msgId) {
  const present = !!msgId && Array.isArray(bubbles) && bubbles.some((b) => b && b.role === 'user' && b.id === msgId);
  return { bubbles: markUndeliveredById(bubbles, msgId), matched: present };
}

/**
 * Round-7 finding #5: does this thread hold an outstanding optimistic (still-"delivered") user message whose
 * delivery status would become uncertain on an epoch reset? MUST be read from a LIVE thread ref, never a stale
 * EventSource-attachment closure (a bubble added after attach must still count).
 */
export function hasOutstandingOptimistic(bubbles) {
  return Array.isArray(bubbles) && bubbles.some((m) => m && m.role === 'user' && m.delivered !== false);
}

export default { markUndeliveredById, applyDeliveryFailedById, hasOutstandingOptimistic };
