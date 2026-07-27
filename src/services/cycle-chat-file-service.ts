import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/config.js';
import { CycleService } from './cycle-service.js';
import { containedInRoot, resolveSafeCycleTmpFilePath } from './doc-path-guard.js';

// B7 (R6.27 backend/scaffold): path-safe cycle chat-file writer under
// <project.directory>/tmp/<cycle-folder>/<filename> for text, files and images pasted into a
// Discovery chat composer (B8 wires the UI half). Rejects traversal, symlinks, oversize payloads,
// and — unlike CycleDocsService.saveCycleAttachment's auto-rename — a filename COLLISION outright,
// since a deterministic paste-generated name colliding means the caller must pick a new one, not
// silently receive a different (renamed) file than the one it thinks it just saved.
// Never OS /tmp: a reboot wiped /tmp/helm-harness and crash-looped Helm 1.38M times — the writer is
// always rooted under the project's OWN directory via CycleService.getCycleTmpDir.

export interface CycleChatFileResult {
  /** Project-relative reference (e.g. "tmp/myproj_0727/pasted-note.txt"), forward-slash joined. */
  path: string;
  size: number;
}

export class CycleChatFileService {
  constructor(private readonly cycleService: CycleService) {}

  async saveCycleChatFile(cycleId: number, filename: string, content: string | Buffer): Promise<CycleChatFileResult> {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
    if (bytes.length === 0) {
      const e: any = new Error('chat-file content required');
      e.code = 'INVALID';
      throw e;
    }
    const max = (loadConfig() as any).PROJECT_DOC_BODY_MAX || 1048576;
    if (bytes.length > max) {
      const e: any = new Error('chat-file too large');
      e.code = 'TOO_LARGE';
      throw e;
    }

    const tmpRootDir = this.cycleService.getCycleTmpDir(cycleId);
    const resolved = await resolveSafeCycleTmpFilePath(tmpRootDir, filename, {
      containmentLabel: 'cycle tmp dir',
      symlinkRejectMessage: 'symlink not allowed for chat-file write'
    });

    // Reject on collision — never overwrite, never silently auto-rename (the caller's own
    // deterministic filename policy, e.g. B8's paste-text naming, decides what to do next).
    try {
      await fs.access(resolved.full);
      const e: any = new Error(`chat-file already exists: ${resolved.filename}`);
      e.code = 'CONFLICT';
      throw e;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    await fs.mkdir(path.dirname(resolved.full), { recursive: true });
    await fs.writeFile(resolved.full, bytes);
    const realFile = await fs.realpath(resolved.full);
    if (!containedInRoot(realFile, resolved.realRoot)) {
      try { await fs.unlink(resolved.full); } catch {}
      const e: any = new Error('path traversal blocked (post-write realpath not contained in cycle tmp dir)');
      e.code = 'TRAVERSAL';
      throw e;
    }

    const st = await fs.stat(realFile);
    // tmpRootDir is always exactly <project.directory>/tmp/<folder_name> (getCycleTmpDir's own
    // contract) — two dirnames up from it is the project root, giving the PROJECT-relative
    // reference the brief calls for ("tmp/<folder_name>/<filename>"), not the cycle-relative shape
    // CycleDocsService's sibling methods return.
    const projectDir = path.dirname(path.dirname(tmpRootDir));
    const projectRelative = path.relative(projectDir, resolved.full).split(path.sep).join('/');
    return { path: projectRelative, size: st.size };
  }
}
