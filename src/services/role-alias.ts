// Role aliasing — worker-facing vs internal role identity.
//
// JROM's global claude/codex CLI has heavyweight standalone agents with names that can
// `coord`, `reviewer` (~/.claude/agents/). When Helm dispatches a WORKER into a
// collide with Helm roles. When Helm dispatches a worker into a claude/codex session,
// a raw internal role in brief/callback text risks pulling the model toward learned behavior instead of
// doing Helm's one scoped role. To de-collide WITHOUT the blast radius of a true
// internal rename (DB CHECK constraints, bindings, provider eligibility, seeded rows),
// we present a Helm-namespaced *face* name to the model only. Multiple internal phase
// roles may deliberately share one face, so callbacks are resolved against the expected
// dispatch/run role at ingest rather than through an ambiguous global reverse map.

// Internal role ID  ->  model-facing (worker-facing) name.
export const WORKER_FACE_ROLE: Record<string, string> = {
  plancore: 'helm_pm',
  ibrain: 'helm_pm',
  coord: 'helm_pm_fast',
  reviewer: 'helm_code_review'
};

// The name the model should see for a given internal role. Non-colliding roles
// (implementer, validator, planner, deliberation, red-team, panelist, ...) are unchanged.
export function workerFaceRole(role: string): string {
  const r = (role || '').toLowerCase().trim();
  return WORKER_FACE_ROLE[r] ?? role;
}

// Resolve only unambiguous model-facing aliases. Ambiguous `helm_pm` is preserved.
export function normalizeRole(role: string): string {
  const r = (role || '').toLowerCase().trim();
  if (r === 'helm_pm_fast') return 'coord';
  if (r === 'helm_code_review') return 'reviewer';
  return r;
}

// Match an emitted callback role to the internal role expected by its dispatch/run.
// This is the safe reverse lookup for shared faces: helm_pm matches plancore only in a
// plancore context and ibrain only in an ibrain context.
export function roleMatches(expectedInternalRole: string, emittedRole: string): boolean {
  const expected = (expectedInternalRole || '').toLowerCase().trim();
  const emitted = (emittedRole || '').toLowerCase().trim();
  if (!expected || !emitted) return false;
  return emitted === expected || emitted === workerFaceRole(expected).toLowerCase().trim();
}
