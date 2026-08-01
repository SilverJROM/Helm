/**
 * D1 — seat-draft-store path helpers, atomic publish, engine rehash (R2.5, R2.7).
 * Paths nest under planning-drafts/<seatId>/ (R2.6 isolation unit; D2).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planRevision, readPlanRevision } from './plan-revision.js';
import {
  atomicWriteFile,
  candidatePlanPath,
  candidateReqPath,
  draftPlanPath,
  draftReqPath,
  hashDraft,
  seatDraftDir,
} from './seat-draft-store.js';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-d1-seat-draft-'));
  tempDirs.push(dir);
  return dir;
}

function expectedSha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('path helpers — seat-scoped drafts + shared candidate (R2.5 / R2.6 nest)', () => {
  it('draftPlanPath / draftReqPath use R2.5 names under planning-drafts/<seatId>/', () => {
    const runDir = '/tmp/helm-run-example';
    const seatId = 'co-planner-a';
    const seatDir = path.join(path.resolve(runDir), 'planning-drafts', seatId);

    expect(seatDraftDir(runDir, seatId)).toBe(seatDir);
    expect(draftPlanPath(runDir, seatId)).toBe(path.join(seatDir, 'draft-co-planner-a.md'));
    expect(draftReqPath(runDir, seatId)).toBe(path.join(seatDir, 'draft-co-planner-a-req.md'));
  });

  it('different seats get distinct draft paths and isolation dirs', () => {
    const runDir = '/runs/r1';
    expect(draftPlanPath(runDir, 'seat-a')).not.toBe(draftPlanPath(runDir, 'seat-b'));
    expect(draftReqPath(runDir, 'seat-a')).not.toBe(draftReqPath(runDir, 'seat-b'));
    expect(seatDraftDir(runDir, 'seat-a')).not.toBe(seatDraftDir(runDir, 'seat-b'));
  });

  it('candidate paths are shared (not seat-scoped) under runDir', () => {
    const runDir = '/runs/r1';
    expect(candidatePlanPath(runDir)).toBe(path.join(path.resolve(runDir), 'candidate-plan.md'));
    expect(candidateReqPath(runDir)).toBe(path.join(path.resolve(runDir), 'candidate-req.md'));
  });

  it('draft and candidate paths never collide with canonical plan.md / og-requirements.md', () => {
    const runDir = '/runs/r1';
    const canonicalPlan = path.join(path.resolve(runDir), 'plan.md');
    const canonicalReq = path.join(path.resolve(runDir), 'og-requirements.md');
    const seats = ['a', 'b', 'plancore'];

    for (const seat of seats) {
      expect(draftPlanPath(runDir, seat)).not.toBe(canonicalPlan);
      expect(draftReqPath(runDir, seat)).not.toBe(canonicalReq);
      expect(draftPlanPath(runDir, seat)).not.toBe(canonicalReq);
      expect(draftReqPath(runDir, seat)).not.toBe(canonicalPlan);
    }
    expect(candidatePlanPath(runDir)).not.toBe(canonicalPlan);
    expect(candidateReqPath(runDir)).not.toBe(canonicalReq);
    expect(candidatePlanPath(runDir)).not.toBe(canonicalReq);
    expect(candidateReqPath(runDir)).not.toBe(canonicalPlan);
  });

  it('module exports path helpers + isolation + publish (no canonical writers)', async () => {
    const mod = await import('./seat-draft-store.js');
    const names = Object.keys(mod).sort();
    expect(names).toEqual([
      'SEAT_DRAFT_ISOLATION',
      'SeatDraftIsolationError',
      'assertNoPeerDraftAccess',
      'atomicWriteFile',
      'candidatePlanPath',
      'candidateReqPath',
      'composeSeatDraftReadAllow',
      'draftPlanPath',
      'draftReqPath',
      'hashDraft',
      'publishDraft',
      'sanitizeSeatId',
      'seatDraftDir',
    ]);
    expect(names.some((n) => /canonical|promote|planMd|ogReq/i.test(n))).toBe(false);
  });
});

describe('atomicWriteFile — temp sibling + rename (R2.7)', () => {
  it('creates parent dirs and leaves final path with exact bytes', () => {
    const runDir = makeTempDir();
    const seat = 'seat-a';
    const target = draftPlanPath(runDir, seat);
    const body = Buffer.from('# draft plan\n\nseat A content\n', 'utf8');

    // Parent is seat draft dir; write into nested subpath to exercise mkdir.
    const nested = path.join(runDir, 'nested', 'deep', 'file.md');
    atomicWriteFile(nested, body);

    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.readFileSync(nested)).toEqual(body);
    // No leftover .tmp siblings in the nested dir.
    const siblings = fs.readdirSync(path.dirname(nested));
    expect(siblings.filter((n) => n.endsWith('.tmp'))).toEqual([]);

    atomicWriteFile(target, body);
    expect(fs.readFileSync(target)).toEqual(body);
  });

  it('overwrites an existing file with the new bytes', () => {
    const runDir = makeTempDir();
    const target = candidatePlanPath(runDir);
    atomicWriteFile(target, 'first\n');
    atomicWriteFile(target, 'second-version\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('second-version\n');
  });

  it('accepts string and Buffer equivalently', () => {
    const runDir = makeTempDir();
    const text = 'utf8 draft body\n';
    const p1 = draftPlanPath(runDir, 's1');
    const p2 = draftPlanPath(runDir, 's2');
    atomicWriteFile(p1, text);
    atomicWriteFile(p2, Buffer.from(text, 'utf8'));
    expect(fs.readFileSync(p1)).toEqual(fs.readFileSync(p2));
  });

  it('publishes seat plan + req drafts at R2.5 paths under seat dir', () => {
    const runDir = makeTempDir();
    const seat = 'partner-1';
    const planBody = Buffer.from('# plan draft partner-1\n');
    const reqBody = Buffer.from('# req draft partner-1\n');

    atomicWriteFile(draftPlanPath(runDir, seat), planBody);
    atomicWriteFile(draftReqPath(runDir, seat), reqBody);

    expect(fs.readFileSync(path.join(seatDraftDir(runDir, seat), `draft-${seat}.md`))).toEqual(planBody);
    expect(fs.readFileSync(path.join(seatDraftDir(runDir, seat), `draft-${seat}-req.md`))).toEqual(reqBody);
    // Canonicals remain absent (engine-only in P2).
    expect(fs.existsSync(path.join(runDir, 'plan.md'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'og-requirements.md'))).toBe(false);
  });
});

describe('hashDraft — engine recomputes; never trusts callback claim (R2.7)', () => {
  it('returns null for missing path (same as readPlanRevision)', () => {
    expect(hashDraft('/tmp/helm-d1-definitely-absent-draft-xyz.md')).toBeNull();
    expect(hashDraft('/tmp/helm-d1-definitely-absent-draft-xyz.md')).toEqual(
      readPlanRevision('/tmp/helm-d1-definitely-absent-draft-xyz.md'),
    );
  });

  it('matches planRevision of committed bytes after atomicWriteFile', () => {
    const runDir = makeTempDir();
    const target = draftPlanPath(runDir, 'seat-a');
    const body = Buffer.from('# plan\n\nengine rehash fixture\n', 'utf8');
    atomicWriteFile(target, body);

    const rev = hashDraft(target);
    expect(rev).not.toBeNull();
    expect(rev).toEqual(planRevision(body));
    expect(rev).toEqual(readPlanRevision(target));
    expect(rev!.sha256).toBe(expectedSha256(body));
    expect(rev!.short12).toBe(expectedSha256(body).slice(0, 12));
  });

  it('diverges from a spoofed callback claim when disk bytes differ', () => {
    const runDir = makeTempDir();
    const target = candidatePlanPath(runDir);
    const actual = Buffer.from('actual candidate bytes on disk\n', 'utf8');
    atomicWriteFile(target, actual);

    const spoofedClaim = planRevision('callback lied about these bytes\n');
    const engine = hashDraft(target);

    expect(engine).not.toBeNull();
    expect(engine!.sha256).not.toBe(spoofedClaim.sha256);
    expect(engine!.short12).not.toBe(spoofedClaim.short12);
    expect(engine).toEqual(planRevision(actual));
  });

  it('hashes req drafts the same way as plan drafts', () => {
    const runDir = makeTempDir();
    const target = draftReqPath(runDir, 'seat-b');
    const body = 'requirements draft body\n';
    atomicWriteFile(target, body);
    expect(hashDraft(target)).toEqual(planRevision(body));
  });
});
