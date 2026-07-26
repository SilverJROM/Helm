// #48 (2026-07-20): model binding has multiple writable layers that silently disagree. Setting the
// "natural" one (default_model_id, the FK a UI would write) is silently overridden by project_agents
// or agents.model, so a roster edit can have NO effect with no warning. This bit the Pusoy exercise
// three times — the only way to tell what ACTUALLY launched was reading the tmux pane's process name.
//
// This is a diagnostic, not a resolver: it reports, per project agent, when the layers denote different
// models and which one GOVERNS, so whoever configured it is told plainly. Non-breaking (log-only).
//
// Precedence (what actually governs the rung-0 launch), highest first:
//   1. project_agents.model_id           (per-project override — WINS)
//   2. agents.model  (TEXT, launch-legal) (worker-service launch fallback)
//   3. agents.default_model_id            (escalation rung-0 fallback FK)

import type Database from 'better-sqlite3';

export interface BindingDivergence {
  projectId: number;
  role: string;
  governs: string; // the model that actually launches at rung 0
  governsLayer: 'project_agents.model_id' | 'agents.model' | 'agents.default_model_id';
  ignored: Array<{ layer: string; model: string }>; // set-but-overridden layers that disagree
}

export function findModelBindingDivergences(db: Database.Database): BindingDivergence[] {
  const out: BindingDivergence[] = [];
  let rows: any[];
  try {
    rows = db.prepare(`
      SELECT pa.project_id            AS project_id,
             a.name                   AS role,
             a.model                  AS agent_model,
             pam.model_id             AS project_model,
             dm.model_id              AS default_model
      FROM project_agents pa
      JOIN agents a            ON a.id = pa.agent_id
      LEFT JOIN models pam     ON pam.id = pa.model_id
      LEFT JOIN models dm      ON dm.id = a.default_model_id
      ORDER BY pa.project_id, a.name
    `).all();
  } catch {
    return out; // thin fixtures without the full schema
  }

  for (const r of rows) {
    // Determine the governing model + layer by precedence.
    let governs: string | null = null;
    let governsLayer: BindingDivergence['governsLayer'] | null = null;
    if (r.project_model) { governs = r.project_model; governsLayer = 'project_agents.model_id'; }
    else if (r.agent_model) { governs = r.agent_model; governsLayer = 'agents.model'; }
    else if (r.default_model) { governs = r.default_model; governsLayer = 'agents.default_model_id'; }
    if (!governs || !governsLayer) continue;

    // Any OTHER layer that is set to a DIFFERENT model is an ignored, misleading binding.
    const ignored: Array<{ layer: string; model: string }> = [];
    const layers: Array<[string, string | null]> = [
      ['project_agents.model_id', r.project_model],
      ['agents.model', r.agent_model],
      ['agents.default_model_id', r.default_model],
    ];
    for (const [layer, model] of layers) {
      if (layer === governsLayer) continue;
      if (model && model !== governs) ignored.push({ layer, model });
    }
    if (ignored.length > 0) {
      out.push({ projectId: r.project_id, role: r.role, governs, governsLayer, ignored });
    }
  }
  return out;
}

/** Log divergences loudly at startup (non-fatal). Returns the count so callers can assert in tests. */
export function warnModelBindingDivergences(db: Database.Database, log: (m: string) => void = (m) => console.warn(m)): number {
  const divs = findModelBindingDivergences(db);
  for (const d of divs) {
    const ign = d.ignored.map((i) => `${i.layer}=${i.model}`).join(', ');
    log(`[model-binding] project ${d.projectId} role '${d.role}': ${d.governsLayer}=${d.governs} GOVERNS the launch, but these set-but-IGNORED layers disagree: ${ign}. Edit ${d.governsLayer} to change what actually runs.`);
  }
  return divs.length;
}
