// Browser-side ID selection only. Phase ownership is resolved by the backend;
// agent names never participate in choosing a phase seat.
export function phaseBrainAgentId(resolution) {
  const brain = resolution && resolution.brain;
  if (!brain) return null;
  const id = brain.agent && brain.agent.id != null ? brain.agent.id : brain.agent_id;
  return id == null ? null : Number(id);
}

export function preferredPhaseAgentId(resolution, selectedId, explicitlySelected = false) {
  if (explicitlySelected && selectedId != null) return Number(selectedId);
  return phaseBrainAgentId(resolution);
}

export default { phaseBrainAgentId, preferredPhaseAgentId };
