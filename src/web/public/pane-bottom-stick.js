// pane-bottom-stick.js
// B3 / R6.23 foundation: pure bottom-stick helper for session panes.
// Records whether the reader was already near the bottom *before* content changes,
// then optionally sticks. No Preact/app coupling — fake-element friendly for unit tests.
// B6 will replace the four unconditional scrollTop=scrollHeight sites with this API.

/** Default distance (px) from true bottom still treated as "at bottom". */
export const PANE_STICK_THRESHOLD_PX = 24;

/**
 * @param {{ scrollTop?: number, scrollHeight?: number, clientHeight?: number } | null | undefined} el
 * @param {number} [thresholdPx]
 * @returns {boolean}
 */
export function isNearBottom(el, thresholdPx = PANE_STICK_THRESHOLD_PX) {
  if (!el || typeof el !== 'object') return false;
  const scrollTop = Number(el.scrollTop) || 0;
  const scrollHeight = Number(el.scrollHeight) || 0;
  const clientHeight = Number(el.clientHeight) || 0;
  const threshold = Number.isFinite(Number(thresholdPx)) ? Number(thresholdPx) : PANE_STICK_THRESHOLD_PX;
  // Empty / non-scrollable: treat as at bottom so first paint can follow.
  if (scrollHeight <= clientHeight) return true;
  return scrollHeight - scrollTop - clientHeight <= Math.max(0, threshold);
}

/**
 * Capture stick intent *before* content mutation.
 * @param {{ scrollTop?: number, scrollHeight?: number, clientHeight?: number } | null | undefined} el
 * @param {number} [thresholdPx]
 * @returns {{ shouldStick: boolean, scrollTop: number, scrollHeight: number, clientHeight: number }}
 */
export function captureStickIntent(el, thresholdPx = PANE_STICK_THRESHOLD_PX) {
  const scrollTop = el && typeof el === 'object' ? Number(el.scrollTop) || 0 : 0;
  const scrollHeight = el && typeof el === 'object' ? Number(el.scrollHeight) || 0 : 0;
  const clientHeight = el && typeof el === 'object' ? Number(el.clientHeight) || 0 : 0;
  return {
    shouldStick: isNearBottom(el, thresholdPx),
    scrollTop,
    scrollHeight,
    clientHeight,
  };
}

/**
 * Apply a previously captured stick intent after content mutation.
 * Only scrolls to bottom when shouldStick was true; otherwise leaves scrollTop alone.
 * @param {{ scrollTop?: number, scrollHeight?: number, clientHeight?: number } | null | undefined} el
 * @param {{ shouldStick?: boolean } | null | undefined} intent
 * @returns {boolean} true if stuck to bottom
 */
export function applyStick(el, intent) {
  if (!el || typeof el !== 'object') return false;
  if (!intent || !intent.shouldStick) return false;
  const scrollHeight = Number(el.scrollHeight) || 0;
  el.scrollTop = scrollHeight;
  return true;
}

export default {
  PANE_STICK_THRESHOLD_PX,
  isNearBottom,
  captureStickIntent,
  applyStick,
};
