// R5b (CC-CHAT-4): in-memory abort registry keyed by runId.
//
// POST /api/runs/:id/stop marks the run terminal in the DB AND flips this flag; the
// in-process OrchestratorLoop consults the flag in its waitForCallback poll loop (every
// ~1s) so a sanctioned stop takes effect within one poll cycle even mid-wait, without any
// DB polling thread. The DB phase/status re-check at each phase boundary (R5a) remains the
// durable source of truth — this registry only makes the stop FAST for the loop that is
// currently running in this process. Process-local by design: a run whose loop died with a
// previous process is already covered by the DB terminal check on any future dispatch.

export interface RunAbortRequest {
  reason: string;
  at: string;
}

const aborts = new Map<number, RunAbortRequest>();

export function requestRunAbort(runId: number, reason: string): void {
  aborts.set(runId, { reason, at: new Date().toISOString() });
}

export function getRunAbort(runId: number): RunAbortRequest | null {
  return aborts.get(runId) ?? null;
}

export function clearRunAbort(runId: number): void {
  aborts.delete(runId);
}
