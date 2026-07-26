import fs from 'node:fs/promises';
import path from 'node:path';

export const CANONICAL_CYCLE_ARTIFACTS = {
  northStar: 'north-star.md',
  requirements: 'og-requirements.md',
  plan: 'plan.md',
} as const;

export const CANONICAL_CYCLE_ARTIFACT_FILES = Object.values(CANONICAL_CYCLE_ARTIFACTS);

export const LEGACY_CYCLE_ALIAS_EXPIRES_AT = '2026-10-10T00:00:00.000Z';

const LEGACY_CYCLE_ALIASES: Record<string, string> = {
  'north_star.md': CANONICAL_CYCLE_ARTIFACTS.northStar,
  'og_req.md': CANONICAL_CYCLE_ARTIFACTS.requirements,
  'execution_plan.md': CANONICAL_CYCLE_ARTIFACTS.plan,
};

const CANONICAL_CYCLE_ALIASES = Object.fromEntries(
  Object.entries(LEGACY_CYCLE_ALIASES).map(([legacy, canonical]) => [canonical, legacy]),
);

export interface CycleArtifactReadResolution {
  filename: string;
  legacyFilename?: string;
  warning?: string;
}

function legacyAliasError(code: 'LEGACY_ALIAS_EXPIRED' | 'LEGACY_ALIAS_READ_ONLY', message: string): Error {
  const error: any = new Error(message);
  error.code = code;
  return error;
}

function legacyWarning(legacyFilename: string, canonicalFilename: string): string {
  return `${legacyFilename} is a read-only legacy alias for ${canonicalFilename}; it expires ${LEGACY_CYCLE_ALIAS_EXPIRES_AT}`;
}

export function resolveCycleArtifactRead(filename: string, now = new Date()): CycleArtifactReadResolution {
  const canonical = LEGACY_CYCLE_ALIASES[filename];
  if (!canonical) return { filename };
  if (now.getTime() >= new Date(LEGACY_CYCLE_ALIAS_EXPIRES_AT).getTime()) {
    throw legacyAliasError('LEGACY_ALIAS_EXPIRED', `${filename} alias expired; use ${canonical}`);
  }
  return {
    filename: canonical,
    legacyFilename: filename,
    warning: legacyWarning(filename, canonical),
  };
}

export function resolveCycleArtifactCanonicalRead(filename: string, now = new Date()): CycleArtifactReadResolution {
  const legacyFilename = CANONICAL_CYCLE_ALIASES[filename];
  if (!legacyFilename) return resolveCycleArtifactRead(filename, now);
  return { filename, legacyFilename };
}

export function assertLegacyFallbackAllowed(legacyFilename: string, canonicalFilename: string, now = new Date()): void {
  if (now.getTime() >= new Date(LEGACY_CYCLE_ALIAS_EXPIRES_AT).getTime()) {
    throw legacyAliasError('LEGACY_ALIAS_EXPIRED', `${legacyFilename} alias expired; use ${canonicalFilename}`);
  }
}

export async function readCycleArtifact(rootDir: string, filename: string, now = new Date()): Promise<{ content: string; resolution: CycleArtifactReadResolution; warning?: string }> {
  const resolution = resolveCycleArtifactCanonicalRead(filename, now);
  try {
    return { content: await fs.readFile(path.join(rootDir, resolution.filename), 'utf8'), resolution, warning: resolution.warning };
  } catch (error: any) {
    if (!resolution.legacyFilename || error?.code !== 'ENOENT') throw error;
    assertLegacyFallbackAllowed(resolution.legacyFilename, resolution.filename, now);
    return {
      content: await fs.readFile(path.join(rootDir, resolution.legacyFilename), 'utf8'),
      resolution,
      warning: resolution.warning ?? legacyWarning(resolution.legacyFilename, resolution.filename),
    };
  }
}

export async function materializeCanonicalArtifactSet(
  canonicalArtifactRoot: string,
  runDir: string,
): Promise<{ materialized: string[] }> {
  if (path.resolve(canonicalArtifactRoot) === path.resolve(runDir)) {
    return { materialized: [] };
  }

  await fs.mkdir(runDir, { recursive: true });
  const materialized: string[] = [];
  for (const filename of CANONICAL_CYCLE_ARTIFACT_FILES) {
    try {
      const artifact = await readCycleArtifact(canonicalArtifactRoot, filename);
      await fs.writeFile(path.join(runDir, filename), artifact.content, 'utf8');
      materialized.push(filename);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const decisionsTarget = path.join(runDir, 'decisions');
  await fs.rm(decisionsTarget, { recursive: true, force: true });
  try {
    const decisionsSource = path.join(canonicalArtifactRoot, 'decisions');
    if ((await fs.stat(decisionsSource)).isDirectory()) {
      await fs.cp(decisionsSource, decisionsTarget, { recursive: true });
      materialized.push('decisions/');
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  return { materialized };
}

export function resolveCycleArtifactWrite(filename: string): string {
  const canonical = LEGACY_CYCLE_ALIASES[filename];
  if (canonical) {
    throw legacyAliasError('LEGACY_ALIAS_READ_ONLY', `${filename} is read-only; write ${canonical} instead`);
  }
  return filename;
}
