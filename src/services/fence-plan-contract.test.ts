/**
 * fence-workflow-upgrade A2 — authored plan-contract schema (R1.1, R1.2, R1.3).
 *
 * Covers:
 *  - fence carries integration_cmd, negative_control_cmd, acceptance_ids, test_path, authored_by, members
 *  - refuse missing NC / unknown member / duplicate member / >5 members at accept
 *  - legacy bare task-array plans remain valid
 *  - optional fences object is preserved through validateExecutionPlan + parseExecutionPlan
 *  - planning brief documents the fence plan-contract
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FENCE_MEMBER_CEILING,
  validateOneFenceContract,
  validatePlanFences,
} from './fence-plan-contract.js';
import {
  parseExecutionPlan,
  validateExecutionPlan,
} from './execution-plan-parser.js';
import { BriefWriterService } from './brief-writer-service.js';

const TASK_A1 = {
  id: 'A1',
  batch: 'A',
  title: 'Two-track fence schema',
  req_refs: ['R1.1'],
  assignee: 'L2',
  validator_lane: 'L3',
  effort: 'med',
  type: 'feature',
  deps: [] as string[],
};

const TASK_A2 = {
  id: 'A2',
  batch: 'A',
  title: 'Plan-contract schema',
  req_refs: ['R1.2', 'R1.3'],
  assignee: 'L2',
  validator_lane: 'L3',
  effort: 'med',
  type: 'feature',
  deps: ['A1'],
};

const TASK_A3 = {
  id: 'A3',
  batch: 'A',
  title: 'Membership ingest',
  req_refs: ['R1.4'],
  assignee: 'L2',
  validator_lane: 'L3',
  effort: 'med',
  type: 'feature',
  deps: ['A2'],
};

const TASK_A4 = {
  id: 'A4',
  batch: 'A',
  title: 'Integration agent route',
  req_refs: ['R1.6'],
  assignee: 'L2',
  validator_lane: 'L3',
  effort: 'med',
  type: 'feature',
  deps: ['A3'],
};

const TASK_B1 = {
  id: 'B1',
  batch: 'B',
  title: 'Report adapter',
  req_refs: ['R6.1'],
  assignee: 'L2',
  validator_lane: 'L3',
  effort: 'med',
  type: 'feature',
  deps: ['A1'],
};

const VALID_FENCE_BODY = {
  integration_cmd:
    'npx vitest run src/services/fence-f1-contract.integration.test.ts --minWorkers=1 --maxWorkers=4',
  negative_control_cmd:
    'FENCE_STUB=A3 npx vitest run src/services/fence-f1-contract.integration.test.ts --minWorkers=1 --maxWorkers=4',
  acceptance_ids: ['R1.1', 'R1.2', 'R1.3'],
  test_path: 'src/services/fence-f1-contract.integration.test.ts',
  authored_by: 'integration_test_agent',
  members: ['A1', 'A2', 'A3', 'A4'],
  label: 'F1 plan-contract membership',
};

function knownIds(...ids: string[]): Set<string> {
  return new Set(ids);
}

function wrapJson(payload: unknown): string {
  return `# Execution Plan\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

describe('A2 fence plan-contract (R1.1, R1.2, R1.3)', () => {
  describe('validateOneFenceContract / validatePlanFences', () => {
    it('accepts a complete fence with all contract fields and exact member ids', () => {
      const r = validateOneFenceContract(
        'I1',
        VALID_FENCE_BODY,
        knownIds('A1', 'A2', 'A3', 'A4')
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.fence.fence_key).toBe('I1');
      expect(r.fence.integration_cmd).toContain('fence-f1-contract');
      expect(r.fence.negative_control_cmd).toContain('FENCE_STUB=A3');
      expect(r.fence.acceptance_ids).toEqual(['R1.1', 'R1.2', 'R1.3']);
      expect(r.fence.test_path).toBe('src/services/fence-f1-contract.integration.test.ts');
      expect(r.fence.authored_by).toBe('integration_test_agent');
      expect(r.fence.members).toEqual(['A1', 'A2', 'A3', 'A4']);
      expect(r.fence.label).toBe('F1 plan-contract membership');
    });

    it('R1.3 refuses a fence with missing negative_control_cmd', () => {
      const { negative_control_cmd: _omit, ...noNc } = VALID_FENCE_BODY;
      const r = validateOneFenceContract('I1', noNc, knownIds('A1', 'A2', 'A3', 'A4'));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.some((e) => /negative_control_cmd/i.test(e) && /refused/i.test(e))).toBe(true);
    });

    it('R1.3 refuses a fence with empty / whitespace-only negative_control_cmd', () => {
      const r = validateOneFenceContract(
        'I1',
        { ...VALID_FENCE_BODY, negative_control_cmd: '   ' },
        knownIds('A1', 'A2', 'A3', 'A4')
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.some((e) => /negative_control_cmd/i.test(e))).toBe(true);
    });

    it('refuses an unknown member id', () => {
      const r = validateOneFenceContract(
        'I1',
        { ...VALID_FENCE_BODY, members: ['A1', 'Z99'] },
        knownIds('A1', 'A2', 'A3', 'A4')
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.some((e) => /Z99/.test(e) && /unknown/i.test(e))).toBe(true);
    });

    it('refuses a duplicate member id within a fence', () => {
      const r = validateOneFenceContract(
        'I1',
        { ...VALID_FENCE_BODY, members: ['A1', 'A2', 'A1'] },
        knownIds('A1', 'A2', 'A3', 'A4')
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.some((e) => /duplicate member/i.test(e) && /A1/.test(e))).toBe(true);
    });

    it(`refuses more than ${FENCE_MEMBER_CEILING} members (ceiling)`, () => {
      const six = ['A1', 'A2', 'A3', 'A4', 'B1', 'X6'];
      const r = validateOneFenceContract(
        'I1',
        { ...VALID_FENCE_BODY, members: six },
        knownIds(...six)
      );
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.some((e) => /ceiling/i.test(e) && String(FENCE_MEMBER_CEILING).includes(String(FENCE_MEMBER_CEILING)))).toBe(
        true
      );
      expect(r.errors.some((e) => new RegExp(String(FENCE_MEMBER_CEILING)).test(e))).toBe(true);
    });

    it('accepts a keyed fences map with multiple fences', () => {
      const r = validatePlanFences(
        {
          I1: { ...VALID_FENCE_BODY, members: ['A1', 'A2'] },
          I2: {
            ...VALID_FENCE_BODY,
            members: ['B1'],
            acceptance_ids: ['R2.1'],
            test_path: 'src/services/fence-f2-open-drain.integration.test.ts',
          },
        },
        knownIds('A1', 'A2', 'B1')
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.fences.map((f) => f.fence_key).sort()).toEqual(['I1', 'I2']);
    });

    it('accepts a fences array form with id/fence_key', () => {
      const r = validatePlanFences(
        [
          { id: 'I1', ...VALID_FENCE_BODY, members: ['A1'] },
          { fence_key: 'I2', ...VALID_FENCE_BODY, members: ['A2'], acceptance_ids: ['R2.1'] },
        ],
        knownIds('A1', 'A2')
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.fences).toHaveLength(2);
    });
  });

  describe('execution-plan-parser preserves optional fences; legacy arrays stay valid', () => {
    it('legacy bare task-array plan still validates (no fences required)', () => {
      const r = validateExecutionPlan([TASK_A1, TASK_A2]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.tasks).toHaveLength(2);
      expect(r.fences).toEqual([]);
      expect(r.normalizedTasks.map((t) => t.task_key)).toEqual(['A1', 'A2']);
    });

    it('legacy fenced-markdown task array still parses via parseExecutionPlan', () => {
      const r = parseExecutionPlan(wrapJson([TASK_A1, TASK_A2]));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.tasks.map((t) => t.id)).toEqual(['A1', 'A2']);
      expect(r.fences).toEqual([]);
    });

    it('object plan {tasks, fences} validates and preserves normalized fences on the success result', () => {
      const payload = {
        tasks: [TASK_A1, TASK_A2, TASK_A3, TASK_A4],
        fences: {
          I1: VALID_FENCE_BODY,
        },
      };
      const r = validateExecutionPlan(payload);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.tasks).toHaveLength(4);
      expect(r.fences).toHaveLength(1);
      expect(r.fences[0]).toMatchObject({
        fence_key: 'I1',
        integration_cmd: VALID_FENCE_BODY.integration_cmd,
        negative_control_cmd: VALID_FENCE_BODY.negative_control_cmd,
        acceptance_ids: VALID_FENCE_BODY.acceptance_ids,
        test_path: VALID_FENCE_BODY.test_path,
        authored_by: VALID_FENCE_BODY.authored_by,
        members: VALID_FENCE_BODY.members,
      });
    });

    it('parseExecutionPlan preserves fences through the markdown object form', () => {
      const md = wrapJson({
        tasks: [TASK_A1, TASK_A2, TASK_A3, TASK_A4],
        fences: { I1: VALID_FENCE_BODY },
      });
      const r = parseExecutionPlan(md);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.fences).toHaveLength(1);
      expect(r.fences[0].fence_key).toBe('I1');
      expect(r.fences[0].members).toEqual(['A1', 'A2', 'A3', 'A4']);
    });

    it('plan accept refuses missing negative_control_cmd (R1.3 end-to-end)', () => {
      const { negative_control_cmd: _omit, ...noNc } = VALID_FENCE_BODY;
      const r = validateExecutionPlan({
        tasks: [TASK_A1, TASK_A2, TASK_A3, TASK_A4],
        fences: { I1: noNc },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.some((e) => /negative_control_cmd/i.test(e) && /refused/i.test(e))).toBe(true);
    });

    it('plan accept refuses unknown member', () => {
      const r = validateExecutionPlan({
        tasks: [TASK_A1, TASK_A2],
        fences: {
          I1: { ...VALID_FENCE_BODY, members: ['A1', 'MISSING'] },
        },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.some((e) => /MISSING/.test(e) && /unknown/i.test(e))).toBe(true);
    });

    it('plan accept refuses duplicate member', () => {
      const r = validateExecutionPlan({
        tasks: [TASK_A1, TASK_A2],
        fences: {
          I1: { ...VALID_FENCE_BODY, members: ['A1', 'A1'] },
        },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.some((e) => /duplicate member/i.test(e))).toBe(true);
    });

    it('plan accept refuses >5 members', () => {
      const tasks = [TASK_A1, TASK_A2, TASK_A3, TASK_A4, TASK_B1, {
        id: 'X6',
        batch: 'X',
        title: 'sixth',
        req_refs: ['R-X'],
        assignee: 'L2',
        validator_lane: 'L3',
        effort: 'low',
        type: 'feature',
        deps: [] as string[],
      }];
      const r = validateExecutionPlan({
        tasks,
        fences: {
          I1: {
            ...VALID_FENCE_BODY,
            members: ['A1', 'A2', 'A3', 'A4', 'B1', 'X6'],
          },
        },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.some((e) => /ceiling/i.test(e))).toBe(true);
    });

    it('object plan with tasks only (no fences key) remains valid', () => {
      const r = validateExecutionPlan({ tasks: [TASK_A1, TASK_A2] });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.fences).toEqual([]);
    });
  });

  describe('planning brief carries fence plan-contract (R1.1 authoring surface)', () => {
    it('plan-draft purpose documents fences fields and NC refusal', () => {
      const writer = new BriefWriterService();
      const brief = writer.generatePanelBrief({
        purpose: 'plan-draft',
        batchId: 'fence-a2',
        seat: 'a2',
        lens: 'whole-plan',
        projectDir: '/tmp/fence-a2-project',
        runDir: '/tmp/fence-a2-run',
        callbacksFile: path.join('/tmp/fence-a2-run', 'callbacks.md'),
      });
      expect(brief).toContain('`fences`');
      expect(brief).toContain('`integration_cmd`');
      expect(brief).toContain('`negative_control_cmd`');
      expect(brief).toContain('`acceptance_ids`');
      expect(brief).toContain('`test_path`');
      expect(brief).toContain('`authored_by`');
      expect(brief).toContain('`members`');
      expect(brief.toLowerCase()).toMatch(/refused at plan accept|refused/);
      expect(brief).toContain('Legacy form remains valid');
    });
  });
});
