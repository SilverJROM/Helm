/**
 * D3 — pure proposer/signer role designation (R3.9, R3.12).
 *
 * Covers: lower full sha256 wins; seatId tie-break; no short12 bias;
 * rolesForRound alternation (round 2 designate → 3 swap → 4 swap again);
 * formatProposerLog audit string with rule name.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PROPOSER_DESIGNATE_RULE,
  designateRound2Proposer,
  formatProposerLog,
  rolesForRound,
} from './proposer-role.js';

function fullSha(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('designateRound2Proposer (R3.9)', () => {
  it('lower full sha256 wins proposer (not short12)', () => {
    // Craft full hashes with known order: shaA < shaB so seat A wins.
    const shaA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const shaB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    expect(
      designateRound2Proposer({
        seatA: 'co-planner-a',
        shaA,
        seatB: 'co-planner-b',
        shaB,
      }),
    ).toBe('co-planner-a');

    // Swap labels: same hashes assigned to opposite seats → B (now holding lower hash) wins.
    expect(
      designateRound2Proposer({
        seatA: 'co-planner-a',
        shaA: shaB,
        seatB: 'co-planner-b',
        shaB: shaA,
      }),
    ).toBe('co-planner-b');
  });

  it('is reproducible from artifacts alone — swap seat labels, same proposer', () => {
    const shaLow = fullSha('draft-content-low');
    const shaHigh = fullSha('draft-content-high-zzzz');
    // Ensure we know which is lower
    const [low, high] = shaLow < shaHigh ? [shaLow, shaHigh] : [shaHigh, shaLow];
    const lowSeat = shaLow < shaHigh ? 'seat-x' : 'seat-y';
    // Actually pin: low hash always maps to seat holding that content.
    const fromXY = designateRound2Proposer({
      seatA: 'seat-x',
      shaA: low,
      seatB: 'seat-y',
      shaB: high,
    });
    const fromYX = designateRound2Proposer({
      seatA: 'seat-y',
      shaA: high,
      seatB: 'seat-x',
      shaB: low,
    });
    expect(fromXY).toBe('seat-x');
    expect(fromYX).toBe('seat-x');
    expect(fromXY).toBe(fromYX);
    void lowSeat;
  });

  it('tie-break: equal full sha → lexicographically lower seatId wins', () => {
    const same = fullSha('identical-draft-bytes');
    expect(
      designateRound2Proposer({
        seatA: 'partner-b',
        shaA: same,
        seatB: 'partner-a',
        shaB: same,
      }),
    ).toBe('partner-a'); // 'partner-a' < 'partner-b'

    expect(
      designateRound2Proposer({
        seatA: 'partner-a',
        shaA: same,
        seatB: 'partner-b',
        shaB: same,
      }),
    ).toBe('partner-a');
  });

  it('compares full 64-char sha, not short12 prefix', () => {
    // Same first-12 prefix, different remainder: full comparison must decide.
    const shaA = 'aaaaaaaaaaaa' + '0000000000000000000000000000000000000000000000000000';
    const shaB = 'aaaaaaaaaaaa' + 'ffffffffffffffffffffffffffffffffffffffffffffffffffff';
    expect(shaA.slice(0, 12)).toBe(shaB.slice(0, 12));
    expect(shaA.length).toBe(64);
    expect(shaB.length).toBe(64);
    expect(shaA < shaB).toBe(true);

    expect(
      designateRound2Proposer({
        seatA: 'a',
        shaA,
        seatB: 'b',
        shaB,
      }),
    ).toBe('a');

    expect(
      designateRound2Proposer({
        seatA: 'a',
        shaA: shaB,
        seatB: 'b',
        shaB: shaA,
      }),
    ).toBe('b');
  });

  it('rejects identical seat ids and empty seats', () => {
    const sha = fullSha('x');
    expect(() =>
      designateRound2Proposer({ seatA: 'same', shaA: sha, seatB: 'same', shaB: sha }),
    ).toThrow(/distinct/i);
    expect(() =>
      designateRound2Proposer({ seatA: '', shaA: sha, seatB: 'b', shaB: sha }),
    ).toThrow(/seatA/i);
  });
});

describe('rolesForRound (R3.12 alternation)', () => {
  const seatA = 'co-planner-a';
  const seatB = 'co-planner-b';
  const designated = seatA; // round-2 proposer

  it('round 2: designated proposes, other signs', () => {
    expect(rolesForRound(2, designated, seatA, seatB)).toEqual({
      proposer: seatA,
      signer: seatB,
    });
  });

  it('round 3: swaps — other proposes, designated signs', () => {
    expect(rolesForRound(3, designated, seatA, seatB)).toEqual({
      proposer: seatB,
      signer: seatA,
    });
  });

  it('round 4: swaps again — back to designated as proposer', () => {
    expect(rolesForRound(4, designated, seatA, seatB)).toEqual({
      proposer: seatA,
      signer: seatB,
    });
  });

  it('3-round trace: no seat holds the pen every round', () => {
    const r2 = rolesForRound(2, designated, seatA, seatB);
    const r3 = rolesForRound(3, designated, seatA, seatB);
    const r4 = rolesForRound(4, designated, seatA, seatB);

    expect(r2.proposer).toBe(designated);
    expect(r3.proposer).toBe(seatB);
    expect(r4.proposer).toBe(r2.proposer);
    // Alternation: consecutive rounds never share the same proposer
    expect(r2.proposer).not.toBe(r3.proposer);
    expect(r3.proposer).not.toBe(r4.proposer);
    // And signer is always the non-proposer
    for (const r of [r2, r3, r4]) {
      expect(r.proposer).not.toBe(r.signer);
      expect([seatA, seatB]).toContain(r.proposer);
      expect([seatA, seatB]).toContain(r.signer);
    }
  });

  it('works when designated is seatB', () => {
    expect(rolesForRound(2, seatB, seatA, seatB)).toEqual({
      proposer: seatB,
      signer: seatA,
    });
    expect(rolesForRound(3, seatB, seatA, seatB)).toEqual({
      proposer: seatA,
      signer: seatB,
    });
    expect(rolesForRound(4, seatB, seatA, seatB)).toEqual({
      proposer: seatB,
      signer: seatA,
    });
  });

  it('rejects round 1 and non-integer / invalid designated seat', () => {
    expect(() => rolesForRound(1, designated, seatA, seatB)).toThrow(/round 1|>= 2/i);
    expect(() => rolesForRound(0, designated, seatA, seatB)).toThrow();
    expect(() => rolesForRound(2, 'unknown', seatA, seatB)).toThrow(/neither/i);
  });
});

describe('formatProposerLog (R3.9 audit)', () => {
  it('includes both full shas, seats, proposer, and rule name', () => {
    const shaA = fullSha('draft-a');
    const shaB = fullSha('draft-b');
    const proposer = designateRound2Proposer({
      seatA: 'seat-a',
      shaA,
      seatB: 'seat-b',
      shaB,
    });
    const line = formatProposerLog({
      seatA: 'seat-a',
      shaA,
      seatB: 'seat-b',
      shaB,
      proposer,
    });

    expect(line).toContain(`rule=${PROPOSER_DESIGNATE_RULE}`);
    expect(line).toContain('lower-sha256-of-round1-drafts');
    expect(line).toContain(`shaA=${shaA}`);
    expect(line).toContain(`shaB=${shaB}`);
    expect(line).toContain('seatA=seat-a');
    expect(line).toContain('seatB=seat-b');
    expect(line).toContain(`proposer=${proposer}`);
    // Full hashes, not short12 only
    expect(shaA.length).toBe(64);
    expect(line).toContain(shaA);
    expect(line).toContain(shaB);
  });
});

describe('module purity', () => {
  it('exports only pure helpers (no I/O surface)', async () => {
    const mod = await import('./proposer-role.js');
    expect(typeof mod.designateRound2Proposer).toBe('function');
    expect(typeof mod.rolesForRound).toBe('function');
    expect(typeof mod.formatProposerLog).toBe('function');
    expect(mod.PROPOSER_DESIGNATE_RULE).toBe('lower-sha256-of-round1-drafts');
    // No fs/path-style names
    for (const key of Object.keys(mod)) {
      expect(key).not.toMatch(/read|write|path|fs|file/i);
    }
  });
});
