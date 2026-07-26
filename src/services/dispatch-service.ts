import fs from 'node:fs/promises';
import path from 'node:path';
import { TmuxService } from '../tmux/tmux-service.js';
import { RunArtifactService } from './run-artifact-service.js';

export interface DispatchStartParams {
  session: string;
  briefPath: string;
  runDir: string;
  batchId: string;
  role: string;
  attemptId?: number;  // POCFIX7: optional; 0/absent for planning (attempt-less) -> skip DB insert
  bucket: 'SHORT' | 'MEDIUM' | 'LONG' | 'OUTSIZED' | 'TEST-HEAVY' | 'MEGA';
  estimateMin: number;
  callbacksFile?: string;
  readySignal?: string; // provider readyProbe signal (real-transport passes it); falls back to '❯' when absent
}

export interface DispatchStartResult {
  dispatchId: number;
  marker: string;
  manifestPath: string;
  wakeupSec: number;
  prebakedBriefPath: string;
}

export class DispatchService {
  private readonly VERIFY_DELAY_MS = 1500; // port of sh VERIFY_DELAY (tunable via env in real)

  constructor(
    private readonly tmux: TmuxService,
    private readonly artifacts: RunArtifactService
  ) {}

  async start(params: DispatchStartParams): Promise<DispatchStartResult> {
    const { session, briefPath, runDir, batchId, role, attemptId: attemptIdParam = 0, bucket, estimateMin, callbacksFile, readySignal } = params;
    const attemptId = attemptIdParam || 0;
    const dispatchDir = path.join(runDir, 'dispatch');
    await fs.mkdir(dispatchDir, { recursive: true });

    // 0. best-effort cleanup of prior manifest/wakeup for this batch/role (idempotent re-dispatch safety, like sh)
    await this.cleanupPrior(dispatchDir, batchId, role);

    // 1. read + contract validate (DSP3) — fail closed before any hand-off
    const originalText = await fs.readFile(briefPath, 'utf8');
    this.validateBriefContract(originalText, role);

    // 2. prebake if placeholder present (so child can copy verbatim emit line + callbacks resolves)
    const { prebakedPath, prebakedText } = await this.maybePrebake(briefPath, callbacksFile, dispatchDir, batchId, role);
    if (prebakedPath !== briefPath) {
      this.validateBriefContract(prebakedText, role);
    }

    // 3. session + ready probe (ensure/reuse the live agent pane)
    if (!(await this.tmux.sessionExists(session))) {
      throw new Error(`tmux session not alive: ${session}`);
    }
    const ready = await this.tmux.waitForReady(session, readySignal);
    if (!ready) {
      throw new Error('worker ready probe failed (ready-timeout)');
    }

    // 4. unique marker + 3-call payload (exact port of sh)
    const marker = `DISPATCH-${batchId}-${role}-${process.pid}-${Math.floor(Date.now() / 1000)}`;
    const payload = `Read ${prebakedPath} and follow its instructions. (dispatch marker: ${marker})`;

    // send (robust submit for the instruction). F2: forward the provider ready glyph we just readyProbed
    // with (line above) so the worker SEAT feed is not falsely marked delivered before its composer is ready.
    const submitted = await this.tmux.sendDispatchInstruction(session, payload, readySignal);
    if (!submitted) {
      throw new Error('sendDispatchInstruction returned false (feed-failed)');
    }

    // 5. verify marker actually echoed in pane (the critical hand-off confirmation)
    await new Promise((r) => setTimeout(r, this.VERIFY_DELAY_MS));
    const verified = await this.tmux.verifyMarkerPresent(session, marker);
    if (!verified) {
      // POCFIX19 (panel-reviewed): marker echo is NOT how delivery is confirmed — the agent's [helm callback]
      // line is (polled with real timeouts downstream by planning/loop/panel). The throw here was the ~50%
      // claude flakiness (echo-timing misses even when the send landed). Warn + proceed; a genuinely dropped
      // send fails loud + correctly at the downstream callback timeout (clean BLOCK), not a silent dead run.
      console.warn(`[dispatch] marker not echoed for ${session} (send likely landed; delivery confirmed via callbacks). Proceeding.`);
    }

    // 6. compute wakeup (exact port of sh compute_wakeup_sec)
    const wakeupSec = this.computeWakeupSec(bucket, estimateMin);

    // 7. SUCCESS PATH ONLY: record row + manifest + wakeup marker (post-verify = no partial on prior failures)
    // POCFIX7: if attemptId absent/0 (planning/projcore attempt-less spawn), SKIP the recordDispatch DB insert
    // (avoids FK on attempt_id=0); the tmux send/verify (dispatch hand-off) still ran above. Planning tracked via callbacks/plan.json only.
    let dispatchId = 0;
    const dispatchedAt = new Date().toISOString();
    const wakeupMarkerPath = path.join(dispatchDir, `${batchId}.wakeup-required`);
    const manifest = {
      schema_version: 4,
      batch_id: batchId,
      role,
      run_dir: runDir,
      session,
      brief: briefPath,
      prebaked_brief: prebakedPath,
      callbacks_file: callbacksFile || '',
      dispatched_at: dispatchedAt,
      estimate_min: estimateMin,
      bucket,
      wakeup_delay_sec: wakeupSec,
      wakeup_marker_path: wakeupMarkerPath,
      dispatch_marker: marker,
      watcher_pid: null,
      watcher_pid_file: null,
      watcher_log: null,
      wakeup_acked_at: null,
      wakeup_acked_by: null
    };

    const manifestPath = path.join(dispatchDir, `${batchId}.json`);
    const roleManifestPath = path.join(dispatchDir, `${batchId}.${role}.json`);

    if (attemptId > 0) {
      dispatchId = this.artifacts.recordDispatch(attemptId, role, briefPath, marker);
      await fs.writeFile(roleManifestPath, JSON.stringify(manifest, null, 2));
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      await fs.writeFile(wakeupMarkerPath, ''); // empty marker file (B5 will consume)
    }
    // else: no dispatch row for planning; send/verify already done

    return {
      dispatchId,
      marker,
      manifestPath: roleManifestPath,
      wakeupSec,
      prebakedBriefPath: prebakedPath
    };
  }

  // Mirrors projcore-dispatch.sh:run_contract_checks exactly (5 checks). Fails closed.
  // Errors carry BRIEF-CONTRACT-MISSING <code> for precise reporting.
  validateBriefContract(briefText: string, role: string): void {
    if (!briefText.includes('<!-- PROJCORE-STATUS-CONTRACT v2 -->')) {
      throw new Error('BRIEF-CONTRACT-MISSING status_contract_v2');
    }
    // B5 (DSP2): canonical is now [helm callback] — clean migration (no silent projcore dual-prefix in Helm parser/contract)
    if (!briefText.includes('[helm callback] <role> <batch-id> STATUS:')) {
      throw new Error('BRIEF-CONTRACT-MISSING callback_format');
    }
    const enumLine = this.getRoleEnumLine(role);
    if (!briefText.includes(enumLine)) {
      throw new Error('BRIEF-CONTRACT-MISSING closed_enum');
    }
    if (!(briefText.includes('first tool call') && briefText.includes('BEFORE any prose tokens'))) {
      throw new Error('BRIEF-CONTRACT-MISSING streaming_order_rule');
    }
    // Helm-native callback contract: the brief MUST instruct a direct append to callbacks.md, and MUST NOT
    // reference the external standalone-projcore emit helper (its HTTP ingest 403s for run-dispatched agents).
    if (!briefText.includes("printf '%s\\n'") || !briefText.includes(">> '") || !briefText.includes('callbacks.md')) {
      throw new Error('BRIEF-CONTRACT-MISSING native_callback_append');
    }
    if (briefText.includes('lib/projcore-emit-status.sh') || briefText.includes('PROJCORE_CALLBACKS_FILE=')) {
      throw new Error('BRIEF-CONTRACT-FORBIDDEN external_callback_helper');
    }

    // B7 TST2 (guardrail 2): generated briefs MUST contain ALL listed clauses or validation REJECTS.
    // callback-first line (exact format already partially above)
    if (!briefText.includes('The callback line template is: [helm callback]') && !briefText.includes('callback line template is: [helm callback]')) {
      throw new Error('BRIEF-CONTRACT-MISSING callback_first_line');
    }
    // artifact output paths
    if (!briefText.includes('prompts/') || !briefText.includes('dispatch/') || !briefText.includes('artifacts/') || !briefText.includes('callbacks.md') || !briefText.includes('state/')) {
      throw new Error('BRIEF-CONTRACT-MISSING artifact_paths');
    }
    // project dir
    if (!briefText.includes('Project dir:') && !briefText.includes('project dir')) {
      throw new Error('BRIEF-CONTRACT-MISSING project_dir');
    }
    // fence policy
    if (!briefText.includes('Write-fence (WRK2)') && !briefText.includes('write-fence')) {
      throw new Error('BRIEF-CONTRACT-MISSING fence_policy');
    }
    // requirement anchor
    if (!briefText.includes('Requirements assigned:')) {
      throw new Error('BRIEF-CONTRACT-MISSING requirement_anchor');
    }
    // B7 TST2 issue-mode repro gate: only for explicit issue briefs (writer header "For issue tasks:"); meta "repro gate" in requirementsSection quote must not trigger for feature briefs
    if (briefText.includes('## Issue reproduction gate') || briefText.includes('For issue tasks:')) {
      if (!briefText.includes('REPRO-CONFIRMED') && !briefText.includes('REPRO-SATISFIED') && !briefText.includes('REPRO-FAILED')) {
        throw new Error('BRIEF-CONTRACT-MISSING issue_repro_gate');
      }
    }
  }

  private getRoleEnumLine(role: string): string {
    const r = (role || '').toLowerCase().trim();
    if (r === 'validator' || r === 'final-validator') {
      return 'validator states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO | PASS | FAIL | REPRO-CONFIRMED | REPRO-SATISFIED | REPRO-FAILED';
    }
    // NOTE: enum prefixes for colliding roles use the worker-facing name (phase brains -> helm_pm,
    // reviewer->helm_code_review) to match brief-writer.getRoleStates exactly. Keep in lockstep.
    if (r === 'discovery') {
      return 'discovery states: INTERVIEWING | NORTH-STAR-READY | IDLE | BLOCKED';
    }
    if (r === 'plancore' || r === 'ibrain') {
      return 'helm_pm states: PLANNING | PLAN-READY | NORTH-STAR-READY | IDLE | DECIDING | DECISION-READY | BLOCKED';
    }
    if (r === 'panelist' || r === 'red-team' || r === 'planner' || r === 'deliberation') {
      return 'panelist states: VERDICT-READY | CONSENSUS | SETTLED | CLEAN | BROKEN';
    }
    if (r === 'reviewer') {
      return 'helm_code_review states: APPROVE | REVISE | REJECT-RESTART';
    }
    return 'implementer states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO';
  }

  private async maybePrebake(
    briefPath: string,
    callbacksFile: string | undefined,
    dispatchDir: string,
    batchId: string,
    role: string
  ): Promise<{ prebakedPath: string; prebakedText: string }> {
    const text = await fs.readFile(briefPath, 'utf8');
    if (!callbacksFile || !text.includes('<abs-path-to-callbacks.md>')) {
      return { prebakedPath: briefPath, prebakedText: text };
    }
    const prebakedPath = path.join(dispatchDir, `${batchId}.${role}.brief.md`);
    const baked = text.replace(/<abs-path-to-callbacks\.md>/g, callbacksFile);
    await fs.writeFile(prebakedPath, baked, 'utf8');
    return { prebakedPath, prebakedText: baked };
  }

  private computeWakeupSec(bucket: string, estimateMin: number): number {
    let multNum = 2;
    let multDen = 1;
    if (bucket === 'TEST-HEAVY') {
      multNum = 5;
      multDen = 2;
    }
    let sec = Math.floor(((estimateMin * 60) * multNum) / multDen);
    if (sec < 60) sec = 60;
    if (sec > 3600) sec = 3600;
    return sec;
  }

  private async cleanupPrior(dispatchDir: string, batchId: string, role: string): Promise<void> {
    // best effort, mirrors prior watcher kill + marker removal before new dispatch
    const files = [
      path.join(dispatchDir, `${batchId}.json`),
      path.join(dispatchDir, `${batchId}.${role}.json`),
      path.join(dispatchDir, `${batchId}.wakeup-required`)
    ];
    for (const f of files) {
      await fs.unlink(f).catch(() => {});
    }
  }

  // Defensive cleanup for any partial written after a late failure (called from catch in start if needed).
  // In practice verify-first means most paths never create state on failure.
  async cleanupPartial(runDir: string, batchId: string, role: string, dispatchId?: number): Promise<void> {
    const dispatchDir = path.join(runDir, 'dispatch');
    await this.cleanupPrior(dispatchDir, batchId, role);
    if (dispatchId != null) {
      try {
        // direct raw delete via the service's internal (tests can also query counts pre/post)
        // RunArtifactService does not expose delete, so best-effort unlink only for files here;
        // row deletion is rare (would only happen if record succeeded then later throw on write).
        // Callers/tests assert via count.
      } catch {}
    }
  }
}
