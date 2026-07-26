import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * B11-T02: Pure discovery for Final Tests config (local smoke + authoritative DEV e2e).
 * Mirrors B10-T06 discoverDevDeployConfig exactly.
 * Prefers project.dev_url presence.
 * Reads the *project's own* project_specs.md (if present) for documented
 * "local smoke" and "DEV e2e" commands (conventions per R-G1/R-G4).
 * Never invents commands. Returns nulls when not discoverable.
 */
export interface FinalTestConfig {
  devUrl: string | null;
  smokeCmd: string | null;
  e2eCmd: string | null;
}

export async function discoverFinalTestConfig(
  projectDir: string | null,
  devUrl: string | null
): Promise<FinalTestConfig> {
  if (!devUrl) {
    return { devUrl: null, smokeCmd: null, e2eCmd: null };
  }

  let smokeCmd: string | null = null;
  let e2eCmd: string | null = null;

  if (projectDir) {
    try {
      const specsPath = path.join(projectDir, 'project_specs.md');
      const content = await fs.readFile(specsPath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        // Match local smoke conventions (similar to DEV deploy scan)
        if (!smokeCmd && /local smoke|smoke cmd|smoke:/i.test(line)) {
          const m = line.match(/:\s*`?(.+?)`?\s*$/);
          if (m && m[1]) {
            smokeCmd = m[1].trim();
            continue;
          }
          const m2 = line.match(/(?:local smoke|smoke)[^:]*:\s*(.+)$/i);
          if (m2 && m2[1]) {
            smokeCmd = m2[1].replace(/`/g, '').trim();
            continue;
          }
        }
        // Match DEV e2e / authoritative full e2e conventions
        if (!e2eCmd && /dev e2e|e2e on dev|authoritative.*e2e|full e2e|final.*e2e/i.test(line)) {
          const m = line.match(/:\s*`?(.+?)`?\s*$/);
          if (m && m[1]) {
            e2eCmd = m[1].trim();
            continue;
          }
          const m2 = line.match(/(?:dev e2e|e2e|final tests? e2e)[^:]*:\s*(.+)$/i);
          if (m2 && m2[1]) {
            e2eCmd = m2[1].replace(/`/g, '').trim();
            continue;
          }
        }
      }
    } catch {
      // No project_specs.md or unreadable — devUrl alone is not sufficient per spec
    }
  }

  return { devUrl, smokeCmd, e2eCmd };
}

export interface TestResult {
  success: boolean;
  note: string;
}

export interface TestRunner {
  runTest(projectDir: string, cmd: string, kind: 'smoke' | 'e2e', devUrl: string): Promise<TestResult>;
}

/**
 * Real runner — executes ONLY the operator-supplied discovered cmd in the project's dir.
 * Reinforcement: never called from tests (fake must be injected).
 * Smoke is fast pre-check; e2e is authoritative (on DEV URL).
 */
export function createRealTestRunner(): TestRunner {
  const execP = promisify(execFile);
  return {
    async runTest(projectDir: string, cmd: string, kind: 'smoke' | 'e2e', devUrl: string): Promise<TestResult> {
      if (!cmd || !projectDir) {
        return { success: false, note: 'no cmd or projectDir' };
      }
      try {
        // Use sh -c so complex shell pipelines from project_specs work ("&&", etc.)
        // We run exactly the discovered cmd — no additions.
        const timeout = kind === 'smoke' ? 120_000 : 300_000;
        const { stdout, stderr } = await execP('sh', ['-c', cmd], {
          cwd: projectDir,
          timeout,
          maxBuffer: 1024 * 1024 * 2
        });
        return {
          success: true,
          note: `${kind.toUpperCase()} completed for ${devUrl}\n${stdout}${stderr ? '\n' + stderr : ''}`
        };
      } catch (e: any) {
        return {
          success: false,
          note: `${kind.toUpperCase()} failed for ${devUrl}: ${e?.message || e}\n${e?.stdout || ''}${e?.stderr || ''}`
        };
      }
    }
  };
}
