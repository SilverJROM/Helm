/**
 * Verification script for Phase A seed.
 * Run: npx tsx seeds/agent-port-2026-06-19/verify.ts
 */
import Database from 'better-sqlite3';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database(path.resolve(__dirname, '../../data/helm.db'));

const TARGET_AGENTS = [
  'projcore', 'coord', 'implementer', 'routine-implementer', 'validator',
  'planner', 'panelist', 'deliberation', 'red-team', 'lead', 'reviewer',
];

console.log('=== AGENT VERIFICATION TABLE ===');
console.log('name | provider/model | def_md_len | toolkits');
console.log('-'.repeat(100));

for (const agName of TARGET_AGENTS) {
  const ag = db
    .prepare('SELECT id, name, provider, model, definition_md FROM agents WHERE name = ?')
    .get(agName) as { id: number; name: string; provider: string; model: string; definition_md: string | null } | undefined;
  if (!ag) {
    console.log(`${agName} | NOT FOUND`);
    continue;
  }
  const tks = db
    .prepare(`
      SELECT t.name FROM toolkits t
      JOIN agent_toolkits at2 ON at2.toolkit_id = t.id
      WHERE at2.agent_id = ?
      ORDER BY at2.position
    `)
    .all(ag.id) as { name: string }[];
  const tkNames = tks.map((t) => t.name);
  const defLen = ag.definition_md ? ag.definition_md.length : 0;
  console.log(`${ag.name} | ${ag.provider}/${ag.model} | ${defLen} | [${tkNames.join(', ')}]`);
}

const totalTk = db.prepare('SELECT COUNT(*) as cnt FROM toolkits').get() as { cnt: number };
const totalAt = db.prepare('SELECT COUNT(*) as cnt FROM agent_toolkits').get() as { cnt: number };

console.log('');
console.log(`Total toolkits in DB: ${totalTk.cnt}`);
console.log(`Total agent_toolkit links: ${totalAt.cnt}`);

db.close();
