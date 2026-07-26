// F2 round-7 finding #4 + matrix (c)/(d)/(e): the per-channel delivery GAP and the app-wide sticky loss
// warning (with a dismiss control) must be VISIBLE on EVERY client surface — Discovery, Command Center, AND
// Studio. TTL / 501-cap / hard-cap / epoch degradation were previously invisible to a Studio user because the
// Studio thread renderer consumed neither `chatDeliveryGap` nor `ccGlobalLossWarn`. There is no DOM harness in
// this repo (app.js imports preact/htm from esm.sh), so this is a render-wiring structural guard that would
// catch a regression removing any surface's banners.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appJs = readFileSync(fileURLToPath(new URL('./web/public/app.js', import.meta.url)), 'utf8');

// Isolate the Studio thread render block so the assertion is scoped to Studio (not just "somewhere in the file").
function block(src: string, startNeedle: string, endNeedle: string): string {
  const a = src.indexOf(startNeedle);
  const b = src.indexOf(endNeedle, a);
  return a >= 0 && b >= 0 ? src.slice(a, b) : '';
}
const studioThread = block(appJs, 'const chatThread = html`', 'const chatFooter = html`');

describe('F2 round-7 (finding #4): delivery gap + loss warning render on ALL surfaces incl. Studio', () => {
  it('STUDIO thread renderer shows the per-channel gap (chatDeliveryGap)', () => {
    expect(studioThread).toContain('data-testid="chat-delivery-gap"');
    expect(studioThread).toContain('chatDeliveryGap');
  });

  it('STUDIO thread renderer shows the app-wide loss warning with a Dismiss control', () => {
    expect(studioThread).toContain('data-testid="chat-loss-warn"');
    expect(studioThread).toContain('ccGlobalLossWarn');
    expect(studioThread).toContain('ccAckGlobalLoss'); // owner dismiss/ack control
  });

  it('COMMAND CENTER surface still renders the gap + dismissable loss warning (regression guard)', () => {
    expect(appJs).toContain('data-testid="cc-delivery-gap"');
    expect(appJs).toContain('data-testid="cc-loss-warn"');
  });

  it('DISCOVERY surface still renders the gap + dismissable loss warning (regression guard)', () => {
    expect(appJs).toContain('data-testid="ws-disc-delivery-gap"');
    expect(appJs).toContain('data-testid="ws-disc-loss-warn"');
  });
});
