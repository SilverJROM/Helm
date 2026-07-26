// cc-delivery.test.ts
// F2: delivery-failed correlation is by STABLE msgId (the bubble id), never by text.
// @ts-nocheck — .js ESM helper (no .d.ts); runtime import works under vitest.
import { describe, it, expect } from 'vitest';
import { markUndeliveredById, applyDeliveryFailedById, hasOutstandingOptimistic } from './web/public/cc-delivery.js';

const u = (id, text, delivered = true) => ({ id, role: 'user', text, delivered });

describe('F2 markUndeliveredById — correlate by msgId, never by text', () => {
  it('DUPLICATE TEXT: two user bubbles with identical text but distinct ids → only the FAILED id is marked', () => {
    const bubbles = [u('m1', 'do the thing'), { id: 'a1', role: 'agent', text: 'ok' }, u('m2', 'do the thing')];
    const out = markUndeliveredById(bubbles, 'm1'); // m1 failed
    expect(out[0].delivered).toBe(false); // m1 marked
    expect(out[2].delivered).toBe(true);  // m2 (same text) NOT marked — no text-based mis-mark
  });

  it('marks the specific id even when a later same-text message exists', () => {
    const bubbles = [u('m1', 'hi'), u('m2', 'hi')];
    expect(markUndeliveredById(bubbles, 'm2')[1].delivered).toBe(false);
    expect(markUndeliveredById(bubbles, 'm2')[0].delivered).toBe(true);
  });

  it('RECONNECT/replay safe: an unknown or already-marked id is a no-op (never re-marks a same-text message)', () => {
    const bubbles = [u('m1', 'hi', false), u('m2', 'hi')]; // m1 already undelivered
    expect(markUndeliveredById(bubbles, 'm1')).toBe(bubbles); // already false → unchanged (same ref)
    expect(markUndeliveredById(bubbles, 'nope')).toBe(bubbles); // unknown id → unchanged
    // m2 stays delivered — a replayed m1 event does NOT bleed onto the same-text m2.
    expect(markUndeliveredById(bubbles, 'm1')[1].delivered).toBe(true);
  });

  it('does not touch non-user bubbles or empty/invalid input', () => {
    const bubbles = [{ id: 'a1', role: 'agent', text: 'x' }];
    expect(markUndeliveredById(bubbles, 'a1')).toBe(bubbles); // agent bubble not marked
    expect(markUndeliveredById([], 'm1')).toEqual([]);
    expect(markUndeliveredById(null, 'm1')).toBe(null);
    expect(markUndeliveredById([u('m1', 'hi')], '')).toEqual([u('m1', 'hi')]); // empty msgId → no-op
  });
});

// Round-7 finding #3: render-before-ack + prior-seat detection.
describe('F2 applyDeliveryFailedById — matched (present seat) vs prior-seat (absent) — case (a)', () => {
  it('PRESENT seat: the bubble exists → matched=true and it is marked undelivered (caller renders, then ACKs)', () => {
    const bubbles = [u('m1', 'hi')];
    const res = applyDeliveryFailedById(bubbles, 'm1');
    expect(res.matched).toBe(true);
    expect(res.bubbles[0].delivered).toBe(false);
  });

  it('PRIOR seat: the msgId is absent (old sid cleared on an F3 switch) → matched=false (caller shows a gap, not a silent no-op)', () => {
    const bubbles = [u('m2', 'other')];
    const res = applyDeliveryFailedById(bubbles, 'gone-old-sid');
    expect(res.matched).toBe(false);            // → the caller surfaces a channel-level prior-seat GAP
    expect(res.bubbles).toBe(bubbles);          // nothing to mark (unchanged ref)
  });

  it('PRESENT but already-marked: existence-based matched=true (a duplicate event is NOT mistaken for a prior seat)', () => {
    const bubbles = [u('m1', 'hi', false)];     // already delivered=false
    const res = applyDeliveryFailedById(bubbles, 'm1');
    expect(res.matched).toBe(true);             // present → NOT a prior-seat gap
    expect(res.bubbles).toBe(bubbles);          // idempotent (already marked)
  });

  it('empty thread / empty msgId → matched=false, unchanged', () => {
    expect(applyDeliveryFailedById([], 'm1').matched).toBe(false);
    expect(applyDeliveryFailedById([u('m1', 'hi')], '').matched).toBe(false);
  });
});

// Round-7 finding #5: epoch degradation must consult LIVE thread state.
describe('F2 hasOutstandingOptimistic — does an epoch reset need to show a gap?', () => {
  it('true when an outstanding (still-delivered) user bubble exists', () => {
    expect(hasOutstandingOptimistic([u('m1', 'hi')])).toBe(true);
  });
  it('false when all user bubbles are already resolved (delivered=false) or none exist', () => {
    expect(hasOutstandingOptimistic([u('m1', 'hi', false)])).toBe(false);
    expect(hasOutstandingOptimistic([{ id: 'a1', role: 'agent', text: 'x' }])).toBe(false);
    expect(hasOutstandingOptimistic([])).toBe(false);
    expect(hasOutstandingOptimistic(null)).toBe(false);
    expect(hasOutstandingOptimistic(undefined)).toBe(false);
  });
});
