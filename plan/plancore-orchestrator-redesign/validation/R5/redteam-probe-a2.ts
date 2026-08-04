// R5 attempt-2 probe — re-runs the validator's attempt-1 red-team probe VERBATIM against the real
// (unmocked) waitForCandidateSignature: a malformed `SIGNED plan=<current12>XYZ` line must resolve
// `signed-mismatched`, never `signed-agreed` (R6.21 fail-closed).
process.env.USE_FAKE_TMUX = '1';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { waitForCandidateSignature } from '/home/agjrom/websites/Helm/src/services/planning-review-round.js';
import { atomicWriteFile, candidatePlanPath } from '/home/agjrom/websites/Helm/src/services/seat-draft-store.js';
import { planRevision } from '/home/agjrom/websites/Helm/src/services/plan-revision.js';

const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r5-probe-a2-'));
const cbPath = path.join(runDir, 'callbacks.md');
const candidatePath = candidatePlanPath(runDir);
const seat = { batchId: 'batch-R5-signer', brief: 'signer brief', handle: 'fake-signer-1', seatId: 'partner-2' };

const bytes = '# Candidate\n```json\n[]\n```\n';
const revision = planRevision(bytes);
atomicWriteFile(candidatePath, bytes);

const malformedLine = `SIGNED plan=${revision.short12}XYZ`;
await fs.writeFile(cbPath, `[helm callback] planner ${seat.batchId} STATUS: ${malformedLine}\n`, 'utf8');

const actual = await waitForCandidateSignature(cbPath, 'planner', seat, candidatePath, 500, 0, {});
console.log(JSON.stringify({ malformedLine, expected: 'signed-mismatched', actual }, null, 2));

await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
process.exit(actual.ok && actual.kind === 'signed-mismatched' ? 0 : 1);
