import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import { ProjectService } from './project-service.js';
import { CycleService } from './cycle-service.js';
import { CycleChatFileService } from './cycle-chat-file-service.js';

/** Minimal 1x1 PNG (67 bytes) — valid image fixture for byte-identity assertions. */
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b7-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

describe('B7 (R6.27): CycleChatFileService — path-safe cycle chat-file writer', () => {
  let cleanupDb: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let cycleSvc: CycleService;
  let chatFileSvc: CycleChatFileService;
  let projDir: string;
  let cycleId: number;
  let cycleFolder: string;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanupDb = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    ps = new ProjectService(dbs);
    cycleSvc = new CycleService(dbs, ps);
    chatFileSvc = new CycleChatFileService(cycleSvc);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b7-proj-'));
    const proj = ps.createProject({ name: 'B7-chat-files', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'Discovery Run', undefined, undefined, () => new Date('2026-07-27T12:00:00Z'));
    cycleId = cycle.id;
    cycleFolder = cycle.folder_name;
  });

  afterEach(() => {
    dbs.close();
    cleanupDb();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  it('persists pasted text and an image, returning a usable project-relative reference for each', async () => {
    const textResult = await chatFileSvc.saveCycleChatFile(cycleId, 'pasted-note.txt', 'hello from the composer\n');
    expect(textResult.path).toBe(`tmp/${cycleFolder}/pasted-note.txt`);
    expect(fs.readFileSync(path.join(projDir, textResult.path), 'utf8')).toBe('hello from the composer\n');

    const imgResult = await chatFileSvc.saveCycleChatFile(cycleId, 'pasted-image.png', FIXTURE_PNG);
    expect(imgResult.path).toBe(`tmp/${cycleFolder}/pasted-image.png`);
    expect(imgResult.size).toBe(FIXTURE_PNG.length);
    expect(Buffer.compare(fs.readFileSync(path.join(projDir, imgResult.path)), FIXTURE_PNG)).toBe(0);

    // Never OS /tmp — always under the project's own directory.
    expect(path.join(projDir, textResult.path).startsWith(projDir)).toBe(true);
  });

  it('rejects traversal, a pre-planted symlink, a filename collision, and an oversize payload', async () => {
    await expect(chatFileSvc.saveCycleChatFile(cycleId, '../../etc/passwd', 'pwn')).rejects.toMatchObject({ code: 'TRAVERSAL' });
    await expect(chatFileSvc.saveCycleChatFile(cycleId, '/etc/passwd', 'pwn')).rejects.toMatchObject({ code: 'TRAVERSAL' });

    const tmpRoot = path.join(projDir, 'tmp', cycleFolder);
    fs.mkdirSync(tmpRoot, { recursive: true });
    const outside = path.join(os.tmpdir(), `helm-b7-out-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'SECRET');
    const link = path.join(tmpRoot, 'escape.txt');
    fs.symlinkSync(outside, link);
    await expect(chatFileSvc.saveCycleChatFile(cycleId, 'escape.txt', 'pwn')).rejects.toMatchObject({ code: 'TRAVERSAL' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('SECRET');
    try { fs.unlinkSync(link); fs.unlinkSync(outside); } catch {}

    // Collision: never overwrite, never silently auto-rename — reject outright.
    await chatFileSvc.saveCycleChatFile(cycleId, 'dup.txt', 'first');
    await expect(chatFileSvc.saveCycleChatFile(cycleId, 'dup.txt', 'second')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fs.readFileSync(path.join(tmpRoot, 'dup.txt'), 'utf8')).toBe('first'); // untouched

    // Oversize (>1MB default PROJECT_DOC_BODY_MAX).
    const big = Buffer.alloc(1048577, 'x');
    await expect(chatFileSvc.saveCycleChatFile(cycleId, 'big.bin', big)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  // B7 send-back (attempt=2, redteam HIGH TOCTOU): a check-then-write (fs.access then fs.writeFile)
  // has a gap a concurrent writer can land in, silently overwriting whatever showed up. Exclusive
  // create (O_CREAT|O_EXCL) makes the open() syscall itself atomic — this test fires two concurrent
  // writes at the SAME filename and proves exactly one wins (CONFLICT for the loser, not a silent
  // overwrite or corrupted/mixed content) — a genuine race, not just a sequential check.
  it('a genuine concurrent race for the same filename: exactly one write wins, the other gets CONFLICT (exclusive create, not check-then-write)', async () => {
    const results = await Promise.allSettled([
      chatFileSvc.saveCycleChatFile(cycleId, 'race.txt', 'writer-A'),
      chatFileSvc.saveCycleChatFile(cycleId, 'race.txt', 'writer-B'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });

    const tmpRoot = path.join(projDir, 'tmp', cycleFolder);
    const onDisk = fs.readFileSync(path.join(tmpRoot, 'race.txt'), 'utf8');
    // Whichever writer won, the content is intact and byte-exact — never truncated, mixed, or
    // silently overwritten by the loser after the fact.
    expect(['writer-A', 'writer-B']).toContain(onDisk);
  });
});
