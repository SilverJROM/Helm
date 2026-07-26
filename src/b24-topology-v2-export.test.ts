/**
 * B24 / Q-08 — Contract v2 topology export shape + v1 live-stamp regression.
 * R8: does not import routing-config-service / plumbing-watcher-service.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  exportTopologyContractV2,
  exportTopologyV2FromFile,
  parseTopologyYamlMinimal,
  serializeTopologyV2Yaml,
  writeTopologyV2Export,
  type TopologyV1Like,
} from './services/topology-v2-export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const LIVE_TOPOLOGY = path.join(REPO, 'plan/c01-agent-studio-rebuild/topology.yaml');
const EXPORT_ARTIFACT = path.join(
  REPO,
  'plan/c01-agent-studio-rebuild/validation/B24-topology-v2-export.yaml'
);
const R8_BANNED = [
  path.join(REPO, 'src/services/routing-config-service.ts'),
  path.join(REPO, 'src/services/plumbing-watcher-service.ts'),
];

function sha256(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

const FIXTURE_V1: TopologyV1Like = {
  contract_version: 1,
  run_id: 'fixture-run',
  project: 'helm',
  co_planners: [
    { id: 'A', model: 'opus', launch: 'claude --model opus' },
    { id: 'B', model: 'grok45', launch: 'grok -m grok-4.5' },
  ],
  implementer: {
    L1: {
      model: 'grokcompose',
      backup: 'spark',
      launch: 'grok -m grok-composer-2.5-fast',
      backup_launch: 'codex -m gpt-5.3-codex-spark',
    },
    L2: {
      model: 'grok45',
      backup: 'haiku',
      launch: 'grok -m grok-4.5',
      backup_launch: 'claude --model haiku',
    },
    L3: {
      model: 'codex55',
      backup: 'sonnet',
      launch: 'codex -m gpt-5.5',
      backup_launch: 'claude --model sonnet',
    },
  },
  validator: {
    L1: { model: 'grok45', launch: 'grok -m grok-4.5' },
    L2: { model: 'sonnet', launch: 'claude --model sonnet' },
    L3: { model: 'opus', launch: 'claude --model opus' },
  },
};

describe('B24 Q-08 contract v2 export', () => {
  let livePreHash: string;
  let r8Pre: { p: string; h: string }[];

  beforeAll(() => {
    expect(fs.existsSync(LIVE_TOPOLOGY)).toBe(true);
    livePreHash = sha256(LIVE_TOPOLOGY);
    r8Pre = R8_BANNED.filter((p) => fs.existsSync(p)).map((p) => ({ p, h: sha256(p) }));
  });

  it('export from fixture → contract_version 2 + planners.min >= 1', () => {
    const v2 = exportTopologyContractV2(FIXTURE_V1, {
      exportedAt: '2026-07-10T00:00:00.000Z',
    });
    expect(v2.contract_version).toBe(2);
    expect(v2.contract_v2).toBe(true);
    expect(v2.planners.min).toBe(1);
    expect(v2.planners.min).toBeGreaterThanOrEqual(1);
    expect(v2.planners.rule).toMatch(/planners\s*>=\s*1/i);
    expect(v2.co_planners.length).toBeGreaterThanOrEqual(1);
    expect(v2.export_meta.source_contract_version).toBe(1);
    expect(v2.export_meta.export_kind).toBe('contract_v2_shape');
  });

  it('preserves per-tier implementer backup (+ backup_launch)', () => {
    const v2 = exportTopologyContractV2(FIXTURE_V1);
    for (const t of ['L1', 'L2', 'L3'] as const) {
      expect(v2.implementer[t].backup, `${t} backup`).toBe(FIXTURE_V1.implementer[t].backup);
      expect(v2.implementer[t].backup_launch, `${t} backup_launch`).toBe(
        FIXTURE_V1.implementer[t].backup_launch
      );
      expect(v2.implementer[t].model).toBe(FIXTURE_V1.implementer[t].model);
    }
  });

  it('includes AVAILABILITY stamping / escalation-reason fields', () => {
    const v2 = exportTopologyContractV2(FIXTURE_V1);
    expect(v2.escalation.lateral_cause).toBe('AVAILABILITY');
    expect(v2.escalation.vertical_cause).toBe('DIFFICULTY');
    expect(v2.escalation.availability_not_difficulty).toBe(true);
    expect(v2.escalation.stamp_reasons).toEqual(
      expect.arrayContaining(['AS_INTENDED', 'AVAILABILITY', 'DIFFICULTY', 'COUPLING'])
    );
    expect(v2.escalation.dual_unavailable).toBe('stall_and_flag_jrom');
  });

  it('serialize → re-parse shape still asserts v2 markers', () => {
    const v2 = exportTopologyContractV2(FIXTURE_V1, {
      exportedAt: '2026-07-10T00:00:00.000Z',
      sourcePath: '/tmp/fixture-topology.yaml',
    });
    const yaml = serializeTopologyV2Yaml(v2);
    expect(yaml).toMatch(/contract_version:\s*2/);
    expect(yaml).toMatch(/contract_v2:\s*true/);
    expect(yaml).toMatch(/planners:/);
    expect(yaml).toMatch(/min:\s*1/);
    expect(yaml).toMatch(/lateral_cause:\s*AVAILABILITY/);
    expect(yaml).toMatch(/vertical_cause:\s*DIFFICULTY/);
    expect(yaml).toMatch(/backup:\s*spark/);
    expect(yaml).toMatch(/backup_launch:/);
  });

  it('live topology.yaml still loads as contract_version 1 (regression)', () => {
    const text = fs.readFileSync(LIVE_TOPOLOGY, 'utf8');
    expect(text).toMatch(/contract_version:\s*1\b/);
    const v1 = parseTopologyYamlMinimal(text);
    expect(v1.contract_version).toBe(1);
    // live c01 stamp has exactly 2 co_planners (v1 rule); both must parse
    expect(v1.co_planners.length).toBe(2);
    expect(v1.co_planners.map((p) => p.id).sort()).toEqual(['A', 'B']);
    expect(v1.implementer.L1.backup).toBeTruthy();
    expect(v1.implementer.L2.backup).toBeTruthy();
    expect(v1.implementer.L3.backup).toBeTruthy();
    // v1 file must not be stamped as v2
    expect(text).not.toMatch(/contract_version:\s*2\b/);
  });

  it('exports live c01 stamp to validation artifact without mutating live', () => {
    const fixedAt = '2026-07-10T12:00:00.000Z';
    // Derive expected seats from live stamp (rev3+ may change models) — property: export preserves source.
    const liveV1 = parseTopologyYamlMinimal(fs.readFileSync(LIVE_TOPOLOGY, 'utf8'));
    const { doc, yaml } = exportTopologyV2FromFile(LIVE_TOPOLOGY, { exportedAt: fixedAt });

    expect(doc.contract_version).toBe(2);
    expect(doc.planners.min).toBeGreaterThanOrEqual(1);
    expect(doc.co_planners.length).toBe(liveV1.co_planners.length);
    expect(doc.co_planners.map((p) => p.model).sort()).toEqual(
      liveV1.co_planners.map((p) => p.model).sort()
    );
    expect(doc.implementer.L3.backup).toBe(liveV1.implementer.L3.backup);
    expect(doc.implementer.L3.backup_launch).toBe(liveV1.implementer.L3.backup_launch);
    expect(doc.escalation.lateral_cause).toBe('AVAILABILITY');
    expect(doc.export_meta.source_path).toBe(LIVE_TOPOLOGY);

    // write only to export path
    fs.mkdirSync(path.dirname(EXPORT_ARTIFACT), { recursive: true });
    writeTopologyV2Export(LIVE_TOPOLOGY, EXPORT_ARTIFACT, { exportedAt: fixedAt });
    expect(fs.existsSync(EXPORT_ARTIFACT)).toBe(true);
    const written = fs.readFileSync(EXPORT_ARTIFACT, 'utf8');
    expect(written).toBe(yaml);
    expect(written).toMatch(/contract_version:\s*2/);
    expect(written).toMatch(/EXPORT ONLY/);

    // live hash unchanged
    expect(sha256(LIVE_TOPOLOGY)).toBe(livePreHash);
    const liveStill = parseTopologyYamlMinimal(fs.readFileSync(LIVE_TOPOLOGY, 'utf8'));
    expect(liveStill.contract_version).toBe(1);

    // R8: banned modules untouched
    for (const { p, h } of r8Pre) {
      expect(sha256(p), p).toBe(h);
    }
  });

  it('rejects non-v1 sources', () => {
    expect(() =>
      exportTopologyContractV2({ ...FIXTURE_V1, contract_version: 2 } as TopologyV1Like)
    ).toThrow(/contract_version 1/);
  });
});
