/**
 * B1 gate — pure plan revision hashing (AC6 foundation).
 * Scope: plan-revision.ts only. No production importers.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planRevision, readPlanRevision, type PlanRevision } from './plan-revision.js';

/** Well-known SHA-256 of empty input (NIST empty message digest). */
const EMPTY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function expectedSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b1-plan-rev-'));
  tempDirs.push(dir);
  return dir;
}

describe('planRevision — pure SHA-256 + short12', () => {
  it('hashes known fixture bytes to full sha256 and matching short12', () => {
    const fixture = Buffer.from('# plan\n\nslice B1 pure hashing\n', 'utf8');
    const rev = planRevision(fixture);
    const expected = expectedSha256(fixture);

    expect(rev.sha256).toBe(expected);
    expect(rev.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rev.short12).toBe(expected.slice(0, 12));
    expect(rev.short12).toHaveLength(12);
  });

  it('string and Buffer of the same utf8 content produce the same revision', () => {
    const text = 'canonical plan.md body\n';
    const fromString = planRevision(text);
    const fromBuffer = planRevision(Buffer.from(text, 'utf8'));
    expect(fromString).toEqual(fromBuffer);
  });

  it('different bytes produce different digests', () => {
    const a = planRevision('plan revision A');
    const b = planRevision('plan revision B');
    expect(a.sha256).not.toBe(b.sha256);
    expect(a.short12).not.toBe(b.short12);
  });

  it('short12 is exactly the first 12 hex chars of sha256', () => {
    const rev = planRevision(Buffer.from([0x00, 0x01, 0xff, 0xfe]));
    expect(rev.short12).toBe(rev.sha256.slice(0, 12));
    expect(rev.sha256.startsWith(rev.short12)).toBe(true);
  });

  it('empty buffer yields the well-known empty SHA-256 and short12', () => {
    const rev = planRevision(Buffer.alloc(0));
    expect(rev.sha256).toBe(EMPTY_SHA256);
    expect(rev.short12).toBe(EMPTY_SHA256.slice(0, 12));
  });

  it('is deterministic across repeated calls', () => {
    const bytes = Buffer.from('stable plan bytes');
    const r1: PlanRevision = planRevision(bytes);
    const r2: PlanRevision = planRevision(bytes);
    expect(r1).toEqual(r2);
  });
});

describe('readPlanRevision — disk path → revision | null', () => {
  it('returns null for a missing path', () => {
    expect(readPlanRevision('/tmp/helm-b1-definitely-absent-plan-md-xyz.md')).toBeNull();
  });

  it('returns null for an unreadable path (directory, not a file)', () => {
    const dir = makeTempDir();
    expect(readPlanRevision(dir)).toBeNull();
  });

  it('returns the same revision as hashing the file bytes on disk', () => {
    const dir = makeTempDir();
    const planPath = path.join(dir, 'plan.md');
    const body = Buffer.from('# plan\n\nAC6 bind verdicts to exact bytes.\n', 'utf8');
    fs.writeFileSync(planPath, body);

    const fromDisk = readPlanRevision(planPath);
    expect(fromDisk).not.toBeNull();
    expect(fromDisk).toEqual(planRevision(body));
    expect(fromDisk!.sha256).toBe(expectedSha256(body));
    expect(fromDisk!.short12).toBe(expectedSha256(body).slice(0, 12));
  });

  it('round-trips empty plan.md to empty digest', () => {
    const dir = makeTempDir();
    const planPath = path.join(dir, 'plan.md');
    fs.writeFileSync(planPath, Buffer.alloc(0));
    expect(readPlanRevision(planPath)).toEqual({
      sha256: EMPTY_SHA256,
      short12: EMPTY_SHA256.slice(0, 12),
    });
  });
});
