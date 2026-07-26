/**
 * B10b / R2.10 — owner approval & authority gates.
 *
 * jkage is seeded at L0 (learner) with decision_authority: none.
 * No code path may let jkage (or any agent actor) exercise JROM/owner
 * approve / reject / direct-authority surfaces enumerated in
 * plan/c01-agent-studio-rebuild/validation/b10-approval-surfaces.md.
 *
 * Pattern matches B07b/B07c: pure assert helper + optional actor on
 * service methods. Production transport (src/index.ts) MUST mint actor
 * from the verified token via decisionActorFromRequestUser — never body.
 * Omitted actor remains allow only for legacy in-process owner callers;
 * agent / L0 actor → fail-closed FORBIDDEN.
 */

export type DecisionActor = {
  /** Explicit owner path (or omit actor entirely). */
  kind?: 'owner' | 'agent';
  /** Auth role claim; 'owner' allows. */
  role?: string;
  name?: string;
  agent_name?: string;
  agent_id?: number;
  /** Seed frontmatter: authority: L0 */
  authority?: string;
  /** Seed frontmatter: decision_authority: none */
  decision_authority?: string;
  definition_md?: string | null;
};

export const OWNER_AUTHORITY_DENY_RE =
  /jkage|L0|no decision authority|cannot exercise owner approval/i;

/**
 * Mint a trusted DecisionActor from verified request.user (or equivalent).
 * Never call with body fields — only token-derived claims.
 *
 * owner token → { kind:'owner', role:'owner' }
 * anything else (agent / viewer / mis-issued) → agent-like (denied at gates)
 */
export function decisionActorFromRequestUser(user: any): DecisionActor {
  if (user?.role === 'owner') {
    return { kind: 'owner', role: 'owner' };
  }
  const name =
    user?.name ??
    user?.agent_name ??
    user?.username ??
    user?.displayName ??
    undefined;
  const agentId =
    user?.agent_id != null && user.agent_id !== ''
      ? Number(user.agent_id)
      : undefined;
  return {
    kind: 'agent',
    role: user?.role != null ? String(user.role) : undefined,
    name: name != null ? String(name) : undefined,
    agent_name: name != null ? String(name) : undefined,
    agent_id: Number.isFinite(agentId as number) ? (agentId as number) : undefined,
    authority: user?.authority,
    decision_authority: user?.decision_authority,
  };
}

/** Master-chat / loopback ingest: always agent (never owner). */
export function decisionActorFromIngest(opts?: {
  name?: string;
  agent_id?: number | null;
}): DecisionActor {
  return {
    kind: 'agent',
    name: opts?.name ?? 'master-chat',
    agent_name: opts?.name ?? 'master-chat',
    agent_id: opts?.agent_id != null ? Number(opts.agent_id) : undefined,
  };
}

export function isJkageOrL0Actor(actor: DecisionActor): boolean {
  const name = String(actor.agent_name ?? actor.name ?? '').toLowerCase();
  if (name === 'jkage' || name === 'jkagebunshin') return true;
  if (String(actor.authority || '').toUpperCase() === 'L0') return true;
  if (String(actor.decision_authority || '').toLowerCase() === 'none') return true;
  const md = actor.definition_md || '';
  if (/authority:\s*L0/i.test(md)) return true;
  if (/decision_authority:\s*none/i.test(md)) return true;
  return false;
}

/**
 * Fail-closed owner-gate check.
 * - null/undefined actor → allow (legacy in-process owner callers only;
 *   production HTTP must pass decisionActorFromRequestUser)
 * - kind/role owner → allow
 * - any agent / jkage / L0 actor → throw FORBIDDEN
 */
export function assertOwnerDecisionAuthority(actor?: DecisionActor | null): void {
  if (actor == null) return;
  if (actor.kind === 'owner' || actor.role === 'owner') return;

  const name = String(actor.agent_name ?? actor.name ?? '').toLowerCase();
  const agentLike =
    actor.kind === 'agent' ||
    actor.agent_id != null ||
    name.length > 0 ||
    isJkageOrL0Actor(actor);

  if (!agentLike) return;

  const who =
    name === 'jkage' || name === 'jkagebunshin'
      ? name
      : isJkageOrL0Actor(actor)
        ? `L0:${name || (actor.agent_id != null ? `id=${actor.agent_id}` : 'agent')}`
        : name || (actor.agent_id != null ? `id=${actor.agent_id}` : 'agent');

  const err: any = new Error(
    `jkage L0 has no decision authority; cannot exercise owner approval gates (${who})`
  );
  err.code = 'FORBIDDEN';
  err.statusCode = 403;
  throw err;
}

/** Canonical jkage L0 actor for tests and defensive call sites. */
export function jkageL0Actor(overrides: Partial<DecisionActor> = {}): DecisionActor {
  return {
    kind: 'agent',
    name: 'jkage',
    agent_name: 'jkage',
    authority: 'L0',
    decision_authority: 'none',
    ...overrides,
  };
}
