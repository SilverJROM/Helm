import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * B10-T06: Pure discovery for DEV deploy config.
 * Prefers project.dev_url presence.
 * Reads the *project's own* project_specs.md (if present) for its documented DEV deploy command.
 * Never invents commands. Returns nulls when not discoverable.
 */
export interface DeployConfig {
  devUrl: string | null;
  deployCmd: string | null;
}

export async function discoverDevDeployConfig(
  projectDir: string | null,
  devUrl: string | null
): Promise<DeployConfig> {
  if (!devUrl) {
    return { devUrl: null, deployCmd: null };
  }

  let deployCmd: string | null = null;

  if (projectDir) {
    try {
      const specsPath = path.join(projectDir, 'project_specs.md');
      const content = await fs.readFile(specsPath, 'utf8');
      // Minimal, robust scan for the documented DEV deploy convention.
      // Matches lines like:
      //   **DEV deploy (autonomous-OK):** `npm run build && pm2 restart helm`
      //   DEV deploy: npm run build && pm2 restart helm
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        if (/DEV\s*deploy/i.test(line)) {
          // Extract after the first ':' 
          const m = line.match(/:\s*`?(.+?)`?\s*$/);
          if (m && m[1]) {
            deployCmd = m[1].trim();
            break;
          }
          // Fallback: take everything after "DEV deploy" phrase
          const m2 = line.match(/DEV\s*deploy[^:]*:\s*(.+)$/i);
          if (m2 && m2[1]) {
            deployCmd = m2[1].replace(/`/g, '').trim();
            break;
          }
        }
      }
    } catch {
      // No project_specs.md or unreadable — that's fine; devUrl alone is not sufficient per spec
    }
  }

  return { devUrl, deployCmd };
}

export interface DeployResult {
  success: boolean;
  note: string;
}

export interface DeployRunner {
  runDeploy(projectDir: string, deployCmd: string, devUrl: string): Promise<DeployResult>;
}

/**
 * Real runner — executes ONLY the operator-supplied discovered deployCmd in the project's dir.
 * Reinforcement: never called from tests (fake must be injected).
 */
export function createRealDeployRunner(): DeployRunner {
  const execP = promisify(execFile);
  return {
    async runDeploy(projectDir: string, deployCmd: string, devUrl: string): Promise<DeployResult> {
      if (!deployCmd || !projectDir) {
        return { success: false, note: 'no deployCmd or projectDir' };
      }
      try {
        // Use sh -c so complex shell pipelines from project_specs work ("&&", etc.)
        // We run exactly the discovered cmd — no additions.
        const { stdout, stderr } = await execP('sh', ['-c', deployCmd], {
          cwd: projectDir,
          timeout: 180_000,
          maxBuffer: 1024 * 1024 * 2
        });
        return {
          success: true,
          note: `DEV deploy completed for ${devUrl}\n${stdout}${stderr ? '\n' + stderr : ''}`
        };
      } catch (e: any) {
        return {
          success: false,
          note: `DEV deploy failed for ${devUrl}: ${e?.message || e}\n${e?.stdout || ''}${e?.stderr || ''}`
        };
      }
    }
  };
}
