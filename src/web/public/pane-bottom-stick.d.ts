export const PANE_STICK_THRESHOLD_PX: number;

export type PaneScrollElement = {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
};

export type PaneStickIntent = {
  shouldStick: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function isNearBottom(el: PaneScrollElement | null | undefined, thresholdPx?: number): boolean;
export function captureStickIntent(el: PaneScrollElement | null | undefined, thresholdPx?: number): PaneStickIntent;
export function applyStick(el: PaneScrollElement | null | undefined, intent: { shouldStick?: boolean } | null | undefined): boolean;

declare const _default: {
  PANE_STICK_THRESHOLD_PX: number;
  isNearBottom: typeof isNearBottom;
  captureStickIntent: typeof captureStickIntent;
  applyStick: typeof applyStick;
};

export default _default;
