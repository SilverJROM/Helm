import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/config.js';
import { CycleService } from './cycle-service.js';
import { containedInRoot, resolveSafeAttachmentPath, resolveSafeAttachmentReadPath, resolveSafeDocPath } from './doc-path-guard.js';
import { parseExecutionPlan } from './execution-plan-parser.js';
import { assertLegacyFallbackAllowed, CANONICAL_CYCLE_ARTIFACTS, resolveCycleArtifactCanonicalRead, resolveCycleArtifactWrite } from './cycle-artifact-paths.js';

export interface CycleDoc {
  filename: string;
  content: string;
  size: number;
  description: string;
  valid?: boolean;
  warning?: string;
}

export interface CycleArtifactItem {
  name: string;
  path: string;
}

export interface CycleArtifactsListing {
  docs: CycleArtifactItem[];
  images: CycleArtifactItem[];
  flow: CycleArtifactItem[];
  other: CycleArtifactItem[];
}

const FLOW_BASENAME = /^flow_\d+\./i;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function posixRel(rootDir: string, absPath: string): string {
  return path.relative(rootDir, absPath).split(path.sep).join('/');
}

function categorizeArtifact(relPath: string, basename: string): keyof CycleArtifactsListing {
  if (FLOW_BASENAME.test(basename)) return 'flow';
  const ext = path.extname(basename).toLowerCase();
  const posix = relPath.replace(/\\/g, '/');
  if (/^(attachments|mockups)\//.test(posix) && IMAGE_EXTENSIONS.has(ext)) return 'images';
  if (ext === '.md') return 'docs';
  return 'other';
}

async function walkContainedFiles(realRoot: string, dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return files;
    throw err;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let realFull: string;
    try {
      realFull = await fs.realpath(full);
    } catch {
      continue;
    }
    if (!containedInRoot(realFull, realRoot)) continue;
    if (ent.isDirectory()) {
      files.push(...await walkContainedFiles(realRoot, realFull));
    } else if (ent.isFile()) {
      files.push(realFull);
    }
  }
  return files;
}

function extractDescription(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('#')) line = line.replace(/^#+\s*/, '');
    if (line) return line.slice(0, 200);
  }
  return '—';
}

export class CycleDocsService {
  constructor(private readonly cycleService: CycleService, private readonly now: () => Date = () => new Date()) {}

  async readCycleDoc(cycleId: number, relOrFilename: string): Promise<CycleDoc> {
    const rootDir = this.cycleService.getCycleDocDir(cycleId);
    const artifact = resolveCycleArtifactCanonicalRead(relOrFilename, this.now());
    let resolved;
    let usedLegacyFallback = false;
    try {
      resolved = await resolveSafeDocPath(rootDir, artifact.filename, 'read', { containmentLabel: 'cycle dir' });
    } catch (error: any) {
      if (!artifact.legacyFilename || error?.code !== 'NOT_FOUND') throw error;
      assertLegacyFallbackAllowed(artifact.legacyFilename, artifact.filename, this.now());
      resolved = await resolveSafeDocPath(rootDir, artifact.legacyFilename, 'read', { containmentLabel: 'cycle dir' });
      usedLegacyFallback = true;
    }
    const realFile = resolved.realFile!;
    const content = await fs.readFile(realFile, 'utf8');
    const st = await fs.stat(realFile);
    const doc: CycleDoc = {
      filename: resolved.filename,
      content,
      size: st.size,
      description: extractDescription(content),
      warning: artifact.warning ?? (usedLegacyFallback ? `${artifact.legacyFilename} is a read-only legacy alias for ${artifact.filename}; it expires 2026-10-10T00:00:00.000Z` : undefined),
    };
    if (artifact.filename === CANONICAL_CYCLE_ARTIFACTS.plan) {
      doc.valid = parseExecutionPlan(content).ok;
    }
    return doc;
  }

  async writeCycleDoc(cycleId: number, relOrFilename: string, content: string): Promise<CycleDoc> {
    const max = (loadConfig() as any).PROJECT_DOC_BODY_MAX || 1048576;
    const bytes = Buffer.byteLength(String(content ?? ''), 'utf8');
    if (bytes > max) {
      const e: any = new Error('content too large');
      e.code = 'TOO_LARGE';
      throw e;
    }

    const rootDir = this.cycleService.getCycleDocDir(cycleId);
    const filename = resolveCycleArtifactWrite(relOrFilename);
    const resolved = await resolveSafeDocPath(rootDir, filename, 'write', {
      containmentLabel: 'cycle dir',
      symlinkRejectMessage: 'symlink not allowed for cycle doc write/delete'
    });
    if (path.basename(resolved.filename) === CANONICAL_CYCLE_ARTIFACTS.plan) {
      const validation = parseExecutionPlan(String(content));
      if (!validation.ok) {
        const e: any = new Error('execution plan validation failed');
        e.code = 'INVALID_EXECUTION_PLAN';
        e.errors = validation.errors;
        throw e;
      }
    }

    const writePath = resolved.realFile || resolved.full;
    const parent = path.dirname(writePath);
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(writePath, String(content), 'utf8');
    const realFile = await fs.realpath(writePath);
    if (!containedInRoot(realFile, resolved.realRoot)) {
      try { await fs.unlink(writePath); } catch {}
      const e: any = new Error('path traversal blocked (post-write realpath not contained in cycle dir)');
      e.code = 'TRAVERSAL';
      throw e;
    }
    const st = await fs.stat(realFile);
    return {
      filename: resolved.filename,
      content: String(content),
      size: st.size,
      description: extractDescription(String(content))
    };
  }

  async saveCycleAttachment(cycleId: number, filename: string, bytes: Buffer): Promise<{ path: string }> {
    const max = (loadConfig() as any).PROJECT_DOC_BODY_MAX || 1048576;
    if (!bytes || bytes.length === 0) {
      const e: any = new Error('attachment content required');
      e.code = 'INVALID';
      throw e;
    }
    if (bytes.length > max) {
      const e: any = new Error('attachment too large');
      e.code = 'TOO_LARGE';
      throw e;
    }

    const rootDir = this.cycleService.getCycleDocDir(cycleId);
    const original = path.basename(String(filename || '').trim());
    const stem = path.basename(original, path.extname(original));
    const ext = path.extname(original);

    for (let suffix = 0; suffix < 1000; suffix++) {
      const candidate = suffix === 0 ? original : `${stem}_${suffix}${ext}`;
      const resolved = await resolveSafeAttachmentPath(rootDir, candidate, {
        containmentLabel: 'cycle dir',
        symlinkRejectMessage: 'symlink not allowed for attachment write'
      });
      try {
        await fs.access(resolved.full);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
        await fs.mkdir(path.dirname(resolved.full), { recursive: true });
        await fs.writeFile(resolved.full, bytes);
        const realFile = await fs.realpath(resolved.full);
        if (!containedInRoot(realFile, resolved.realRoot)) {
          try { await fs.unlink(resolved.full); } catch {}
          const e: any = new Error('path traversal blocked (post-write realpath not contained in cycle dir)');
          e.code = 'TRAVERSAL';
          throw e;
        }
        return { path: resolved.safeRel.split(path.sep).join('/') };
      }
    }

    const e: any = new Error('too many duplicate attachment names');
    e.code = 'CONFLICT';
    throw e;
  }

  /** B7-T03: read back the raw bytes of an already-saved cycle attachment or mockup image (traversal-guarded, attachments/ or mockups/ only — B7-T04 widened the prefix). */
  async readCycleAttachmentImage(cycleId: number, relPath: string): Promise<{ bytes: Buffer; ext: string; filename: string }> {
    const rootDir = this.cycleService.getCycleDocDir(cycleId);
    const resolved = await resolveSafeAttachmentReadPath(rootDir, relPath, { containmentLabel: 'cycle dir' });
    const bytes = await fs.readFile(resolved.realFile!);
    return { bytes, ext: path.extname(resolved.filename).toLowerCase(), filename: resolved.filename };
  }

  /** B3-T03: categorized listing of cycle folder artifacts (read-only, fence-contained). */
  async listCycleArtifacts(cycleId: number): Promise<CycleArtifactsListing> {
    const empty: CycleArtifactsListing = { docs: [], images: [], flow: [], other: [] };
    const rootDir = this.cycleService.getCycleDocDir(cycleId);
    let realRoot: string;
    try {
      realRoot = await fs.realpath(rootDir);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return empty;
      throw err;
    }

    const absFiles = await walkContainedFiles(realRoot, realRoot);
    const result: CycleArtifactsListing = { docs: [], images: [], flow: [], other: [] };

    for (const abs of absFiles) {
      const rel = posixRel(realRoot, abs);
      const name = path.basename(abs);
      result[categorizeArtifact(rel, name)].push({ name, path: rel });
    }

    for (const key of Object.keys(result) as (keyof CycleArtifactsListing)[]) {
      result[key].sort((a, b) => a.path.localeCompare(b.path));
    }

    return result;
  }
}
