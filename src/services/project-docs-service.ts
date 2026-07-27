import { ProjectService } from './project-service.js';
import { loadConfig } from '../config/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  containedInRoot,
  resolveSafeDocPath,
  type DocPathMode
} from './doc-path-guard.js';

export interface ProjectDocMeta {
  filename: string;
  size: number;
  description: string;
}

export interface ProjectDoc {
  filename: string;
  content: string;
  size: number;
  description: string;
}

export interface TechStackSummary {
  language: string | null;
  framework: string | null;
  key_dependencies: string | null;
}

interface ResolvedProjectDocPath {
  projectDir: string;
  realRoot: string;
  full: string;
  realFile: string | null;
  safeRel: string;
  segments: string[];
  filename: string;
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

function normalizeHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanValueLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

function extractSectionValues(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      const headingText = heading[1].trim();
      const inline = headingText.match(/^([^:]+):\s*(.+)$/);
      current = normalizeHeading(inline ? inline[1] : headingText);
      if (inline && inline[2].trim()) {
        (sections[current] ||= []).push(cleanValueLine(inline[2]));
      } else {
        sections[current] ||= [];
      }
      continue;
    }
    if (!current) continue;
    const value = cleanValueLine(line);
    if (value) sections[current].push(value);
  }
  return sections;
}

function firstValue(sections: Record<string, string[]>, key: string): string | null {
  const values = sections[key] || [];
  return values[0] || null;
}

function joinedValues(sections: Record<string, string[]>, key: string): string | null {
  const values = sections[key] || [];
  return values.length ? values.slice(0, 5).join(', ') : null;
}

export function extractTechStackSummary(text: string): TechStackSummary {
  const sections = extractSectionValues(text);
  return {
    language: firstValue(sections, 'language'),
    framework: firstValue(sections, 'framework'),
    key_dependencies: joinedValues(sections, 'key dependencies')
  };
}

export class ProjectDocsService {
  constructor(private readonly projectService: ProjectService) {}

  private async getProjectDir(projectId: number): Promise<string> {
    const p = this.projectService.getProject(projectId);
    if (!p) throw new Error('unknown project');
    return p.directory;
  }

  /**
   * Shared path guard for read/write/delete. Traversal + .md + realpath containment.
   * Read: containment root = project dir. Write/delete: containment root = helm_docs/ only.
   */
  private async resolveProjectDocPath(
    projectId: number,
    relOrFilename: string,
    mode: DocPathMode,
    containmentSubdir: '' | 'helm_docs' = ''
  ): Promise<ResolvedProjectDocPath> {
    const projectDir = await this.getProjectDir(projectId);
    const rawInput = String(relOrFilename || '');
    if (rawInput.includes('..') || path.isAbsolute(rawInput)) {
      const e: any = new Error('path traversal blocked (invalid characters or relative escape in path)');
      e.code = 'TRAVERSAL';
      throw e;
    }
    let raw = rawInput.replace(/^\/+/, '');
    if (containmentSubdir === 'helm_docs') {
      raw = raw.replace(/^helm_docs[\\/]+/i, '');
      if (!raw) {
        const e: any = new Error('path traversal blocked (empty path under helm_docs)');
        e.code = 'TRAVERSAL';
        throw e;
      }
    }
    const rootPath = containmentSubdir ? path.join(projectDir, containmentSubdir) : projectDir;
    const containmentLabel = containmentSubdir === 'helm_docs' ? 'helm_docs dir' : 'project dir';
    const resolved = await resolveSafeDocPath(rootPath, raw, mode, {
      containmentLabel,
      symlinkRejectMessage: 'symlink not allowed for helm_docs write/delete'
    });
    return {
      projectDir,
      realRoot: resolved.realRoot,
      full: resolved.full,
      realFile: resolved.realFile,
      safeRel: resolved.safeRel,
      segments: resolved.segments,
      filename: resolved.filename
    };
  }

  async listProjectDocs(projectId: number): Promise<ProjectDocMeta[]> {
    let dir: string;
    try {
      dir = await this.getProjectDir(projectId);
    } catch {
      return [];
    }
    let entries: any[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: ProjectDocMeta[] = [];
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
      const full = path.join(dir, ent.name);
      try {
        const st = await fs.stat(full);
        const content = await fs.readFile(full, 'utf8');
        out.push({
          filename: ent.name,
          size: st.size,
          description: extractDescription(content)
        });
      } catch {}
    }
    out.sort((a, b) => a.filename.localeCompare(b.filename));
    return out;
  }

  async readProjectDoc(projectId: number, relOrFilename: string): Promise<ProjectDoc> {
    const resolved = await this.resolveProjectDocPath(projectId, relOrFilename, 'read', '');
    const realFile = resolved.realFile!;
    const content = await fs.readFile(realFile, 'utf8');
    const st = await fs.stat(realFile);
    return {
      filename: resolved.filename,
      content,
      size: st.size,
      description: extractDescription(content)
    };
  }

  async writeProjectDoc(projectId: number, relOrFilename: string, content: string): Promise<ProjectDoc> {
    const max = (loadConfig() as any).PROJECT_DOC_BODY_MAX || 1048576;
    const bytes = Buffer.byteLength(String(content ?? ''), 'utf8');
    if (bytes > max) {
      const e: any = new Error('content too large');
      e.code = 'TOO_LARGE';
      throw e;
    }
    const resolved = await this.resolveProjectDocPath(projectId, relOrFilename, 'write', 'helm_docs');
    const writePath = resolved.realFile || resolved.full;
    const parent = path.dirname(writePath);
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(writePath, String(content), 'utf8');
    const realFile = await fs.realpath(writePath);
    if (!containedInRoot(realFile, resolved.realRoot)) {
      try { await fs.unlink(writePath); } catch {}
      const e: any = new Error('path traversal blocked (post-write realpath not contained in helm_docs dir)');
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

  async deleteProjectDoc(projectId: number, relOrFilename: string): Promise<void> {
    const resolved = await this.resolveProjectDocPath(projectId, relOrFilename, 'delete', 'helm_docs');
    await fs.unlink(resolved.realFile!);
  }

  async getTechStackSummary(projectId: number): Promise<TechStackSummary | null> {
    try {
      const doc = await this.readProjectDoc(projectId, 'helm_docs/tech-stack.md');
      return extractTechStackSummary(doc.content);
    } catch (e: any) {
      if (e?.code === 'NOT_FOUND' || e?.code === 'TRAVERSAL') return null;
      throw e;
    }
  }

  // B11 UI2: recursive .md tree under project dir (supports project-task/run/ subfolders etc).
  // Returns flat list with relPath for client tree render + indent. .md only, same containment.
  // E-b1: node_modules / vendor dirs are always excluded from recursion (scoped helm_tasks tree for Documents).
  async listProjectMdTree(projectId: number, baseRel: string = ''): Promise<Array<ProjectDocMeta & { relPath: string }>> {
    const dir = await this.getProjectDir(projectId);
    const base = String(baseRel || '').replace(/^\/+/, '').replace(/\.\.+/g, '.');
    const start = base ? path.join(dir, base) : dir;
    const out: Array<ProjectDocMeta & { relPath: string }> = [];
    const EXCLUDE_DIRS = ['node_modules', 'vendor'];
    const walk = async (currentAbs: string, currentRel: string) => {
      let ents: any[];
      try { ents = await fs.readdir(currentAbs, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (ent.isDirectory() && EXCLUDE_DIRS.includes(ent.name)) continue;
        const childAbs = path.join(currentAbs, ent.name);
        const childRel = currentRel ? path.join(currentRel, ent.name) : ent.name;
        if (ent.isDirectory()) {
          // recurse (no limit depth for project docs; realpath guards below)
          await walk(childAbs, childRel);
        } else if (ent.isFile() && ent.name.endsWith('.md')) {
          try {
            const st = await fs.stat(childAbs);
            const content = await fs.readFile(childAbs, 'utf8');
            const [rDir, rFile] = await Promise.all([
              fs.realpath(dir),
              fs.realpath(childAbs).catch(() => null)
            ]);
            if (rFile && (rFile.startsWith(rDir + path.sep) || rFile === rDir)) {
              out.push({
                filename: ent.name,
                relPath: childRel,
                size: st.size,
                description: extractDescription(content)
              });
            }
          } catch {}
        }
      }
    };
    await walk(start, base);
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return out;
  }

  // E-b1: server-scoped helm_tasks/ tree only. Starts under <proj>/helm_tasks (if exists).
  // relPath always includes helm_tasks/ prefix (for view/read subpath + grouping).
  // node_modules / vendor excluded anywhere under. Returns [] if no helm_tasks dir.
  async listProjectHelmTasksMdTree(projectId: number): Promise<Array<ProjectDocMeta & { relPath: string }>> {
    const dir = await this.getProjectDir(projectId);
    const helmRoot = path.join(dir, 'helm_tasks');
    const out: Array<ProjectDocMeta & { relPath: string }> = [];
    const EXCLUDE_DIRS = ['node_modules', 'vendor'];
    let rootExists = false;
    try {
      const st = await fs.stat(helmRoot);
      rootExists = st.isDirectory();
    } catch { return []; }
    if (!rootExists) return [];
    const walk = async (currentAbs: string, currentRelFromHelm: string) => {
      let ents: any[];
      try { ents = await fs.readdir(currentAbs, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        if (ent.isDirectory() && EXCLUDE_DIRS.includes(ent.name)) continue;
        const childAbs = path.join(currentAbs, ent.name);
        const childRelFromHelm = currentRelFromHelm ? path.join(currentRelFromHelm, ent.name) : ent.name;
        const fullRel = currentRelFromHelm ? path.join('helm_tasks', currentRelFromHelm, ent.name) : path.join('helm_tasks', ent.name);
        if (ent.isDirectory()) {
          await walk(childAbs, childRelFromHelm);
        } else if (ent.isFile() && ent.name.endsWith('.md')) {
          try {
            const st = await fs.stat(childAbs);
            const content = await fs.readFile(childAbs, 'utf8');
            const [rDir, rFile] = await Promise.all([
              fs.realpath(dir),
              fs.realpath(childAbs).catch(() => null)
            ]);
            if (rFile && (rFile.startsWith(rDir + path.sep) || rFile === rDir)) {
              out.push({
                filename: ent.name,
                relPath: fullRel,
                size: st.size,
                description: extractDescription(content)
              });
            }
          } catch {}
        }
      }
    };
    await walk(helmRoot, '');
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return out;
  }

  async scaffoldProjectFolders(directory: string): Promise<void> {
    if (!directory) return;
    const helmDocs = path.join(directory, 'helm_docs');
    const helmTasks = path.join(directory, 'helm_tasks');
    await fs.mkdir(helmDocs, { recursive: true });
    await fs.mkdir(helmTasks, { recursive: true });
    const stubs: Array<{ name: string; content: string }> = [
      { name: 'tech-stack.md',  content: '# Tech Stack\n\n## Language\n\n## Framework\n\n## Key Dependencies\n' },
      { name: 'overview.md',    content: '# Project Overview\n\n## Purpose\n\n## Goals\n\n## Architecture\n' },
      { name: 'specs.md',       content: '# Specifications\n\n## Features\n\n## Requirements\n\n## Constraints\n' },
      { name: 'preferences.md', content: "# Preferences & Standards\n\n## Code Style\n\n## Conventions\n\n## Do's and Don'ts\n" },
    ];
    for (const stub of stubs) {
      const fp = path.join(helmDocs, stub.name);
      try { await fs.access(fp); } catch { await fs.writeFile(fp, stub.content, 'utf8'); }
    }
    await this.scaffoldProjectGitignore(directory);
  }

  /**
   * B7 (R6.27): idempotently ensure the project's own .gitignore carries a `tmp/` entry — the
   * cycle chat-file writer's scratch root (project.directory/tmp/<cycle-folder>) must never be
   * committed. No existing .gitignore -> create one with just `tmp/`. Existing .gitignore -> append
   * `tmp/` ONLY if no line already ignores it, preserving every existing line untouched (never
   * overwrites, never duplicates on repeat scaffold calls).
   */
  private async scaffoldProjectGitignore(directory: string): Promise<void> {
    const fp = path.join(directory, '.gitignore');
    let existing: string | null = null;
    try {
      existing = await fs.readFile(fp, 'utf8');
    } catch {
      existing = null;
    }
    if (existing == null) {
      await fs.writeFile(fp, 'tmp/\n', 'utf8');
      return;
    }
    const alreadyIgnored = existing
      .split(/\r?\n/)
      .some((line) => {
        const t = line.trim();
        return t === 'tmp/' || t === 'tmp' || t === '/tmp/' || t === '/tmp';
      });
    if (alreadyIgnored) return;
    const needsNewline = existing.length > 0 && !existing.endsWith('\n');
    await fs.writeFile(fp, existing + (needsNewline ? '\n' : '') + 'tmp/\n', 'utf8');
  }
}