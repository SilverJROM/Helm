/**
 * B00.s9 sanctioned one-time live repair. Run with: npx tsx tools/repair-b00-s9-live-agent-seeds.ts
 * The service sets and restores HELM_ALLOW_LIVE_DB=1 only while opening data/helm.db.
 */
import path from 'node:path';
import { repairCanonicalAgentDefinitions } from '../src/services/canonical-agent-seed-repair.js';

const liveDbPath = path.resolve(process.cwd(), 'data/helm.db');
const repaired = repairCanonicalAgentDefinitions(liveDbPath);
console.log(`Repaired ${repaired.map((item) => `${item.name} (${item.definitionLength} bytes)`).join(', ')} via Studio-authorized service path.`);
