import { describe, it, expect, vi } from 'vitest';
import { PROVIDERS } from './config/providers.js';
import {
  isLoopbackAddress,
  createRequireLocalLaunch,
  AGENT_ROLES,
  createRequireValidRoleProvider,
  checkCommand
} from './guardrails.js';

describe('P1-3 B6 guardrails (real outcomes)', () => {
  it('loopback reject + enumerated vocab reject are real', async () => {
    // Pure functions (real)
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
    expect(AGENT_ROLES.includes('implementer')).toBe(true);
    expect(AGENT_ROLES.includes('badrole' as any)).toBe(false);

    // PreHandler sim for non-loopback (real reject)
    const reqBad: any = { raw: { socket: { remoteAddress: '8.8.8.8' } } };
    const replyBad: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    let doneBad = false;
    createRequireLocalLaunch()(reqBad, replyBad, () => { doneBad = true; });
    expect(doneBad).toBe(false);
    expect(replyBad.code).toHaveBeenCalledWith(403);

    // Vocab reject (real)
    const reqVocabBad: any = { body: { role: 'badrole', provider: 'grok' } };
    const replyVocabBad: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    let doneV = false;
    createRequireValidRoleProvider(PROVIDERS)(reqVocabBad, replyVocabBad, () => { doneV = true; });
    expect(doneV).toBe(false);
    expect(replyVocabBad.code).toHaveBeenCalledWith(400);

    // Valid vocab accept (real)
    const reqVocabOk: any = { body: { role: 'implementer', provider: 'grok' } };
    const replyVocabOk: any = { code: vi.fn().mockReturnThis(), send: vi.fn() };
    let doneOk = false;
    createRequireValidRoleProvider(PROVIDERS)(reqVocabOk, replyVocabOk, () => { doneOk = true; });
    expect(doneOk).toBe(true);
  });

  it('safety check real (blocks known bad)', () => {
    expect(checkCommand('rm -rf /').blocked).toBe(true);
    expect(checkCommand('ls -la').blocked).toBe(false);
  });
});
