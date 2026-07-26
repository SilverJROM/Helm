import { createHash } from 'node:crypto';
import { paneFooterRegion, paneIsGenerating, stripAnsi } from './chat-session-service.js';
import { seatReadySignal } from '../config/providers.js';

export interface SeatInspection {
  sessionAlive: boolean;
  pane: string;
  composerHoldsBrief: boolean;
}

export interface SeatPaneState {
  known: boolean;
  hash: string | null;
  idlePrompt: boolean;
  generating: boolean;
  composerHeld: boolean;
}

/** Pure, footer-scoped classification used by callback waits and provider fixture tests. */
export function classifySeatPane(provider: string | undefined, inspection: SeatInspection): SeatPaneState {
  const pane = stripAnsi(inspection.pane ?? '').replace(/\r\n/g, '\n');
  const known = pane.trim().length > 0;
  const generating = known && paneIsGenerating(pane);
  const footer = known ? paneFooterRegion(pane, 8) : '';
  const readySignal = seatReadySignal(provider);
  const idlePrompt = Boolean(
    known &&
    readySignal &&
    footer.includes(readySignal) &&
    !generating &&
    !inspection.composerHoldsBrief
  );

  return {
    known,
    hash: known ? createHash('sha256').update(pane).digest('hex') : null,
    idlePrompt,
    generating,
    composerHeld: inspection.composerHoldsBrief,
  };
}
