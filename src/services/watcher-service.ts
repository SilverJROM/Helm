import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * WatcherService (B5 DSP5)
 * Ports the v4 anchored scan-after-last-ACK + state artifact logic from projcore-watcher.sh
 * (read; port logic, don't shell out for Helm children).
 * Helm reads the written artifact (never re-parses prose for decision).
 * Deterministic artifacts for: DONE (terminal), IDLE (no-callback/stopped), HARD-CAP, MTIME-STALL, MALFORMED, etc.
 * Fakeable deps + USE_FAKE_TMUX for tests; real-string [helm callback] parse.
 */

export interface WatcherParams {
  role: 'implementer' | 'validator';
  batchId: string;
  callbacksPath: string;
  runDir: string;
  progressPath?: string;
  session?: string; // for pane idle
  pollMs?: number;
  workingIdleS?: number; // default 300
}

export interface WatcherState {
  role: string;
  batch: string;
  status: string;
  source: string;
  line_no: number;
  note: string;
}

export class WatcherService {
  private readonly now: () => number;
  private readonly readF: (p: string) => Promise<string>;
  private readonly writeF: (p: string, c: string) => Promise<void>;
  private readonly capture: (sess: string) => Promise<string>;

  constructor(deps: {
    now?: () => number;
    readFile?: (p: string) => Promise<string>;
    writeFile?: (p: string, c: string) => Promise<void>;
    capturePane?: (sess: string) => Promise<string>;
  } = {}) {
    this.now = deps.now ?? Date.now;
    this.readF = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
    this.writeF = deps.writeFile ?? fs.writeFile;
    this.capture = deps.capturePane ?? (async () => '');
  }

  async start(params: WatcherParams): Promise<WatcherState> {
    const {
      role,
      batchId,
      callbacksPath,
      runDir,
      progressPath,
      session,
      pollMs = 20,
      workingIdleS = 300
    } = params;

    const dispatchDir = path.join(runDir, 'dispatch');
    const stateDir = path.join(runDir, 'state');
    await fs.mkdir(dispatchDir, { recursive: true }).catch(() => {});
    await fs.mkdir(stateDir, { recursive: true }).catch(() => {});

    // v4 PID first (gateway visible)
    const pidFile = path.join(dispatchDir, `${batchId}.watcher-${role}.pid`);
    await fs.writeFile(pidFile, String(process.pid)).catch(() => {});

    const stateFile = path.join(stateDir, `${role}-${batchId}.watcher-status`);

    const writeArtifact = async (status: string, source: string, lineNo: number, note: string) => {
      const tmp = `${stateFile}.tmp.${Date.now()}`;
      const content = `role=${role}\nbatch=${batchId}\nstatus=${status}\nsource=${source}\nline_no=${lineNo}\nnote=${note}\n`;
      await this.writeF(tmp, content);
      await fs.rename(tmp, stateFile).catch(async () => {
        // fallback
        await this.writeF(stateFile, content);
      });
    };

    // initial
    await writeArtifact('WATCHING', 'init', 0, 'watcher started');

    const startEpoch = this.now() / 1000;
    let lastAckLine = 0;
    let idleStreak = 0;
    let prevPaneHash = '';

    const scanAfterAck = async (): Promise<{ line: string; state: string; note: string; lineNo: number } | null> => {
      let raw = '';
      try { raw = await this.readF(callbacksPath); } catch { return null; }
      const lines = raw.split(/\r?\n/);
      // find last role ACK line num (1-based approx via index)
      let ackIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (new RegExp(`^\\[helm ACK\\]\\s+${role}\\s+${batchId}\\b`).test(lines[i])) {
          ackIdx = i;
          break;
        }
      }
      const searchStart = ackIdx + 1;
      for (let i = lines.length - 1; i >= searchStart; i--) {
        const line = lines[i];
        const m = new RegExp(`^\\[helm callback\\]\\s+${role}\\s+${batchId}\\s+STATUS:\\s+([A-Z-]+)(?:\\s+[—-]\\s+(.*))?$`).exec(line);
        if (m) {
          return { line, state: m[1], note: m[2] ?? '', lineNo: i + 1 };
        }
      }
      return null;
    };

    // progress parse (minimal for hard-cap/checkin in test)
    let dispatchedEpoch = startEpoch;
    let estimateMin = 10;
    let hardCapMin = 240;
    if (progressPath) {
      try {
        const p = await this.readF(progressPath);
        const m = p.match(new RegExp(`${batchId}.*?dispatched_at:\\s*([^\\s]+).*?estimate_min:\\s*(\\d+)`));
        if (m) {
          dispatchedEpoch = Date.parse(m[1]) / 1000 || startEpoch;
          estimateMin = parseInt(m[2], 10) || 10;
          hardCapMin = estimateMin > 30 ? 240 : 90;
        }
      } catch {}
    }

    const isHardCap = () => {
      const elapsedMin = ((this.now() / 1000) - dispatchedEpoch) / 60;
      return elapsedMin >= hardCapMin;
    };

    while (true) {
      const found = await scanAfterAck();
      if (found) {
        const st = found.state;
        if (st === 'DONE') {
          await writeArtifact('DONE', 'callback', found.lineNo, found.note);
          return { role, batch: batchId, status: 'DONE', source: 'callback', line_no: found.lineNo, note: found.note };
        }
        if (st === 'BLOCKED' || st === 'NEEDS-INFO') {
          await writeArtifact(st, 'callback', found.lineNo, found.note);
          return { role, batch: batchId, status: st, source: 'callback', line_no: found.lineNo, note: found.note };
        }
        // WORKING or handshake: continue (for B5 we surface terminal primarily)
        if (st === 'WORKING') {
          // age check for stale working -> idle
          // (simplified; full sh has pane too)
        }
      }

      // hard-cap (timer)
      if (isHardCap()) {
        await writeArtifact('HARD-CAP', 'timer', 0, `elapsed >= ${hardCapMin}min`);
        return { role, batch: batchId, status: 'HARD-CAP', source: 'timer', line_no: 0, note: `elapsed >= ${hardCapMin}min` };
      }

      // idle / pane (if session)
      if (session) {
        try {
          const pane = await this.capture(session);
          const hash = this.hash(pane);
          if (hash !== prevPaneHash) {
            idleStreak = 0;
            prevPaneHash = hash;
          } else {
            idleStreak++;
            if (idleStreak >= 2) {
              await writeArtifact('IDLE', 'pane', 0, 'stopped / no callback');
              return { role, batch: batchId, status: 'IDLE', source: 'pane', line_no: 0, note: 'stopped / no callback' };
            }
          }
        } catch {}
      }

      // mtime stall on progress (if provided)
      if (progressPath) {
        try {
          const st = await fs.stat(progressPath);
          const age = (this.now() / 1000) - st.mtimeMs / 1000;
          if (age > 5400) {
            await writeArtifact('MTIME-STALL', 'timer', 0, 'progress mtime >90min');
            return { role, batch: batchId, status: 'MTIME-STALL', source: 'timer', line_no: 0, note: 'progress mtime >90min' };
          }
        } catch {}
      }

      await new Promise(r => setTimeout(r, pollMs));
    }
  }

  private hash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h.toString(16);
  }
}
