process.env.USE_FAKE_TMUX = '1';

/**
 * R5 gate — `waitForCandidateSignature`'s standalone agreement decision (R3.11/R3.14/R6.21).
 *
 * Scope: the extracted, exported `waitForCandidateSignature` (planning-review-round.ts) in isolation
 * from the full `runProposerSignerRound` exchange — this is the ONE place `agreed:true` is ever
 * decided (R3.14): the signer's claimed `plan=<sha12>` is checked against
 * `readPlanRevision(candidatePlanFilePath)` recomputed at check time, never a cached/trusted claim
 * (B5's exact mechanism, re-pointed). A missing, malformed, or stale-relative-to-current-candidate
 * claim is never agreement — fail-closed (R6.21). No brain `PLAN-READY` line is part of this grammar.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { waitForCandidateSignature } from './planning-review-round.js';
import { atomicWriteFile, candidatePlanPath } from './seat-draft-store.js';
import { planRevision } from './plan-revision.js';

describe('waitForCandidateSignature — signature-on-candidate-bytes gate (R3.11, R3.14, R6.21)', () => {
  let runDir: string;
  let cbPath: string;
  let candidatePath: string;
  const seat = { batchId: 'batch-R5-signer', brief: 'signer brief', handle: 'fake-signer-1', seatId: 'partner-2' };

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r5-signature-gate-'));
    cbPath = path.join(runDir, 'callbacks.md');
    candidatePath = candidatePlanPath(runDir);
    await fs.writeFile(cbPath, '', 'utf8');
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  async function post(line: string): Promise<void> {
    await fs.appendFile(cbPath, `${line}\n`, 'utf8');
  }

  it('SIGNED with a plan= claim matching the candidate\'s current bytes agrees', async () => {
    const bytes = '# Candidate\n```json\n[]\n```\n';
    const revision = planRevision(bytes);
    atomicWriteFile(candidatePath, bytes);
    await post(`[helm callback] planner ${seat.batchId} STATUS: SIGNED plan=${revision.short12}`);

    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 500, 0, {});

    expect(result.ok).toBe(true);
    if (result.ok && result.kind !== 'objections') {
      expect(result.kind).toBe('signed-agreed');
      expect(result.candidatePlan?.short12).toBe(revision.short12);
    }
  });

  it('R6.21: SIGNED with NO plan= field at all is fail-closed, never agreement', async () => {
    const bytes = '# Candidate\n```json\n[]\n```\n';
    atomicWriteFile(candidatePath, bytes);
    await post(`[helm callback] planner ${seat.batchId} STATUS: SIGNED`);

    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 500, 0, {});

    expect(result.ok).toBe(true);
    if (result.ok && result.kind !== 'objections') {
      expect(result.kind).toBe('signed-mismatched');
      expect(result.claimedShort12).toBeNull();
    }
  });

  it('R6.21: SIGNED with a malformed (wrong-length) sha is fail-closed, never agreement', async () => {
    const bytes = '# Candidate\n```json\n[]\n```\n';
    atomicWriteFile(candidatePath, bytes);
    // "abc123" is not a 12-hex-char short12 — SIGNED_RE's optional capture will not match it, so the
    // line is still identified as a signature decision but yields no usable claim (per R5's scope).
    await post(`[helm callback] planner ${seat.batchId} STATUS: SIGNED plan=abc123`);

    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 500, 0, {});

    expect(result.ok).toBe(true);
    if (result.ok && result.kind !== 'objections') {
      expect(result.kind).toBe('signed-mismatched');
      expect(result.claimedShort12).toBeNull();
    }
  });

  it('R6.21: SIGNED with a well-formed but STALE sha (candidate rewritten since) is fail-closed', async () => {
    const originalBytes = '# Candidate v1\n```json\n[]\n```\n';
    const staleClaim = planRevision(originalBytes).short12;
    // The candidate on disk is now DIFFERENT bytes than what the signer claims to have reviewed.
    atomicWriteFile(candidatePath, '# Candidate v2 — rewritten after the signer read v1\n```json\n[]\n```\n');
    await post(`[helm callback] planner ${seat.batchId} STATUS: SIGNED plan=${staleClaim}`);

    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 500, 0, {});

    expect(result.ok).toBe(true);
    if (result.ok && result.kind !== 'objections') {
      expect(result.kind).toBe('signed-mismatched');
      expect(result.claimedShort12).toBe(staleClaim);
      expect(result.candidatePlan?.short12).not.toBe(staleClaim);
    }
  });

  it('R6.21: a well-formed sha claim against an UNREADABLE candidate path is fail-closed', async () => {
    // candidatePath is never written — readPlanRevision returns null.
    const claim = planRevision('# whatever\n').short12;
    await post(`[helm callback] planner ${seat.batchId} STATUS: SIGNED plan=${claim}`);

    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 500, 0, {});

    expect(result.ok).toBe(true);
    if (result.ok && result.kind !== 'objections') {
      expect(result.kind).toBe('signed-mismatched');
      expect(result.candidatePlan).toBeNull();
    }
  });

  it('a bounded OBJECTIONS list is captured and is never treated as agreement', async () => {
    atomicWriteFile(candidatePath, '# Candidate\n```json\n[]\n```\n');
    await post(
      `[helm callback] planner ${seat.batchId} STATUS: OBJECTIONS — n=2; 1. Missing req_refs. 2. Bad effort enum.`
    );

    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 500, 0, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('objections');
      if (result.kind === 'objections') {
        expect(result.note).toContain('n=2');
        expect(result.note).toContain('req_refs');
      }
    }
  });

  it('R3.14: PLAN-READY is not part of this grammar — a plancore PLAN-READY line alone never resolves the wait', async () => {
    atomicWriteFile(candidatePath, '# Candidate\n```json\n[]\n```\n');
    await post(`[helm callback] plancore ${seat.batchId} STATUS: PLAN-READY — plan agreed`);

    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 300, 0, {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-first-callback');
  });

  it('a signer that never posts SIGNED or OBJECTIONS times out — bounded, never a silent pass', async () => {
    atomicWriteFile(candidatePath, '# Candidate\n```json\n[]\n```\n');

    const start = Date.now();
    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 300, 0, {});
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-first-callback');
    expect(elapsed).toBeLessThan(1000);
  });

  it('resolves session-gone when the watchdog reports the seat session died', async () => {
    atomicWriteFile(candidatePath, '# Candidate\n```json\n[]\n```\n');

    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 5000, 0, {
      inspectSeat: async () => ({ sessionAlive: false }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('session-gone');
  });

  it('ignores a SIGNED line from a different batchId (identity-scoped, never cross-seat)', async () => {
    const bytes = '# Candidate\n```json\n[]\n```\n';
    const revision = planRevision(bytes);
    atomicWriteFile(candidatePath, bytes);
    await post(`[helm callback] planner batch-R5-OTHER-SEAT STATUS: SIGNED plan=${revision.short12}`);

    const result = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 300, 0, {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-first-callback');
  });
});
