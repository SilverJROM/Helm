/**
 * B3 gate — parseAgreementCallbackLine separator widening + optional planSha (AC6/AC8 foundation).
 * Scope: planning-phase-service.ts's private parseAgreementCallbackLine only.
 */
import { describe, expect, it } from 'vitest';
import { PlanningPhaseService } from './planning-phase-service.js';

function parseLine(line: string): { role: string; batchId: string; state: string; note: string | null; planSha: string | null } | null {
  const svc = new PlanningPhaseService({} as any, {} as any, {} as any);
  return (svc as any).parseAgreementCallbackLine(line);
}

describe('parseAgreementCallbackLine — separator widening (AC8)', () => {
  it('parses the em dash separator (—, pre-existing form)', () => {
    const parsed = parseLine('[helm callback] implementer B3 STATUS: PLAN-READY — em dash note');
    expect(parsed).toEqual({ role: 'implementer', batchId: 'B3', state: 'PLAN-READY', note: 'em dash note', planSha: null });
  });

  it('parses the hyphen separator (-, pre-existing form)', () => {
    const parsed = parseLine('[projcore callback] validator B3 STATUS: VERDICT-READY - hyphen note');
    expect(parsed).toEqual({ role: 'validator', batchId: 'B3', state: 'VERDICT-READY', note: 'hyphen note', planSha: null });
  });

  it('parses the en dash separator (–, previously fell through to null)', () => {
    const parsed = parseLine('[helm callback] implementer B3 STATUS: WORKING – en dash note');
    expect(parsed).toEqual({ role: 'implementer', batchId: 'B3', state: 'WORKING', note: 'en dash note', planSha: null });
  });

  it('parses the colon separator (:, previously fell through to null)', () => {
    const parsed = parseLine('[helm callback] implementer B3 STATUS: DONE : colon note');
    expect(parsed).toEqual({ role: 'implementer', batchId: 'B3', state: 'DONE', note: 'colon note', planSha: null });
  });

  it('still parses no-note PLAN-READY (no trailing separator/note at all)', () => {
    const parsed = parseLine('[helm callback] plancore B3 STATUS: PLAN-READY');
    expect(parsed).toEqual({ role: 'plancore', batchId: 'B3', state: 'PLAN-READY', note: null, planSha: null });
  });

  it('malformed callback lines (bad prefix, missing STATUS token) still return null', () => {
    expect(parseLine('not a callback line at all')).toBeNull();
    expect(parseLine('[helm not-callback] implementer B3 STATUS: DONE — note')).toBeNull();
    expect(parseLine('[helm callback] implementer B3 STATE: DONE — note')).toBeNull();
    expect(parseLine('[helm callback] implementer B3 STATUS: done — lowercase state')).toBeNull();
  });
});

describe('parseAgreementCallbackLine — optional planSha extraction (AC6 foundation)', () => {
  it('extracts plan=<12 lowercase hex> from the note payload', () => {
    const parsed = parseLine('[helm callback] validator B5 STATUS: REPRO-CONFIRMED — CLEAN plan=abcdef012345 verified');
    expect(parsed).toEqual({
      role: 'validator',
      batchId: 'B5',
      state: 'REPRO-CONFIRMED',
      note: 'CLEAN plan=abcdef012345 verified',
      planSha: 'abcdef012345',
    });
  });

  it('extracts plan=<sha12> across every widened separator form', () => {
    for (const sep of ['—', '-', '–', ':']) {
      const parsed = parseLine(`[helm callback] implementer B3 STATUS: VERDICT-READY ${sep} plan=0123456789ab note`);
      expect(parsed?.planSha).toBe('0123456789ab');
    }
  });

  it('planSha is null when the note has no plan= field', () => {
    const parsed = parseLine('[helm callback] implementer B3 STATUS: DONE — no sha here');
    expect(parsed?.planSha).toBeNull();
  });

  it('planSha is null (not thrown) when there is no note at all', () => {
    const parsed = parseLine('[helm callback] implementer B3 STATUS: PLAN-READY');
    expect(parsed?.planSha).toBeNull();
  });

  it('does not match a plan= value shorter than 12 hex chars', () => {
    const parsed = parseLine('[helm callback] implementer B3 STATUS: DONE — plan=abc123 too short');
    expect(parsed?.planSha).toBeNull();
  });

  it('does not match uppercase hex — grammar requires lowercase per plan-revision.ts short12', () => {
    const parsed = parseLine('[helm callback] implementer B3 STATUS: DONE — plan=ABCDEF012345 uppercase');
    expect(parsed?.planSha).toBeNull();
  });
});
