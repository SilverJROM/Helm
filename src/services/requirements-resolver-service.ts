import fs from 'node:fs';
import path from 'node:path';

const REQUIREMENT_BULLET = /^- \*\*([^*]+)\*\*/;
const REQUIREMENT_BOUNDARY = /^(?:- \*\*|## |---\s*$)/;

/** Resolve task requirement references to their verbatim og-requirements.md bullet blocks. */
export function resolveRequirementsText(runDir: string, reqRefs: readonly string[]): string {
  const refs = reqRefs.map((ref) => String(ref).trim()).filter(Boolean);
  if (refs.length === 0) {
    return '(no req_refs assigned; see the ## Task section for atomic_work + validation_criteria)';
  }

  let source: string;
  try {
    source = fs.readFileSync(path.join(runDir, 'og-requirements.md'), 'utf8');
  } catch {
    return `(og-requirements.md not found in runDir; req_refs: ${refs.join(', ')})`;
  }

  const blocks = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = REQUIREMENT_BULLET.exec(lines[index]);
    if (!match) continue;

    const block = [lines[index]];
    for (index += 1; index < lines.length && !REQUIREMENT_BOUNDARY.test(lines[index]); index += 1) {
      block.push(lines[index]);
    }
    index -= 1;
    blocks.set(match[1].trim(), block.join('\n').trim());
  }

  return refs
    .map((ref) => blocks.get(ref) ?? `(req ${ref} not found in og-requirements.md)`)
    .join('\n');
}
