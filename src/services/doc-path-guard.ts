import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type DocPathMode = 'read' | 'write' | 'delete';

export interface ResolvedDocPath {
  realRoot: string;
  full: string;
  realFile: string | null;
  safeRel: string;
  segments: string[];
  filename: string;
}

export function containedInRoot(realPath: string, realRoot: string): boolean {
  return realPath === realRoot || realPath.startsWith(realRoot + path.sep);
}

export interface ResolveSafeDocPathOptions {
  containmentLabel?: string;
  symlinkRejectMessage?: string;
}

const ATTACHMENT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * Traversal guard for cycle image attachments under <cycleRoot>/attachments/<safe_filename>.
 * Rejects .., absolute paths, non-image extensions, realpath escape, and symlink leaves on write.
 */
export async function resolveSafeAttachmentPath(
  cycleRootDir: string,
  filename: string,
  opts: ResolveSafeDocPathOptions = {}
): Promise<ResolvedDocPath> {
  const containmentLabel = opts.containmentLabel || 'cycle dir';
  const symlinkRejectMessage = opts.symlinkRejectMessage || 'symlink not allowed for attachment write';

  const rawInput = String(filename || '').trim();
  if (!rawInput || rawInput.includes('..') || path.isAbsolute(rawInput)) {
    const e: any = new Error('path traversal blocked (invalid characters or relative escape in path)');
    e.code = 'TRAVERSAL';
    throw e;
  }

  const base = path.basename(rawInput.replace(/^\/+/, ''));
  const ext = path.extname(base).toLowerCase();
  if (!ATTACHMENT_IMAGE_EXTENSIONS.has(ext)) {
    const e: any = new Error('only image attachments are allowed (png, jpg, jpeg, webp, gif)');
    e.code = 'TRAVERSAL';
    throw e;
  }

  const safeRel = path.join('attachments', base);
  const segments = safeRel.split(/[\\/]+/).filter(Boolean);

  await fs.mkdir(cycleRootDir, { recursive: true });

  const full = path.join(cycleRootDir, safeRel);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(cycleRootDir);
  } catch {
    const e: any = new Error('project directory or file not found');
    e.code = 'NOT_FOUND';
    throw e;
  }

  let realFile: string | null = null;
  try {
    realFile = await fs.realpath(full);
  } catch {
    realFile = null;
  }

  if (realFile) {
    if (!containedInRoot(realFile, realRoot)) {
      const e: any = new Error(`path traversal blocked (realpath not contained in ${containmentLabel})`);
      e.code = 'TRAVERSAL';
      throw e;
    }
  } else {
    const parent = path.dirname(full);
    await fs.mkdir(parent, { recursive: true });
    let realParent: string;
    try {
      realParent = await fs.realpath(parent);
    } catch {
      const e: any = new Error('project directory or file not found');
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (!containedInRoot(realParent, realRoot)) {
      const e: any = new Error(`path traversal blocked (parent realpath not contained in ${containmentLabel})`);
      e.code = 'TRAVERSAL';
      throw e;
    }
  }

  try {
    const leaf = await fs.lstat(full);
    if (leaf.isSymbolicLink()) {
      const e: any = new Error(symlinkRejectMessage);
      e.code = 'TRAVERSAL';
      throw e;
    }
  } catch (err: any) {
    if (err?.code === 'TRAVERSAL') throw err;
    if (err?.code !== 'ENOENT') throw err;
  }

  return {
    realRoot,
    full,
    realFile,
    safeRel,
    segments,
    filename: segments[segments.length - 1] || base
  };
}

/**
 * B7 (R6.27 backend/scaffold): traversal guard for the cycle chat-file writer, under
 * <project.directory>/tmp/<cycle-folder>/<filename> — text, files AND images, so (unlike
 * resolveSafeAttachmentPath) there is deliberately no extension allowlist, and no `attachments/`
 * subfolder prefix (the caller's tmpRootDir already IS the intended write location). Same fence
 * otherwise: rejects .., absolute paths, realpath escape, and symlink leaves on write.
 */
export async function resolveSafeCycleTmpFilePath(
  tmpRootDir: string,
  filename: string,
  opts: ResolveSafeDocPathOptions = {}
): Promise<ResolvedDocPath> {
  const containmentLabel = opts.containmentLabel || 'cycle tmp dir';
  const symlinkRejectMessage = opts.symlinkRejectMessage || 'symlink not allowed for chat-file write';

  const rawInput = String(filename || '').trim();
  if (!rawInput || rawInput.includes('..') || path.isAbsolute(rawInput)) {
    const e: any = new Error('path traversal blocked (invalid characters or relative escape in path)');
    e.code = 'TRAVERSAL';
    throw e;
  }

  const safeRel = path.basename(rawInput.replace(/^\/+/, ''));
  if (!safeRel) {
    const e: any = new Error('path traversal blocked (empty filename)');
    e.code = 'TRAVERSAL';
    throw e;
  }

  await fs.mkdir(tmpRootDir, { recursive: true });

  const full = path.join(tmpRootDir, safeRel);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(tmpRootDir);
  } catch {
    const e: any = new Error('project directory or file not found');
    e.code = 'NOT_FOUND';
    throw e;
  }

  let realFile: string | null = null;
  try {
    realFile = await fs.realpath(full);
  } catch {
    realFile = null;
  }

  if (realFile) {
    if (!containedInRoot(realFile, realRoot)) {
      const e: any = new Error(`path traversal blocked (realpath not contained in ${containmentLabel})`);
      e.code = 'TRAVERSAL';
      throw e;
    }
  } else {
    const parent = path.dirname(full);
    await fs.mkdir(parent, { recursive: true });
    let realParent: string;
    try {
      realParent = await fs.realpath(parent);
    } catch {
      const e: any = new Error('project directory or file not found');
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (!containedInRoot(realParent, realRoot)) {
      const e: any = new Error(`path traversal blocked (parent realpath not contained in ${containmentLabel})`);
      e.code = 'TRAVERSAL';
      throw e;
    }
  }

  try {
    const leaf = await fs.lstat(full);
    if (leaf.isSymbolicLink()) {
      const e: any = new Error(symlinkRejectMessage);
      e.code = 'TRAVERSAL';
      throw e;
    }
  } catch (err: any) {
    if (err?.code === 'TRAVERSAL') throw err;
    if (err?.code !== 'ENOENT') throw err;
  }

  return {
    realRoot,
    full,
    realFile,
    safeRel,
    segments: [safeRel],
    filename: safeRel
  };
}

/**
 * B7-T03: read-only guard for serving an already-saved cycle attachment image back out
 * (e.g. `attachments/mockup.png`). B7-T04 widened it to also allow `mockups/` (approved-mockup
 * deliverables, R-C4) — same fence, same image-extension allowlist, just a second recognized
 * top-level prefix. Rejects `..`, absolute paths, any path outside those two prefixes, non-image
 * extensions, and realpath escape. 404s (NOT_FOUND) if the file doesn't exist.
 */
export async function resolveSafeAttachmentReadPath(
  cycleRootDir: string,
  relPath: string,
  opts: ResolveSafeDocPathOptions = {}
): Promise<ResolvedDocPath> {
  const containmentLabel = opts.containmentLabel || 'cycle dir';

  const rawInput = String(relPath || '').trim();
  if (!rawInput || rawInput.includes('..') || path.isAbsolute(rawInput)) {
    const e: any = new Error('path traversal blocked (invalid characters or relative escape in path)');
    e.code = 'TRAVERSAL';
    throw e;
  }

  const norm = rawInput.replace(/^\/+/, '');
  const ALLOWED_READ_PREFIXES = ['attachments/', 'mockups/'];
  const matchedPrefix = ALLOWED_READ_PREFIXES.find(p => norm.startsWith(p));
  if (!matchedPrefix) {
    const e: any = new Error('only cycle attachments or mockups may be read');
    e.code = 'TRAVERSAL';
    throw e;
  }

  const base = path.basename(norm);
  const ext = path.extname(base).toLowerCase();
  if (!ATTACHMENT_IMAGE_EXTENSIONS.has(ext)) {
    const e: any = new Error('only image attachments are allowed (png, jpg, jpeg, webp, gif)');
    e.code = 'TRAVERSAL';
    throw e;
  }

  const safeRel = path.join(matchedPrefix, base);
  const segments = safeRel.split(/[\\/]+/).filter(Boolean);
  const full = path.join(cycleRootDir, safeRel);

  let realRoot: string;
  try {
    realRoot = await fs.realpath(cycleRootDir);
  } catch {
    const e: any = new Error('project directory or file not found');
    e.code = 'NOT_FOUND';
    throw e;
  }

  let realFile: string | null = null;
  try {
    realFile = await fs.realpath(full);
  } catch {
    const e: any = new Error('attachment not found');
    e.code = 'NOT_FOUND';
    throw e;
  }

  if (!containedInRoot(realFile, realRoot)) {
    const e: any = new Error(`path traversal blocked (realpath not contained in ${containmentLabel})`);
    e.code = 'TRAVERSAL';
    throw e;
  }

  return {
    realRoot,
    full,
    realFile,
    safeRel,
    segments,
    filename: segments[segments.length - 1] || base
  };
}

/**
 * Shared traversal guard for .md read/write/delete under a single containment root.
 * Rejects .., absolute paths, non-.md, realpath escape, and symlink leaves on write/delete.
 */
export async function resolveSafeDocPath(
  rootDir: string,
  relOrFilename: string,
  mode: DocPathMode,
  opts: ResolveSafeDocPathOptions = {}
): Promise<ResolvedDocPath> {
  const containmentLabel = opts.containmentLabel || 'doc root';
  const symlinkRejectMessage = opts.symlinkRejectMessage || 'symlink not allowed for doc write/delete';

  const rawInput = String(relOrFilename || '');
  if (rawInput.includes('..') || path.isAbsolute(rawInput)) {
    const e: any = new Error('path traversal blocked (invalid characters or relative escape in path)');
    e.code = 'TRAVERSAL';
    throw e;
  }

  const raw = rawInput.replace(/^\/+/, '');
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  const safeRel = segments.map(s => path.basename(s)).join(path.sep);
  if (!safeRel.endsWith('.md')) {
    const e: any = new Error('only .md files are allowed');
    e.code = 'TRAVERSAL';
    throw e;
  }

  if (mode === 'write') {
    await fs.mkdir(rootDir, { recursive: true });
  }

  const full = path.join(rootDir, safeRel);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootDir);
  } catch {
    const e: any = new Error('project directory or file not found');
    e.code = 'NOT_FOUND';
    throw e;
  }

  let realFile: string | null = null;
  try {
    realFile = await fs.realpath(full);
  } catch {
    realFile = null;
  }

  if (realFile) {
    if (!containedInRoot(realFile, realRoot)) {
      const e: any = new Error(`path traversal blocked (realpath not contained in ${containmentLabel})`);
      e.code = 'TRAVERSAL';
      throw e;
    }
  } else if (mode === 'read' || mode === 'delete') {
    const e: any = new Error('project directory or file not found');
    e.code = 'NOT_FOUND';
    throw e;
  } else {
    const parent = path.dirname(full);
    await fs.mkdir(parent, { recursive: true });
    let realParent: string;
    try {
      realParent = await fs.realpath(parent);
    } catch {
      const e: any = new Error('project directory or file not found');
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (!containedInRoot(realParent, realRoot)) {
      const e: any = new Error(`path traversal blocked (parent realpath not contained in ${containmentLabel})`);
      e.code = 'TRAVERSAL';
      throw e;
    }
  }

  if (mode === 'write' || mode === 'delete') {
    try {
      const leaf = await fs.lstat(full);
      if (leaf.isSymbolicLink()) {
        const e: any = new Error(symlinkRejectMessage);
        e.code = 'TRAVERSAL';
        throw e;
      }
    } catch (err: any) {
      if (err?.code === 'TRAVERSAL') throw err;
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  return {
    realRoot,
    full,
    realFile,
    safeRel,
    segments,
    filename: segments[segments.length - 1] || safeRel
  };
}

// ─── R7.26 / I11: governed doc write predicates (unit half; wire = B22b) ───────
//
// The Landlock write-fence lets project agents write *inside* the project dir.
// Governing documents live inside that dir. These pure helpers classify and deny
// writes to the four governing paths so an implementer cannot edit its own
// acceptance criteria. B22a = unit; B22b wires into the real agent fence.

/** Stable error code for governed-document write denials (R7.26). */
export const GOVERNED_DOC_CODE = 'GOVERNED_DOC' as const;

/** Cycle-level governing basenames under `plan/<cycle>/`. */
const GOVERNED_CYCLE_BASENAMES = new Set([
  'og-requirements.md',
  'plan.md',
  'topology.yaml',
]);

/**
 * Normalize a project-relative path for classification.
 * - Collapses `\` → `/`, strips empty/`.` segments, rejects absolute and `..`.
 * Throws with code `TRAVERSAL` on invalid input.
 */
export function normalizeProjectRelPath(relPath: string): string {
  const raw = String(relPath ?? '')
    .trim()
    .replace(/\\/g, '/');
  if (!raw) {
    const e: any = new Error('path traversal blocked (empty path)');
    e.code = 'TRAVERSAL';
    throw e;
  }
  if (path.isAbsolute(raw) || raw.startsWith('/')) {
    const e: any = new Error('path traversal blocked (absolute path)');
    e.code = 'TRAVERSAL';
    throw e;
  }
  const segments = raw.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.length === 0) {
    const e: any = new Error('path traversal blocked (empty path)');
    e.code = 'TRAVERSAL';
    throw e;
  }
  if (segments.some((s) => s === '..')) {
    const e: any = new Error('path traversal blocked (relative escape)');
    e.code = 'TRAVERSAL';
    throw e;
  }
  return segments.join('/');
}

/**
 * True when `relPath` is one of the four R7.26 governing documents:
 * - `north-star.md` (project root)
 * - `plan/<cycle>/og-requirements.md`
 * - `plan/<cycle>/plan.md`
 * - `plan/<cycle>/topology.yaml`
 *
 * Invalid paths (absolute, `..`) return false — use `assertProjectWriteAllowed`
 * for fail-closed write checks that also reject traversal.
 */
export function isGovernedDocPath(relPath: string): boolean {
  let n: string;
  try {
    n = normalizeProjectRelPath(relPath);
  } catch {
    return false;
  }
  if (n === 'north-star.md') return true;
  const parts = n.split('/');
  if (parts.length === 3 && parts[0] === 'plan' && parts[1].length > 0) {
    return GOVERNED_CYCLE_BASENAMES.has(parts[2]);
  }
  return false;
}

/**
 * Positive R7.26 allow shape: project-relative path under `src/**`.
 * Invalid paths return false.
 */
export function isSrcWritePath(relPath: string): boolean {
  let n: string;
  try {
    n = normalizeProjectRelPath(relPath);
  } catch {
    return false;
  }
  return n === 'src' || n.startsWith('src/');
}

/**
 * Unit-level write gate for a project-relative path (R7.26).
 * - Traversal / absolute → throws `TRAVERSAL`
 * - Governed doc → throws `GOVERNED_DOC`
 * - Otherwise returns (allow). `src/**` is the documented allow case;
 *   full agent-fence wiring is B22b.
 */
export function assertProjectWriteAllowed(relPath: string): void {
  const n = normalizeProjectRelPath(relPath);
  if (isGovernedDocPath(n)) {
    const e: any = new Error(`governed document write denied: ${n}`);
    e.code = GOVERNED_DOC_CODE;
    throw e;
  }
}

// ─── B22b + S03: userspace fence for plan/<cycle> and Discovery cycle/<folder> docs ───
//
// north-star.md is fenced at the kernel level (tools/helm-sandbox.c omits it from the
// project rw grant by omission). The three plan/<cycle>/{og-requirements.md,plan.md,
// topology.yaml} docs cannot get the same treatment: they are siblings inside a directory
// that must stay open to new-directory creation (every batch creates its own batch-B*/ dir
// there), and Landlock cannot grant "create new siblings here" without also covering the
// existing siblings in the same directory (confirmed by direct testing; see
// plan/c01-agent-studio-rebuild/batch-B22b/changes.md).
//
// Fallback: snapshot these docs' content when a fenced agent session starts, watch them for
// the session's lifetime, and revert any change - recording denial evidence. This is
// detect-and-revert, not prevent-at-write-time: there is a small window (bounded by
// `pollMs`, plus fs.watch's own debounce) where unauthorized content is briefly on disk.
//
// S03: when ChatSessionService passes Discovery phase/role + bound cycleFolder, also guard
// cycle/<folder>/{og-requirements.md,plan.md,plan.json} (create/replace/unlink/rename).
// north-star.md and conversation-log.md under that folder remain writable. Other cycle
// folders and non-Discovery phases are not over-blocked.
//
// S03 fix6 / D-02: FAIL-CLOSED — never write unless path shape is provably safe.
// No-follow lstat every ancestor; containment before ANY write; on failure record denial
// and stop that entry (no unlink/mkdir/write through agent-reshaped paths). The guard is
// unsandboxed; recovery-through-repair is a confused-deputy hazard.

/** Basenames Discovery may not create/replace/unlink/rename under its bound cycle/ folder. */
export const DISCOVERY_FORBIDDEN_CYCLE_DOC_BASENAMES = [
  'og-requirements.md',
  'plan.md',
  'plan.json',
] as const;

const DISCOVERY_FORBIDDEN_CYCLE_DOC_SET = new Set<string>(DISCOVERY_FORBIDDEN_CYCLE_DOC_BASENAMES);

export interface GovernedDocGuardOptions {
  pollMs?: number;
  /** Agent role for the chat session (e.g. `discovery`). */
  role?: string | null;
  /** Active cycle phase (e.g. `discovery`, `planning`). */
  phase?: string | null;
  /** Bound cycle folder_name under `cycle/` — scopes Discovery denials to this folder only. */
  cycleFolder?: string | null;
}

export interface GovernedDocDenialRecord {
  relPath: string;
  absPath: string;
  detectedAt: string;
  attemptedContentSample: string;
  revertedToOriginalSha256: string;
}

export interface GovernedDocGuardHandle {
  /** Denial evidence recorded so far (grows in place for the handle's lifetime). */
  readonly denials: GovernedDocDenialRecord[];
  /** Stop watching and release the fs.watch handles + poll timer. Idempotent. */
  stop(): void;
}

type GuardEntryMode = 'restore' | 'forbid-create';

interface GuardEntry {
  abs: string;
  /** Snapshot bytes for restore mode; empty string for forbid-create. */
  original: string;
  mode: GuardEntryMode;
  /**
   * S03 fix6: after a fail-closed path-shape denial, stop all future mutate attempts
   * for this entry (still observable via denials; no recovery spin).
   */
  dead?: boolean;
}

export type SafeWritePathResult = { ok: true } | { ok: false; reason: string };

/**
 * S03 fix6 / D-02: no-follow ancestor walk + fence containment before any guard write.
 * Pure assertion — never creates, removes, or writes.
 *
 * Every ancestor from `projectDir` to the leaf parent must be a **real directory**
 * (not a symlink, not a file). Relative containment under the fence is required.
 */
export function assertSafeWritePath(
  projectDir: string,
  leafAbs: string
): SafeWritePathResult {
  const fenceRoot = path.resolve(projectDir);
  const leaf = path.resolve(leafAbs);

  const relToFence = path.relative(fenceRoot, leaf);
  if (!relToFence || relToFence.startsWith('..') || path.isAbsolute(relToFence)) {
    return { ok: false, reason: '<outside-fence>' };
  }

  try {
    const rootSt = fsSync.lstatSync(fenceRoot);
    if (rootSt.isSymbolicLink()) return { ok: false, reason: '<symlink-ancestor>' };
    if (!rootSt.isDirectory()) return { ok: false, reason: '<path-unsafe>' };
  } catch (err: any) {
    return { ok: false, reason: `<path-unsafe:${err?.code || 'ERR'}>` };
  }

  const parts = relToFence.split(path.sep).filter((p) => p.length > 0 && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..')) {
    return { ok: false, reason: parts.some((p) => p === '..') ? '<outside-fence>' : '<path-unsafe>' };
  }

  let cur = fenceRoot;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    try {
      const st = fsSync.lstatSync(cur);
      if (st.isSymbolicLink()) return { ok: false, reason: '<symlink-ancestor>' };
      if (!st.isDirectory()) return { ok: false, reason: '<path-unsafe>' };
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        return { ok: false, reason: '<path-unsafe>' };
      }
      if (err?.code === 'EACCES' || err?.code === 'EPERM') {
        return { ok: false, reason: '<parent-unreadable>' };
      }
      return { ok: false, reason: `<path-unsafe:${err?.code || 'ERR'}>` };
    }
  }

  return { ok: true };
}

/** True when role or phase indicates a Discovery-owned chat (case-insensitive). */
export function isDiscoveryDocGuardContext(opts: {
  role?: string | null;
  phase?: string | null;
}): boolean {
  const role = String(opts.role ?? '')
    .trim()
    .toLowerCase();
  const phase = String(opts.phase ?? '')
    .trim()
    .toLowerCase();
  return role === 'discovery' || phase === 'discovery';
}

/**
 * Sanitize a cycle folder_name for path joining. Rejects empty, traversal, and multi-segment names.
 * Returns null when the folder cannot be bound safely.
 */
export function safeCycleFolderName(cycleFolder: string | null | undefined): string | null {
  const raw = String(cycleFolder ?? '').trim();
  if (!raw) return null;
  if (path.isAbsolute(raw) || raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    return null;
  }
  const base = path.basename(raw);
  if (!base || base === '.' || base === '..') return null;
  return base;
}

/**
 * True when `relPath` is a Discovery-forbidden doc under the bound `cycle/<folder>/`.
 * Invalid paths return false.
 */
export function isDiscoveryForbiddenCycleDocPath(
  relPath: string,
  cycleFolder: string | null | undefined
): boolean {
  const folder = safeCycleFolderName(cycleFolder);
  if (!folder) return false;
  let n: string;
  try {
    n = normalizeProjectRelPath(relPath);
  } catch {
    return false;
  }
  const parts = n.split('/');
  return (
    parts.length === 3 &&
    parts[0] === 'cycle' &&
    parts[1] === folder &&
    DISCOVERY_FORBIDDEN_CYCLE_DOC_SET.has(parts[2])
  );
}

/** Existing plan/<cycle>/{og-requirements.md,plan.md,topology.yaml} paths under projectDir. */
function findExistingGovernedPlanDocs(projectDir: string): string[] {
  const planDir = path.join(projectDir, 'plan');
  let cycles: string[];
  try {
    cycles = fsSync
      .readdirSync(planDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const cycle of cycles) {
    for (const basename of GOVERNED_CYCLE_BASENAMES) {
      const abs = path.join(planDir, cycle, basename);
      if (fsSync.existsSync(abs)) found.push(abs);
    }
  }
  return found;
}

/**
 * Discovery-bound cycle/<folder> forbidden paths. Existing files → restore snapshots;
 * missing files → forbid-create (delete if they appear). Only the bound folder is included.
 */
function buildDiscoveryCycleGuardEntries(
  projectDir: string,
  cycleFolder: string
): GuardEntry[] {
  const folder = safeCycleFolderName(cycleFolder);
  if (!folder) return [];
  const cycleDir = path.join(projectDir, 'cycle', folder);
  const entries: GuardEntry[] = [];
  for (const basename of DISCOVERY_FORBIDDEN_CYCLE_DOC_BASENAMES) {
    const abs = path.join(cycleDir, basename);
    if (fsSync.existsSync(abs)) {
      try {
        entries.push({
          abs,
          original: fsSync.readFileSync(abs, 'utf8'),
          mode: 'restore',
        });
      } catch {
        // unreadable at session start — still forbid further creates by treating as forbid-create
        entries.push({ abs, original: '', mode: 'forbid-create' });
      }
    } else {
      entries.push({ abs, original: '', mode: 'forbid-create' });
    }
  }
  return entries;
}

/**
 * Start the userspace guard for a fenced agent session rooted at `projectDir`.
 *
 * Always protects existing legacy `plan/<cycle>/` governed docs (B22b).
 * When `opts` marks a Discovery chat with a bound `cycleFolder`, also prevents
 * create/replace/unlink/rename of that folder's og-requirements.md, plan.md, and plan.json
 * (S03 / AC6). Call `stop()` when the fenced session ends.
 */
export function startGovernedDocGuard(
  projectDir: string,
  opts: GovernedDocGuardOptions = {}
): GovernedDocGuardHandle {
  const pollMs = opts.pollMs ?? 500;
  const denials: GovernedDocDenialRecord[] = [];
  let stopped = false;

  const entries: GuardEntry[] = [];
  for (const abs of findExistingGovernedPlanDocs(projectDir)) {
    try {
      entries.push({ abs, original: fsSync.readFileSync(abs, 'utf8'), mode: 'restore' });
    } catch {
      // unreadable at session start - nothing to protect
    }
  }

  if (isDiscoveryDocGuardContext(opts)) {
    const folder = safeCycleFolderName(opts.cycleFolder);
    if (folder) {
      for (const entry of buildDiscoveryCycleGuardEntries(projectDir, folder)) {
        // Avoid duplicate abs paths if a path somehow overlaps (should not for plan/ vs cycle/).
        if (!entries.some((e) => e.abs === entry.abs)) entries.push(entry);
      }
    }
  }

  const recordDenial = (entry: GuardEntry, attemptedContentSample: string) => {
    denials.push({
      relPath: path.relative(projectDir, entry.abs).split(path.sep).join('/'),
      absPath: entry.abs,
      detectedAt: new Date().toISOString(),
      attemptedContentSample,
      revertedToOriginalSha256: createHash('sha256').update(entry.original, 'utf8').digest('hex'),
    });
  };

  /** Fail-closed: record denial and permanently stop mutate attempts for this entry. */
  const failClosed = (entry: GuardEntry, reason: string): void => {
    recordDenial(entry, reason);
    entry.dead = true;
  };

  type PathKind = 'file' | 'directory' | 'symlink' | 'non-regular';
  type PathProbe =
    | { result: 'missing' }
    | { result: 'access-denied'; code: string }
    | { result: 'parent-not-dir' }
    | { result: 'present'; kind: PathKind };

  const isAccessErrno = (code: unknown): boolean =>
    code === 'EACCES' || code === 'EPERM';

  /**
   * Probe a protected abs with lstat (never follow).
   * ENOENT → missing; ENOTDIR → parent-not-dir; EACCES/EPERM/other → access-denied.
   */
  const probePath = (abs: string): PathProbe => {
    try {
      const st = fsSync.lstatSync(abs);
      if (st.isSymbolicLink()) return { result: 'present', kind: 'symlink' };
      if (st.isDirectory()) return { result: 'present', kind: 'directory' };
      if (st.isFile()) return { result: 'present', kind: 'file' };
      return { result: 'present', kind: 'non-regular' };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { result: 'missing' };
      if (err?.code === 'ENOTDIR') return { result: 'parent-not-dir' };
      return { result: 'access-denied', code: String(err?.code || 'UNKNOWN') };
    }
  };

  const denialSampleForKind = (kind: Exclude<PathKind, 'file'>): string => {
    if (kind === 'directory') return '<directory>';
    if (kind === 'symlink') return '<symlink>';
    return '<non-regular>';
  };

  /**
   * Remove leaf without following symlinks. Caller MUST have passed assertSafeWritePath.
   * Returns null on success, or an error code string on failure (never silent).
   */
  const removeLeafNoFollow = (abs: string): string | null => {
    try {
      const st = fsSync.lstatSync(abs);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        fsSync.rmSync(abs, { recursive: true, force: true });
      } else {
        // file, symlink, fifo — unlink without following
        fsSync.rmSync(abs, { force: true });
      }
      return null;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      return String(err?.code || 'ERR');
    }
  };

  /**
   * After assertSafeWritePath OK: optional parent search-perm repair (mode only, shape already proven),
   * then restore leaf bytes (restore) or ensure absent (forbid-create). Explicit error branches only.
   */
  const safeMutateLeaf = (
    entry: GuardEntry,
    sample: string
  ): void => {
    const gate = assertSafeWritePath(projectDir, entry.abs);
    if (!gate.ok) {
      failClosed(entry, gate.reason);
      return;
    }

    // Parent is a real directory inside the fence — chmod for search is shape-safe (fix3/fix4 class).
    try {
      fsSync.chmodSync(path.dirname(entry.abs), 0o755);
    } catch (err: any) {
      // non-fatal if already searchable; write may still succeed
      if (isAccessErrno(err?.code)) {
        // continue; write path records failure explicitly
      }
    }

    if (entry.mode === 'forbid-create') {
      const rmErr = removeLeafNoFollow(entry.abs);
      if (rmErr) {
        failClosed(entry, `<remove-failed:${rmErr}>`);
        return;
      }
      recordDenial(entry, sample);
      return;
    }

    // restore mode: clear non-file leaf if present, then write original bytes
    const leafProbe = probePath(entry.abs);
    if (leafProbe.result === 'present' && leafProbe.kind !== 'file') {
      const rmErr = removeLeafNoFollow(entry.abs);
      if (rmErr) {
        failClosed(entry, `<remove-failed:${rmErr}>`);
        return;
      }
      // sample for non-regular leaf if caller did not already specialize
      if (sample === '<unreadable>' || sample === '') {
        sample = denialSampleForKind(leafProbe.kind);
      }
    } else if (leafProbe.result === 'present' && leafProbe.kind === 'file') {
      try {
        fsSync.chmodSync(entry.abs, 0o644);
      } catch (err: any) {
        // best-effort; writeFile may still replace via unlink+create if needed
        if (err?.code && !isAccessErrno(err.code) && err.code !== 'ENOENT') {
          failClosed(entry, `<chmod-failed:${err.code}>`);
          return;
        }
      }
    }

    try {
      fsSync.writeFileSync(entry.abs, entry.original, 'utf8');
      recordDenial(entry, sample);
    } catch (err: any) {
      // Last resort on unreadable-but-undeletable file: try unlink then rewrite (parent still safe)
      if (isAccessErrno(err?.code) || err?.code === 'EPERM') {
        const rmErr = removeLeafNoFollow(entry.abs);
        if (rmErr) {
          failClosed(entry, `<restore-failed:${err?.code || rmErr}>`);
          return;
        }
        try {
          fsSync.writeFileSync(entry.abs, entry.original, 'utf8');
          recordDenial(entry, sample || '<unreadable>');
          return;
        } catch (err2: any) {
          failClosed(entry, `<restore-failed:${err2?.code || 'ERR'}>`);
          return;
        }
      }
      failClosed(entry, `<restore-failed:${err?.code || 'ERR'}>`);
    }
  };

  const checkOne = (entry: GuardEntry) => {
    if (stopped || entry.dead) return;

    // D-02: path-shape gate first — never mutate through unsafe ancestors
    const gate = assertSafeWritePath(projectDir, entry.abs);
    if (!gate.ok) {
      // Tamper or anomalous parent shape (symlink ancestor, parent-as-file, missing parent, …)
      failClosed(entry, gate.reason);
      return;
    }

    const probe = probePath(entry.abs);

    // parent-not-dir should already fail gate; belt-and-suspenders
    if (probe.result === 'parent-not-dir') {
      failClosed(entry, '<path-unsafe>');
      return;
    }

    if (probe.result === 'access-denied') {
      // Leaf or intermediate unreadable but ancestors asserted OK → attempt safe restore
      if (entry.mode === 'forbid-create') {
        safeMutateLeaf(entry, isAccessErrno(probe.code) ? '<unreadable>' : '<unreadable>');
        return;
      }
      safeMutateLeaf(entry, isAccessErrno(probe.code) ? '<unreadable>' : '<unreadable>');
      return;
    }

    // non-regular leaf (dir/symlink/fifo) — parent chain safe, remove+restore or remove
    if (probe.result === 'present' && probe.kind !== 'file') {
      safeMutateLeaf(entry, denialSampleForKind(probe.kind));
      return;
    }

    // missing
    if (probe.result === 'missing') {
      if (entry.mode === 'forbid-create') return; // still absent — allowed
      safeMutateLeaf(entry, '');
      return;
    }

    // present regular file — read content
    let current: string;
    try {
      current = fsSync.readFileSync(entry.abs, 'utf8');
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        if (entry.mode === 'forbid-create') return;
        safeMutateLeaf(entry, '');
        return;
      }
      if (err?.code === 'ENOTDIR') {
        failClosed(entry, '<path-unsafe>');
        return;
      }
      // EACCES/EPERM leaf (chmod 0) — shape OK, safe restore
      safeMutateLeaf(entry, '<unreadable>');
      return;
    }

    if (entry.mode === 'forbid-create') {
      safeMutateLeaf(entry, current.slice(0, 500));
      return;
    }

    // restore mode: content mismatch
    if (current !== entry.original) {
      safeMutateLeaf(entry, current.slice(0, 500));
    }
  };

  const watchers: fsSync.FSWatcher[] = [];
  const entriesByDir = new Map<string, GuardEntry[]>();
  for (const entry of entries) {
    const dir = path.dirname(entry.abs);
    const list = entriesByDir.get(dir) ?? [];
    list.push(entry);
    entriesByDir.set(dir, list);
  }
  for (const entry of entries) {
    if (entry.mode === 'forbid-create') continue; // no inode yet; dir watch + poll cover creates
    try {
      watchers.push(
        fsSync.watch(entry.abs, { persistent: false }, () => {
          setTimeout(() => checkOne(entry), 20);
        })
      );
    } catch {
      // best-effort; the poll loop below still covers it
    }
  }
  for (const [dir, dirEntries] of entriesByDir) {
    // FIX1: also watch the containing directory, not just each file's own inode — unlink/rename
    // (and S03 create of a missing forbidden basename) fire directory-level events. The poll
    // loop below remains the last-resort fallback for both watch kinds.
    try {
      if (!fsSync.existsSync(dir)) continue;
      watchers.push(
        fsSync.watch(dir, { persistent: false }, () => {
          setTimeout(() => dirEntries.forEach(checkOne), 20);
        })
      );
    } catch {
      // best-effort; the poll loop below still covers it
    }
  }

  const interval = setInterval(() => entries.forEach(checkOne), pollMs);
  if (typeof interval.unref === 'function') interval.unref();

  return {
    denials,
    stop(): void {
      stopped = true;
      clearInterval(interval);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
    },
  };
}