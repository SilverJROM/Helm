import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { DatabaseService } from '../db/database.js';
import { TmuxService, type TmuxTerminateOpts } from '../tmux/tmux-service.js';
import { KlooDiscoveryService, type KlooValidateResult } from './kloo-discovery-service.js';
import { applyEnvelopeIsolation, HELM_ENVELOPE_DIRECTIVE } from './envelope-isolation.js';
import { sessionStatusTokenFromRow } from './session-registry-service.js';

// Minimal seam so tests can inject a stub discovery without hitting the network.
export interface KlooValidator {
  validate(route: string, model: string): Promise<KlooValidateResult>;
}

// ---------------------------------------------------------------------------
// Injectable command runner — default uses execFile; tests inject a stub.
// Never shell-interpolates: cmd + args array goes straight to execFile.
// ---------------------------------------------------------------------------
export type CommandRunner = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string; code: number }>;

export function defaultCommandRunner(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const execOpts: any = {
      timeout: opts.timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: 1024 * 1024,
    };
    if (opts.env) {
      execOpts.env = { ...process.env, ...opts.env };
    }
    execFile(
      cmd,
      args,
      execOpts,
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) {
            // Process was killed due to timeout
            reject(new Error(`timeout: child killed after ${opts.timeoutMs}ms`));
            return;
          }
          // Nonzero exit — resolve with the exit code and captured output
          const code = typeof (err as any).code === 'number' ? (err as any).code : 1;
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code });
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: 0 });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Per-provider headless command map.
// args are passed as an array — never shell-interpolated.
// ---------------------------------------------------------------------------
interface ProviderCmd {
  bin: string;
  makeArgs: (modelId: string, prompt: string) => string[];
}

const PROVIDER_CMDS: Record<string, ProviderCmd> = {
  grok: {
    bin: 'grok',
    makeArgs: (modelId, prompt) => ['-p', prompt, '-m', modelId],
  },
  claude: {
    bin: 'claude',
    makeArgs: (modelId, prompt) => ['-p', prompt, '--model', modelId, '--dangerously-skip-permissions'],
  },
  // codex uses _validateViaCodexTmux — TUI-only, no headless execFile path
};

// ---------------------------------------------------------------------------
// Classifier — pure function, tested independently.
// Used on stdout + '\n' + stderr from the headless run.
//
// For headless output the marker appears exactly ONCE (model response only —
// no TUI echo of the sent prompt). So valid detection is done by the caller
// (exit0 + marker present). classifyPane is called for the invalid-class regexes.
// Returning null means "no definitive fatal class matched".
// ---------------------------------------------------------------------------
const INVALID_MODEL_RE = /invalid model|model not found|unknown model|does not exist/i;
const AUTH_RE = /api[_\s-]?key|authentication|unauthorized|sign[_\s-]in|login(?:\s+to|\s+required|\s+expired)?|credentials|permission denied/i;
const QUOTA_RE = /rate[_\s-]?limit|quota|billing|usage limit|too many requests/i;

function paneExcerpt(pane: string, re: RegExp): string {
  const idx = pane.search(re);
  if (idx < 0) return pane.slice(0, 40).replace(/\s+/g, ' ').trim();
  return pane.slice(Math.max(0, idx - 5), idx + 35).replace(/\s+/g, ' ').trim();
}

export interface ValidationResult {
  // B1 (kloo/D7): 'untested' added for dynamic providers whose models are discovered at runtime —
  // NOT a headless-CLI-validatable class in this batch (real discovery-based validation is B2/D7).
  status: 'valid' | 'invalid' | 'untested';
  detail: string;
}

/**
 * Classify captured pane/output text for error patterns.
 * Returns a ValidationResult for recognized fatal-invalid classes,
 * or null if no definitive class matched (caller decides valid vs unknown).
 * Exported for independent unit testing with fixture strings.
 */
export function classifyPane(pane: string, _marker: string): ValidationResult | null {
  if (INVALID_MODEL_RE.test(pane)) {
    return { status: 'invalid', detail: `invalid_model: ${paneExcerpt(pane, INVALID_MODEL_RE)}` };
  }
  if (AUTH_RE.test(pane)) {
    return { status: 'invalid', detail: `auth: ${paneExcerpt(pane, AUTH_RE)}` };
  }
  if (QUOTA_RE.test(pane)) {
    return { status: 'invalid', detail: `quota: ${paneExcerpt(pane, QUOTA_RE)}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface ModelValidationOpts {
  hardWallMs?: number;  // execFile timeout + overall cap; default 60 000
}

const DEFAULT_HARD_WALL = 60_000;

// ---------------------------------------------------------------------------
// ModelValidationService
// ---------------------------------------------------------------------------
export class ModelValidationService {
  private readonly inFlight = new Set<number>();
  private readonly runner: CommandRunner;
  private readonly hardWallMs: number;

  private readonly discovery?: KlooValidator;

  constructor(
    private readonly db: DatabaseService,
    runner?: CommandRunner,
    opts: ModelValidationOpts = {},
    private readonly tmux?: TmuxService,
    discovery?: KlooValidator
  ) {
    this.runner = runner ?? defaultCommandRunner;
    this.hardWallMs = opts.hardWallMs ?? DEFAULT_HARD_WALL;
    this.discovery = discovery;
  }

  async validate(modelId: number): Promise<ValidationResult> {
    if (this.inFlight.has(modelId)) {
      return { status: 'invalid', detail: 'concurrent: validation already in flight for this model' };
    }

    const model = this.db.prepare('SELECT * FROM models WHERE id = ?').get(modelId) as any;
    if (!model) throw new Error(`unknown model: ${modelId}`);

    // B2/D7 (kloo): REAL discovery-based validation — route reachable AND model present in that
    // route's live /v1/models catalog → valid; route unknown/unreachable or model absent → invalid.
    // Discovery never throws (see KlooDiscoveryService); we still guard and never throw here either.
    if (model.provider === 'kloo') {
      const result = await this._validateKloo(model);
      this._writeResult(modelId, result);
      return result;
    }

    // Codex is TUI-only: validate via a fresh tmux session, not execFile
    if (model.provider === 'codex') {
      if (!this.tmux) {
        const result: ValidationResult = { status: 'invalid', detail: 'startup_failure: codex validation requires tmux service' };
        this._writeResult(modelId, result);
        return result;
      }
      this.inFlight.add(modelId);
      let result: ValidationResult = { status: 'invalid', detail: 'internal: validate did not complete' };
      try {
        result = await this._validateViaCodexTmux(model, this.hardWallMs);
        return result;
      } finally {
        this.inFlight.delete(modelId);
        this._writeResult(modelId, result);
      }
    }

    const provCmd = PROVIDER_CMDS[model.provider as string];
    if (!provCmd) {
      const result: ValidationResult = { status: 'invalid', detail: `startup_failure: unsupported provider ${model.provider}` };
      this._writeResult(modelId, result);
      return result;
    }

    this.inFlight.add(modelId);
    let result: ValidationResult = { status: 'invalid', detail: 'internal: validate did not complete' };

    try {
      const nonce = randomBytes(4).toString('hex');
      const marker = `HELM_VALID_${nonce}`;
      const prompt = `Reply with exactly ${marker} and no other text.`;
      let runArgs = provCmd.makeArgs(model.model_id, prompt);
      let runEnv: NodeJS.ProcessEnv | undefined;

      // Apply shared envelope isolation even for unfenced direct CLI validation probes (validation
      // loading operator agents/skills is the same leak risk as masters/workers). See B4-T03.
      if (model.provider === 'claude') {
        const base = `claude --model ${model.model_id} --dangerously-skip-permissions`;
        const { envPrefix } = applyEnvelopeIsolation('claude', base);
        if (envPrefix && envPrefix.trim()) {
          runEnv = {};
          for (const part of envPrefix.trim().split(/\s+/)) {
            if (!part) continue;
            const eq = part.indexOf('=');
            if (eq > 0) runEnv[part.slice(0, eq)] = part.slice(eq + 1);
          }
        }
        // Append isolation flags (reusing shared HELM_ENVELOPE_DIRECTIVE via import of helper result source)
        runArgs = [
          ...runArgs,
          '--setting-sources', '',
          '--append-system-prompt', HELM_ENVELOPE_DIRECTIVE
        ];
      } else if (model.provider === 'grok') {
        // grok unchanged by helper; call for coverage/traceability
        applyEnvelopeIsolation('grok', `grok -m ${model.model_id}`);
      }

      let stdout = '';
      let stderr = '';
      let code = 0;

      try {
        const out = await this.runner(provCmd.bin, runArgs, { timeoutMs: this.hardWallMs, env: runEnv });
        stdout = out.stdout;
        stderr = out.stderr;
        code = out.code;
      } catch (e: any) {
        // runner rejected — treat as timeout/kill
        result = { status: 'invalid', detail: `timeout: no response after ${this.hardWallMs}ms` };
        return result;
      }

      const combined = stdout + '\n' + stderr;

      // Valid: exit 0 AND the exact marker is present in the output
      if (code === 0 && combined.includes(marker)) {
        result = { status: 'valid', detail: 'valid: headless marker echoed' };
        return result;
      }

      // Fatal-class error patterns (invalid_model / auth / quota)
      const classified = classifyPane(combined, marker);
      if (classified !== null) {
        result = classified;
        return result;
      }

      // Fallback by exit code
      const excerpt = combined.slice(0, 60).replace(/\s+/g, ' ').trim();
      if (code !== 0) {
        result = { status: 'invalid', detail: `cli_error: exit ${code} ${excerpt}` };
      } else {
        result = { status: 'invalid', detail: `no_valid_marker: ${excerpt}` };
      }
      return result;
    } finally {
      this.inFlight.delete(modelId);
      this._writeResult(modelId, result);
    }
  }

  // B2/D7: validate a kloo model against its route's live catalog via KlooDiscoveryService.
  // Never throws — mirrors discovery's never-throw contract.
  private async _validateKloo(model: { route?: string | null; model_id: string }): Promise<ValidationResult> {
    const route = String(model.route ?? '').trim();
    if (!route) {
      return { status: 'invalid', detail: 'kloo: no route set' };
    }
    try {
      const disc = this.discovery ?? new KlooDiscoveryService();
      const r = await disc.validate(route, model.model_id);
      if (r.ok) {
        return { status: 'valid', detail: `kloo: ${route} catalog has ${model.model_id}` };
      }
      return { status: 'invalid', detail: `kloo: ${r.reason ?? `model not found on route ${route}`}` };
    } catch (e: any) {
      return { status: 'invalid', detail: `kloo validation error: ${e?.message ?? String(e)}` };
    }
  }

  private async _validateViaCodexTmux(
    model: { model_id: string },
    timeoutMs: number
  ): Promise<ValidationResult> {
    const nonce = randomBytes(4).toString('hex');
    const sessionName = `helm-val-codex-${nonce}`;
    const target = `${sessionName}:0.0`;
    const marker = `HELM_VALID_${nonce}`;
    const prompt = `Reply with exactly ${marker} and no other text.`;

    try {
      // S05: validation probe seats are Helm-owned.
      await this.tmux!.createSession(sessionName, undefined, { owner: 'helm', kind: 'test' });
      const baseCmd = `codex -m ${model.model_id} --dangerously-bypass-approvals-and-sandbox`;
      const { envPrefix: _envPrefix, launchCmd } = applyEnvelopeIsolation('codex', baseCmd);
      // envPrefix is '' for codex; launchCmd carries -c project_doc_max_bytes=0
      await this.tmux!.sendCommand(target, launchCmd, true, true);

      const ready = await this.tmux!.waitForReady(target, '›', timeoutMs);
      if (!ready) {
        return { status: 'invalid', detail: `timeout: codex did not reach ready state in ${timeoutMs}ms` };
      }

      // F2: interactive SEAT (always codex) — gate on the codex composer glyph '›' (just confirmed ready above).
      await this.tmux!.sendAndSubmit(target, prompt, { readySignal: '›' });

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2_000));
        const pane = await this.tmux!.capturePane(target, 500);
        if (pane.replace(/\s+/g, '').includes(marker)) {
          return { status: 'valid', detail: 'valid: headless marker echoed' };
        }
        const classified = classifyPane(pane, marker);
        if (classified) return classified;
      }
      return { status: 'invalid', detail: `timeout: no response after ${timeoutMs}ms` };
    } finally {
      // B02 C1: capture decision-boundary token for this validation seat, or kill-only.
      try {
        await this.tmux!.terminateSession(sessionName, this.terminateOptsForSession(sessionName));
      } catch {}
    }
  }

  /** B02 C1: CAS token from helm_sessions at terminate decision, else explicit noRegistryWrite. */
  private terminateOptsForSession(name: string): TmuxTerminateOpts {
    if (!name) return { noRegistryWrite: true };
    try {
      const row = this.db
        .prepare(`SELECT id, name, owner, status, generation FROM helm_sessions WHERE name = ?`)
        .get(name) as
        | { id: number; name: string; owner: string | null; status: string; generation: number }
        | undefined;
      if (!row || row.status === 'reaped') return { noRegistryWrite: true };
      return { sessionToken: sessionStatusTokenFromRow(row) };
    } catch {
      return { noRegistryWrite: true };
    }
  }

  private _writeResult(modelId: number, result: ValidationResult): void {
    this.db.prepare(
      `UPDATE models SET validation_status=?, validated_at=datetime('now'), validation_detail=?, updated_at=datetime('now') WHERE id=?`
    ).run(result.status, result.detail, modelId);
  }

  async validateAll(opts?: { force?: boolean }): Promise<{
    considered: number;
    validated: number;
    valid: number;
    invalid: number;
    skipped: number;
    errors: string[];
  }> {
    const rows = (
      opts?.force
        ? this.db.prepare('SELECT id FROM models').all()
        : this.db.prepare("SELECT id FROM models WHERE validation_status = 'untested'").all()
    ) as { id: number }[];

    const summary = { considered: rows.length, validated: 0, valid: 0, invalid: 0, skipped: 0, errors: [] as string[] };
    for (const { id } of rows) {
      try {
        const r = await this.validate(id);
        summary.validated++;
        if (r.status === 'valid') summary.valid++;
        else summary.invalid++;
      } catch (err) {
        summary.errors.push(`model ${id}: ${String(err)}`);
        summary.skipped++;
      }
    }
    return summary;
  }
}
