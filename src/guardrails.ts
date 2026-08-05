import type { ProviderRegistry } from './config/providers.js';

export function isLoopbackAddress(remoteAddress?: string): boolean {
  if (!remoteAddress) return false;
  const a = remoteAddress.toLowerCase().trim();
  return (
    a === '127.0.0.1' ||
    a === '::1' ||
    a === '::ffff:127.0.0.1' ||
    a.startsWith('127.') ||
    a === 'localhost'
  );
}

// Private (RFC1918) LAN ranges + IPv4-mapped IPv6 forms. Used only when HELM_ALLOW_LAN_LAUNCH is on.
export function isPrivateLanAddress(remoteAddress?: string): boolean {
  if (!remoteAddress) return false;
  let a = remoteAddress.toLowerCase().trim();
  if (a.startsWith('::ffff:')) a = a.slice(7); // unwrap IPv4-mapped IPv6
  const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  return (
    o1 === 10 ||                              // 10.0.0.0/8
    (o1 === 172 && o2 >= 16 && o2 <= 31) ||   // 172.16.0.0/12
    (o1 === 192 && o2 === 168)                // 192.168.0.0/16
  );
}

// A mutating/launch request is allowed from loopback always. When HELM_ALLOW_LAN_LAUNCH=1 (opt-in), a
// request from a private RFC1918 LAN address is ALSO allowed — for a single-user box reached over a
// trusted home LAN via its 0.0.0.0 bind (these endpoints are already behind owner-cred auth; this is a
// second layer for process-spawning ops). Default (env unset) is loopback-only, unchanged.
export function isLaunchAddressAllowed(remoteAddress?: string): boolean {
  if (isLoopbackAddress(remoteAddress)) return true;
  const lanOptIn = process.env.HELM_ALLOW_LAN_LAUNCH === '1';
  return lanOptIn && isPrivateLanAddress(remoteAddress);
}

export function createRequireLocalLaunch() {
  return (request: any, reply: any, done: any) => {
    const addr = request.raw?.socket?.remoteAddress;
    if (!isLaunchAddressAllowed(addr)) {
      reply.code(403).send({
        error: process.env.HELM_ALLOW_LAN_LAUNCH === '1'
          ? 'launch requires loopback or a private-LAN client'
          : 'local launch required (loopback only)'
      });
      return;
    }
    done();
  };
}

export const AGENT_ROLES = [
  'discovery',
  'plancore',
  'ibrain',
  'coord',
  'implementer',
  'validator',
  'deliberation',
  'red-team',
  'planner',
  'routine-implementer',
  'panelist',
  'branch-safety'
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export function createRequireValidRoleProvider(providers: ProviderRegistry) {
  return (request: any, reply: any, done: any) => {
    const role = (request.body?.role || request.params?.role || request.query?.role) as string;
    const provider = (request.body?.provider || 'grok') as string;
    if (!AGENT_ROLES.includes(role as AgentRole) || !providers[provider]) {
      reply.code(400).send({ error: 'invalid role or unknown provider' });
      return;
    }
    done();
  };
}

export function checkCommand(command: string): { blocked: boolean; pattern?: string } {
  const patterns = [
    'rm -rf',
    'rm -r',
    'drop table',
    'drop database',
    'kill -9',
    'reboot',
    'shutdown',
    'mkfs',
    'dd if=',
    'chmod 777',
    '> /dev/'
  ];
  const lower = command.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p)) {
      return { blocked: true, pattern: p };
    }
  }
  return { blocked: false };
}
