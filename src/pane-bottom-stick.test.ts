import { describe, it, expect } from 'vitest';
import {
  PANE_STICK_THRESHOLD_PX,
  isNearBottom,
  captureStickIntent,
  applyStick,
} from './web/public/pane-bottom-stick.js';

/**
 * B3 / R6.23 foundation — pure bottom-stick helper.
 * (a) near-bottom detection
 * (b) position preservation across a content change
 */

function fakeEl(partial: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}) {
  return {
    scrollTop: partial.scrollTop,
    scrollHeight: partial.scrollHeight,
    clientHeight: partial.clientHeight,
  };
}

describe('B3 pane-bottom-stick (pure helper)', () => {
  it('(a) isNearBottom true within threshold; false when scrolled up', () => {
    // At exact bottom
    expect(
      isNearBottom(fakeEl({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }))
    ).toBe(true);
    // Within default 24px threshold
    expect(
      isNearBottom(
        fakeEl({ scrollTop: 1000 - 200 - 10, scrollHeight: 1000, clientHeight: 200 })
      )
    ).toBe(true);
    // Just outside threshold
    expect(
      isNearBottom(
        fakeEl({
          scrollTop: 1000 - 200 - (PANE_STICK_THRESHOLD_PX + 1),
          scrollHeight: 1000,
          clientHeight: 200,
        })
      )
    ).toBe(false);
    // Scrolled well up
    expect(
      isNearBottom(fakeEl({ scrollTop: 0, scrollHeight: 1000, clientHeight: 200 }))
    ).toBe(false);
    // Non-scrollable / empty content → at bottom
    expect(
      isNearBottom(fakeEl({ scrollTop: 0, scrollHeight: 100, clientHeight: 200 }))
    ).toBe(true);
    // Null-safe
    expect(isNearBottom(null)).toBe(false);
  });

  it('(b) captureStickIntent before growth → applyStick preserves non-stick; sticks when near bottom', () => {
    // Reader scrolled up: content grows, position preserved
    const scrolledUp = fakeEl({ scrollTop: 40, scrollHeight: 500, clientHeight: 200 });
    const intentUp = captureStickIntent(scrolledUp);
    expect(intentUp.shouldStick).toBe(false);
    scrolledUp.scrollHeight = 900; // content grew
    const stuckUp = applyStick(scrolledUp, intentUp);
    expect(stuckUp).toBe(false);
    expect(scrolledUp.scrollTop).toBe(40); // preserved

    // Reader at bottom: content grows, sticks to new bottom
    const atBottom = fakeEl({ scrollTop: 300, scrollHeight: 500, clientHeight: 200 });
    const intentBot = captureStickIntent(atBottom);
    expect(intentBot.shouldStick).toBe(true);
    atBottom.scrollHeight = 800;
    const stuckBot = applyStick(atBottom, intentBot);
    expect(stuckBot).toBe(true);
    expect(atBottom.scrollTop).toBe(800);
  });
});
