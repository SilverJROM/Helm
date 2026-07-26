// #50: parse the PLAN-CONTRADICTION marker a worker emits when its task instruction disagrees with the
// verbatim requirement text.
//
// Why this exists: on Pusoy run 22 the implementer hit a deliberately contradictory PC06 brief, spotted
// it ("There's a clear conflict in the brief:"), silently resolved it in favour of the authoritative
// requirement, shipped, and reported DONE. The validator independently verified against the same
// requirement and returned PASS. Nothing failed — so the plan-defect route, which is gated on FAILURE,
// never fired, ibrain was never consulted, and plan.json kept the defect for every downstream task.
//
// The lesson: capability MASKS plan defects. A strong worker routes around a broken plan instead of
// surfacing it, so the better the models get, the blinder the self-healing gets. The marker gives a
// successful task a way to say "this succeeded, AND the plan is still wrong".

export interface PlanContradiction {
  /** What the task instruction claimed. */
  instruction: string;
  /** What the requirement (or other authoritative source) claimed. */
  requirement: string;
  /** What the worker actually implemented, or null when it blocked instead of choosing. */
  resolvedAs: string | null;
  /** True when the worker declined to invent a resolution (underspecified / nothing authoritative). */
  blocked: boolean;
  /** The raw matched line, for the artifact + operator page. */
  raw: string;
}

// Deliberately tolerant of the em-dash/hyphen the models actually emit, and of case.
const MARKER_RE = /PLAN-CONTRADICTION:\s*(.+)/i;
const RESOLVED_RE = /(?:—|--|-)\s*resolved-as:\s*(.+)$/i;

/**
 * Returns the parsed contradiction if `text` (a callback note or changes.md body) carries the marker,
 * else null. Parses the LAST occurrence so a re-emitted marker on a later attempt wins.
 */
export function parsePlanContradiction(text: string): PlanContradiction | null {
  if (!text) return null;
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let hit: string | null = null;
  for (const line of lines) {
    if (MARKER_RE.test(line)) hit = line.trim();
  }
  if (!hit) return null;

  const body = (hit.match(MARKER_RE)?.[1] ?? '').trim();
  const resolvedMatch = body.match(RESOLVED_RE);
  const resolvedRaw = resolvedMatch ? resolvedMatch[1].trim() : null;
  // Strip the resolved-as clause to leave the "X vs Y" claim pair.
  const claimPair = resolvedMatch ? body.slice(0, resolvedMatch.index).trim() : body;

  // "<instruction> vs <requirement>" — split on the LAST standalone " vs " so either side may contain it.
  const vsIdx = claimPair.toLowerCase().lastIndexOf(' vs ');
  const instruction = vsIdx >= 0 ? claimPair.slice(0, vsIdx).trim() : claimPair;
  const requirement = vsIdx >= 0 ? claimPair.slice(vsIdx + 4).trim() : '';

  const blocked =
    resolvedRaw === null ||
    /^none\b/i.test(resolvedRaw) ||
    /\bblocked\b/i.test(resolvedRaw);

  return {
    instruction: instruction.replace(/^[—\-\s]+/, ''),
    requirement: requirement.replace(/[—\-\s]+$/, ''),
    resolvedAs: blocked ? null : resolvedRaw,
    blocked,
    raw: hit,
  };
}
