import { describe, it, expect } from 'vitest';
import { assertI7ResolveGuard, ResolveStallError } from './db/resolve-time-invariants.js';

describe('B15x / I7 resolve-time guard', () => {
  it('(1) happy-path: impl != val, redteam panel of 4 not containing impl -> no throw', () => {
    expect(() =>
      assertI7ResolveGuard({
        implModel: 'grok-4.5',
        valModel: 'claude-opus',
        redTeamAgents: [{ model: 'spark' }, { model: 'claude-haiku-4-5' }, { model: 'grok-4.5.1' }, { model: 'gpt-5.5' }],
      })
    ).not.toThrow();
  });

  it('(2) impl==val sonnet x sonnet collision -> val-collision stall regardless of redteam', () => {
    let err: unknown;
    try {
      assertI7ResolveGuard({
        implModel: 'claude-sonnet-5',
        valModel: 'claude-sonnet-5',
        redTeamAgents: [{ model: 'spark' }, { model: 'claude-haiku-4-5' }, { model: 'grok-4.5' }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResolveStallError);
    expect((err as ResolveStallError).reason).toBe('val-collision');
  });

  it('(3) L2 DIFFICULTY->L3 sonnet vs standard-ex-L2 w/ sonnet -> strip -> count2<3 stall', () => {
    // impl resolved to sonnet (as if L2->L3 vertical escalation landed on sonnet); redteam panel
    // is the standard-ex-L2 roster [sonnet, spark, haiku] (3, includes sonnet).
    let err: unknown;
    try {
      assertI7ResolveGuard({
        implModel: 'claude-sonnet-5',
        valModel: 'claude-opus',
        redTeamAgents: [{ model: 'claude-sonnet-5' }, { model: 'spark' }, { model: 'claude-haiku-4-5' }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResolveStallError);
    expect((err as ResolveStallError).reason).toBe('redteam-strip-count');
  });

  it('(4) AVAILABILITY->haiku vs panel w/ haiku -> strip -> stall if <3', () => {
    // impl resolved to haiku (AVAILABILITY lateral); panel has haiku + 1 other -> strip -> 1 <3.
    let err: unknown;
    try {
      assertI7ResolveGuard({
        implModel: 'claude-haiku-4-5',
        valModel: 'claude-opus',
        redTeamAgents: [{ model: 'claude-haiku-4-5' }, { model: 'spark' }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResolveStallError);
    expect((err as ResolveStallError).reason).toBe('redteam-strip-count');
  });

  it('redteam half is skipped-safe when panel already >=3 after strip', () => {
    expect(() =>
      assertI7ResolveGuard({
        implModel: 'claude-haiku-4-5',
        valModel: 'claude-opus',
        redTeamAgents: [{ model: 'claude-haiku-4-5' }, { model: 'spark' }, { model: 'grok-4.5' }, { model: 'gpt-5.5' }],
      })
    ).not.toThrow();
  });
});
