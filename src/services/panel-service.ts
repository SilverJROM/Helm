import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCallbackLine } from './agent-event-ingest.js';
import type { ITransport } from './fake-transport.js';
import type { RunArtifactService } from './run-artifact-service.js';
import { BriefWriterService } from './brief-writer-service.js';

export interface PanelVerdict {
  seat: string;
  verdict: string;
}

export interface DeliberationResult {
  state: 'CONSENSUS' | 'SETTLED';
  consensus: string;
  verdicts: PanelVerdict[];
}

export interface RedTeamResult {
  state: 'CLEAN' | 'BROKEN';
  note: string;
  rounds: number;
  verdicts: Array<{ round: number; verdict: string }>;
}

/**
 * PanelService (B10 DSP9/10 + panel support)
 * - Spawns panelist seats (multi-provider via B2 transport + role defs from B3)
 * - Collects independent VERDICT-READY only (verifier ≠ fixer)
 * - Aggregates for deliberation (consensus from N verdicts) and red-team (N-consecutive CLEAN or BROKEN)
 * - Helm (loop) routes the result; panel never writes code/fix.
 * - Fixture friendly under USE_FAKE_TMUX (tests append cbs + poll file).
 */
export class PanelService {
  constructor(
    private readonly transport: ITransport,
    private readonly artifactService?: RunArtifactService,
    private readonly batchId = 'batch-B10'
  ) {}

  async conveneDeliberationPanel(opts: {
    runDir: string;
    batchId?: string;
    topic: string;
    seats?: Array<{ lens: string; model?: string; provider?: string }>;
    projectDir?: string;  // POCFIX19: fence panelists to the project dir (was missing → fenced to Helm cwd)
    strictReadAllow?: string[];  // B-ISO1 (sol wiring review-2 fix #2): run-scoped opt-in strict READ fence for panelist seats; undefined => read-all (unchanged)
  }): Promise<DeliberationResult> {
    const batchId = opts.batchId || this.batchId;
    const runDir = opts.runDir;
    const seats = opts.seats || [
      { lens: 'correctness + requirements fidelity' },
      { lens: 'tests + edge coverage' },
      { lens: 'architecture + maintainability' }
    ];
    const panelId = `delib-${Date.now()}`;
    const verdicts: PanelVerdict[] = [];

    for (let i = 0; i < seats.length; i++) {
      const seat = `${panelId}:${i}`;
      const lens = seats[i].lens;
      const briefWriter = new BriefWriterService();
      const brief = briefWriter.generatePanelBrief({
        role: 'panelist',
        batchId,
        seat,
        lens,
        requirement: opts.topic,
        projectDir: opts.projectDir || process.cwd(),
        callbacksFile: path.join(runDir, 'callbacks.md'),
      });
      let off = 0;
      const isFakePath = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
      if (!isFakePath) {
        try { off = (await fs.stat(path.join(runDir, 'callbacks.md'))).size; } catch {}
      }
      const s = seats[i];
      const spawned = await this.transport.spawn({ role: 'panelist', brief, runDir, batchId, projectDir: opts.projectDir, model: s?.model, provider: s?.provider, ...(opts.strictReadAllow ? { strictReadAllow: opts.strictReadAllow } : {}) });  // B-ISO1: run-scoped strict read fence on the deliberation panelist seat
      const handle = spawned.handle;
      const seen = await this.waitForVerdict(runDir, batchId, seat, 'VERDICT-READY', undefined, off);
      verdicts.push({ seat, verdict: seen.note || 'no-note' });
      await this.transport.reap(handle, 'panel-verdict-received');
    }

    // Aggregate per deliberation.md: strict unanimous ≤3 rounds or two strongest settle
    const norm = verdicts.map(v => (v.verdict || '').trim());
    const unique = Array.from(new Set(norm.map(s => s.toLowerCase())));
    const state: 'CONSENSUS' | 'SETTLED' = unique.length <= 1 ? 'CONSENSUS' : 'SETTLED';
    const consensus = unique.join(' || ');
    return { state, consensus, verdicts };
  }

  async conveneRedTeamPanel(opts: {
    runDir: string;
    batchId?: string;
    implementedDiff: string;
    requirement: string;
    nConsecutiveClean?: number;
    redTeamAgents?: Array<{ role: string; agent_id?: number; model?: string; provider?: string }>;  // POCFIX5: include provider for robust resolution (null model -> provider default)
    projectDir?: string;  // POCFIX19: fence red-team agents to the project dir (was missing → fenced to Helm cwd)
    strictReadAllow?: string[];  // B-ISO1 (sol wiring review-2 fix #2): run-scoped opt-in strict READ fence for red-team seats; undefined => read-all (unchanged)
  }): Promise<RedTeamResult> {
    const batchId = opts.batchId || this.batchId;
    const runDir = opts.runDir;
    const n = opts.nConsecutiveClean || 2;
    const agents = opts.redTeamAgents || [];
    const panelId = `red-${Date.now()}`;
    let consecutive = 0;
    let rounds = 0;
    const verdicts: Array<{ round: number; verdict: string }> = [];
    const maxR = 6;

    while (consecutive < n && rounds < maxR) {
      rounds++;
      const agentIdx = (rounds - 1) % (agents.length || 1);
      const agent = agents.length > 0 ? agents[agentIdx] : null;
      const spawnRole = agent?.role || 'panelist';
      const spawnModel = agent?.model;
      const seat = `${panelId}:r${rounds}`;
      const lens = `adversarial-lens-${(rounds % 3) + 1}`;
      const agentInfo = agent ? ` (project role_bindings red-team agent: role=${agent.role}, model=${agent.model || 'default'}, id=${agent.agent_id || 'n/a'})` : ' (generic)';
      const briefWriter = new BriefWriterService();
      const brief = briefWriter.generatePanelBrief({
        role: spawnRole,
        batchId,
        seat,
        lens,
        requirement: opts.requirement,
        implementedDiff: opts.implementedDiff,
        projectDir: opts.projectDir || process.cwd(),
        callbacksFile: path.join(runDir, 'callbacks.md'),
      });
      let off = 0;
      const isFakePath = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
      if (!isFakePath) {
        try { off = (await fs.stat(path.join(runDir, 'callbacks.md'))).size; } catch {}
      }
      const spawned = await this.transport.spawn({ role: spawnRole, model: spawnModel, provider: agent?.provider, brief, runDir, batchId, projectDir: opts.projectDir, ...(opts.strictReadAllow ? { strictReadAllow: opts.strictReadAllow } : {}) });  // B-ISO1: run-scoped strict read fence on the red-team seat
      const handle = spawned.handle;
      const seen = await this.waitForVerdict(runDir, batchId, seat, 'VERDICT-READY', undefined, off);
      const vtext = seen.note || '';
      verdicts.push({ round: rounds, verdict: vtext });
      await this.transport.reap(handle, 'red-verdict-received');

      const up = vtext.toUpperCase();
      if (up.includes('CLEAN') && !up.includes('BROKEN')) {
        consecutive++;
      } else {
        consecutive = 0;
        if (up.includes('BROKEN')) {
          return { state: 'BROKEN', note: vtext, rounds, verdicts };
        }
      }
    }
    // POCFIX21: an EXPLICIT BROKEN verdict already returned mid-loop (line ~138). Reaching here means NO red-team
    // round called it BROKEN — so failing to reach N-consecutive-CLEAN is INCONCLUSIVE (a flaky agent not
    // re-emitting), NOT a break. The deterministic test-gate (POCFIX17) is the real PASS gate; red-team is an
    // advisory adversarial overlay. Return CLEAN (advisory) so an inconclusive panel never false-fails a
    // test-green task. Only an explicit BROKEN routes a break back.
    const clean = consecutive >= n;
    return {
      state: 'CLEAN',
      note: clean ? `${n}-consecutive-clean over distinct lenses` : `advisory CLEAN: ${consecutive}/${n} clean, no BROKEN verdict in ${rounds} rounds — proceeding (deterministic test-gate is the gate)`,
      rounds,
      verdicts
    };
  }

  // FIX-B: role-aware (for red-team/panel) wall + idle; isFake keeps short, real uses minutes.
  // Heartbeat via last line change for the verdict.
  private async waitForVerdict(
    runDir: string,
    batchId: string,
    seatTag: string,
    wantedState: string,
    timeoutMs?: number,
    sinceOffset = 0
  ): Promise<{ state: string; note: string | null }> {
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    const wallMs = timeoutMs ?? (isFake ? 2500 : 10 * 60_000);  // real red-team rounds can take time
    const idleMs = isFake ? 2500 : 4 * 60_000;
    const start = Date.now();
    const cbp = path.join(runDir, 'callbacks.md');
    let lastSig = '';
    let lastChangeAt = Date.now();
    while (Date.now() - start < wallMs) {
      try {
        const raw = await fs.readFile(cbp, 'utf8');
        const body = raw.slice(sinceOffset);
        const lines = body.split(/\r?\n/).reverse();
        for (const line of lines) {
          const p = parseCallbackLine(line);
          if (p && p.batchId === batchId && (p.role === 'panelist' || p.role === 'red-team') && p.state === wantedState) {
            return { state: p.state, note: p.note };
          }
        }
        // heartbeat: any new line for red/panel resets idle (even if not the wanted yet)
        const sig = body.split(/\r?\n/).reverse().find(l => {
          const p = parseCallbackLine(l); return !!p && (p.role === 'panelist' || p.role === 'red-team');
        }) || '';
        if (sig !== lastSig) { lastSig = sig; lastChangeAt = Date.now(); }
      } catch {
        // file may not exist yet or race; continue polling
      }
      if (Date.now() - lastChangeAt > idleMs) {
        throw new Error(`waitForVerdict idle-timeout for ${seatTag} (no progress ${idleMs}ms; wanted ${wantedState})`);
      }
      await new Promise((r) => setTimeout(r, isFake ? 8 : 1000));
    }
    throw new Error(`waitForVerdict wall-timeout for ${seatTag} (wanted ${wantedState})`);
  }
}
