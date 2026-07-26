#!/usr/bin/env node
/**
 * B21 / R6.24–R6.25 — read-only recon: Helm B04 model registry × CLI scaffolding.
 *
 * Compares:
 *   - Helm canonical slugs / model_ids (B04 seeds in src/db/schema.ts)
 *   - vs agent-usage.sh rung keys / setup naming
 *   - vs cycle topology.yaml model / backup / panel fields
 *
 * Writes ONLY the report path(s). Never mutates agent-usage.sh, topology.yaml,
 * or live usage state (OPEN-BY-JROM / JROM-OWNED edits are recommendations only).
 *
 * Usage:
 *   node scripts/r6-recon.mjs
 *   node scripts/r6-recon.mjs --out <dir>
 *   node scripts/r6-recon.mjs --repo <helm-root> --usage <agent-usage.sh> --topology <topology.yaml>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(__dirname, '..');
const DEFAULT_REPORT_NAME = 'B21-r6-recon-report.md';
const DEFAULT_JSON_NAME = 'B21-r6-recon-report.json';

/** CLI-land short names that map to Helm B04 slugs (documentation only; not applied). */
const KNOWN_ALIASES = Object.freeze({
  opus: 'opus4.8',
  sonnet: 'sonnet5',
});

function parseArgs(argv) {
  const out = {
    repo: DEFAULT_REPO,
    usage: path.join(process.env.HOME || '', '.claude/agents/lib/agent-usage.sh'),
    topology: null, // filled after repo known
    outDir: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--repo' && next) {
      out.repo = path.resolve(next);
      i++;
    } else if (a === '--usage' && next) {
      out.usage = path.resolve(next);
      i++;
    } else if (a === '--topology' && next) {
      out.topology = path.resolve(next);
      i++;
    } else if (a === '--out' && next) {
      out.outDir = path.resolve(next);
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: node scripts/r6-recon.mjs [--repo DIR] [--usage PATH] [--topology PATH] [--out DIR]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (!out.topology) {
    out.topology = path.join(out.repo, 'plan/c01-agent-studio-rebuild/topology.yaml');
  }
  if (!out.outDir) {
    out.outDir = path.join(out.repo, 'plan/c01-agent-studio-rebuild/validation');
  }
  return out;
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

function assertReadable(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${filePath}`);
  }
  fs.accessSync(filePath, fs.constants.R_OK);
}

/**
 * Parse B04_CANONICAL_MODEL_SEEDS from schema.ts without importing TS runtime.
 * Read-only string parse — no DB, no side effects.
 */
function parseB04Seeds(schemaTs) {
  const start = schemaTs.indexOf('export const B04_CANONICAL_MODEL_SEEDS');
  if (start < 0) throw new Error('B04_CANONICAL_MODEL_SEEDS not found in schema.ts');
  const eq = schemaTs.indexOf('=', start);
  const arrStart = schemaTs.indexOf('[', eq);
  // find matching ] for as const
  let depth = 0;
  let arrEnd = -1;
  for (let i = arrStart; i < schemaTs.length; i++) {
    const ch = schemaTs[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        arrEnd = i;
        break;
      }
    }
  }
  if (arrEnd < 0) throw new Error('failed to bound B04_CANONICAL_MODEL_SEEDS array');
  const block = schemaTs.slice(arrStart, arrEnd + 1);
  const seeds = [];
  const objRe = /\{([^{}]+)\}/g;
  let m;
  while ((m = objRe.exec(block)) !== null) {
    const body = m[1];
    const slug = /slug:\s*'([^']+)'/.exec(body)?.[1];
    if (!slug) continue;
    seeds.push({
      slug,
      display_name: /display_name:\s*'([^']+)'/.exec(body)?.[1] ?? null,
      cli: /cli:\s*'([^']+)'/.exec(body)?.[1] ?? null,
      provider: /provider:\s*'([^']+)'/.exec(body)?.[1] ?? null,
      model_id: /model_id:\s*'([^']+)'/.exec(body)?.[1] ?? null,
    });
  }
  // FIX-Q13-COUNTS: never pin a magic seed count (was 10; Q-13 grew the set).
  // Property-validate each seed + self-consistency of the parse vs slug: occurrences.
  if (seeds.length === 0) {
    throw new Error('parsed zero B04 seeds from B04_CANONICAL_MODEL_SEEDS');
  }
  const slugHitsInBlock = (block.match(/slug:\s*'/g) || []).length;
  if (seeds.length !== slugHitsInBlock) {
    throw new Error(
      `B04 parse length mismatch: parsed ${seeds.length} seeds but block has ${slugHitsInBlock} slug: entries`
    );
  }
  const slugs = new Set();
  const modelIds = new Set();
  for (const s of seeds) {
    for (const key of ['slug', 'display_name', 'cli', 'provider', 'model_id']) {
      if (!s[key] || String(s[key]).trim() === '') {
        throw new Error(`B04 seed missing required field ${key}: ${JSON.stringify(s)}`);
      }
    }
    if (slugs.has(s.slug)) throw new Error(`duplicate B04 slug: ${s.slug}`);
    if (modelIds.has(s.model_id)) throw new Error(`duplicate B04 model_id: ${s.model_id}`);
    slugs.add(s.slug);
    modelIds.add(s.model_id);
  }
  return seeds;
}

/** Extract agent-usage rung keys from the rungs:{ ... } block. */
function parseUsageRungs(usageSrc) {
  const rungsIdx = usageSrc.indexOf('"rungs"');
  if (rungsIdx < 0) {
    // fallback: look for rungs:{
    const alt = usageSrc.search(/rungs\s*:\s*\{/);
    if (alt < 0) throw new Error('rungs block not found in agent-usage.sh');
  }
  // Prefer the JSON-ish rungs object inside the python embed
  const blockMatch = usageSrc.match(/"rungs"\s*:\s*\{([\s\S]*?)\n\s*\}/);
  const block = blockMatch ? blockMatch[1] : '';
  const keys = [...block.matchAll(/"([a-zA-Z0-9._-]+)"\s*:/g)].map((x) => x[1]);
  // also collect setup string examples mentioning model tokens
  const setupExamples = [
    ...usageSrc.matchAll(/['"]([a-z0-9._+-]+\+[a-z0-9._+-]+)['"]/gi),
  ].map((x) => x[1]);
  const setupTokens = new Set();
  for (const ex of setupExamples) {
    for (const part of ex.split('+')) setupTokens.add(part);
  }
  // comment mentions of setup patterns
  for (const m of usageSrc.matchAll(/grokcompose|codex55|sonnet|spark|opus|haiku|grok45/g)) {
    setupTokens.add(m[0]);
  }
  return {
    rung_keys: [...new Set(keys)],
    setup_tokens: [...setupTokens].sort(),
  };
}

/**
 * Extract model-ish tokens from topology.yaml (model:, backup:, models: [], settle: []).
 * Does not parse full YAML — field-oriented regex is enough and stays dependency-free.
 */
function parseTopologyTokens(topoSrc) {
  const tokens = new Set();
  const sources = [];

  for (const line of topoSrc.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let m = /^\s*model:\s*([A-Za-z0-9._-]+)\s*$/.exec(line);
    if (m) {
      tokens.add(m[1]);
      sources.push({ field: 'model', token: m[1], line: line.trim() });
      continue;
    }
    m = /^\s*backup:\s*([A-Za-z0-9._-]+)\s*$/.exec(line);
    if (m) {
      tokens.add(m[1]);
      sources.push({ field: 'backup', token: m[1], line: line.trim() });
      continue;
    }
    m = /\bmodels:\s*\[([^\]]+)\]/.exec(line);
    if (m) {
      for (const t of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        tokens.add(t);
        sources.push({ field: 'models[]', token: t, line: line.trim() });
      }
      continue;
    }
    m = /\bsettle:\s*\[([^\]]+)\]/.exec(line);
    if (m) {
      for (const t of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        tokens.add(t);
        sources.push({ field: 'settle[]', token: t, line: line.trim() });
      }
    }
  }
  return { tokens: [...tokens].sort(), sources };
}

function resolveAlias(token) {
  if (KNOWN_ALIASES[token]) return KNOWN_ALIASES[token];
  return null;
}

function buildComparison(seeds, usage, topology) {
  const helmSlugs = new Set(seeds.map((s) => s.slug));
  const helmBySlug = new Map(seeds.map((s) => [s.slug, s]));
  const reverseAlias = new Map(Object.entries(KNOWN_ALIASES).map(([k, v]) => [v, k]));

  const scaffoldingTokens = new Set([
    ...usage.rung_keys,
    ...usage.setup_tokens,
    ...topology.tokens,
  ]);

  const matches = [];
  const aliasMatches = [];
  const helmOnly = [];
  const scaffoldingOnly = [];
  const mismatches = [];

  // Exact slug present on both sides
  for (const slug of [...helmSlugs].sort()) {
    if (scaffoldingTokens.has(slug)) {
      matches.push({
        helm_slug: slug,
        model_id: helmBySlug.get(slug)?.model_id ?? null,
        scaffolding_token: slug,
        where: [
          usage.rung_keys.includes(slug) ? 'agent-usage.rungs' : null,
          usage.setup_tokens.includes(slug) ? 'agent-usage.setup/comments' : null,
          topology.tokens.includes(slug) ? 'topology' : null,
        ].filter(Boolean),
      });
    } else if (reverseAlias.has(slug) && scaffoldingTokens.has(reverseAlias.get(slug))) {
      const short = reverseAlias.get(slug);
      aliasMatches.push({
        helm_slug: slug,
        model_id: helmBySlug.get(slug)?.model_id ?? null,
        scaffolding_token: short,
        note: `CLI-land short name "${short}" → Helm slug "${slug}"`,
        where: [
          usage.rung_keys.includes(short) ? 'agent-usage.rungs' : null,
          usage.setup_tokens.includes(short) ? 'agent-usage.setup/comments' : null,
          topology.tokens.includes(short) ? 'topology' : null,
        ].filter(Boolean),
      });
    } else {
      helmOnly.push({
        helm_slug: slug,
        model_id: helmBySlug.get(slug)?.model_id ?? null,
        note: 'Present in Helm B04 registry; no matching scaffolding token (exact or known alias)',
      });
    }
  }

  for (const tok of [...scaffoldingTokens].sort()) {
    if (helmSlugs.has(tok)) continue;
    const aliasTarget = resolveAlias(tok);
    if (aliasTarget && helmSlugs.has(aliasTarget)) continue; // already in aliasMatches
    scaffoldingOnly.push({
      scaffolding_token: tok,
      note: 'Scaffolding token with no Helm B04 slug (exact or known alias)',
      where: [
        usage.rung_keys.includes(tok) ? 'agent-usage.rungs' : null,
        usage.setup_tokens.includes(tok) ? 'agent-usage.setup/comments' : null,
        topology.tokens.includes(tok) ? 'topology' : null,
      ].filter(Boolean),
    });
  }

  // Named drift cases for the report
  for (const [short, full] of Object.entries(KNOWN_ALIASES)) {
    if (scaffoldingTokens.has(short) && helmSlugs.has(full)) {
      mismatches.push({
        kind: 'short-name-vs-helm-slug',
        scaffolding_token: short,
        helm_slug: full,
        severity: 'drift',
        detail:
          `Scaffolding uses short name "${short}" while Helm B04 canonical slug is "${full}". ` +
          `Helm is authoritative within Helm; CLI-land rename is OPEN-BY-JROM.`,
      });
    }
  }

  // Topology L3 backup "sonnet" vs B12b seed sonnet5 is the same alias drift
  if (topology.tokens.includes('sonnet') && helmSlugs.has('sonnet5')) {
    mismatches.push({
      kind: 'topology-backup-short-name',
      scaffolding_token: 'sonnet',
      helm_slug: 'sonnet5',
      severity: 'drift',
      detail:
        'topology implementer L3 backup / panel seats use "sonnet"; Helm B12b seeds map this intent to slug sonnet5.',
    });
  }

  // Usage rungs incomplete vs Helm seat models
  const usageMissingHelm = ['grok45', 'grokcompose', 'haiku', 'codex54', 'codex54min', 'deepseek-v4-flash', 'opus4.8', 'sonnet5'].filter(
    (s) => helmSlugs.has(s) && !usage.rung_keys.includes(s) && !usage.rung_keys.includes(reverseAlias.get(s) || '')
  );
  // reverse: opus/sonnet rungs cover opus4.8/sonnet5 via alias
  const usageMissingFiltered = usageMissingHelm.filter((s) => {
    if (s === 'opus4.8' && usage.rung_keys.includes('opus')) return false;
    if (s === 'sonnet5' && usage.rung_keys.includes('sonnet')) return false;
    return true;
  });
  if (usageMissingFiltered.length) {
    mismatches.push({
      kind: 'usage-rungs-incomplete',
      scaffolding_token: usage.rung_keys.join(','),
      helm_slug: usageMissingFiltered.join(','),
      severity: 'info',
      detail:
        `agent-usage.sh tracks only 4 rungs (${usage.rung_keys.join(', ')}). ` +
        `Helm B04 slugs without a usage rung (exact or alias): ${usageMissingFiltered.join(', ')}. ` +
        `Usage gateway is headroom routing, not a full model registry — expected unless JROM expands rungs.`,
    });
  }

  const recommendations = [];
  if (aliasMatches.length || mismatches.some((m) => m.kind === 'short-name-vs-helm-slug')) {
    recommendations.push({
      owner: 'JROM',
      target: 'topology.yaml scaffolding + any global topology templates',
      action:
        'Optionally rename short model fields (opus→opus4.8, sonnet→sonnet5) for name parity with Helm B04. ' +
        'Not required for Helm correctness — Helm already maps intent via B12b seeds. OPEN-BY-JROM only.',
      apply: false,
    });
    recommendations.push({
      owner: 'JROM',
      target: '~/.claude/agents/lib/agent-usage.sh',
      action:
        'Optionally alias rung keys sonnet→sonnet5 and opus→opus4.8, or add dual-key support. ' +
        'Do not migrate scaffolding to Helm unilaterally; usage DB / telemetry rows use current keys. OPEN-BY-JROM.',
      apply: false,
    });
  }
  if (helmOnly.length) {
    recommendations.push({
      owner: 'JROM',
      target: 'agent-usage.sh (optional) / docs',
      action:
        `Document Helm-only registry models (${helmOnly.map((h) => h.helm_slug).join(', ')}) as out of usage-rung scope, ` +
        'or add rungs if headroom tracking is desired. OPEN-BY-JROM.',
      apply: false,
    });
  }
  recommendations.push({
    owner: 'Helm (no action this batch)',
    target: 'src/db/schema.ts B04 seeds',
    action: 'Helm remains authoritative for slugs within Helm. No scaffolding migration in B21.',
    apply: false,
  });

  return {
    matches,
    alias_matches: aliasMatches,
    mismatches,
    helm_only: helmOnly,
    scaffolding_only: scaffoldingOnly,
    recommendations,
  };
}

function renderMarkdown(report) {
  const { meta, helm, usage, topology, comparison } = report;
  const lines = [];
  lines.push('# B21 — R6 recon report (read-only)');
  lines.push('');
  lines.push('**Batch:** B21 · **Scope:** R6.24–R6.25 (amended) · **Mode:** recon only');
  lines.push('');
  lines.push('Helm is authoritative for model slugs **within Helm**. CLI-land scaffolding');
  lines.push('(`agent-usage.sh`, `topology.yaml`) is **not** migrated by this batch.');
  lines.push('Any scaffolding edit is **OPEN-BY-JROM / JROM-OWNED** — recommendations below are not applied.');
  lines.push('');
  lines.push('## Meta');
  lines.push('');
  lines.push(`- Generated: ${meta.generated_at}`);
  lines.push(`- Repo: \`${meta.repo}\``);
  lines.push(`- Schema: \`${meta.schema_path}\` (sha256 \`${meta.schema_sha256.slice(0, 12)}…\`)`);
  lines.push(`- agent-usage: \`${meta.usage_path}\` (sha256 \`${meta.usage_sha256.slice(0, 12)}…\`, **read-only**)`)
  lines.push(`- topology: \`${meta.topology_path}\` (sha256 \`${meta.topology_sha256.slice(0, 12)}…\`, **read-only**)`);
  lines.push(`- Write targets: \`${meta.report_md}\`, \`${meta.report_json}\` only`);
  lines.push(`- Read-only proof: pre/post hashes for usage+topology unchanged (\`${meta.read_only_ok}\`)`);
  lines.push('');
  lines.push(`## Helm B04 canonical registry (${helm.seeds.length} models)`);
  lines.push('');
  lines.push('| slug | model_id | provider | cli | display_name |');
  lines.push('|------|----------|----------|-----|--------------|');
  for (const s of helm.seeds) {
    lines.push(
      `| \`${s.slug}\` | \`${s.model_id}\` | ${s.provider} | ${s.cli} | ${s.display_name} |`
    );
  }
  lines.push('');
  lines.push('## Scaffolding model naming');
  lines.push('');
  lines.push('### agent-usage.sh rungs');
  lines.push('');
  lines.push(`- Rung keys: ${usage.rung_keys.map((k) => `\`${k}\``).join(', ') || '_(none)_'}`);
  lines.push(
    `- Tokens seen in setup/comments: ${usage.setup_tokens.map((k) => `\`${k}\``).join(', ') || '_(none)_'}`
  );
  lines.push('');
  lines.push('### topology.yaml model fields');
  lines.push('');
  lines.push(`- Tokens: ${topology.tokens.map((k) => `\`${k}\``).join(', ') || '_(none)_'}`);
  lines.push('');
  lines.push('<details><summary>Field sources</summary>');
  lines.push('');
  for (const s of topology.sources) {
    lines.push(`- \`${s.field}\` → \`${s.token}\` — \`${s.line}\``);
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');
  lines.push('## Matches (exact slug on both sides)');
  lines.push('');
  if (!comparison.matches.length) {
    lines.push('_None._');
  } else {
    lines.push('| helm_slug | model_id | scaffolding_token | where |');
    lines.push('|-----------|----------|-------------------|-------|');
    for (const m of comparison.matches) {
      lines.push(
        `| \`${m.helm_slug}\` | \`${m.model_id}\` | \`${m.scaffolding_token}\` | ${m.where.join(', ')} |`
      );
    }
  }
  lines.push('');
  lines.push('## Alias matches (known short name ↔ Helm slug)');
  lines.push('');
  if (!comparison.alias_matches.length) {
    lines.push('_None._');
  } else {
    lines.push('| helm_slug | model_id | scaffolding_token | where | note |');
    lines.push('|-----------|----------|-------------------|-------|------|');
    for (const m of comparison.alias_matches) {
      lines.push(
        `| \`${m.helm_slug}\` | \`${m.model_id}\` | \`${m.scaffolding_token}\` | ${m.where.join(', ')} | ${m.note} |`
      );
    }
  }
  lines.push('');
  lines.push('## Mismatches / drift');
  lines.push('');
  if (!comparison.mismatches.length) {
    lines.push('_None._');
  } else {
    for (const m of comparison.mismatches) {
      lines.push(`### \`${m.kind}\` (${m.severity})`);
      lines.push('');
      lines.push(`- Scaffolding: \`${m.scaffolding_token}\``);
      lines.push(`- Helm: \`${m.helm_slug}\``);
      lines.push(`- ${m.detail}`);
      lines.push('');
    }
  }
  lines.push('## Helm-only (registry, no scaffolding token)');
  lines.push('');
  if (!comparison.helm_only.length) {
    lines.push('_None._');
  } else {
    lines.push('| helm_slug | model_id | note |');
    lines.push('|-----------|----------|------|');
    for (const h of comparison.helm_only) {
      lines.push(`| \`${h.helm_slug}\` | \`${h.model_id}\` | ${h.note} |`);
    }
  }
  lines.push('');
  lines.push('## Scaffolding-only (no Helm B04 slug)');
  lines.push('');
  if (!comparison.scaffolding_only.length) {
    lines.push('_None_ (all scaffolding tokens map via exact slug or known alias).');
  } else {
    lines.push('| token | where | note |');
    lines.push('|-------|-------|------|');
    for (const s of comparison.scaffolding_only) {
      lines.push(`| \`${s.scaffolding_token}\` | ${s.where.join(', ')} | ${s.note} |`);
    }
  }
  lines.push('');
  lines.push('## Recommended JROM-owned edits (DO NOT APPLY in B21)');
  lines.push('');
  for (const r of comparison.recommendations) {
    lines.push(`### ${r.owner} → \`${r.target}\``);
    lines.push('');
    lines.push(`- apply: **${r.apply}**`);
    lines.push(`- ${r.action}`);
    lines.push('');
  }
  lines.push('## Read-only guarantee');
  lines.push('');
  lines.push('This script:');
  lines.push('');
  lines.push('1. Opens `agent-usage.sh` and `topology.yaml` **read-only**.');
  lines.push('2. Writes **only** the report `.md` / `.json` under the `--out` directory.');
  lines.push('3. Does **not** call usage endpoints, open the usage SQLite DB, or mutate live state.');
  lines.push('4. Does **not** touch `routing-config-service.ts` or `plumbing-watcher-service.ts` (R8).');
  lines.push('');
  lines.push(`Pre/post hash check: **${meta.read_only_ok ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  lines.push('| path | pre sha256 | post sha256 |');
  lines.push('|------|------------|-------------|');
  lines.push(
    `| agent-usage.sh | \`${meta.usage_sha256}\` | \`${meta.usage_sha256_post}\` |`
  );
  lines.push(
    `| topology.yaml | \`${meta.topology_sha256}\` | \`${meta.topology_sha256_post}\` |`
  );
  lines.push('');
  lines.push('---');
  lines.push('_Generated by `scripts/r6-recon.mjs` (B21)._');
  lines.push('');
  return lines.join('\n');
}

/**
 * Ensure we only write under outDir. Rejects path escape.
 */
function assertWriteTarget(outDir, filePath) {
  const resolvedOut = path.resolve(outDir);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(resolvedOut + path.sep) && resolvedFile !== resolvedOut) {
    throw new Error(`refusing write outside report dir: ${resolvedFile}`);
  }
  // hard ban known scaffolding paths
  const banned = ['agent-usage.sh', 'topology.yaml', 'routing-config-service.ts', 'plumbing-watcher-service.ts'];
  const base = path.basename(resolvedFile);
  if (banned.includes(base)) {
    throw new Error(`refusing banned write target: ${base}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const schemaPath = path.join(args.repo, 'src/db/schema.ts');

  assertReadable(schemaPath, 'schema.ts');
  assertReadable(args.usage, 'agent-usage.sh');
  assertReadable(args.topology, 'topology.yaml');

  const usagePre = sha256File(args.usage);
  const topoPre = sha256File(args.topology);
  const schemaSha = sha256File(schemaPath);

  const seeds = parseB04Seeds(fs.readFileSync(schemaPath, 'utf8'));
  const usage = parseUsageRungs(fs.readFileSync(args.usage, 'utf8'));
  const topology = parseTopologyTokens(fs.readFileSync(args.topology, 'utf8'));
  const comparison = buildComparison(seeds, usage, topology);

  // re-hash after all reads (must be identical — we never write these)
  const usagePost = sha256File(args.usage);
  const topoPost = sha256File(args.topology);
  const readOnlyOk = usagePre === usagePost && topoPre === topoPost;
  if (!readOnlyOk) {
    throw new Error('read-only proof failed: usage or topology hash changed during recon');
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const reportMd = path.join(args.outDir, DEFAULT_REPORT_NAME);
  const reportJson = path.join(args.outDir, DEFAULT_JSON_NAME);
  assertWriteTarget(args.outDir, reportMd);
  assertWriteTarget(args.outDir, reportJson);

  const report = {
    meta: {
      generated_at: new Date().toISOString(),
      repo: args.repo,
      schema_path: schemaPath,
      schema_sha256: schemaSha,
      usage_path: args.usage,
      usage_sha256: usagePre,
      usage_sha256_post: usagePost,
      topology_path: args.topology,
      topology_sha256: topoPre,
      topology_sha256_post: topoPost,
      report_md: reportMd,
      report_json: reportJson,
      read_only_ok: readOnlyOk,
      known_aliases: KNOWN_ALIASES,
    },
    helm: { seeds, slugs: seeds.map((s) => s.slug) },
    usage,
    topology: { tokens: topology.tokens, sources: topology.sources },
    comparison,
  };

  fs.writeFileSync(reportMd, renderMarkdown(report), 'utf8');
  fs.writeFileSync(reportJson, JSON.stringify(report, null, 2) + '\n', 'utf8');

  // final hash check after writes
  if (sha256File(args.usage) !== usagePre || sha256File(args.topology) !== topoPre) {
    throw new Error('FATAL: scaffolding mutated during report write — abort');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        read_only_ok: true,
        report_md: reportMd,
        report_json: reportJson,
        matches: comparison.matches.length,
        alias_matches: comparison.alias_matches.length,
        mismatches: comparison.mismatches.length,
        helm_only: comparison.helm_only.length,
        scaffolding_only: comparison.scaffolding_only.length,
      },
      null,
      2
    )
  );
}

main();
