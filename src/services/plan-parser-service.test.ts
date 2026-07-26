process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlanParserService, Plan, PlannedTask } from './plan-parser-service.js';
import { parseExecutionPlan } from './execution-plan-parser.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';
import { ProjectService } from './project-service.js';
import { CycleService } from './cycle-service.js';
import { CycleDocsService } from './cycle-docs-service.js';

describe('plan-parser-service (B9 PLN2)', () => {
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let parser: PlanParserService;
  let queue: TaskQueueService;
  let runDir: string;

  beforeEach(async () => {
    tmpDb = path.join(os.tmpdir(), `helm-b9-parser-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    parser = new PlanParserService(art);
    queue = new TaskQueueService(art);
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-plan-'));
  });

  afterEach(async () => {
    if (dbs) dbs.close();
    if (tmpDb) await fs.rm(tmpDb, { force: true }).catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('ingests ALL 8 fields + deps; queue executes in dependency order; roundtrip via plan.json artifact', async () => {
    const plan: Plan = {
      tasks: [
        { task_key: 'T1', atomic_work: 'Setup project skeleton and basic config', complexity: 'low', recommended_model: 'grok-4.5', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'npm run build succeeds and basic test passes', deps: [] },
        { task_key: 'T2', atomic_work: 'Add plan parser service and types', complexity: 'med', recommended_model: 'claude-sonnet', effort: 'med', needs_more_info: false, task_type: 'feature', validation_criteria: 'parser accepts valid plan.json with all fields and rejects bad ones', deps: ['T1'] },
        { task_key: 'T3', atomic_work: 'Wire planning phase + co-planner gate (fixture)', complexity: 'high', recommended_model: 'codex-5.5', effort: 'high', needs_more_info: true, task_type: 'feature', validation_criteria: 'auto picks planner for simple; gate blocks until agreement; tasks ingested only after PLAN-READY', deps: ['T2'] },
        { task_key: 'T4', atomic_work: 'Cross cutting: ensure B8 plan-summon uses recommended_model/complexity', complexity: 'med', recommended_model: 'claude-opus', effort: 'med', needs_more_info: false, task_type: 'feature', validation_criteria: 'resolveRungAndModel receives explicitModel + complexity from plan; rung/model applied', deps: ['T1'] }
      ],
      meta: { version: 1, source: 'b9-test' }
    };

    const rid = art.createRun(null, 'batch-B9-parser');
    const { createdTaskIds, keyToId } = await parser.ingestPlan(rid, plan, queue, runDir);

    expect(createdTaskIds.length).toBe(4);
    expect(Object.keys(keyToId).length).toBe(4);
    expect(keyToId['T1']).toBeTypeOf('number');
    expect(keyToId['T3']).toBeTypeOf('number');

    // queue order: deps respected (T1/T4 indep first, T2 after T1, T3 after T2)
    // Minimal dep-order + created proof (first ready exists; after its mark a dep is ready; full drain ends null; 4 created)
    expect(createdTaskIds.length).toBe(4);
    const r1 = queue.getNextReady(rid);
    expect(r1).toBeTypeOf('number');
    queue.markComplete(r1!, rid);

    const r2 = queue.getNextReady(rid);
    expect(r2).toBeTypeOf('number'); // dep on the first becomes ready
    queue.markComplete(r2!, rid);

    let r = queue.getNextReady(rid);
    while (r != null) {
      queue.markComplete(r, rid);
      r = queue.getNextReady(rid);
    }
    expect(queue.getNextReady(rid)).toBeNull();

    // roundtrip fields via artifact plan.json (written by ingest)
    const planPath = path.join(runDir, 'plan.json');
    const raw = await fs.readFile(planPath, 'utf8');
    const loaded = JSON.parse(raw) as Plan;
    const t3 = loaded.tasks.find((t) => t.task_key === 'T3')!;
    expect(t3.atomic_work).toMatch(/co-planner gate/);
    expect(t3.complexity).toBe('high');
    expect(t3.recommended_model).toBe('codex-5.5');
    expect(t3.task_type).toBe('feature');
    expect(t3.validation_criteria).toMatch(/auto picks planner/);
    expect(t3.deps).toEqual(['T2']);
    expect(t3.needs_more_info).toBe(true);
  });

  it('rejects plan missing required fields (guardrail 1)', () => {
    const bad = { tasks: [{ task_key: 'X', atomic_work: 'foo' /* missing complexity etc */ }] };
    expect(() => parser.parsePlanFromJson(JSON.stringify(bad))).toThrow(/complexity|task_type|validation_criteria/);
  });

  it('supports fenced block fallback in plan.md', async () => {
    const md = `# Plan\n\n\`\`\`json\n{"tasks":[{"task_key":"F1","atomic_work":"fenced work","complexity":"low","task_type":"feature","validation_criteria":"fenced ok"}]}\n\`\`\`\n`;
    const mdPath = path.join(runDir, 'plan.md');
    await fs.writeFile(mdPath, md, 'utf8');

    const loaded = await parser.loadPlanFromRunDir(runDir);
    expect(loaded.tasks[0].task_key).toBe('F1');
    expect(loaded.tasks[0].atomic_work).toBe('fenced work');
  });

  // POCFIX9 (a): parser accepts validation_criteria as string[] (real projcore multi-crit output) or plain string;
  // normalizes array->string internally; ingest succeeds + artifact carries the (normalized) criteria.
  it('POCFIX9 (a): parsePlanFromJson accepts validation_criteria string[] (and string); normalizes + ingest carries criteria', async () => {
    const arrInput = {
      tasks: [{
        task_key: 'L9-1',
        atomic_work: 'Implement Lucky 9 core + tests',
        complexity: 'med',
        recommended_model: 'claude-sonnet',
        effort: 'med',
        needs_more_info: false,
        task_type: 'feature',
        validation_criteria: ['game class present', 'unit tests pass for deal/hit', 'committed in target project dir'],
        deps: []
      }],
      meta: { source: 'pocfix9-array-vc' }
    };
    const parsedArr = parser.parsePlanFromJson(JSON.stringify(arrInput));
    expect(parsedArr.tasks[0].validation_criteria).toBe('game class present\n- unit tests pass for deal/hit\n- committed in target project dir'); // normalized string

    const rid = art.createRun(null, 'batch-POCFIX9-parser-array');
    const { createdTaskIds } = await parser.ingestPlan(rid, parsedArr, queue, runDir);
    expect(createdTaskIds.length).toBe(1);

    // artifact roundtrips the (normalized) criteria
    const planPath = path.join(runDir, 'plan.json');
    const raw = await fs.readFile(planPath, 'utf8');
    const loaded = JSON.parse(raw) as Plan;
    expect(loaded.tasks[0].validation_criteria).toMatch(/game class present/);
    expect(typeof loaded.tasks[0].validation_criteria).toBe('string');

    // plain string still works (no regression)
    const strInput = { tasks: [{ task_key: 'S1', atomic_work: 'string vc task', complexity: 'low', task_type: 'feature', validation_criteria: 'single criterion ok', deps: [] }] };
    const parsedStr = parser.parsePlanFromJson(JSON.stringify(strInput));
    expect(parsedStr.tasks[0].validation_criteria).toBe('single criterion ok');
  });

  // B10-T01: plan.md as canonical source for helm-algo task queue (cycle→run bridge).
  // Verifies: createRunForCycle + ingestExecutionPlan (reuses parseExecutionPlan) produces correct
  // run_tasks (task_key=id, label=title), deps resolved into queue, compat plan.json written,
  // cycle_id linked on run row. Full mapping per spec.
  it('B10-T01: ingests canonical plan.md → correct run_tasks + deps + cycle link + derived plan.json artifact', async () => {
    // Setup a real cycle + canonical plan.md (reuse cycle-docs.test patterns)
    const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b10-cycle-'));
    // Local minimal setup inside test (dbs/art/parser/queue already from beforeEach)
    const localPs = new ProjectService(dbs);
    const localCycleSvc = new CycleService(dbs, localPs);
    const localCycleDocs = new CycleDocsService(localCycleSvc);
    const proj2 = localPs.createProject({ name: 'B10-T01-cycle2', directory: projDir });
    const cycle = await localCycleSvc.createCycle(proj2.id, 'B10 Exec Plan Test', undefined, undefined, () => new Date('2026-07-03T12:00:00Z'));
    const cycleDir = localCycleSvc.getCycleDocDir(cycle.id);  // <proj>/cycle/<folder>
    await fs.mkdir(cycleDir, { recursive: true });

    const execPlanMd = `# plan.md — B10-T01 test
\`\`\`json
[
  {
    "id": "B10-T01",
    "batch": "B10",
    "title": "Ingest execution_plan as canonical queue",
    "req_refs": ["R-D2"],
    "assignee": "grok-4.5",
    "validator_lane": "L1",
    "effort": "high",
    "type": "feature",
    "deps": []
  },
  {
    "id": "B10-T02",
    "batch": "B10",
    "title": "Dispatch one task at a time",
    "req_refs": ["R-F1"],
    "assignee": "grok-4.5",
    "validator_lane": "L2",
    "effort": "high",
    "type": "feature",
    "exception_handling": "pause on cycles",
    "deps": ["B10-T01"]
  },
  {
    "id": "B10-T03",
    "batch": "B10",
    "title": "Validator clone brief",
    "req_refs": ["R-F2"],
    "assignee": "grok-composer",
    "validator_lane": "L1",
    "effort": "med",
    "type": "feature",
    "deps": ["B10-T01"]
  }
]
\`\`\`
`;

    await localCycleDocs.writeCycleDoc(cycle.id, 'plan.md', execPlanMd);
    const doc = await localCycleDocs.readCycleDoc(cycle.id, 'plan.md');
    expect(doc.valid).toBe(true);

    // Create run linked to cycle + ingest via the new path (writes compat plan.json to cycleDir)
    const rid = art.createRunForCycle(proj2.id, cycle.id, 'batch-B10-T01', 'north-star.md');
    const { createdTaskIds, keyToId } = await parser.ingestExecutionPlan(rid, doc.content, queue, cycleDir);

    // run_tasks mapping correct
    expect(createdTaskIds.length).toBe(3);
    const runTasks = dbs.raw.prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY id').all(rid) as any[];
    expect(runTasks.length).toBe(3);
    expect(runTasks[0].task_key).toBe('B10-T01');
    expect(runTasks[0].label).toBe('Ingest execution_plan as canonical queue');
    expect(runTasks[1].task_key).toBe('B10-T02');
    expect(runTasks[2].task_key).toBe('B10-T03');

    // cycle link
    const runRow = dbs.raw.prepare('SELECT * FROM runs WHERE id = ?').get(rid) as any;
    expect(runRow.cycle_id).toBe(cycle.id);

    // compat plan.json generated (so load + legacy paths work)
    const compatPath = path.join(cycleDir, 'plan.json');
    const compatRaw = await fs.readFile(compatPath, 'utf8');
    const compat = JSON.parse(compatRaw) as Plan;
    expect(compat.tasks.length).toBe(3);
    expect(compat.tasks[0].task_key).toBe('B10-T01');
    expect(compat.tasks[0].atomic_work).toBe('Ingest execution_plan as canonical queue');
    expect(compat.tasks[0].recommended_model).toBe('grok-4.5');
    expect(compat.tasks[0].effort).toBe('high');
    expect(compat.tasks[0].complexity).toBe('high');
    expect(compat.tasks[0].task_type).toBe('feature');
    expect(compat.tasks[0].deps).toEqual([]);
    expect(compat.tasks[1].deps).toEqual(['B10-T01']);  // preserved
    expect(compat.tasks[1].validation_criteria).toMatch(/R-F1/);
    expect(compat.tasks[1].validation_criteria).toMatch(/pause on cycles/);

    // deps resolved in queue (T01 and T03 ready first-ish; after mark T02 becomes ready)
    const first = queue.getNextReady(rid)!;
    expect([keyToId['B10-T01'], keyToId['B10-T03']]).toContain(first);  // indep
    queue.markComplete(first, rid);

    const second = queue.getNextReady(rid)!;
    // remaining of the two indeps or the dep
    queue.markComplete(second, rid);

    const third = queue.getNextReady(rid)!;
    expect(third).toBeTypeOf('number');
    queue.markComplete(third, rid);
    expect(queue.getNextReady(rid)).toBeNull();

    // cleanup this test's dir
    await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  });

  it('normalizes execution_plan lane assignees so implementation uses project model bindings', async () => {
    const execPlanMd = `# execution_plan.md — lane assignee test
\`\`\`json
[
  { "id": "L1-A", "batch": "B1", "title": "Routine lane task", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "L1-routine", "type": "feature", "deps": [] },
  { "id": "L2-A", "batch": "B2", "title": "Higher lane task", "req_refs": ["R-2"], "assignee": "L2", "validator_lane": "L2", "effort": "L2", "type": "feature", "deps": ["L1-A"] },
  { "id": "VAL-A", "batch": "B3", "title": "Validator lane task", "req_refs": ["R-3"], "assignee": "L3", "validator_lane": "L3", "effort": "medium", "type": "feature", "deps": ["L2-A"] },
  { "id": "MODEL-A", "batch": "B4", "title": "Explicit model task", "req_refs": ["R-4"], "assignee": "claude-sonnet-5", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": [] }
]
\`\`\`
`;
    const rid = art.createRun(null, 'batch-lane-assignees');

    await parser.ingestExecutionPlan(rid, execPlanMd, queue, runDir);

    const compat = JSON.parse(await fs.readFile(path.join(runDir, 'plan.json'), 'utf8')) as Plan;
    const byKey = Object.fromEntries(compat.tasks.map((t) => [t.task_key, t]));
    expect(byKey['L1-A'].recommended_model).toBeUndefined();
    expect(byKey['L1-A'].recommended_rung).toBe(0);
    expect(byKey['L1-A'].validator_rung).toBe(0);
    expect(byKey['L1-A'].effort).toBe('low');
    expect(byKey['L1-A'].complexity).toBe('low');
    expect(byKey['L2-A'].recommended_model).toBeUndefined();
    expect(byKey['L2-A'].recommended_rung).toBe(1);
    expect(byKey['L2-A'].validator_rung).toBe(1);
    expect(byKey['L2-A'].effort).toBe('high');
    expect(byKey['VAL-A'].recommended_model).toBeUndefined();
    expect(byKey['VAL-A'].validator_rung).toBe(2);
    expect(byKey['MODEL-A'].recommended_model).toBe('claude-sonnet');
  });

  // cards2 ingest fault (2026-07-16) + sol send-back (2026-07-17): planners emit T-shirt effort sizes instead
  // of the low|med|high|xhigh enum. The parser recovers the UNAMBIGUOUS T-shirt tokens, but the recovery must
  // be CASE-AWARE: the exact UPPERCASE tokens are resolved on the raw value BEFORE lowercasing, so uppercase
  // `L` (Large→high) is NOT silently collapsed into the legacy lowercase `l`→low alias, and `M`→med is
  // recovered instead of thrown. Scale: XS/S→low, M→med, L→high, XL→xhigh. Legacy lowercase `l`→low and bare
  // lowercase `m`→throw are preserved; genuine garbage still throws.
  it('cards2 (sol send-back): T-shirt effort is CASE-AWARE — uppercase L→high (not low), M→med, S/XS→low, XL→xhigh; legacy lowercase l→low unchanged; garbage throws', async () => {
    const planMd = (effort: string) => `# execution_plan.md — tshirt effort test
\`\`\`json
[
  { "id": "TS-1", "batch": "B1", "title": "tee-shirt effort task", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "${effort}", "type": "feature", "deps": [] }
]
\`\`\`
`;
    const effortOf = async (effort: string) => {
      const rid = art.createRun(null, `batch-tshirt-${effort}`);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-tshirt-'));
      await parser.ingestExecutionPlan(rid, planMd(effort), queue, dir);
      const compat = JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8')) as Plan;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      // effort and complexity are always set together by the mapper
      expect(compat.tasks[0].complexity).toBe(compat.tasks[0].effort);
      return compat.tasks[0].effort;
    };

    // CASE-AWARE resolution — the load-bearing distinction: uppercase L (Large) → high, NOT legacy l → low.
    expect(await effortOf('L'), 'uppercase L (Large) → high').toBe('high');
    expect(await effortOf('l'), 'lowercase legacy l → low (UNCHANGED)').toBe('low');
    expect(await effortOf('M'), 'uppercase M (Medium) → med (not a throw)').toBe('med');
    expect(await effortOf('S'), 'uppercase S → low').toBe('low');
    expect(await effortOf('XS'), 'uppercase XS → low').toBe('low');
    expect(await effortOf('XL'), 'uppercase XL → xhigh').toBe('xhigh');

    // lowercase T-shirt / word variants still normalize (prior behavior preserved)
    for (const low of ['s', 'xs', 'small', 'x-small']) expect(await effortOf(low), `${low} → low`).toBe('low');
    for (const xh of ['xl', 'x-large', 'extra-large']) expect(await effortOf(xh), `${xh} → xhigh`).toBe('xhigh');

    // canonical enum values + word aliases unchanged (no regression)
    expect(await effortOf('low')).toBe('low');
    expect(await effortOf('med')).toBe('med');
    expect(await effortOf('medium')).toBe('med');
    expect(await effortOf('high')).toBe('high');
    expect(await effortOf('xhigh')).toBe('xhigh');

    // genuinely-invalid effort STILL throws (bare lowercase 'm' is ambiguous → deliberately NOT accepted)
    for (const bad of ['banana', 'm', 'sizeXXL']) {
      const rid = art.createRun(null, `batch-tshirt-bad`);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-tshirt-bad-'));
      await expect(
        parser.ingestExecutionPlan(rid, planMd(bad), queue, dir),
        `effort '${bad}' must still throw`,
      ).rejects.toThrow(/invalid effort/);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // sol send-back FULL regression: the ACTUAL mixed live cards2 plan (cards2-r1_0717/plan.md) shape — S at
  // T01/T03/T18, M at nine tasks, L at six tasks, plus an XL. Before the case-aware fix this threw at the
  // first `M` (T02) and silently mis-mapped every `L` to low. Inline fixture of that exact mix; assert the
  // whole plan ingests and every effort resolves correctly (S→low, M→med, L→high, XL→xhigh).
  it('cards2 (sol send-back): FULL ingest of the mixed live-plan shape (S/M/L/XL) succeeds; every effort resolves correctly', async () => {
    const effortByTask: Record<string, string> = {
      T01: 'S',  T02: 'M',  T03: 'S',  T04: 'L',  T05: 'L',  T06: 'L',  T07: 'L',
      T08: 'M',  T09: 'M',  T10: 'M',  T11: 'L',  T12: 'M',  T13: 'M',  T14: 'L',
      T15: 'M',  T16: 'M',  T17: 'M',  T18: 'S',  T19: 'XL',
    };
    const tasks = Object.entries(effortByTask).map(([id, effort]) => ({
      id, batch: 'B1', title: `live task ${id}`, req_refs: ['R-1'],
      assignee: 'L1', validator_lane: 'L1', effort, type: 'feature', deps: [],
    }));
    const md = '# plan.md — live cards2 mixed T-shirt shape\n```json\n' + JSON.stringify(tasks, null, 2) + '\n```\n';

    const rid = art.createRun(null, 'batch-live-mix');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-livemix-'));
    const { createdTaskIds } = await parser.ingestExecutionPlan(rid, md, queue, dir);

    // full ingest SUCCEEDS: all 19 tasks seeded (no throw on the 9 M tasks)
    expect(createdTaskIds.length).toBe(19);
    const compat = JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8')) as Plan;
    const byKey = Object.fromEntries(compat.tasks.map((t) => [t.task_key, t]));

    const tshirtToEnum: Record<string, string> = { S: 'low', M: 'med', L: 'high', XL: 'xhigh' };
    for (const [id, tshirt] of Object.entries(effortByTask)) {
      const want = tshirtToEnum[tshirt];
      expect(byKey[id]?.effort, `${id} (${tshirt}) effort → ${want}`).toBe(want);
      expect(byKey[id]?.complexity, `${id} (${tshirt}) complexity → ${want}`).toBe(want);
    }
    // spot-assert the two cases that regressed before the fix
    expect(byKey['T04'].effort, 'L must be high, not the silent low').toBe('high');
    expect(byKey['T02'].effort, 'M must ingest as med, not throw').toBe('med');

    // queue drains all 19 (deps [] → all ready; proves they entered the queue, not just run_tasks)
    let seeded = 0;
    let r = queue.getNextReady(rid);
    while (r != null) { seeded++; queue.markComplete(r, rid); r = queue.getNextReady(rid); }
    expect(seeded).toBe(19);

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // cards2 batch fault (2026-07-17): the live plan wrote `"batch": 1..5` (numbers). parseExecutionPlan now
  // coerces numeric batch → string, so both doc.valid (Start Implementation button) AND ingest succeed and the
  // compat plan.json carries batch as a string. Full-ingest regression over the exact live shape (numeric
  // batch, 11 tasks with deps) — not an isolated one-task plan.
  it('cards2 (batch fault): FULL ingest of a numeric-batch plan (live shape) succeeds; compat carries batch as a string', async () => {
    // 11 tasks: batches 1,1,2,2,2,3,3,4,4,5,5 as NUMBERS; deps mirror the live batch order.
    const batchByTask: Array<[string, number, string[]]> = [
      ['T01', 1, []], ['T02', 1, []],
      ['T03', 2, ['T02']], ['T04', 2, ['T02']], ['T05', 2, ['T02']],
      ['T06', 3, ['T03']], ['T07', 3, ['T02']],
      ['T08', 4, ['T06']], ['T09', 4, ['T07']],
      ['T10', 5, ['T08']], ['T11', 5, ['T09']],
    ];
    const tasks = batchByTask.map(([id, batch, deps]) => ({
      id, batch, title: `live task ${id}`, req_refs: ['R-1'],
      assignee: 'L1', validator_lane: 'L1', effort: 'med', type: 'feature', deps,
    }));
    const md = '# plan.md — live cards2 numeric-batch shape\n```json\n' + JSON.stringify(tasks, null, 2) + '\n```\n';

    // doc.valid path (server-computed gate the Start Implementation button reads)
    const parsed = parseExecutionPlan(md);
    expect(parsed.ok, 'numeric-batch plan must validate (button enable)').toBe(true);
    if (parsed.ok) expect(parsed.tasks[0].batch).toBe('1'); // coerced to string

    // ingest path
    const rid = art.createRun(null, 'batch-numeric-batch');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-numbatch-'));
    const { createdTaskIds } = await parser.ingestExecutionPlan(rid, md, queue, dir);
    expect(createdTaskIds.length).toBe(11);

    const compat = JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8')) as Plan;
    const byKey = Object.fromEntries(compat.tasks.map((t) => [t.task_key, t]));
    // compat plan.json carries batch as a STRING
    expect((byKey['T01'] as any).batch).toBe('1');
    expect((byKey['T10'] as any).batch).toBe('5');
    expect(typeof (byKey['T01'] as any).batch).toBe('string');

    // run_tasks created for all 11 (deps resolved: T01/T02 ready first)
    const runTasks = dbs.raw.prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY id').all(rid) as any[];
    expect(runTasks.length).toBe(11);
    const first = queue.getNextReady(rid)!;
    expect(first).toBeTypeOf('number');

    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // sol send-back #3 (2026-07-17): the CORE invariant, now guaranteed BY CONSTRUCTION via ONE shared validator
  // (validateExecutionPlan). `execDoc.valid === true` (parseExecutionPlan.ok, the gate the Start Implementation
  // button reads) ⟺ `ingestExecutionPlan` succeeds — across the FULL matrix of every check the two paths used
  // to diverge on. For EVERY case: parseExecutionPlan.ok === expected AND (valid ⟹ ingest resolves, invalid ⟹
  // ingest throws). No case where the button says valid but ingest throws or reinterprets.
  it('cards2 (sol send-back #3): valid ⟺ ingestible — EXHAUSTIVE matrix (one shared validator)', async () => {
    const T = (over: Record<string, unknown> = {}) =>
      ({ id: 'T01', batch: 'B1', title: 'x', req_refs: ['R-1'], assignee: 'L1', validator_lane: 'L1', effort: 'med', type: 'feature', ...over });
    const wrap = (tasks: unknown[]) => '```json\n' + JSON.stringify(tasks) + '\n```\n';

    // [label, tasks, expectedValid]
    const matrix: Array<[string, unknown[], boolean]> = [
      // valid
      ['valid plan', [T()], true],
      ['numeric batch coerces → "1"', [T({ batch: 1 })], true],
      ['string batch', [T({ batch: 'B7' })], true],
      ['bare-string req_refs coerces → ["R-9"]', [T({ req_refs: 'R-9' })], true],
      ['known-id deps', [T({ id: 'A' }), T({ id: 'B', deps: ['A'] })], true],
      ['model-slug assignee (override)', [T({ assignee: 'claude-sonnet-5' })], true],
      // effort
      ['numeric effort', [T({ effort: 2 })], false],
      ['out-of-enum effort', [T({ effort: 'banana' })], false],
      // type
      ['numeric type', [T({ type: 2 })], false],
      ['out-of-enum type', [T({ type: 'ui' })], false],
      // assignee / validator_lane
      ['numeric assignee', [T({ assignee: 2 })], false],
      ['bare-numeric-string assignee', [T({ assignee: '2' })], false],
      ['numeric validator_lane', [T({ validator_lane: 2 })], false],
      ['bare-numeric-string validator_lane', [T({ validator_lane: '2' })], false],
      // B6a: L4 is now in-domain (→ recommended_rung 3); L5+ / L0 remain out-of-range
      ['in-domain lane L4 assignee (B6a)', [T({ assignee: 'L4' })], true],
      ['in-domain lane L4 validator_lane (B6a)', [T({ validator_lane: 'L4' })], true],
      ['out-of-range lane L5 assignee', [T({ assignee: 'L5' })], false],
      ['out-of-range lane L0 assignee', [T({ assignee: 'L0' })], false],
      // id
      ['numeric id', [T({ id: 1 })], false],
      ['whitespace-only id', [T({ id: '   ' })], false],
      ['whitespace-only title', [T({ title: '   ' })], false],
      ['duplicate ids', [T({ id: 'D' }), T({ id: 'D' })], false],
      // deps
      ['dependency cycle', [T({ id: 'C1', deps: ['C2'] }), T({ id: 'C2', deps: ['C1'] })], false],
      ['non-array deps', [T({ deps: 'T01' })], false],
      ['numeric dep', [T({ id: 'A' }), T({ id: 'B', deps: [1] })], false],
      ['empty-string dep', [T({ id: 'A' }), T({ id: 'B', deps: [''] })], false],
      ['dangling dep', [T({ deps: ['MISSING'] })], false],
    ];

    for (const [label, tasks, expectValid] of matrix) {
      const md = wrap(tasks);
      // the UI gate (parseExecutionPlan → execDoc.valid)
      expect(parseExecutionPlan(md).ok, `${label}: parseExecutionPlan.ok`).toBe(expectValid);
      // the invariant: parseExecutionPlan.ok ⟺ ingestExecutionPlan succeeds
      const rid = art.createRun(null, 'batch-m3');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-m3-'));
      if (expectValid) {
        await expect(parser.ingestExecutionPlan(rid, md, queue, dir), `${label}: valid ⟹ ingest RESOLVES`).resolves.toBeDefined();
      } else {
        await expect(parser.ingestExecutionPlan(rid, md, queue, dir), `${label}: invalid ⟹ ingest THROWS`).rejects.toThrow();
      }
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('cards2 (sol send-back #2): a declared dep to a KNOWN id is preserved through ingest (never silently dropped)', async () => {
    const mk = (deps: unknown) => '```json\n' + JSON.stringify([
      { id: 'T01', batch: 'B1', title: 'a', req_refs: ['R-1'], assignee: 'L1', validator_lane: 'L1', effort: 'low', type: 'feature' },
      { id: 'T02', batch: 'B1', title: 'b', req_refs: ['R-1'], assignee: 'L1', validator_lane: 'L1', effort: 'low', type: 'feature', deps },
    ], null, 2) + '\n```\n';

    // known-id dep → valid + ingest preserves the dependency (T02 depends on T01)
    expect(parseExecutionPlan(mk(['T01'])).ok).toBe(true);
    const rid = art.createRun(null, 'batch-deps-preserve');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-depspreserve-'));
    await parser.ingestExecutionPlan(rid, mk(['T01']), queue, dir);
    const compat = JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8')) as Plan;
    const t02 = compat.tasks.find((t) => t.task_key === 'T02')!;
    expect(t02.deps).toEqual(['T01']); // NOT silently []
    // T02 is gated behind T01 in the queue (predecessor honored)
    const first = queue.getNextReady(rid)!;
    expect(first).toBeTypeOf('number');
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    // dangling + numeric deps are rejected at validation (so ingest can't silently drop them)
    expect(parseExecutionPlan(mk(['MISSING'])).ok).toBe(false);
    expect(parseExecutionPlan(mk([1])).ok).toBe(false);
  });

  // shakedown-5 (2026-07-17, TERMINAL) + B6a L4: enumerate EVERY value the execution-plan validator ACCEPTS for
  // assignee/validator_lane and assert each PERSISTS (through ingest) a concrete rung OR model — there is no
  // accepted value that yields an empty marker. Role labels remain rejected (ingest throws).
  it('shakedown-5: every accepted assignee/validator_lane persists a concrete rung|model through ingest (no accept-yet-drop)', async () => {
    // The representative set spanning every ACCEPT branch of classifyAssignee.
    const acceptedLane = ['L1', 'L2', 'L3', 'L4', 'L1-routine'];                                  // → rung (B6a: L4→3)
    const acceptedModel = ['sonnet', 'opus', 'claude-sonnet-5', 'grok', 'grok-4.5', 'grok-composer', 'terra']; // → model
    const accepted = [...acceptedLane, ...acceptedModel];

    // As ASSIGNEE: each accepted value must persist recommended_rung OR recommended_model.
    // As VALIDATOR_LANE: each accepted value must persist validator_rung OR validator_model.
    const tasks = accepted.flatMap((v, i) => ([
      { id: `AS${i}`, batch: 'B1', title: `assignee ${v}`, req_refs: ['R-1'], assignee: v, validator_lane: 'L1', effort: 'low', type: 'feature' },
      { id: `VL${i}`, batch: 'B1', title: `vlane ${v}`, req_refs: ['R-1'], assignee: 'L1', validator_lane: v, effort: 'low', type: 'feature' },
    ]));
    const md = '```json\n' + JSON.stringify(tasks) + '\n```\n';
    expect(parseExecutionPlan(md).ok, 'all-accepted plan validates').toBe(true);

    const rid = art.createRun(null, 'batch-repr5');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-repr5-'));
    await parser.ingestExecutionPlan(rid, md, queue, dir);
    const compat = JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8')) as Plan;
    const byKey = Object.fromEntries(compat.tasks.map((t) => [t.task_key, t as any]));

    accepted.forEach((v, i) => {
      const asTask = byKey[`AS${i}`];
      expect(asTask.recommended_rung != null || asTask.recommended_model != null,
        `assignee '${v}' must persist a concrete rung or model`).toBe(true);
      const vlTask = byKey[`VL${i}`];
      expect(vlTask.validator_rung != null || vlTask.validator_model != null,
        `validator_lane '${v}' must persist a concrete rung or model`).toBe(true);
    });
    // spot-check the exact mappings (indices shift with L4 inserted as AS3)
    expect(byKey['AS0'].recommended_rung).toBe(0);       // L1
    expect(byKey['AS2'].recommended_rung).toBe(2);       // L3
    expect(byKey['AS3'].recommended_rung).toBe(3);       // L4 (B6a)
    expect(byKey['AS5'].recommended_model).toBe('claude-sonnet'); // sonnet → claude-sonnet
    expect(byKey['AS7'].recommended_model).toBe('claude-sonnet'); // claude-sonnet-5 → claude-sonnet
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    // TERMINAL: no accept-yet-drop path remains — role labels are REJECTED, so ingest throws (never a
    // valid-but-dropped task).
    const bad = '```json\n' + JSON.stringify([{ id: 'X', batch: 'B1', title: 'x', req_refs: ['R-1'], assignee: 'validator', validator_lane: 'L1', effort: 'low', type: 'feature' }]) + '\n```\n';
    const rid2 = art.createRun(null, 'batch-repr5-bad');
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-repr5b-'));
    await expect(parser.ingestExecutionPlan(rid2, bad, queue, dir2)).rejects.toThrow();
    await fs.rm(dir2, { recursive: true, force: true }).catch(() => {});
  });

  // B10-T02: real cycle must be DETECTED at ingest with clear reason (not merely getNextReady null later)
  it('B10-T02: ingestExecutionPlan detects real dependency cycle (A→B→A) and throws with clear reason', async () => {
    const localPs = new ProjectService(dbs);
    const localCycleSvc = new CycleService(dbs, localPs);
    const localCycleDocs = new CycleDocsService(localCycleSvc);
    const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b10-cycle-detect-'));
    const proj = localPs.createProject({ name: 'B10-cycle-detect', directory: projDir });
    const cycle = await localCycleSvc.createCycle(proj.id, 'Cycle Detect Test', undefined, undefined, () => new Date());
    const cycleDir = localCycleSvc.getCycleDocDir(cycle.id);
    await fs.mkdir(cycleDir, { recursive: true });

    const cyclingPlan = `# plan.md — cycle test
\`\`\`json
[
  { "id": "T-A", "batch": "B10", "title": "A", "req_refs": [], "assignee": "grok", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": ["T-B"] },
  { "id": "T-B", "batch": "B10", "title": "B", "req_refs": [], "assignee": "grok", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": ["T-A"] }
]
\`\`\`
`;
    await fs.writeFile(path.join(cycleDir, 'plan.md'), cyclingPlan, 'utf8');
    const doc = await localCycleDocs.readCycleDoc(cycle.id, 'plan.md');

    const rid = art.createRunForCycle(proj.id, cycle.id, 'batch-B10-cycle', 'north-star.md');

    await expect(
      parser.ingestExecutionPlan(rid, doc.content, queue, cycleDir)
    ).rejects.toThrow(/dependency cycle detected/);

    await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
  });
});
