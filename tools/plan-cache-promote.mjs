#!/usr/bin/env node
// plan-cache-promote — freeze a run's validated Phase-1 output for cheap Phase-2 replay.
//
// Copies a run's north-star/decisions/requirements/plan into a durable, repo-tracked cache slug and snapshots
// the CODE BASELINE the plan was authored against (as a git bundle + protecting tag + SHA in meta.json), so a
// later `POST /runs {seedPlan:<slug>, roleBindings:[...]}` can reset the project to that exact state and run ONLY
// the implementation loop with a different implementer/validator model — no Phase-1 re-spend.
//
// Usage:
//   node tools/plan-cache-promote.mjs --slug <slug> --run-dir <helm-run-dir> --project-dir <repo> \
//        --baseline <sha> [--desc "..."] [--source-run <id>] [--projcore-model <m>] [--cache-dir <dir>]
//
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const slug = arg('slug');
const runDir = arg('run-dir');
const projectDir = arg('project-dir');
const baseline = arg('baseline');
const desc = arg('desc', '');
const sourceRun = arg('source-run', '');
const projcoreModel = arg('projcore-model', '');
const cacheBase = arg('cache-dir', process.env.HELM_PLAN_CACHE_DIR || path.join(process.cwd(), 'plan-cache'));

if (!slug || !runDir || !projectDir || !baseline) {
  console.error('required: --slug --run-dir --project-dir --baseline');
  process.exit(2);
}
const git = (args) => execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' }).trim();

// resolve baseline to a full sha (fail loud if it does not exist in the project repo)
let baselineSha;
try { baselineSha = git(['rev-parse', `${baseline}^{commit}`]); }
catch (e) { console.error(`baseline '${baseline}' not found in ${projectDir}: ${e.message}`); process.exit(1); }

const cacheDir = path.join(cacheBase, slug);
fs.mkdirSync(cacheDir, { recursive: true });

// 1) copy Phase-1 artifacts (best-effort; plan.json + north_star are the essentials)
let copied = [];
for (const f of ['north_star.md', 'conversation-log.md', 'plan.json', 'plan.md', 'req.md', 'og-requirements.md', 'og-validation-report.md']) {
  const src = path.join(runDir, f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(cacheDir, f)); copied.push(f); }
}
const decSrc = path.join(runDir, 'decisions');
if (fs.existsSync(decSrc)) { fs.cpSync(decSrc, path.join(cacheDir, 'decisions'), { recursive: true }); copied.push('decisions/'); }
if (!fs.existsSync(path.join(cacheDir, 'plan.json'))) { console.error(`FATAL: no plan.json in ${runDir}`); process.exit(1); }
const nTasks = JSON.parse(fs.readFileSync(path.join(cacheDir, 'plan.json'), 'utf8')).tasks?.length ?? 0;

// 2) snapshot the code baseline: protecting tag (prevents GC) + git bundle (self-contained restore)
const baselineRef = `refs/tags/plancache/${slug}/baseline`;
try { git(['tag', '-f', `plancache/${slug}/baseline`, baselineSha]); } catch (e) { console.error('tag warn:', e.message); }
try { git(['bundle', 'create', path.join(cacheDir, 'baseline.bundle'), `plancache/${slug}/baseline`]); }
catch (e) { console.error(`bundle create failed: ${e.message}`); process.exit(1); }

// 3) meta
const meta = {
  slug,
  baseline_sha: baselineSha,
  baseline_ref: baselineRef,
  baseline_desc: desc,
  project_dir: projectDir,
  source_run: sourceRun,
  projcore_model: projcoreModel,
  tasks: nTasks,
  artifacts: copied,
  created_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(cacheDir, 'meta.json'), JSON.stringify(meta, null, 2));

console.log(`✓ promoted '${slug}' → ${cacheDir}`);
console.log(`  tasks: ${nTasks} | baseline: ${baselineSha.slice(0, 8)} (${desc || 'no desc'})`);
console.log(`  artifacts: ${copied.join(', ')}`);
console.log(`  replay: POST /api/projects/<id>/runs  {"seedPlan":"${slug}","roleBindings":[{"role":"implementer",...},{"role":"validator",...}]}`);
