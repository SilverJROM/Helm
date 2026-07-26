process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WatcherService } from './watcher-service.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('WatcherService (B5 DSP5, USE_FAKE_TMUX + real-string [helm callback])', () => {
  let runDir: string;
  let cbp: string;
  let stateDir: string;
  let now = Date.now();
  let watcher: WatcherService;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b5-watcher-'));
    cbp = path.join(runDir, 'callbacks.md');
    stateDir = path.join(runDir, 'state');
    await fs.writeFile(cbp, '# B5 watcher test\n', 'utf8');
    await fs.mkdir(stateDir, { recursive: true });
    now = Date.now();
    watcher = new WatcherService({
      now: () => now,
      readFile: (p) => fs.readFile(p, 'utf8'),
      writeFile: (p, c) => fs.writeFile(p, c, 'utf8'),
      capturePane: async () => 'idle pane no busy'
    });
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('detects [helm callback] DONE after last ACK, writes deterministic artifact (never re-parses in caller)', async () => {
    const p = watcher.start({ role: 'implementer', batchId: 'batch-B5-t1', callbacksPath: cbp, runDir, pollMs: 5 });

    // ACK then callback (scan after ACK)
    await fs.appendFile(cbp, `[helm ACK] implementer batch-B5-t1 RECEIVED — ack\n`);
    await fs.appendFile(cbp, `[helm callback] implementer batch-B5-t1 STATUS: DONE — work complete\n`);
    await sleep(30);

    const res = await p;
    expect(res.status).toBe('DONE');
    expect(res.source).toBe('callback');
    expect(res.note).toContain('work complete');

    const art = await fs.readFile(path.join(stateDir, 'implementer-batch-B5-t1.watcher-status'), 'utf8');
    expect(art).toContain('status=DONE');
    expect(art).toContain('source=callback');
    expect(art).toContain('note=work complete');
  });

  it('rejects [projcore callback] (clean migration, no silent dual)', async () => {
    const p = watcher.start({ role: 'implementer', batchId: 'batch-B5-t2', callbacksPath: cbp, runDir, pollMs: 5 });
    await fs.appendFile(cbp, `[projcore callback] implementer batch-B5-t2 STATUS: DONE — old\n`);
    // give time; should not terminate on projcore
    await sleep(30);
    // still watching (no terminal artifact yet)
    const artPath = path.join(stateDir, 'implementer-batch-B5-t2.watcher-status');
    const art = await fs.readFile(artPath, 'utf8').catch(() => '');
    expect(art).toContain('WATCHING'); // or still init

    // now real helm -> terminates
    await fs.appendFile(cbp, `[helm callback] implementer batch-B5-t2 STATUS: DONE — new\n`);
    const res = await p;
    expect(res.status).toBe('DONE');
  });

  it('hard-cap from progress writes HARD-CAP artifact (fake clock)', async () => {
    // seed a progress with old dispatched_at
    const prog = path.join(runDir, 'progress.md');
    const old = new Date(now - 1000 * 60 * 200).toISOString(); // > hard
    await fs.writeFile(prog, `batch-B5-t3 dispatched_at: ${old} estimate_min: 10 bucket: SHORT\n`, 'utf8');

    const w = new WatcherService({
      now: () => now,
      readFile: (p) => fs.readFile(p, 'utf8'),
      writeFile: (p, c) => fs.writeFile(p, c, 'utf8')
    });
    const res = await w.start({ role: 'implementer', batchId: 'batch-B5-t3', callbacksPath: cbp, runDir, progressPath: prog, pollMs: 5 });
    expect(res.status).toBe('HARD-CAP');
    const art = await fs.readFile(path.join(stateDir, 'implementer-batch-B5-t3.watcher-status'), 'utf8');
    expect(art).toContain('status=HARD-CAP');
  });

  it('scan-after-last-ACK only (ignores pre-ACK callbacks)', async () => {
    await fs.appendFile(cbp, `[helm callback] implementer batch-B5-t4 STATUS: DONE — pre\n`);
    await fs.appendFile(cbp, `[helm ACK] implementer batch-B5-t4 RECEIVED — ack\n`);
    const p = watcher.start({ role: 'implementer', batchId: 'batch-B5-t4', callbacksPath: cbp, runDir, pollMs: 5 });
    await sleep(20);
    // pre should be ignored; no DONE yet
    let art = await fs.readFile(path.join(stateDir, 'implementer-batch-B5-t4.watcher-status'), 'utf8').catch(() => '');
    expect(art).toContain('WATCHING');

    await fs.appendFile(cbp, `[helm callback] implementer batch-B5-t4 STATUS: DONE — post\n`);
    const res = await p;
    expect(res.status).toBe('DONE');
    expect(res.note).toContain('post');
  });
});
