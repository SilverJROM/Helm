import fs from 'node:fs/promises';
import path from 'node:path';
import type { SeatInspection } from './seat-pane-state.js';
import { makeCycleGitAllowEnv, type CycleGitAllowCycle } from '../security/landlock-sandbox.js';

export type { CycleGitAllowCycle };

export interface ITransport {
  spawn(params: {
    role: 'implementer' | 'validator' | 'discovery' | 'plancore' | 'ibrain' | string;
    brief: string;
    runDir: string;
    batchId?: string;
    rung?: number;
    model?: string;
    effort?: string;  // C6: per-task effort from plan honored at spawn (for launch cmd)
    sessionName?: string;
    provider?: string;  // POCFIX5: authoritative provider from role_binding (threaded to avoid reverse-lookup)
    route?: string;  // C0: kloo route (openrouter/llamacpp) for `<route>` in dynamic-provider launch templates; unused by non-kloo
    attemptId?: number;  // POCFIX7: real attempt id (for per-task dispatch FK); 0/absent for planning
    projectDir?: string;  // POCFIX14: registered project dir to fence the agent to (so implementer can write the build)
    strictReadAllow?: string[];  // B-ISO1: run-scoped opt-in strict read allowlist (undefined => read-all; RealTransport composes the sandbox env)
    projectId?: number;  // A2 (R4.16): threaded into TmuxService.createSession → helm_sessions linkage
    runId?: number;      // A2 (R4.16): same
    // B9 (R4.1/R4.3): persisted, revalidated cycle identity — CYCLE SEATS ONLY (implementation,
    // validator, final-validation). Absent (every master-runtime spawn, chat session, and
    // non-cycle worker) => no git env composed at all. A stale/mismatched identity fails the
    // spawn closed (makeCycleGitAllowEnv throws before any session is created).
    cycleGitIdentity?: CycleGitAllowCycle;
  }): Promise<{ handle: string; role: string }>;
  reap(handle: string, reason?: string): Promise<void>;
  inspectSeat?(handle: string, brief: string, provider?: string): Promise<SeatInspection>;
  nudgeSeat?(handle: string, provider?: string): Promise<boolean>;
}

export class FakeTransport implements ITransport {
  private spawned = new Map<string, { role: string; brief: string; runDir: string; at: number; rung?: number; model?: string; effort?: string; sessionName?: string; provider?: string; route?: string; attemptId?: number; strictReadAllow?: string[]; gitAllowEnv?: string }>();
  public readonly reapCalls: Array<{ handle: string; reason: string; at: number }> = [];
  public readonly spawnCalls: Array<{ role: string; brief: string; at: number; batchId?: string; rung?: number; model?: string; effort?: string; sessionName?: string; provider?: string; route?: string; attemptId?: number; projectDir?: string; strictReadAllow?: string[]; projectId?: number; runId?: number; cycleGitIdentity?: CycleGitAllowCycle; gitAllowEnv?: string }> = [];
  public readonly nudgeCalls: Array<{ handle: string; provider?: string; at: number }> = [];
  public readonly inspectCalls: Array<{ handle: string; provider?: string; at: number }> = [];
  // B0 legacy (kept for test call sites); callback decisions still come only from genuine callbacks.md lines.
  // Tests still append to callbacks.md for file asserts + to drive the real parser. queueCallback calls are now no-ops for wait logic.
  public scriptedCallbacks: Array<{ role: string; state: string; note?: string }> = [];
  private nextHandle = 1;
  private pendingSeatScripts: SeatInspection[][] = [];
  private seatScripts = new Map<string, SeatInspection[]>();

  constructor() {
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    if (!isFake) {
      throw new Error('FakeTransport strictly behind USE_FAKE_TMUX=1 (non-production) per batch-B0 approval; real tmux/worker paths untouched');
    }
  }

  async spawn(params: { role: 'implementer' | 'validator' | 'discovery' | 'plancore' | 'ibrain' | string; brief: string; runDir: string; batchId?: string; rung?: number; model?: string; effort?: string; sessionName?: string; provider?: string; route?: string; attemptId?: number; projectDir?: string; strictReadAllow?: string[]; projectId?: number; runId?: number; cycleGitIdentity?: CycleGitAllowCycle }): Promise<{ handle: string; role: string }> {
    // B9 (R4.1/R4.3): compose (fail-closed) BEFORE any spawn state is recorded — a stale/mismatched
    // identity throws here and this spawn leaves no trace, mirroring RealTransport's contract.
    // Absent cycleGitIdentity (every master-runtime/chat-session/non-cycle-worker caller) => undefined.
    const gitAllowEnv = params.cycleGitIdentity ? makeCycleGitAllowEnv(params.cycleGitIdentity) : undefined;
    const handle = `fake-${params.role}-${this.nextHandle++}`;
    this.spawned.set(handle, { role: params.role, brief: params.brief, runDir: params.runDir, at: Date.now(), rung: params.rung, model: params.model, sessionName: params.sessionName, provider: params.provider, route: params.route, attemptId: params.attemptId, strictReadAllow: params.strictReadAllow, gitAllowEnv });
    const pendingScript = this.pendingSeatScripts.shift();
    if (pendingScript) this.seatScripts.set(handle, pendingScript.map((frame) => ({ ...frame })));
    this.spawnCalls.push({ role: params.role, brief: params.brief, at: Date.now(), batchId: params.batchId, rung: params.rung, model: params.model, sessionName: params.sessionName, provider: params.provider, route: params.route, attemptId: params.attemptId, effort: params.effort, projectDir: params.projectDir, strictReadAllow: params.strictReadAllow, projectId: params.projectId, runId: params.runId, cycleGitIdentity: params.cycleGitIdentity, gitAllowEnv });
    return { handle, role: params.role };
  }

  async reap(handle: string, reason = 'complete'): Promise<void> {
    if (this.spawned.has(handle)) {
      this.reapCalls.push({ handle, reason, at: Date.now() });
      this.spawned.delete(handle);
    }
  }

  /** Queue pane frames for the next spawn. The final frame remains stable after the script drains. */
  queueSeatScript(frames: SeatInspection[]): void {
    this.pendingSeatScripts.push(frames.map((frame) => ({ ...frame })));
  }

  async inspectSeat(handle: string, _brief: string, _provider?: string): Promise<SeatInspection> {
    this.inspectCalls.push({ handle, provider: _provider, at: Date.now() });
    if (!this.spawned.has(handle)) return { sessionAlive: false, pane: '', composerHoldsBrief: false };
    const frames = this.seatScripts.get(handle);
    if (!frames || frames.length === 0) return { sessionAlive: true, pane: '', composerHoldsBrief: false };
    if (frames.length === 1) return { ...frames[0] };
    return { ...frames.shift()! };
  }

  async nudgeSeat(handle: string, provider?: string): Promise<boolean> {
    if (!this.spawned.has(handle)) return false;
    this.nudgeCalls.push({ handle, provider, at: Date.now() });
    return true;
  }

  getBriefFor(handle: string): string | undefined {
    return this.spawned.get(handle)?.brief;
  }

  getRungFor(handle: string): number | undefined {
    return this.spawned.get(handle)?.rung;
  }

  getModelFor(handle: string): string | undefined {
    return this.spawned.get(handle)?.model;
  }

  getEffortFor(handle: string): string | undefined {
    return this.spawned.get(handle)?.effort;
  }

  getSessionNameFor(handle: string): string | undefined {
    return this.spawned.get(handle)?.sessionName;
  }

  queueCallback(role: string, state: string, note?: string) {
    this.scriptedCallbacks.push({ role, state, note });
  }
}
