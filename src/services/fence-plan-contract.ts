/**
 * fence-workflow-upgrade A2 — authored plan-contract schema (R1.1, R1.2, R1.3).
 *
 * Pure validation of fence objects declared on an execution plan. Each fence carries
 * integration_cmd, negative_control_cmd, acceptance_ids, test_path, authored_by, and
 * exact member ids. Refuse missing NC, unknown/duplicate member, or >5 members at accept.
 * DB ingest of fences/fence_members is A3 — this module only shapes + refuses at plan accept.
 */

/** Ceiling on contributing units per fence (TILLER-USAGE §1.4 / brief §2.1). */
export const FENCE_MEMBER_CEILING = 5;

/** Contract fields required on every authored fence (R1.2 + plan-time test ownership). */
export const FENCE_CONTRACT_REQUIRED_FIELDS = [
  'integration_cmd',
  'negative_control_cmd',
  'acceptance_ids',
  'test_path',
  'authored_by',
  'members',
] as const;

export type FenceContractRequiredField = (typeof FENCE_CONTRACT_REQUIRED_FIELDS)[number];

/** Normalized fence row preserved through the execution-plan accept path. */
export interface FencePlanContract {
  fence_key: string;
  integration_cmd: string;
  negative_control_cmd: string;
  acceptance_ids: string[];
  test_path: string;
  authored_by: string;
  /** Exact contributing task ids (ceiling FENCE_MEMBER_CEILING). */
  members: string[];
  label?: string;
}

export type ValidatePlanFencesResult =
  | { ok: true; fences: FencePlanContract[] }
  | { ok: false; errors: string[] };

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function fenceLabel(key: string): string {
  return `fence '${key}'`;
}

/**
 * Normalize a raw `fences` value into keyed entries.
 * Accepts:
 *   - record keyed by fence_key: { "I1": { integration_cmd, ... } }
 *   - array of objects each with id|fence_key: [ { "id":"I1", ... }, ... ]
 */
export function coerceFenceEntries(
  raw: unknown
): { ok: true; entries: Array<{ key: string; body: Record<string, unknown> }> } | { ok: false; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, entries: [] };
  }
  if (Array.isArray(raw)) {
    const entries: Array<{ key: string; body: Record<string, unknown> }> = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, error: `fences[${i}]: must be an object` };
      }
      const body = item as Record<string, unknown>;
      const keyRaw = body.fence_key ?? body.id ?? body.key;
      if (!nonEmptyString(keyRaw)) {
        return {
          ok: false,
          error: `fences[${i}]: missing non-empty fence_key (or id)`,
        };
      }
      const key = String(keyRaw).trim();
      entries.push({ key, body });
    }
    return { ok: true, entries };
  }
  if (typeof raw === 'object') {
    const entries: Array<{ key: string; body: Record<string, unknown> }> = [];
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!nonEmptyString(key)) {
        return { ok: false, error: 'fences: empty fence_key is not allowed' };
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: `fence '${key}': must be an object` };
      }
      entries.push({ key: key.trim(), body: value as Record<string, unknown> });
    }
    return { ok: true, entries };
  }
  return { ok: false, error: 'fences must be an object map or an array of fence objects' };
}

/**
 * Validate one fence body against R1.2/R1.3 + member ceiling/membership rules.
 * `knownTaskIds` is the set of task ids declared in the same plan (exact member match).
 */
export function validateOneFenceContract(
  fenceKey: string,
  body: Record<string, unknown>,
  knownTaskIds: ReadonlySet<string>
): { ok: true; fence: FencePlanContract } | { ok: false; errors: string[] } {
  const label = fenceLabel(fenceKey);
  const errors: string[] = [];

  // R1.3 — missing / empty negative_control_cmd is an explicit refusal at accept.
  if (!('negative_control_cmd' in body) || body.negative_control_cmd === null || body.negative_control_cmd === undefined) {
    errors.push(`${label}: missing required field 'negative_control_cmd' (a fence with no negative control is refused at accept)`);
  } else if (!nonEmptyString(body.negative_control_cmd)) {
    errors.push(`${label}: 'negative_control_cmd' must be a non-empty string (a fence with no negative control is refused at accept)`);
  }

  if (!nonEmptyString(body.integration_cmd)) {
    errors.push(`${label}: missing or empty required field 'integration_cmd'`);
  }
  if (!nonEmptyString(body.test_path)) {
    errors.push(`${label}: missing or empty required field 'test_path'`);
  }
  if (!nonEmptyString(body.authored_by)) {
    errors.push(`${label}: missing or empty required field 'authored_by'`);
  }

  // acceptance_ids: non-empty string[]
  let acceptance_ids: string[] = [];
  if (!('acceptance_ids' in body) || body.acceptance_ids === null || body.acceptance_ids === undefined) {
    errors.push(`${label}: missing required field 'acceptance_ids'`);
  } else if (typeof body.acceptance_ids === 'string' && body.acceptance_ids.trim() !== '') {
    // bare string coerce → 1-element (mirrors req_refs light-model tolerance)
    acceptance_ids = [body.acceptance_ids.trim()];
  } else if (!Array.isArray(body.acceptance_ids)) {
    errors.push(`${label}: field 'acceptance_ids' must be an array of strings`);
  } else if (body.acceptance_ids.length === 0) {
    errors.push(`${label}: field 'acceptance_ids' must be a non-empty array of strings`);
  } else if (!body.acceptance_ids.every((id) => nonEmptyString(id))) {
    errors.push(`${label}: field 'acceptance_ids' must be an array of non-empty strings`);
  } else {
    acceptance_ids = (body.acceptance_ids as string[]).map((id) => id.trim());
  }

  // members: exact task ids, 1..FENCE_MEMBER_CEILING, unique, all known
  let members: string[] = [];
  if (!('members' in body) || body.members === null || body.members === undefined) {
    errors.push(`${label}: missing required field 'members' (exact contributing unit ids)`);
  } else if (!Array.isArray(body.members)) {
    errors.push(`${label}: field 'members' must be an array of task-id strings`);
  } else if (body.members.length === 0) {
    errors.push(`${label}: field 'members' must list at least one contributing unit id`);
  } else if (body.members.length > FENCE_MEMBER_CEILING) {
    errors.push(
      `${label}: field 'members' has ${body.members.length} entries — ceiling is ${FENCE_MEMBER_CEILING} contributing units per fence`
    );
  } else {
    const seen = new Set<string>();
    for (const m of body.members) {
      if (!nonEmptyString(m)) {
        errors.push(`${label}: member ${JSON.stringify(m)} must be a non-empty task-id string`);
        continue;
      }
      const id = m.trim();
      if (seen.has(id)) {
        errors.push(`${label}: duplicate member '${id}' — member ids must be unique within a fence`);
        continue;
      }
      seen.add(id);
      if (!knownTaskIds.has(id)) {
        errors.push(`${label}: member '${id}' references an unknown task id (dangling — declare the unit in tasks or remove it)`);
        continue;
      }
      members.push(id);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const fence: FencePlanContract = {
    fence_key: fenceKey,
    integration_cmd: String(body.integration_cmd).trim(),
    negative_control_cmd: String(body.negative_control_cmd).trim(),
    acceptance_ids,
    test_path: String(body.test_path).trim(),
    authored_by: String(body.authored_by).trim(),
    members,
  };
  if (nonEmptyString(body.label)) fence.label = body.label.trim();
  return { ok: true, fence };
}

/**
 * Validate the optional plan-level `fences` object/array against known task ids.
 * Empty / absent fences → ok with []. Duplicate fence_keys refused.
 */
export function validatePlanFences(
  fencesRaw: unknown,
  knownTaskIds: ReadonlySet<string>
): ValidatePlanFencesResult {
  const coerced = coerceFenceEntries(fencesRaw);
  if (!coerced.ok) return { ok: false, errors: [coerced.error] };

  const errors: string[] = [];
  const fences: FencePlanContract[] = [];
  const seenKeys = new Set<string>();

  for (const { key, body } of coerced.entries) {
    if (seenKeys.has(key)) {
      errors.push(`duplicate fence_key '${key}' — fence keys must be unique across the plan`);
      continue;
    }
    seenKeys.add(key);
    const one = validateOneFenceContract(key, body, knownTaskIds);
    if (one.ok) fences.push(one.fence);
    else errors.push(...one.errors);
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, fences };
}
