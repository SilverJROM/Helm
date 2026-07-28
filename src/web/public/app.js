import { h, render } from 'https://esm.sh/preact@10.19.3';
import { useState, useEffect, useRef } from 'https://esm.sh/preact@10.19.3/hooks';
import htm from 'https://esm.sh/htm@3.1.1';
import { paneLooksGenerating, extractAgentPaneSegment, extractHelmReply, lastCompleteHelmReplyText } from './reply-extractor.js';
import { phaseBrainAgentId, preferredPhaseAgentId } from './phase-agent-selection.js';
import { seatLeaseSendChain } from './cc-session-reconcile.js';
import { markUndeliveredById, applyDeliveryFailedById, hasOutstandingOptimistic } from './cc-delivery.js';
import { captureStickIntent, applyStick } from './pane-bottom-stick.js';
import { SESSION_PANE_CLASSES } from './session-pane.js';
import { stripAnsiForDisplay } from './ansi-strip.js';
import { buildDiscoveryMirrorHtml } from './discovery-mirror.js';
import { isAgentReplyContinuation } from './chat-bubble-merge.js';
import { decideDiscoveryReconcile } from './cc-disc-stream-reconcile.js';

const html = htm.bind(h);
const PA_DEFINITION_MAX = 50000;

// B11 UI2: load marked + DOMPurify from CDN once (no build). Fallback to escaped pre for safety.
let __mdLoaded = false;
(async () => {
  try {
    const [m, d] = await Promise.all([
      import('https://esm.sh/marked@12'),
      import('https://esm.sh/dompurify@3')
    ]);
    window.__marked = (m && m.marked) || m;
    window.__DOMPurify = (d && d.default) || d;
    __mdLoaded = true;
  } catch (e) { /* fallback in render */ }
})();

function MdViewer({ content, maxHeight, testId, className }) {
  const safeHtml = content && window.__DOMPurify && window.__marked
    ? window.__DOMPurify.sanitize(window.__marked.parse(String(content)))
    : content
      ? '<pre style="white-space:pre-wrap">' + String(content).replace(/</g, '&lt;') + '</pre>'
      : '';
  const cls = 'md-viewer' + (className ? ' ' + className : '');
  return html`<div
    data-testid=${testId || 'md-view'}
    class=${cls}
    style=${'background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:10px;margin:0;font-size:12px;line-height:1.5;overflow:auto;max-height:' + (maxHeight || '460px') + ';font-family:system-ui,ui-sans-serif'}
    ref=${(el) => { if (el) el.innerHTML = safeHtml; }}>
  </div>`;
}

// B8-T02: mirrors the fenced-JSON extraction in src/services/execution-plan-parser.ts
// (parseExecutionPlan). The server already validates on read (doc.valid, B8-T01) and on save
// (B3-T04), so the client only re-runs the same extraction to get the task array for rendering —
// callers must gate on doc.valid === true first; this returns [] rather than re-validating.
function parsePlanTasksClient(content) {
  const m = /```json\s*([\s\S]*?)```/im.exec(String(content ?? ''));
  if (!m || !m[1] || !m[1].trim()) return [];
  try {
    const parsed = JSON.parse(m[1].trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

const PROVIDERS = {
  grok: { models: ['grok-4.5', 'grok-composer-2.5-fast'] },
  codex: { models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex-spark'] },
  claude: { models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'] },
  kloo: { models: [], dynamicModels: true }
};
const AGENT_ROLES = ['discovery','plancore','ibrain','coord','implementer','validator','deliberation','red-team','planner','routine-implementer','panelist'];
// B11 / AC-3: panelist retired as product seat (hidden seed remains for runtime). Exclude from
// Project Setup Add-agent / Add-all candidates and Studio team-member agent picks. Backend also
// sets agents.in_development=1 + skips add-all; this is a name-layer belt-and-braces filter.
const isProductRetiredAgent = (a) => String(a?.name || '').toLowerCase() === 'panelist';
const isProjectAddCandidate = (a) => a && !a.in_development && !isProductRetiredAgent(a);
// B7-T04: sentinel selectedDoc value for the synthetic "mockups/" doc-list entry (R-C4) — not a
// real doc path, so the doc-content loader must skip it rather than fetch a nonexistent file.
const CC_DISC_MOCKUPS_KEY = '__mockups__';

function navIconSvg(kind) {
  const svg = (body) => html`<svg class="nav-item-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  if (kind === 'studio') return svg(html`<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>`);
  if (kind === 'setup') return svg(html`<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3H7l1 1.5h3.5A1.5 1.5 0 0 1 13 6v6.5A1.5 1.5 0 0 1 11.5 14h-7A1.5 1.5 0 0 1 3 12.5V4.5z"/><circle cx="8" cy="9" r="1.5"/>`);
  if (kind === 'cmd') return svg(html`<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M5 6.5h4M5 9h6M5 11.5h3"/>`);
  if (kind === 'tracking') return svg(html`<path d="M2.5 13V8.5M6.5 13V5M10.5 13V9.5M14 13V3"/>`);
  if (kind === 'sessions') return svg(html`<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><path d="M5 7h6M5 9.5h4"/>`);
  return svg(html`<ellipse cx="8" cy="5" rx="5" ry="2"/><path d="M3 5v4c0 1.1 2.2 2 5 2s5-.9 5-2V5"/><path d="M3 9v2c0 1.1 2.2 2 5 2s5-.9 5-2V9"/>`);
}

const SECTIONS = {
  studio: { title: 'Agent Studio', tabs: [
    {slug: '02-studio-agents', key: 'agents', label: 'Agents'},
    {slug: '01-studio-models', key: 'models', label: 'Models'},
    {slug: '05-studio-tiers', key: 'tiers', label: 'Tiers'},
    {slug: '07-studio-teams', key: 'teams', label: 'Teams'},
    {slug: '06-studio-telemetry', key: 'telemetry', label: 'Telemetry'},
    {slug: '03-studio-plumbing-watchers', key: 'plumbing', label: 'Plumbing / Watchers'},
    {slug: '04-studio-routing', key: 'routing', label: 'Routing'}
  ]},
  setup: { title: 'Project Setup', tabs: [
    {slug: '04-projects', key: 'projects', label: 'Projects'}
  ]},
  cmd: { title: 'Command Center', tabs: [
    // B6-T01: the 4 phase slugs (Discovery/Planning/Implementation/Final Tests) that lived here are
    // superseded by the per-cycle workspace's own phase-tab strip (renderCommandCenterWorkspace) —
    // collapsed to Overview-only so there is exactly one phase-tab UI, not two out-of-sync strips.
    {slug: '07-command-center-overview', key: 'overview', label: 'Overview'}
  ]},
  memory: { title: 'Memory', tabs: [
    {slug: '10-memory', key: 'memory', label: 'Memory'}
  ]},
  tracking: { title: 'Tracking', tabs: [
    {slug: '12-tracking', key: 'tracking', label: 'Tracking'}
  ]},
  // S14b: human manual-close surface for registry sessions (owner + status; Close only for owner=human).
  sessions: { title: 'Sessions', tabs: [
    {slug: '13-sessions', key: 'sessions', label: 'Sessions'}
  ]}
};

const THEME_KEY = 'helm_theme';

let __chatMsgSeq = 0;
function nextChatMsgId() {
  __chatMsgSeq += 1;
  return 'cm-' + Date.now() + '-' + __chatMsgSeq;
}
function formatChatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatRelativeTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function normalizeOptionalText(value) {
  const text = value == null ? '' : String(value);
  return text.trim() ? text : null;
}
function normalizeTagList(values) {
  const raw = Array.isArray(values) ? values : [];
  const seen = new Set();
  const tags = [];
  raw.forEach(value => {
    const tag = String(value == null ? '' : value).trim();
    if (!tag) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  });
  return tags;
}
function memoryScopeChipClass(scope) {
  if (scope === 'project') return 'chip-green';
  if (scope === 'agent') return 'chip-purple';
  return 'chip-blue';
}
const MEMORY_SCOPE_ORDER = { app: 0, project: 1, agent: 2 };
function memoryScopeLabel(scope) {
  if (scope === 'project') return 'project-scoped';
  if (scope === 'agent') return 'agent-meta';
  return 'app-scoped';
}
function memoryOneLineSummary(m) {
  const d = (m.description || '').trim();
  if (d) return d;
  const b = (m.body || '').trim();
  if (!b) return '—';
  return b.split(/\r?\n/)[0].trim().slice(0, 120) || '—';
}
const STUDIO_ACTIVITY_CAP = 10;
const ACTIVITY_STATE_VERBS = {
  'master-launched': 'launched',
  'deliver-failed': 'delivery failed',
  'done': 'completed',
  'working': 'in progress',
  'blocked': 'blocked',
  'switched': 'model switched',
  'auto-fallback': 'auto fallback',
  'rules-refresh': 'rules refreshed',
  'repro-confirmed': 'repro confirmed',
  'repro-failed': 'repro failed',
  'pass': 'gate passed',
  'fail': 'validation failed',
  'gate-pass': 'gate passed',
  'gate-passed': 'gate passed',
};
function activitySubject(ev) {
  const batch = String(ev.batch_id || '').trim();
  if (batch) return batch;
  return String(ev.role || '').trim().toLowerCase();
}
function stateVerb(state) {
  if (!state) return '';
  const s = String(state).trim().toLowerCase();
  if (ACTIVITY_STATE_VERBS[s]) return ACTIVITY_STATE_VERBS[s];
  return s.replace(/-/g, ' ');
}
function activityBodyDetail(body) {
  const raw = body.task || body.progress || body.error;
  if (raw == null || raw === '') return '';
  return String(raw).trim().slice(0, 48);
}
function activityProseLine(subject, verb, detail) {
  let line = '';
  if (subject && verb) line = `${subject} ${verb}`;
  else if (verb) line = verb;
  else if (subject) line = subject;
  else line = 'event';
  const d = detail ? String(detail).trim() : '';
  if (d) line += ` · ${d}`;
  return line;
}
function activityEventIso(ev) {
  const body = ev.body || {};
  if (ev.seq != null && /^\d{4}-\d{2}-\d{2}T/.test(String(ev.seq))) return String(ev.seq);
  if (ev.ts != null && /^\d{4}-\d{2}-\d{2}T/.test(String(ev.ts))) return String(ev.ts);
  const corr = String(ev.correlation_id || '');
  const cm = corr.match(/:(\d{13})$/);
  if (cm) return new Date(Number(cm[1])).toISOString();
  for (const k of ['timestamp', 'ts', 'created_at', 'at']) {
    const v = body[k];
    if (v != null && /^\d{4}-\d{2}-\d{2}T/.test(String(v))) return String(v);
  }
  return null;
}
function activityDotClass(ev) {
  const state = String(ev.state || '').toLowerCase();
  const type = String(ev.type || '').toLowerCase();
  if (/fail|error|blocked|deliver-failed/.test(state)) return 'as-activity-dot-red';
  if (/done|pass|success|complete|approved|switched|repro-cleared/.test(state)) return 'as-activity-dot-green';
  if (type === 'gate' || state === 'working' || /launch|park|ingest|requested/.test(state)) return 'as-activity-dot-amber';
  return 'as-activity-dot-grey';
}
function activityEventText(ev) {
  const body = ev.body || {};
  const state = String(ev.state || '').trim().toLowerCase();
  const role = String(ev.role || '').trim().toLowerCase();
  const subject = activitySubject(ev);
  const detail = activityBodyDetail(body);
  const type = String(ev.type || '').toLowerCase();

  if (type === 'message') {
    const t = String(body.text || '').trim();
    if (t) return t.length > 88 ? `${t.slice(0, 85)}…` : t;
    return activityProseLine(role || 'message', 'message received', detail);
  }
  if (type === 'tool') {
    return activityProseLine(subject || role, 'tool called', detail);
  }
  if (type === 'gate') {
    return activityProseLine(subject, stateVerb(state) || 'gate event', detail);
  }
  if (type === 'status') {
    return activityProseLine(subject || role, stateVerb(state) || 'status update', detail);
  }
  const verb = stateVerb(state);
  if (verb) return activityProseLine(subject || role, verb, detail);
  const fallbackVerb = type ? type.replace(/-/g, ' ') : 'event';
  return activityProseLine(role || subject, fallbackVerb, detail);
}
function activityEventTime(ev) {
  const iso = activityEventIso(ev);
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return formatChatTime(d);
}
function normalizeActivityFeed(events) {
  const sorted = [...(events || [])].sort((a, b) => {
    const ia = Number(a.id) || 0;
    const ib = Number(b.id) || 0;
    if (ib !== ia) return ib - ia;
    const sa = Number(a.seq) || 0;
    const sb = Number(b.seq) || 0;
    return sb - sa;
  });
  return sorted.slice(0, STUDIO_ACTIVITY_CAP);
}
function fetchActivitySnapshot(projectId, authToken) {
  return new Promise((resolve) => {
    if (!projectId || !authToken) {
      resolve([]);
      return;
    }
    let settled = false;
    const finish = (events) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { es.close(); } catch {}
      resolve(events);
    };
    const es = new EventSource(`/api/projects/${projectId}/activity?access_token=${encodeURIComponent(authToken)}`);
    const timer = setTimeout(() => finish([]), 8000);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        if (data.snapshot === true && Array.isArray(data.recent)) finish(data.recent);
      } catch {
        finish([]);
      }
    };
    es.onerror = () => finish([]);
  });
}
// Reply extraction now imported from ./reply-extractor.js (G1: pure module for unit tests + hardened
// plain-prose + chrome stripping). The 4 required cases are covered in reply-extractor.test.ts.
// renderChatMessageBody stays here (uses html).
function renderChatMessageBody(text) {
  const raw = String(text || '');
  const parts = raw.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    const fence = part.match(/^```(\w*)\r?\n?([\s\S]*?)```$/);
    if (fence) {
      return html`<pre class="as-chat-code" data-testid="as-chat-code-block" key=${'c' + i}>${fence[2]}</pre>`;
    }
    if (!part) return null;
    return html`<span key=${'t' + i} style="white-space:pre-wrap">${part}</span>`;
  });
}

function agentInitial(name) {
  const n = String(name || '').trim();
  return (n[0] || '?').toUpperCase();
}

function resolveAgentBoundModel(agent, modelsList) {
  const models = modelsList || [];
  if (agent?.default_model_id) {
    return models.find(m => m.id === agent.default_model_id) || null;
  }
  const provider = agent?.provider;
  const model = agent?.model;
  if (!provider || !model) return null;
  return models.find(m => m.provider === provider && (m.model_id === model || m.name === model)) || null;
}

function agentHasLiveSession(agentId, cache, selectedId, currentSid) {
  if (agentId && selectedId === agentId && currentSid) return true;
  return !!(agentId && cache?.[agentId]?.sid);
}

function agentStatusDotState(agent, modelsList, cache, selectedId, currentSid) {
  if (agentHasLiveSession(agent.id, cache, selectedId, currentSid)) return 'green';
  if (agent.in_development) return 'amber';
  const bound = resolveAgentBoundModel(agent, modelsList);
  if (!bound) return 'grey';
  const st = bound.validation_status || 'untested';
  if (st === 'valid') return 'green';
  if (st === 'invalid') return 'grey';
  return 'amber';
}

function memberModelDotState(modelId, modelsList) {
  const m = (modelsList || []).find(x => x.id === modelId);
  if (!m) return 'grey';
  const st = m.validation_status || 'untested';
  if (st === 'valid') return 'green';
  if (st === 'invalid') return 'grey';
  return 'amber';
}

function teamNavDotState(teamId, membersByTeam, agentsList, modelsList, cache, selectedId, currentSid) {
  const members = membersByTeam?.[teamId] || [];
  if (!members.length) return 'grey';
  const states = members.map(m => {
    if (m.member_type === 'agent' && m.agent_id) {
      const agent = (agentsList || []).find(a => a.id === m.agent_id);
      if (!agent) return 'grey';
      return agentStatusDotState(agent, modelsList, cache, selectedId, currentSid);
    }
    return memberModelDotState(m.model_id, modelsList);
  });
  if (states.includes('green')) return 'green';
  if (states.includes('amber')) return 'amber';
  return 'grey';
}

function deriveAgentFrontmatterField(md, field) {
  const text = String(md || '').trim();
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return '';
  const re = new RegExp(`^\\s*${field}\\s*:`, 'i');
  const line = fmMatch[1].split('\n').find(l => re.test(l));
  if (!line) return '';
  return line.replace(new RegExp(`^\\s*${field}\\s*:\\s*`, 'i'), '').trim().replace(/^['"]|['"]$/g, '');
}

/** B10c / R2.10: jkage is L0 learner — UI badge only (no routing controls). */
function isJkageL0Learner(agent, definitionMd) {
  const name = String(agent?.name || '').toLowerCase();
  if (name === 'jkage' || name === 'jkagebunshin') return true;
  const md = definitionMd != null ? definitionMd : (agent?.definition_md || '');
  const role = deriveAgentFrontmatterField(md, 'role');
  if (/^jkage(bunshin)?$/i.test(String(role || ''))) return true;
  const authority = deriveAgentFrontmatterField(md, 'authority');
  const label = deriveAgentFrontmatterField(md, 'authority_label');
  // Only stamp L0/learner when role or name already points at jkage (badge is for R2.10 jkage, not any future L0).
  if ((/^l0$/i.test(authority) || /^learner$/i.test(label)) && /^jkage/i.test(name || role || '')) return true;
  return false;
}

function jkageL0LearnerBadge(testId) {
  return html`<span
    data-testid=${testId || 'as-jkage-l0-badge'}
    class="chip chip-orange as-jkage-l0-badge"
    title="L0 learner — no routing · no decision authority"
  >L0 · learner</span>`;
}

/** B11 / R2.7: normalize agent kind (project | house). Legacy helm → house. */
function agentKind(agent) {
  const raw = String(agent?.kind || agent?.agent_type || '').toLowerCase().trim();
  if (raw === 'house' || raw === 'helm') return 'house';
  if (raw === 'project') return 'project';
  // Default unknown/missing to project so house fence is never silent-misclassified as house.
  return 'project';
}

function isHouseKind(agent) {
  return agentKind(agent) === 'house';
}

/** B11: visible kind chip on roster rows (CC chip tokens). */
function agentKindChip(kind) {
  const k = kind === 'house' ? 'house' : 'project';
  const cls = k === 'house' ? 'chip chip-purple as-agent-kind-chip' : 'chip chip-teal as-agent-kind-chip';
  const title = k === 'house'
    ? 'kind: house — not fenced into a single project'
    : 'kind: project — fenced into a project run';
  return html`<span data-testid="as-agent-kind-chip" data-kind=${k} class=${cls} title=${title}>${k}</span>`;
}

function deriveAgentDescription(md) {
  const text = String(md || '').trim();
  if (!text) return '';
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const descLine = fmMatch[1].split('\n').find(l => /^\s*description\s*:/i.test(l));
    if (descLine) {
      const val = descLine.replace(/^\s*description\s*:\s*/i, '').trim().replace(/^['"]|['"]$/g, '');
      if (val) return val;
    }
  }
  const body = fmMatch ? text.slice(fmMatch[0].length).trim() : text;
  const heading = body.match(/^#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const line = body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#') && !l.startsWith('```'));
  return line ? line.slice(0, 200) : '';
}

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem('helm_token') || '');
  const [loginCred, setLoginCred] = useState('');
  const [error, setError] = useState('');
  const [tgLogin, setTgLogin] = useState({ phase: 'idle', challengeId: '', displayNumber: null, message: '', timeoutAt: 0 });
  const [currentSlug, setCurrentSlug] = useState('02-studio-agents');
  const [agentsList, setAgentsList] = useState([]);
  const [theme, setTheme] = useState('dark');
  const [drawerOpen, setDrawerOpen] = useState(false);
  // B1 Models (S1) + B06 R1.1 cascade CLI→provider→model
  const [modelsList, setModelsList] = useState([]);
  const [editingModel, setEditingModel] = useState(null);
  const [modelForm, setModelForm] = useState({ name: '', cli: '', provider: '', model_id: '', slug: '', display_name: '', effort: 'medium', approval: 'auto', flags: '', route: '' });
  const [modelErr, setModelErr] = useState('');
  const [validatingModelIds, setValidatingModelIds] = useState(() => new Set());
  // B06 cascade facet lists (from B05 GET /api/models/clis|providers|models)
  const [modelClis, setModelClis] = useState([]);
  const [modelProviders, setModelProviders] = useState([]);
  const [cascadeModels, setCascadeModels] = useState([]);
  // B3 (kloo): cascading Provider(route)->Model dropdowns, gated on modelForm.provider === 'kloo'
  const [klooRoutesList, setKlooRoutesList] = useState([]);
  const [klooRoutesLoading, setKlooRoutesLoading] = useState(false);
  const [klooModels, setKlooModels] = useState({ models: [], cached: false, note: '' });
  const [klooModelsLoading, setKlooModelsLoading] = useState(false);
  const [klooModelFilter, setKlooModelFilter] = useState('');
  // B12c / R3.12: studio role_tiers editor (implementer|validator × L1|L2|L3 × primary+backup)
  const [roleTiersDraft, setRoleTiersDraft] = useState({});
  const [roleTiersErr, setRoleTiersErr] = useState('');
  const [roleTiersOk, setRoleTiersOk] = useState('');
  const [roleTiersSaving, setRoleTiersSaving] = useState(false);
  const [roleTiersLoaded, setRoleTiersLoaded] = useState(false);
  // B17 / R4: studio team_tiers editor (deliberation|red-team × budget|standard|elite ordered models)
  const [teamTiersDraft, setTeamTiersDraft] = useState({});
  const [teamTiersAddPick, setTeamTiersAddPick] = useState({});
  const [teamTiersErr, setTeamTiersErr] = useState('');
  const [teamTiersOk, setTeamTiersOk] = useState('');
  const [teamTiersSaving, setTeamTiersSaving] = useState(false);
  const [teamTiersLoaded, setTeamTiersLoaded] = useState(false);
  // B15c / R3.15: implementer L3 telemetry (Reading B M2+M5)
  const [telemetryView, setTelemetryView] = useState(null);
  const [telemetryErr, setTelemetryErr] = useState('');
  const [telemetryOk, setTelemetryOk] = useState('');
  const [telemetryBusy, setTelemetryBusy] = useState(false);
  // B20 / R5.23 intended vs actual (freeze vs resolve stamps)
  const [intendedActualView, setIntendedActualView] = useState(null);
  const [intendedActualOk, setIntendedActualOk] = useState('');
  // B2 Agents master-detail (S2 + standing gates 3/4)
  const [selectedAgentId, setSelectedAgentId] = useState(null);
  const [agentName, setAgentName] = useState('');
  const [agentDefMd, setAgentDefMd] = useState('');
  const [defMdMode, setDefMdMode] = useState('hidden');
  const [expandedSkillId, setExpandedSkillId] = useState(null);
  const [bindings, setBindings] = useState({ default_model_id: '', backup_model_id: '', spawn_pref: 'tmux' });
  const [attachedToolkits, setAttachedToolkits] = useState([]);
  const [allToolkits, setAllToolkits] = useState([]);
  const [agentErr, setAgentErr] = useState('');
  const [agentEscalations, setAgentEscalations] = useState([]);
  // B9 / AC-14: Studio create-by-type (solo|tiered|team); independent of kind/agent_type
  const [agentClassification, setAgentClassification] = useState('solo');
  // Agent-level default effort (solo + tiered L1); whitelist low|medium|high|xhigh|max
  const [agentDefaultEffort, setAgentDefaultEffort] = useState('medium');
  // D1: per-agent readiness flag
  const [agentInDev, setAgentInDev] = useState(false);
  // B4: agent detail workspace tabs (Identity default)
  const [agentDetailTab, setAgentDetailTab] = useState('identity');
  // C1b: test-chat panel state
  const [chatSid, setChatSid] = useState(null);
  const [chatPaneContent, setChatPaneContent] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [chatErr, setChatErr] = useState('');
  const [chatConnecting, setChatConnecting] = useState(false);
  const [chatThreadMessages, setChatThreadMessages] = useState([]);
  // HB3: chat-first center — default hero surface; config editor is secondary
  const [studioCenterView, setStudioCenterView] = useState('chat');
  const [studioChatOpen, setStudioChatOpen] = useState(true);
  // Test-chat UX (JROM 2026-06-22): tmux session name (attach-able), send mutex, Chat/Logs tabs, collapsible rails.
  const [chatTmuxSession, setChatTmuxSession] = useState(null);
  const [sendPending, setSendPending] = useState(false);
  const [chatCtxPending, setChatCtxPending] = useState(false); // A2: clear/compact context in-flight guard
  const [chatQueued, setChatQueued] = useState(false);
  const [activeSessions, setActiveSessions] = useState([]);
  const [chatSpawnModelOverride, setChatSpawnModelOverride] = useState(''); // AGENTROLE T5: per-agent model override (PROJECT agents)
  const [chatActualSpawnModel, setChatActualSpawnModel] = useState(''); // model the current session was actually spawned with
  const [agentRenameEditing, setAgentRenameEditing] = useState(false);
  const [agentRenameDraft, setAgentRenameDraft] = useState('');
  const [chatCenterTab, setChatCenterTab] = useState('chat'); // 'chat' | 'logs'
  const [chatLogs, setChatLogs] = useState('');
  const [agentsColCollapsed, setAgentsColCollapsed] = useState(() => localStorage.getItem('helm_agents_collapsed') === '1');
  const [contextColCollapsed, setContextColCollapsed] = useState(() => localStorage.getItem('helm_context_collapsed') === '1');
  const toggleAgentsCol = () => setAgentsColCollapsed(v => { const n = !v; localStorage.setItem('helm_agents_collapsed', n ? '1' : '0'); return n; });
  const toggleContextCol = () => setContextColCollapsed(v => { const n = !v; localStorage.setItem('helm_context_collapsed', n ? '1' : '0'); return n; });
  // Impl-UI: collapse the main left nav sidebar to a thin rail so the terminals get more room.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('helm_sidebar_collapsed') === '1');
  const toggleSidebar = () => setSidebarCollapsed(v => { const n = !v; localStorage.setItem('helm_sidebar_collapsed', n ? '1' : '0'); return n; });
  const COL_RAIL_MIN = 220, COL_RAIL_MAX = 420, COL_RAIL_DEFAULT = 280;
  const CHAT_LOGS_MIN = 280, CHAT_MIN_DESKTOP = 420;
  const loadStoredPx = (key, fallback) => {
    try { const v = parseInt(localStorage.getItem(key), 10); return Number.isFinite(v) ? v : fallback; } catch { return fallback; }
  };
  const clampPx = (n, min, max) => Math.min(max, Math.max(min, n));
  const [colAgentsWidth, setColAgentsWidth] = useState(() => clampPx(loadStoredPx('helm_col_agents', COL_RAIL_DEFAULT), COL_RAIL_MIN, COL_RAIL_MAX));
  const [colContextWidth, setColContextWidth] = useState(() => clampPx(loadStoredPx('helm_col_context', COL_RAIL_DEFAULT), COL_RAIL_MIN, COL_RAIL_MAX));
  const [chatCenterMode, setChatCenterMode] = useState(() => { const m = localStorage.getItem('helm_chat_center_mode'); return m === 'split' ? 'split' : 'tabs'; });
  const [chatLogsWidth, setChatLogsWidth] = useState(() => clampPx(loadStoredPx('helm_chat_logs_width', 360), CHAT_LOGS_MIN, 9999));
  const [studioLayoutMobile, setStudioLayoutMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches);
  const tgPollRef = useRef(null);
  const effectiveChatCenterMode = studioLayoutMobile ? 'tabs' : chatCenterMode;
  const persistChatCenterMode = (m) => { localStorage.setItem('helm_chat_center_mode', m); setChatCenterMode(m); };
  const chatCenterSplitRef = useRef(null);
  const chatTmuxSessionRef = useRef(null);
  const clampChatLogsWidth = (w, centerW) => {
    const maxByRatio = Math.floor(centerW * 0.55);
    const maxAllowed = Math.max(CHAT_LOGS_MIN, Math.min(maxByRatio, centerW - CHAT_MIN_DESKTOP - 6));
    return clampPx(w, CHAT_LOGS_MIN, maxAllowed);
  };
  const startColRailDrag = (which, e) => {
    if (studioLayoutMobile) return;
    e.preventDefault();
    const startX = e.clientX;
    const startAgents = colAgentsWidth;
    const startContext = colContextWidth;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      if (which === 'agents') {
        const w = clampPx(startAgents + dx, COL_RAIL_MIN, COL_RAIL_MAX);
        setColAgentsWidth(w);
        localStorage.setItem('helm_col_agents', String(w));
      } else {
        const w = clampPx(startContext - dx, COL_RAIL_MIN, COL_RAIL_MAX);
        setColContextWidth(w);
        localStorage.setItem('helm_col_context', String(w));
      }
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.classList.remove('as-col-dragging');
    };
    document.body.classList.add('as-col-dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };
  const startChatLogsDrag = (e) => {
    if (studioLayoutMobile || effectiveChatCenterMode !== 'split') return;
    e.preventDefault();
    const centerW = chatCenterSplitRef.current?.offsetWidth || 800;
    const startX = e.clientX;
    const startW = chatLogsWidth;
    const onMove = (ev) => {
      const w = clampChatLogsWidth(startW + (startX - ev.clientX), centerW);
      setChatLogsWidth(w);
      localStorage.setItem('helm_chat_logs_width', String(w));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.classList.remove('as-col-dragging');
    };
    document.body.classList.add('as-col-dragging');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };
  const [studioAppMemCount, setStudioAppMemCount] = useState(null);
  const [studioContextMemories, setStudioContextMemories] = useState([]);
  const [studioContextActivity, setStudioContextActivity] = useState([]);
  const [studioContextActivityLoaded, setStudioContextActivityLoaded] = useState(false);
  const [studioActivitySortAsc, setStudioActivitySortAsc] = useState(false);
  const [studioPastSessions, setStudioPastSessions] = useState([]);
  const [agentsFilterQuery, setAgentsFilterQuery] = useState('');
  const [agentsActionMenuOpen, setAgentsActionMenuOpen] = useState(false);
  const [contextIdentityExpanded, setContextIdentityExpanded] = useState(false);
  const agentChatCacheRef = useRef({});
  const chatThreadMessagesRef = useRef([]);
  const chatPaneBaselineRef = useRef('');
  const chatPendingUserRef = useRef('');
  const chatThreadScrollRef = useRef(null);
  // E1: pending agent definition proposals (propose→approve)
  const [agentProposals, setAgentProposals] = useState([]);
  // B6d Teams editor state
  const [teamsList, setTeamsList] = useState([]);
  const [teamMembersByTeamId, setTeamMembersByTeamId] = useState({});
  const [selectedTeamId, setSelectedTeamId] = useState(null);
  const [teamForm, setTeamForm] = useState({ name: '', type: 'deliberation', consensus_rule: '', protocol_note: '' });
  const [teamMembers, setTeamMembers] = useState([]);
  const [teamErr, setTeamErr] = useState('');
  const [teamAddModel, setTeamAddModel] = useState('');
  const [teamAddLens, setTeamAddLens] = useState('');
  const [teamAddType, setTeamAddType] = useState('model');
  const [teamAddAgent, setTeamAddAgent] = useState('');

  // B3b Plumbing / Watchers (S3 UI + Context Steward live table with real backend state)
  const [plumbingConfigs, setPlumbingConfigs] = useState([]);
  const [watchStates, setWatchStates] = useState([]);
  const [plumbingForm, setPlumbingForm] = useState({ brain_agent_id: '', backup_brain_agent_id: '', refresh_every_tasks: 10, context_watermark_pct: 80, escalation: 'coordinator stuck AND self-remediation failed (3× attempts)' });
  const [plumbingErr, setPlumbingErr] = useState('');
  const [plumbingPid, setPlumbingPid] = useState(null);
  const [plumbingEs, setPlumbingEs] = useState(null);

  // A5 Routing table (RoutingConfigService.listRules() + validateConfig())
  const [routingRulesList, setRoutingRulesList] = useState([]);
  const [routingValidation, setRoutingValidation] = useState({ ok: true, problems: [] });
  // A6: edit + add state
  const [routingOpErr, setRoutingOpErr] = useState(null); // {error, problems?} | null
  const [editingRuleId, setEditingRuleId] = useState(null);
  const [routingEditForm, setRoutingEditForm] = useState({ handler_role: '', action: '', note: '' });
  const [routingAddForm, setRoutingAddForm] = useState({ emitter_role: '', when_status: '', handler_role: '', action: '', note: '' });

  // C1 Projects (A0/P1)
  const [projectsList, setProjectsList] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [projectStatusById, setProjectStatusById] = useState({});
  const [projectTechStackById, setProjectTechStackById] = useState({});
  const [projectPageSize, setProjectPageSize] = useState(5);
  const [projectPage, setProjectPage] = useState(0);
  const [projectTagFilter, setProjectTagFilter] = useState('');
  const [projectSubTab, setProjectSubTab] = useState('detail');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProjName, setNewProjName] = useState('');
  const [newProjDir, setNewProjDir] = useState('');
  const [editingProject, setEditingProject] = useState(null); // null | { name, dir }
  const [projectOpErr, setProjectOpErr] = useState('');
  const [projectAutonomyDefault, setProjectAutonomyDefault] = useState('pause_after_planning');
  const [projectAutonomySaving, setProjectAutonomySaving] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(false);
  // E-b2: project memory review (short/long) read-only on Projects page
  const [memReviewPid, setMemReviewPid] = useState(null);
  const [memReviewShort, setMemReviewShort] = useState([]);
  const [memReviewLong, setMemReviewLong] = useState([]);

  // A4: register-by-dir plus canonical planning session; no tmux/master is opened by registration.
  const [registerForm, setRegisterForm] = useState({ name: '', directory: '', plancore_session: '' });
  const [registerErr, setRegisterErr] = useState('');
  const [roleProjectId, setRoleProjectId] = useState(null);
  const [roleSel, setRoleSel] = useState({});
  const [redTeam, setRedTeam] = useState([]);
  const [roleErr, setRoleErr] = useState('');

  // C2 Project agents (P2)
  const [projectAgents, setProjectAgents] = useState([]);
  const [projectTeamBindings, setProjectTeamBindings] = useState([]);
  const [paErr, setPaErr] = useState('');
  const [expandedPaAgentId, setExpandedPaAgentId] = useState(null);
  const [paOverrideDetail, setPaOverrideDetail] = useState(null);
  const [paOverrideLoading, setPaOverrideLoading] = useState(false);
  const [paDrawerExpandedToolkitId, setPaDrawerExpandedToolkitId] = useState(null);
  const [paPersonaEditingAid, setPaPersonaEditingAid] = useState(null);
  const [paPersonaDraft, setPaPersonaDraft] = useState('');
  const [paPersonaErr, setPaPersonaErr] = useState('');
  const [paSaveFlash, setPaSaveFlash] = useState(false);
  const paSaveFlashTimerRef = useRef(null);
  const [addAgentSel, setAddAgentSel] = useState('');
  const [addTeamSel, setAddTeamSel] = useState('');

  // v93: per-project adaptive Planner Panel (members / lead / backups / default effort)
  const [plannerPanel, setPlannerPanel] = useState({ members: [], backups: [], default_effort: 'med' });
  const [plannerPanelDirty, setPlannerPanelDirty] = useState(false);
  const [plannerPanelSaving, setPlannerPanelSaving] = useState(false);
  const [plannerPanelErr, setPlannerPanelErr] = useState('');
  const [plannerPanelFlash, setPlannerPanelFlash] = useState(false);
  const plannerPanelFlashTimerRef = useRef(null);

  // B8b: per-role (deliberation | red-team) effective roster editor (Studio vs Project override)
  const ROLE_ROSTER_ROLES = ['deliberation', 'red-team'];
  const emptyRoleRosterState = () => ({
    members: [],
    source: 'studio',
    team_id: null,
    dirty: false,
    saving: false,
    err: '',
    flash: false,
  });
  const [roleRosters, setRoleRosters] = useState({
    deliberation: emptyRoleRosterState(),
    'red-team': emptyRoleRosterState(),
  });
  const roleRosterFlashTimersRef = useRef({ deliberation: null, 'red-team': null });

  // C4 Prompts/Prefs (P4) — read-only
  const [projectDocsList, setProjectDocsList] = useState([]);
  const [viewedDoc, setViewedDoc] = useState(null);
  const [prefsErr, setPrefsErr] = useState('');

  // B11 UI2 Documents (tree + md renderer; reuses above states + activeProjectId for the tab)
  const [docsTree, setDocsTree] = useState([]);
  const [helmDocsTree, setHelmDocsTree] = useState([]);
  const [docSubTab, setDocSubTab] = useState('docs');
  const [docEditing, setDocEditing] = useState(false);
  const [docEditDraft, setDocEditDraft] = useState('');
  const [docEditErr, setDocEditErr] = useState('');
  const [docsNewOpen, setDocsNewOpen] = useState(false);
  const [docsNewFolder, setDocsNewFolder] = useState('');
  const [docsNewName, setDocsNewName] = useState('');
  const [docsNewContent, setDocsNewContent] = useState('');
  const [docsNewErr, setDocsNewErr] = useState('');
  const [docDeleteErr, setDocDeleteErr] = useState('');
  const [projectTaskRows, setProjectTaskRows] = useState({});

  // D2 Command Center chat (HERO per sonnet 07 + JROM 3-way)
  // B5-T01: all-projects Overview board (R-A2) — cycle-status tabs + badge counts.
  const [ccOvData, setCcOvData] = useState(null);
  const [ccOvBucket, setCcOvBucket] = useState('active');
  const [ccOvLoading, setCcOvLoading] = useState(false);
  const [ccOvError, setCcOvError] = useState('');

  // B5-T03: New Cycle dialog (R-B4/E2/C1) — project dropdown + name + autonomy radios (inherited, editable).
  const [ccNcOpen, setCcNcOpen] = useState(false);
  const [ccNcProjectId, setCcNcProjectId] = useState(null);
  const [ccNcName, setCcNcName] = useState('');
  const [ccNcAutonomy, setCcNcAutonomy] = useState('pause_after_planning');
  const [ccNcError, setCcNcError] = useState('');
  const [ccNcSubmitting, setCcNcSubmitting] = useState(false);

  // B6-T01: project cycle workspace (R-A3/E2) — opened in place of the Overview board.
  const [ccWsProjectId, setCcWsProjectId] = useState(null);
  const [ccWsCycleId, setCcWsCycleId] = useState(null);
  const [ccWsTab, setCcWsTab] = useState('discovery');
  const [ccWsSwitcherOpen, setCcWsSwitcherOpen] = useState(false);
  // B6-T02: workspace autonomy popover (R-E2/E3) — editable until Implementation starts.
  const [ccWsAutonomyOpen, setCcWsAutonomyOpen] = useState(false);
  const [ccWsAutonomySaving, setCcWsAutonomySaving] = useState(false);
  const [ccWsAutonomyErr, setCcWsAutonomyErr] = useState('');

  // B7-T01: Discovery tab — split chat (reuses ccSession/ccThread/agent-chat plumbing keyed by
  // ccWsProjectId) + living docs pane, either pane minimizable to a rail (R-C1).
  const [ccDiscChatMin, setCcDiscChatMin] = useState(false);
  // E7: Discovery default view is the 1:1 session mirror (raw pane, formatted for readability,
  // nothing inferred). The reconstructed-bubble view survives behind this toggle — pid -> 'mirror'
  // (default, any value other than 'bubbles') | 'bubbles'.
  const [ccDiscViewMode, setCcDiscViewMode] = useState({});
  // DC-R4: docs rail defaults COLLAPSED (helm_disc_docs_min, default '1'); localStorage-backed.
  const [ccDiscDocsMin, setCcDiscDocsMin] = useState(() => localStorage.getItem('helm_disc_docs_min') !== '0');
  const [ccDiscArtifacts, setCcDiscArtifacts] = useState({});   // cycleId -> {docs,images,flow,other}
  const [ccDiscSelectedDoc, setCcDiscSelectedDoc] = useState({}); // cycleId -> relPath
  const [ccDiscDocContent, setCcDiscDocContent] = useState({});  // "cycleId::relPath" -> {content,...}
  const [ccDiscDocsErr, setCcDiscDocsErr] = useState('');
  // B7-T02: docs pane Edit mode (R-C2) — single workspace open at a time, so non-keyed.
  const [ccDiscDocEditing, setCcDiscDocEditing] = useState(false);
  const [ccDiscDocEditDraft, setCcDiscDocEditDraft] = useState('');
  const [ccDiscDocEditErr, setCcDiscDocEditErr] = useState('');
  // B7-T03: composer image attach (R-C3) + saved image artifacts gallery (R-C4). Auth is
  // Bearer-token, so thumbnails/full-screen fetch bytes via authedFetch and cache blob object
  // URLs here rather than pointing <img src> at the (auth-protected) serve route.
  const [ccDiscAttaching, setCcDiscAttaching] = useState(false);
  const [ccDiscAttachErr, setCcDiscAttachErr] = useState('');
  const [ccDiscImageUrl, setCcDiscImageUrl] = useState({}); // "cycleId::relPath" -> blob object URL
  const ccDiscAttachInputRef = useRef(null);

  // B8-T01: Planning tab — og-requirements.md + plan.md doc cards (R-D1/D3). cycleId ->
  // {ogreq, execplan}, each undefined (loading), 'absent' (404, doc not produced yet), or the
  // doc object {content,valid,...} from GET /docs/:filename.
  const [ccPlanDocs, setCcPlanDocs] = useState({});
  // B8-T02: per-task planning table (R-D2/D4) — id of the row selected for the detail strip.
  // Non-keyed by cycle (single workspace open at a time); reset on cycle switch below.
  const [ccPlanSelectedTaskId, setCcPlanSelectedTaskId] = useState(null);
  // B8-T03: "watch live" pane toggle (R-D1/D3/H4). B4: default open so SEAM-1 panes are visible.
  const [ccPlanWatchLiveOpen, setCcPlanWatchLiveOpen] = useState(true);
  // A3 (R4.17): cycleId -> { seats: [...] } | 'absent' | undefined(loading)
  const [ccPlanSeats, setCcPlanSeats] = useState({});
  // B4 (R5.19): cycleId::runtimeId -> { content, session } from path-safe seat capture
  const [ccPlanSeatPanes, setCcPlanSeatPanes] = useState({});
  const ccPlanPaneBodyRefs = useRef({}); // runtimeId -> scroll body el (bottom-stick)
  // A4 (R4.18): cycleId -> { hasRun, runId?, events: [...] } | 'absent' | undefined(loading)
  const [ccPlanEvents, setCcPlanEvents] = useState({});
  // B8-T04: Approve Planning gate (R-E3/F1) — busy + inline notice for approve POST outcomes.
  const [ccPlanApproving, setCcPlanApproving] = useState(false);
  const [ccPlanApproveNotice, setCcPlanApproveNotice] = useState('');

  // B9-T02: Implementation tab per-task detail (R-F4/F5/F6) — id of the row expanded for the
  // detail block (one-expanded-at-a-time, mirrors the mockup's single running-task detail).
  const [ccImplExpandedTaskId, setCcImplExpandedTaskId] = useState(null);
  // "cycleId::taskId" -> {changes, validation}, each undefined (loading), 'absent' (404 or
  // non-matching route — pre-live the nested tasks/<id>/*.md path isn't wired server-side, so
  // this is the expected steady state until a later batch), or the doc object from GET /docs/:filename.
  const [ccImplTaskDocs, setCcImplTaskDocs] = useState({});
  // B9-T04: collapsed-by-default Docs rail on the right of the Implementation body (R-F6),
  // mirrors the Discovery cc-disc-rail collapse pattern. Not keyed by cycle — single workspace
  // open at a time, mirrors ccPlanSelectedTaskId/ccImplExpandedTaskId non-keyed convention above.
  const [ccImplDocsRailOpen, setCcImplDocsRailOpen] = useState(false);
  // B9-T05: Graceful Stop (R-F7) — "cycleId -> note text" once requested. No safe cycle-level
  // stop signal is wired yet (verified: no method on cycle-service, no 'stopped' status value),
  // so this ONLY records that a stop was requested; it never calls any network/kill/exec path.
  // B10 is the single place that will replace requestGracefulStop()'s body with a real call.
  const [ccGracefulStopNote, setCcGracefulStopNote] = useState({});
  // IS-R2 (impl-start): Start Implementation button. cycleId -> busy flag / inline notice for the
  // POST /start-implementation outcome. The button is enabled purely on (valid plan.md
  // exists AND no active run) — never gated behind Approve-Planning. Clicking it starts the run.
  const [ccImplStarting, setCcImplStarting] = useState({});
  const [ccImplStartNotice, setCcImplStartNotice] = useState({});
  // Start Planning button — same shape, for the phase that PRODUCES the plan. Enabled when there is
  // no valid plan.md yet and no active run (previously this state showed only a dead-end hint, and
  // no UI control anywhere could start a run).
  const [ccPlanStarting, setCcPlanStarting] = useState({});
  const [ccPlanStartNotice, setCcPlanStartNotice] = useState({});
  // Impl-UI: which worker terminal pane is MANUALLY minimized to a thin rail (null | 'implementer'
  // | 'validator'). This is the operator's explicit full-collapse (per-pane header button) and is
  // independent of auto-focus — a manual rail always overrides the auto-resize below.
  const [ccImplCollapsedPane, setCcImplCollapsedPane] = useState(null);
  // Impl-UI: dynamic auto-focus. When ON (default), the worker actively streaming right now grows
  // to the larger share (~68%) and the idle worker SHRINKS to ~32% but stays visible + readable;
  // it follows the run live as work moves implementer<->validator. OFF = equal 50/50 split.
  const [ccImplAutoFocus, setCcImplAutoFocus] = useState(() => localStorage.getItem('helm_impl_autofocus') !== '0');
  const toggleImplAutoFocus = () => setCcImplAutoFocus(v => { const n = !v; localStorage.setItem('helm_impl_autofocus', n ? '1' : '0'); return n; });
  // Impl-UI: the currently-active worker ('implementer' | 'validator' | null), derived live from
  // which pane's tmux text is present / changed most recently (see effect below). Drives auto-focus.
  const [ccImplActiveWorker, setCcImplActiveWorker] = useState(null);
  const implTermPrevRef = useRef({ key: '', implementer: '', validator: '' });
  const implActiveRef = useRef(null);
  // Impl-UI: the T01..Tnn task list defaults collapsed to just the currently-working task;
  // this reveals the full list. Persisted so the operator's choice survives reloads.
  const [ccImplTasklistExpanded, setCcImplTasklistExpanded] = useState(() => localStorage.getItem('helm_impl_tasklist_expanded') === '1');
  const toggleImplTasklist = () => setCcImplTasklistExpanded(v => { const n = !v; localStorage.setItem('helm_impl_tasklist_expanded', n ? '1' : '0'); return n; });
  // Impl-UI: inject the layout CSS for the new toggles once (app.js is the only editable file;
  // index.html's <style> is off-limits, so the rules live here and mount on the document head).
  useEffect(() => {
    const ID = 'helm-impl-ui-improvements';
    if (document.getElementById(ID)) return;
    const el = document.createElement('style');
    el.id = ID;
    el.textContent = `
/* Impl-UI improvements (runtime-injected from app.js) */
.sidebar-collapse-toggle{margin-left:auto;flex:0 0 auto;background:transparent;border:1px solid var(--border);border-radius:5px;color:var(--text-sec);cursor:pointer;font-size:12px;line-height:1;padding:3px 7px}
.sidebar-collapse-toggle:hover{border-color:var(--accent);color:var(--accent)}
@media (min-width:481px){
  #sidebar.sidebar-collapsed{width:54px;min-width:54px}
  #sidebar.sidebar-collapsed .nav-item-label,
  #sidebar.sidebar-collapsed .sidebar-logo-text,
  #sidebar.sidebar-collapsed .nav-brand-mark,
  #sidebar.sidebar-collapsed .sidebar-teams-label,
  #sidebar.sidebar-collapsed .nav-team-name,
  #sidebar.sidebar-collapsed .sidebar-active-section,
  #sidebar.sidebar-collapsed .sidebar-account-text,
  #sidebar.sidebar-collapsed .sidebar-theme-toggle{display:none}
  #sidebar.sidebar-collapsed .sidebar-logo{justify-content:center;padding:12px 4px}
  #sidebar.sidebar-collapsed .sidebar-collapse-toggle{margin-left:0}
  #sidebar.sidebar-collapsed .nav-item{justify-content:center;padding:7px 0}
  #sidebar.sidebar-collapsed .nav-team-row{justify-content:center}
  #sidebar.sidebar-collapsed .sidebar-account-row{justify-content:center}
  #sidebar.sidebar-collapsed .sidebar-teams{max-height:none}
}
/* Feature 2 + B5: readable worker terminals without rigid 440/60vh floor (R6.25) */
.cc-impl-term-row{height:min(50vh,100%);min-height:200px;grid-template-columns:50% 50%;transition:grid-template-columns .28s ease}
.cc-impl-term-row .cmt-term-body{font-size:12.5px;line-height:1.5;min-height:0;overflow:auto}
/* Feature 3: focus active worker — dynamic SHRINK (both visible) + manual full-collapse (rail) */
.cc-impl-term-controls{display:flex;align-items:center;gap:8px;padding:2px 0 8px;flex-wrap:wrap}
.cc-impl-pane-toolbtn{background:transparent;border:1px solid var(--border);border-radius:5px;color:var(--text-sec);cursor:pointer;font-size:11px;line-height:1;padding:3px 8px}
.cc-impl-pane-toolbtn:hover{border-color:var(--accent);color:var(--accent)}
.cc-impl-toolbtn-on{border-color:var(--accent);color:var(--accent)}
/* auto-focus resize: active worker larger (~68%), idle worker smaller (~32%) but still visible */
.cc-impl-term-row.impl-focus-implementer{grid-template-columns:68% 32%}
.cc-impl-term-row.impl-focus-validator{grid-template-columns:32% 68%}
/* manual full-collapse: idle worker becomes a thin rail */
.cc-impl-term-row.impl-collapsed-implementer{grid-template-columns:46px 1fr}
.cc-impl-term-row.impl-collapsed-validator{grid-template-columns:1fr 46px}
.cc-impl-pane-rail{cursor:pointer}
.cc-impl-pane-rail .cmt-term-header{flex-direction:column;height:100%;justify-content:flex-start;gap:10px;padding:8px 4px;border-bottom:none;align-items:center}
.cc-impl-pane-rail-label{writing-mode:vertical-rl;transform:rotate(180deg);font-size:11px;font-weight:700;color:var(--text-sec);letter-spacing:.04em;text-transform:capitalize}
/* Feature 4: task list collapses to the active task */
.cc-impl-tasklist-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border)}
@media (max-width:760px){
  .cc-impl-term-row,
  .cc-impl-term-row.impl-focus-implementer,
  .cc-impl-term-row.impl-focus-validator,
  .cc-impl-term-row.impl-collapsed-implementer,
  .cc-impl-term-row.impl-collapsed-validator{grid-template-columns:1fr;height:auto;min-height:0}
}`;
    document.head.appendChild(el);
  }, []);

  // B11-T04: Final Tests tab (R-G3) — cycleId -> the GET /api/cycles/:id/final-tests-status
  // payload, or 'absent' on error. Single fetch backs all 6 sections (completion banner, smoke,
  // e2e, run history, deploy history, History strip) — same honest real-or-absent seam as B9.
  const [ccFinalTestsStatus, setCcFinalTestsStatus] = useState({});

  // B13-T01b: Implementation tab live state (R-I4/F6) — cycleId -> the GET /api/cycles/:id/run-state
  // payload ({hasRun, tasks}), or 'absent' on error. Replaces the B9 taskState/taskDetail stubs;
  // hasRun:false degrades to the same honest all-pending seam B9 already had for a run-less cycle.
  const [ccRunState, setCcRunState] = useState({});

  // LV-R3: Implementation tab live terminal — key `${cycleId}::${role}` -> {session, text} from
  // GET /api/cycles/:id/task-terminal (server-derived running worker pane). Polled only while the
  // cycle has an active run; empty text / null session falls back to the "No live terminal" placeholder.
  const [ccImplTerm, setCcImplTerm] = useState({});

  // B6-T04: reusable full-screen viewer primitive (R-C2/D3) — Discovery (B7) / Planning (B8)
  // call openFullScreen(kind, title, payload) to show a doc or image full-viewport.
  const [fsViewer, setFsViewer] = useState(null); // null | {kind:'doc'|'image', title, payload}
  const openFullScreen = (kind, title, payload) => setFsViewer({ kind, title, payload });
  const closeFullScreen = () => setFsViewer(null);
  useEffect(() => {
    if (!fsViewer) return;
    const onKeyDown = (e) => { if (e.key === 'Escape') closeFullScreen(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fsViewer]);

  // B7-T01: Discovery tab data load — agents (so the coordinator auto-selects, R-H3) + living docs.
  useEffect(() => {
    if (ccWsTab !== 'discovery' || !ccWsProjectId || !ccWsCycleId || !token) return;
    if (!ccAgents[ccWsProjectId]) loadCcAgents(ccWsProjectId);
  }, [ccWsTab, ccWsProjectId, ccWsCycleId, token]);
  // LIVE-ATTACH / E8 FIX1: auto-attach (and RE-attach) the discovery chat to an ALREADY-RUNNING seat,
  // so the app reflects the live conversation instead of "Session Off / no messages" whenever a seat
  // exists but this browser's live feed is missing — fresh reload, a different browser (the operator's),
  // or Discovery's own stream having been dropped (proxy/tunnel idle timeout, network blip). Was
  // one-shot: returned early forever once ccSession[pid] existed, without ever checking the EventSource
  // was still alive — see SOL diagnosis. Now RECONCILES: on mount, on ccWsTab/ccWsProjectId change, and
  // on a timer, using Discovery's OWN ref (ccDiscChatEsRef) so it can never be starved by the unrelated
  // CC-chat route's stream lifecycle. Never spawns; only attaches.
  const discReconcileRef = useRef(() => {});
  discReconcileRef.current = () => {
    const pid = ccWsProjectId;
    const sess = (ccSessionRef.current || {})[pid] || ccSession[pid];
    const decision = decideDiscoveryReconcile({
      pid,
      session: sess,
      streamReadyState: ccDiscChatEsRef.current ? ccDiscChatEsRef.current.readyState : null,
      activeSessions,
    });
    if (decision.action === 'attach') {
      ccDiscAttachStream(pid, decision.agentId, decision.sid);
    } else if (decision.action === 'discover-and-attach') {
      const next = { sid: decision.sid, agentId: decision.agentId, tmux: decision.tmux };
      setCcSession((p) => { const n = { ...p, [pid]: next }; ccSessionRef.current = n; return n; });
      ccDiscAttachStream(pid, decision.agentId, decision.sid);
    }
  };
  useEffect(() => {
    if (ccWsTab !== 'discovery' || !ccWsProjectId || !token) { ccDiscDetachStream(); return; }
    discReconcileRef.current();
    const id = setInterval(() => discReconcileRef.current(), 4000);
    return () => { clearInterval(id); ccDiscDetachStream(); };
  }, [ccWsTab, ccWsProjectId, token]);
  // B9-T04: Implementation tab's collapsed Docs rail (R-F6) reuses the same cycle-artifacts
  // listing as Discovery's living docs — widen the gate to fire on either tab (same pattern as
  // the B9-T01 plan-docs widen below) rather than duplicating the fetch.
  useEffect(() => {
    if ((ccWsTab !== 'discovery' && ccWsTab !== 'implementation') || !ccWsCycleId || !token) return;
    if (!ccDiscArtifacts[ccWsCycleId]) loadDiscArtifacts(ccWsCycleId);
  }, [ccWsTab, ccWsCycleId, token]);
  // Discovery living-docs are LIVE: the discovery brain writes north-star.md (and later docs) DURING chat,
  // so the once-loaded listing goes stale ("agent said it wrote it, but the pane still says 'No docs
  // yet'"). Poll the artifacts listing while the Discovery tab is open so newly-written docs appear
  // within seconds without a manual reload. loadDiscArtifacts is a plain re-fetch — it keeps the
  // current selection and only auto-selects (prefer north-star.md) when nothing is selected yet.
  useEffect(() => {
    if (ccWsTab !== 'discovery' || !ccWsCycleId || !token) return;
    const id = setInterval(() => { loadDiscArtifacts(ccWsCycleId); }, 4000);
    return () => clearInterval(id);
  }, [ccWsTab, ccWsCycleId, token]);
  useEffect(() => {
    const sel = ccDiscSelectedDoc[ccWsCycleId];
    if (ccWsTab === 'discovery' && ccWsCycleId && sel && sel !== CC_DISC_MOCKUPS_KEY) loadDiscDoc(ccWsCycleId, sel);
  }, [ccWsTab, ccWsCycleId, ccDiscSelectedDoc[ccWsCycleId]]);
  // B8-T01: Planning tab data load — og-requirements.md + plan.md doc cards.
  // B9-T01: Implementation tab reuses the same plan.md (task list + metrics), so widen
  // the gate to fire on either tab rather than duplicating the fetch.
  useEffect(() => {
    if ((ccWsTab !== 'planning' && ccWsTab !== 'implementation') || !ccWsCycleId || !token) return;
    if (!ccPlanDocs[ccWsCycleId]) loadPlanDocs(ccWsCycleId);
  }, [ccWsTab, ccWsCycleId, token]);
  // A3 (R4.17): load cycle seats whenever Planning is open (live or historical).
  useEffect(() => {
    if (ccWsTab !== 'planning' || !ccWsCycleId || !token) return;
    loadCycleSeats(ccWsCycleId);
    const id = setInterval(() => { loadCycleSeats(ccWsCycleId); }, 4000);
    return () => clearInterval(id);
  }, [ccWsTab, ccWsCycleId, token]);
  // B4 (R5.19): poll path-safe pane capture for every live seat while Planning is open (~2s).
  useEffect(() => {
    if (ccWsTab !== 'planning' || !ccWsCycleId || !token) return;
    const payload = ccPlanSeats[ccWsCycleId];
    const seats =
      payload && payload !== 'absent' && Array.isArray(payload.seats) ? payload.seats : [];
    const live = seats.filter((s) => s && s.live);
    if (live.length === 0) return;
    const tick = () => {
      live.forEach((s) => { loadSeatPaneCapture(ccWsCycleId, s); });
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [ccWsTab, ccWsCycleId, token, ccPlanSeats[ccWsCycleId]]);
  // A4 (R4.18): step-level event trail from run_events (not full transcripts).
  useEffect(() => {
    if (ccWsTab !== 'planning' || !ccWsCycleId || !token) return;
    loadCycleEvents(ccWsCycleId);
    const id = setInterval(() => { loadCycleEvents(ccWsCycleId); }, 4000);
    return () => clearInterval(id);
  }, [ccWsTab, ccWsCycleId, token]);
  // B11-T04: Final Tests tab data load (R-G3).
  useEffect(() => {
    if (ccWsTab !== 'final_tests' || !ccWsCycleId || !token) return;
    if (!ccFinalTestsStatus[ccWsCycleId]) loadFinalTestsStatus(ccWsCycleId);
  }, [ccWsTab, ccWsCycleId, token]);
  // B13-T01b: Implementation tab live run-state load (R-I4/F6).
  useEffect(() => {
    if (ccWsTab !== 'implementation' || !ccWsCycleId || !token) return;
    if (!ccRunState[ccWsCycleId]) loadRunState(ccWsCycleId);
  }, [ccWsTab, ccWsCycleId, token]);
  // LIVE workspace (same fix as Discovery's living docs): og-requirements.md/plan.md (Planning),
  // per-task run-state (Implementation), and final-tests status are written/updated by the agents
  // DURING a phase — a once-cached load goes stale. Poll each while its tab is open so they stay live
  // (agents write it → it appears within ~4s, no reload). loadPlanDocs/loadRunState/loadFinalTestsStatus
  // are plain re-fetches that overwrite the cached snapshot; per-row expand/selection is separate UI
  // state and is preserved across a refresh.
  useEffect(() => {
    if ((ccWsTab !== 'planning' && ccWsTab !== 'implementation') || !ccWsCycleId || !token) return;
    const id = setInterval(() => { loadPlanDocs(ccWsCycleId); }, 4000);
    return () => clearInterval(id);
  }, [ccWsTab, ccWsCycleId, token]);
  useEffect(() => {
    if (ccWsTab !== 'implementation' || !ccWsCycleId || !token) return;
    const id = setInterval(() => { loadRunState(ccWsCycleId); }, 4000);
    return () => clearInterval(id);
  }, [ccWsTab, ccWsCycleId, token]);
  // LV-R3: live implementer/validator terminal poll (~2s) — ONLY while the cycle has an active run
  // (runState.runActive). When the run is terminal / no run, this effect is a no-op so completed
  // cycles never poll. Cleans up the interval on tab-change/unmount/run-terminal (no leaked intervals).
  useEffect(() => {
    if (ccWsTab !== 'implementation' || !ccWsCycleId || !token) return;
    const rs = ccRunState[ccWsCycleId];
    const active = !!(rs && rs !== 'absent' && rs.hasRun && rs.runActive);
    if (!active) return;
    const tick = () => {
      loadTaskTerminal(ccWsCycleId, 'implementer');
      loadTaskTerminal(ccWsCycleId, 'validator');
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [ccWsTab, ccWsCycleId, token, !!(ccRunState[ccWsCycleId] && ccRunState[ccWsCycleId] !== 'absent' && ccRunState[ccWsCycleId].hasRun && ccRunState[ccWsCycleId].runActive)]);
  // Impl-UI: derive the actively-working worker live from the 2s terminal poll. Presence of live
  // pane text is the primary signal (the idle worker shows the "No live terminal" placeholder);
  // when both stream, the one that changed this tick wins, else the last active is kept. Recomputes
  // every poll so auto-focus follows the run as work cycles implementer<->validator across tasks.
  useEffect(() => {
    const cid = ccWsCycleId;
    if (!cid) { if (implActiveRef.current !== null) { implActiveRef.current = null; setCcImplActiveWorker(null); } return; }
    const iTxt = ((ccImplTerm[`${cid}::implementer`] || {}).text || '').trim();
    const vTxt = ((ccImplTerm[`${cid}::validator`] || {}).text || '').trim();
    const prev = implTermPrevRef.current;
    const cycleSwitched = prev.key !== cid;
    const iChanged = !cycleSwitched && !!iTxt && iTxt !== prev.implementer;
    const vChanged = !cycleSwitched && !!vTxt && vTxt !== prev.validator;
    implTermPrevRef.current = { key: cid, implementer: iTxt, validator: vTxt };
    let next;
    if (iTxt && !vTxt) next = 'implementer';
    else if (vTxt && !iTxt) next = 'validator';
    else if (iTxt && vTxt) {
      if (iChanged && !vChanged) next = 'implementer';
      else if (vChanged && !iChanged) next = 'validator';
      else next = implActiveRef.current || 'implementer';
    } else next = null;
    if (next !== implActiveRef.current) { implActiveRef.current = next; setCcImplActiveWorker(next); }
  }, [ccImplTerm, ccWsCycleId]);
  useEffect(() => {
    if (ccWsTab !== 'final_tests' || !ccWsCycleId || !token) return;
    const id = setInterval(() => { loadFinalTestsStatus(ccWsCycleId); }, 4000);
    return () => clearInterval(id);
  }, [ccWsTab, ccWsCycleId, token]);

  const [ccOpenTabs, setCcOpenTabs] = useState(() => { try { return JSON.parse(localStorage.getItem('helm_cc_tabs') || '[]'); } catch { return []; } });
  const [ccCurrentId, setCcCurrentId] = useState(null);
  const [ccViewMode, setCcViewMode] = useState(() => localStorage.getItem('helm_cc_mode') || 'split');
  const [ccMessages, setCcMessages] = useState({});
  const [ccTerminal, setCcTerminal] = useState({});
  const [ccComposer, setCcComposer] = useState('');
  const [ccErr, setCcErr] = useState('');
  const ccEsRef = useRef(null);
  const ccPollRef = useRef(null);
  const chatEsRef = useRef(null);
  const [chatDeliveryGap, setChatDeliveryGap] = useState(false); // F2 (Studio chat): SSE signalled a delivery-failure GAP (Studio shares the CC channel cursor/epoch/loss refs)

  // CC-MT: Command Center Multi-Terminal viewer (10-command-center-terminals).
  // Live per-worker tmux tails in a configurable 1x2 / 2x2 grid + roster rail + overflow tabs.
  const [ccMtWorkers, setCcMtWorkers] = useState({});      // pid -> [worker]
  const [ccMtCaptures, setCcMtCaptures] = useState({});     // pid -> { workerId: {session, content} }
  const [ccMtGridSize, setCcMtGridSize] = useState(4);      // 2 or 4
  const [ccMtSelected, setCcMtSelected] = useState({});     // pid -> [workerId|null]
  const [ccMtGridTab, setCcMtGridTab] = useState({});       // pid -> active overflow grid index
  const [ccMtPid, setCcMtPid] = useState(null);
  const [ccMtErr, setCcMtErr] = useState('');
  const ccMtPollRef = useRef(null);

  // B11: CC selected agent per-pid
  const [ccSelectedAgentId,setCcSelectedAgentId]=useState({});
  // BUG-2: Discovery-phase selected agent per-pid — decoupled from the shared main-CC selection so the
  // Discovery pane can default to the `discovery` agent while main CC keeps defaulting to `plancore`.
  const [ccDiscSelectedAgentId,setCcDiscSelectedAgentId]=useState({}); // pid -> agentId (discovery pane)
  const [ccPhaseAgents,setCcPhaseAgents]=useState({});     // pid -> { discovery, planning } backend-resolved seats
  // CC-CHAT-1 B3: Studio-parity project agent chat (picker + fenced session + reply bubbles)
  const [ccAgents,setCcAgents]=useState({});            // pid -> projectAgents rows (project_agents join agents)
  const [ccSession,setCcSession]=useState({});          // pid -> {sid, agentId, tmux}
  const [ccSessConnecting,setCcSessConnecting]=useState({});
  const [ccThread,setCcThread]=useState({});            // pid -> [{id, role:'user'|'agent', text, thinking, fallback, ts}]
  const [ccDeliveryGap,setCcDeliveryGap]=useState({});  // F2: pid -> true when the SSE signalled a delivery-failure GAP (some failures evicted / epoch degraded)
  const [ccGlobalLossWarn,setCcGlobalLossWarn]=useState(false); // F2 round-6: app-wide sticky warning when a hard-cap loss (lossGeneration) occurred; stays until the owner acks
  const [ccLivePane,setCcLivePane]=useState({});        // pid -> latest agent-chat pane from SSE (B6: feeds last-reply strip)
  // B6 / R6.24: last-reply strip mode per project — collapsed (2-line) | expanded | hidden
  const [ccLastReplyStrip, setCcLastReplyStrip] = useState({}); // pid -> 'collapsed'|'expanded'|'hidden'
  const [ccFavAgents,setCcFavAgents]=useState(() => { try { return JSON.parse(localStorage.getItem('helm_cc_fav_agents') || '[]'); } catch { return []; } });
  const ccChatEsRef = useRef(null);                     // one live SSE stream for the current pid's session
  // E8 FIX1: Discovery owns an INDEPENDENT SSE stream. The old Command Center Chat route
  // (07-command-center-chat) closes ccChatEsRef whenever it's not the active route (see the
  // route-lifecycle effect below) — Discovery lives under 07-command-center-overview and must
  // never depend on that shared ref surviving. See SOL diagnosis (plan/_backlog/SOL-discovery-
  // reply-path-diagnosis.md): the second/third reply was lost exactly at this subscription boundary.
  const ccDiscChatEsRef = useRef(null);
  const ccPendingUserRef = useRef({});                  // pid -> last user text (reply-extraction scope)
  const ccSessionRef = useRef({});                      // state mirror for cleanup paths
  const ccThreadRef = useRef({});                       // F2 round-7 (finding #5): LIVE mirror of ccThread (pid -> bubbles) so the SSE closure reads current thread state, not a stale attachment snapshot
  const ccEnsureInFlightRef = useRef({});               // F3: pid -> { tail } in-flight ensure+send lease chain
  // B6 / R6.23: bottom-stick refs — capture intent on scroll / before mutation; never unconditional scrollTop
  const discChatBodyRef = useRef(null);
  const discChatStickRef = useRef({ shouldStick: true });
  const chatThreadStickRef = useRef({ shouldStick: true });
  const implTermBodyRefs = useRef({}); // role -> element
  const implTermStickRefs = useRef({}); // role -> last intent

  // B6 e2e seed (sessionStorage HELM_E2E_B6=1 only): force live strip + stick paths without a real agent.
  useEffect(() => {
    try {
      if (typeof sessionStorage === 'undefined' || sessionStorage.getItem('HELM_E2E_B6') !== '1') return undefined;
    } catch {
      return undefined;
    }
    const onSeed = (ev) => {
      const d = (ev && ev.detail) || {};
      const pid = Number(d.projectId || d.pid);
      if (!pid) return;
      if (d.prompt != null) ccPendingUserRef.current[pid] = String(d.prompt);
      if (d.session) {
        setCcSession((p) => {
          const n = { ...p, [pid]: d.session };
          ccSessionRef.current = n;
          return n;
        });
      }
      if (d.liveReply != null) {
        const bodyEl = discChatBodyRef.current;
        const intent = captureStickIntent(bodyEl);
        discChatStickRef.current = intent;
        setCcLivePane((p) => ({ ...p, [pid]: String(d.liveReply) }));
        requestAnimationFrame(() => applyStick(discChatBodyRef.current, intent));
      }
      if (Array.isArray(d.thread)) setCcThread((p) => ({ ...p, [pid]: d.thread }));
      if (d.stripMode) setCcLastReplyStrip((p) => ({ ...p, [pid]: d.stripMode }));
    };
    window.addEventListener('helm:e2e-b6-seed', onSeed);
    window.__helmE2eB6Seed = (detail) => onSeed({ detail });
    return () => {
      window.removeEventListener('helm:e2e-b6-seed', onSeed);
      try { delete window.__helmE2eB6Seed; } catch { /* ignore */ }
    };
  }, []);
  const ccChannelCursorRef = useRef({});                // F2 round-6: CHANNEL -> highest delivery-failure seq seen (a cursor on one channel must never suppress another)
  const ccDeliveryEpochRef = useRef(null);              // F2 round-5: last-seen server delivery epoch; a change (restart) resets the per-channel cursors + shows a gap
  const ccLossGenAckedRef = useRef(0);                  // F2 round-6: highest process-wide lossGeneration the owner has acknowledged
  const ccLastLossGenRef = useRef(0);                   // F2 round-6: highest lossGeneration seen from any stream
  const ccMsgIdRef = useRef(1);
  const ccExplicitAgentRef = useRef({});                  // pid -> operator deliberately changed main picker
  const ccDiscExplicitAgentRef = useRef({});              // pid -> operator deliberately changed discovery picker
  // F2 round-7 (finding #5): keep the live thread ref in sync so SSE closures (epoch degradation, prior-seat
  // detection) read CURRENT thread state rather than the snapshot captured when the EventSource was attached.
  useEffect(() => { ccThreadRef.current = ccThread; }, [ccThread]);

  // D3 Command Center Tasks (per-project tasklist groups + agent roster from runtimes; follows ccCurrentId or explicit selector)
  const [tasksByPid, setTasksByPid] = useState({});
  const [rosterByPid, setRosterByPid] = useState({});
  const [tasksPid, setTasksPid] = useState(null);
  const [tasksErr, setTasksErr] = useState('');

  // D4 Command Center Completed (C4r archive per project)
  const [completedArchives, setCompletedArchives] = useState([]);
  const [completedErr, setCompletedErr] = useState('');
  const [expandedCompleted, setExpandedCompleted] = useState({});

  // O6.2 Tracking UI (read-only native run substrate view)
  const [trackingSnapshot, setTrackingSnapshot] = useState(null);
  const [trackingErr, setTrackingErr] = useState('');
  const [trackingLoading, setTrackingLoading] = useState(false);

  // S14b Sessions panel — GET /api/sessions (+owner/status); POST close only for human-owned rows.
  const [sessionsList, setSessionsList] = useState([]);
  const [sessionsErr, setSessionsErr] = useState('');
  const [sessionsMsg, setSessionsMsg] = useState('');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsClosingName, setSessionsClosingName] = useState('');

  // E2 Memory UI (M2)
  const [memories, setMemories] = useState([]);
  const [memScope, setMemScope] = useState('app');
  const [memProjectId, setMemProjectId] = useState(null);
  const [memSearch, setMemSearch] = useState('');
  const [memErr, setMemErr] = useState('');
  const [editingMemory, setEditingMemory] = useState(null);
  const [memForm, setMemForm] = useState({ title: '', description: '', type: 'reference', body: '' });
  const [expandedMemId, setExpandedMemId] = useState(null);
  // B11 Memory horizon (long|short) + promote/purge flow (UI3)
  const [memHorizon, setMemHorizon] = useState('short');
  const [shortSelected, setShortSelected] = useState([]);
  // B11 timeline (OBS1)
  const [timelineEvents, setTimelineEvents] = useState([]);
  const [timelinePid, setTimelinePid] = useState(null);
  const [timelineErr, setTimelineErr] = useState('');

  // A3: live Run view state (phase + run_tasks + current + reuse timeline). Populated on CC project select + on chat send that starts run.
  const [runByPid, setRunByPid] = useState({});
  const runPollRef = useRef(null);

  // A3 e2e test seam (force CC project currentId for reliable chat-send -> run start in e2e; harmless, not used for asserted run state)
  if (typeof window !== 'undefined') {
    window.__setCcCurrentIdForTest = setCcCurrentId;
  }

  // D2 cc helpers (declared early for hooks + render onclicks)
  const persistCcTabs = (t) => { localStorage.setItem('helm_cc_tabs', JSON.stringify(t)); setCcOpenTabs(t); };
  const persistCcMode = (m) => { localStorage.setItem('helm_cc_mode', m); setCcViewMode(m); };
  const loadCcProjectsIfNeeded = async () => {
    if ((projectsList || []).length === 0 && token) {
      try { const r = await authedFetch('/api/projects'); const d = await r.json(); setProjectsList(d.projects || []); } catch {}
    }
  };
  const loadChat = async (pid) => {
    if (!pid || !token) return; setCcErr('');
    try {
      const r = await authedFetch(`/api/projects/${pid}/chat`, { allowStatuses: [400, 404] });
      if (!r.ok) { setCcMessages(p => ({...p, [pid]: []})); return; }
      const d = await r.json();
      setCcMessages(p => ({...p, [pid]: d.messages || d || []}));
    } catch(e){ setCcErr('chat load failed'); }
  };
  const loadTerminal = async (pid) => {
    if (!pid || !token) return;
    try {
      // G1: terminal source selection — prefer active agent-chat session's pane when present
      // (for split view next to CC chat with the phase brain). Falls back to the master run terminal.
      const ccSess = (ccSessionRef && ccSessionRef.current && ccSessionRef.current[pid]) || ccSession[pid];
      const url = (ccSess && ccSess.sid)
        ? `/api/projects/${pid}/agent-chat/${ccSess.sid}/terminal`
        : `/api/projects/${pid}/terminal`;
      const r = await authedFetch(url);
      const d = await r.json();
      setCcTerminal(p => ({...p, [pid]: d || {session:null,content:''}}));
    } catch {}
  };
  const startCcTerminalPoll = (pid) => { stopCcTerminalPoll(); ccPollRef.current = setInterval(() => loadTerminal(pid), 1500); };
  const stopCcTerminalPoll = () => { if (ccPollRef.current) { clearInterval(ccPollRef.current); ccPollRef.current = null; } };

  // CC-MT: multi-terminal loaders. Worker list from real run runtimes; per-pane live tail from tmux capture.
  const loadMtWorkers = async (pid) => {
    if (!pid || !token) return; setCcMtErr('');
    try {
      const r = await authedFetch(`/api/projects/${pid}/terminals`);
      const d = await r.json();
      const workers = d.workers || [];
      setCcMtWorkers(p => ({ ...p, [pid]: workers }));
      // Seed selection (first up-to-gridSize workers) ONLY on first load for this pid.
      // Use `undefined` as the sentinel so a user's explicit Clear (empty array) is NOT re-seeded by the poll.
      setCcMtSelected(prev => {
        if (prev[pid] !== undefined) return prev;
        return { ...prev, [pid]: workers.slice(0, ccMtGridSize).map(w => w.id) };
      });
    } catch (e) { setCcMtErr('worker list load failed'); }
  };
  const loadMtCaptures = async (pid, ids) => {
    if (!pid || !token || !ids || !ids.length) return;
    const uniq = [...new Set(ids.filter(Boolean))];
    await Promise.all(uniq.map(async (wid) => {
      try {
        const r = await authedFetch(`/api/projects/${pid}/terminals/${encodeURIComponent(wid)}`);
        const d = await r.json();
        setCcMtCaptures(p => ({ ...p, [pid]: { ...(p[pid] || {}), [wid]: d || { session: null, content: '' } } }));
      } catch { /* degrade: keep last content */ }
    }));
  };
  const startCcMtPoll = (pid) => {
    stopCcMtPoll();
    ccMtPollRef.current = setInterval(() => {
      loadMtWorkers(pid);
      const sel = (ccMtSelected[pid] || []).filter(Boolean);
      if (sel.length) loadMtCaptures(pid, sel);
    }, 1500);
  };
  const stopCcMtPoll = () => { if (ccMtPollRef.current) { clearInterval(ccMtPollRef.current); ccMtPollRef.current = null; } };
  // CC-MT selection helpers (roster interactions).
  const mtSetGridSize = (size) => {
    setCcMtGridSize(size);
    const pid = ccMtPid || ccCurrentId;
    if (pid) setCcMtSelected(prev => ({ ...prev, [pid]: (prev[pid] || []).filter(Boolean).slice(0, size) }));
  };
  const mtPlaceWorker = (pid, workerId, slotIndex) => {
    if (slotIndex >= ccMtGridSize) return;
    setCcMtSelected(prev => {
      const cur = (prev[pid] || []).filter(id => id !== workerId);
      const next = cur.slice(0, ccMtGridSize);
      while (next.length <= slotIndex) next.push(null);
      next[slotIndex] = workerId;
      return { ...prev, [pid]: next.slice(0, ccMtGridSize) };
    });
  };
  const mtToggleWorker = (pid, workerId) => {
    setCcMtSelected(prev => {
      const cur = (prev[pid] || []).filter(Boolean);
      if (cur.includes(workerId)) return { ...prev, [pid]: cur.filter(id => id !== workerId) };
      if (cur.length >= ccMtGridSize) { const copy = cur.slice(); copy[ccMtGridSize - 1] = workerId; return { ...prev, [pid]: copy }; }
      return { ...prev, [pid]: [...cur, workerId] };
    });
  };
  const mtClearGrid = (pid) => setCcMtSelected(prev => ({ ...prev, [pid]: [] }));
  const mtFillFromTab = (pid, workerIds) => setCcMtSelected(prev => ({ ...prev, [pid]: workerIds.slice(0, ccMtGridSize) }));

  // D3 loads for Tasks sub-tab (real render, body-aware authedFetch, follows active cmd project or selector)
  const loadTasks = async (pid) => {
    if (!pid || !token) return; setTasksErr('');
    try {
      const r = await authedFetch(`/api/projects/${pid}/tasks`);
      const d = await r.json();
      setTasksByPid(p => ({...p, [pid]: d.tasks || []}));
      setRosterByPid(p => ({...p, [pid]: d.roster || []}));
    } catch(e){ setTasksErr('tasks load failed'); }
  };
  const refreshTasks = () => { const pid = tasksPid || ccCurrentId; if (pid) loadTasks(pid); };

  // D4 loads (body-aware authedFetch: GET with no body arg)
  const loadCompleted = async () => {
    if (!token) return; setCompletedErr('');
    try {
      const r = await authedFetch('/api/completed'); // no body → no Content-Type set
      const d = await r.json();
      setCompletedArchives(d.archives || []);
    } catch(e){ setCompletedErr('completed load failed'); }
  };
  const toggleCompleted = (pid) => setExpandedCompleted(p => ({...p, [pid]: !p[pid]}));
  const refreshCompleted = () => loadCompleted();

  // E-b2: load short/long split for a project (read-only review; uses existing /api/memory filter)
  const loadProjectMemReview = async (pid) => {
    if (!pid || !token) { setMemReviewPid(null); setMemReviewShort([]); setMemReviewLong([]); return; }
    try {
      const [rs, rl] = await Promise.all([
        authedFetch(`/api/memory?scope=project&project_id=${pid}&horizon=short`),
        authedFetch(`/api/memory?scope=project&project_id=${pid}&horizon=long`)
      ]);
      const ds = await rs.json();
      const dl = await rl.json();
      setMemReviewShort(ds.memories || []);
      setMemReviewLong(dl.memories || []);
      setMemReviewPid(pid);
    } catch (e) {
      setMemReviewShort([]); setMemReviewLong([]); setMemReviewPid(pid);
    }
  };

  // O6.2 Tracking: read-only /api/tracking snapshot (native run substrate; no mutation controls).
  const loadTracking = async () => {
    setTrackingErr('');
    setTrackingLoading(true);
    try {
      const r = await authedFetch('/api/tracking');
      const d = await r.json();
      setTrackingSnapshot(d);
    } catch (e) {
      setTrackingErr('Failed to load tracking (see banner)');
    } finally {
      setTrackingLoading(false);
    }
  };
  const refreshTracking = () => loadTracking();

  // S14b: registry sessions list (owner + status). Manual refresh only.
  const loadSessions = async () => {
    setSessionsErr('');
    setSessionsLoading(true);
    try {
      const r = await authedFetch('/api/sessions');
      const d = await r.json();
      setSessionsList(Array.isArray(d.sessions) ? d.sessions : []);
    } catch (e) {
      setSessionsErr('Failed to load sessions (see banner)');
      setSessionsList([]);
    } finally {
      setSessionsLoading(false);
    }
  };
  const refreshSessions = () => loadSessions();
  // S14b: plain manual close — human-owned only; explicit confirm; honest success/error.
  const closeRegistrySession = async (s) => {
    const name = s && s.name ? String(s.name) : '';
    if (!name) return;
    if (s.owner !== 'human') return;
    if (s.status === 'reaped') return;
    if (sessionsClosingName) return;
    if (!window.confirm(`Close session ${name}? This terminates the tmux session and cannot be undone.`)) return;
    setSessionsErr('');
    setSessionsMsg('');
    setSessionsClosingName(name);
    try {
      const r = await authedFetch(`/api/sessions/${encodeURIComponent(name)}/close`, {
        method: 'POST',
        allowStatuses: [400, 403, 404, 409, 500],
      });
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      if (!r.ok || !body || body.ok !== true) {
        const reason = body && body.reason ? String(body.reason) : '';
        const errMsg = body && body.error ? String(body.error) : (body && body.message ? String(body.message) : '');
        const detail = [errMsg, reason && `reason=${reason}`].filter(Boolean).join(' · ') || `Close failed (HTTP ${r.status})`;
        setSessionsErr(detail);
        return;
      }
      setSessionsMsg(body.already_reaped ? `Session ${name} was already closed.` : `Closed session ${name}.`);
      await loadSessions();
    } catch (e) {
      setSessionsErr(e && e.message ? String(e.message) : 'Close failed');
    } finally {
      setSessionsClosingName('');
    }
  };

  // E2 Memory loads + refresh (body-aware authedFetch: GETs bodyless, no Content-Type)
  const loadProjectsForMem = async () => {
    if ((projectsList || []).length === 0 && token) {
      try { const r = await authedFetch('/api/projects'); const d = await r.json(); setProjectsList(d.projects || []); } catch {}
    }
  };
  const loadMemories = async (scope, pid, horizon = null) => {
    setMemErr('');
    try {
      let url = `/api/memory?scope=${scope}`;
      if (scope === 'project' && pid != null) url += `&project_id=${pid}`;
      const h = horizon || memHorizon;
      if (h) url += `&horizon=${h}`;
      // no status filter for app: returns proposed+approved so pending shown distinctly; project always approved
      const r = await authedFetch(url); // bodyless GET → no Content-Type (body-aware)
      const d = await r.json();
      setMemories(d.memories || []);
    } catch (e) { setMemErr('Failed to load memories (see banner)'); }
  };
  const refreshMemories = () => loadMemories(memScope, memProjectId, memHorizon);

  // B11 OBS1 timeline loader (real /api/projects/:id/timeline over agent_events)
  const loadTimeline = async (pid) => {
    setTimelineErr('');
    try {
      const r = await authedFetch(`/api/projects/${pid}/timeline`);
      const d = await r.json();
      setTimelineEvents(d.events || []);
    } catch (e) { setTimelineErr('Failed to load timeline (see banner)'); }
  };
  const refreshTimeline = () => { const pid = timelinePid || ccCurrentId; if (pid) loadTimeline(pid); };

  // A3 Run view helpers (poll modeled exactly on loadTerminal/startCcTerminalPoll; supports latest /runs and direct /runs/:rid)
  const isTerminalPhase = (ph) => ['complete', 'failed', 'blocked'].includes(String(ph || '').toLowerCase());
  const loadRun = async (pid, rid = null) => {
    if (!pid || !token) return;
    try {
      let url = `/api/projects/${pid}/runs`;
      if (rid) url += `/${rid}`;
      const r = await authedFetch(url);
      const d = await r.json();
      const st = d && d.run ? d.run : d;
      if (st && st.runId) {
        setRunByPid(p => ({ ...p, [pid]: st }));
      }
    } catch (e) { /* run view is best-effort; no UI error banner */ }
  };
  const startRunPoll = (pid) => {
    stopRunPoll();
    // CC-CHAT-2 R4: poll the project's LATEST run (never a pinned rid) so the panel tracks a NEW
    // run the moment it starts (fixes the stale failed-run-73-shown-during-live-run-74 class).
    // Piggyback the chat transcript refresh so coordinator callback bubbles stream during a run.
    runPollRef.current = setInterval(() => { loadRun(pid); loadChat(pid); }, 1500);
  };
  const stopRunPoll = () => { if (runPollRef.current) { clearInterval(runPollRef.current); runPollRef.current = null; } };

  // D4 auto-load on tab enter (follows D2/D3 cmd patterns)
  // (placed here for closure over loadCompleted + state)
  // Note: e2e also forces goto + refresh for determinism

  const subscribeCc = (pid) => {
    if (ccEsRef.current) { try { ccEsRef.current.close(); } catch {} }
    const es = new EventSource(`/api/projects/${pid}/activity?access_token=${encodeURIComponent(token)}`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        const bid = data.batch_id || (data.body && data.body.batch_id) || '';
        if (String(bid).startsWith(`chat-${pid}`) || (data.role && (data.role==='owner' || data.role==='master'))) {
          setCcMessages(prev => {
            const arr = [...(prev[pid]||[]), data];
            return {...prev, [pid]: arr};
          });
        }
      } catch {}
    };
    es.onerror = () => {};
    ccEsRef.current = es;
  };
  const openCcTab = (pid) => {
    if (!pid) return;
    let tabs = ccOpenTabs;
    if (!tabs.includes(pid)) { tabs = [...tabs, pid]; persistCcTabs(tabs); }
    setCcCurrentId(pid);
  };
  const closeCcTab = (pid, e) => {
    if (e) e.stopPropagation();
    const tabs = ccOpenTabs.filter(x => x !== pid);
    persistCcTabs(tabs);
    if (ccCurrentId === pid) setCcCurrentId(tabs[0] || null);
    if (ccEsRef.current) { try { ccEsRef.current.close(); } catch {} }
    stopCcTerminalPoll();
    stopRunPoll();
  };
  const setCcView = (m) => {
    persistCcMode(m);
    const pid = ccCurrentId;
    if (m === 'chat') stopCcTerminalPoll();
    else if (pid) startCcTerminalPoll(pid);
  };
  const sendCc = async () => {
    const pid = ccCurrentId; const text = (ccComposer || '').trim();
    if (!pid || !text) return;
    setCcErr('');
    try {
      const currentRun = runByPid[pid];
      const isActiveRun = currentRun && !isTerminalPhase(currentRun.phase);
      if (isActiveRun) {
        // Active run owns the conversation: forward via /chat (quick-return; backend delivers to the
        // active run phase-brain session in the background; owner message is recorded for chat bubbles).
        const opt = { role: 'owner', batch_id: `chat-${pid}`, body: { text }, ts: new Date().toISOString() };
        setCcMessages(p => ({...p, [pid]: [...(p[pid]||[]), opt]}));
        await authedFetch(`/api/projects/${pid}/chat`, { method: 'POST', body: JSON.stringify({ text }) });
      } else {
        // CC-CHAT-1 B2: NO auto-run — chatting NEVER starts a run (kills the 524 class).
        // The composer talks ONLY to the live project agent-chat session (B1). Main CC requires an explicit
        // Session On (an existing session for this pid) before it will send.
        const cur = ccSession[pid];
        if (!cur || !cur.sid) { setCcErr('Turn on a session to chat'); return; }
        const mainSelAid = ccSelectedAgentId[pid];
        if (!mainSelAid) { setCcErr('pick an agent to chat with'); return; }
        // F3: the WHOLE ensure→POST is one LEASED unit — never send through a session bound to a DIFFERENT
        // agent than the main-CC selection (the Discovery pane may have switched ccSession[pid]); reconcile to
        // OUR selected agent inside the lease, and a concurrent different-agent switch cannot tear down this
        // seat until this POST lands. F2: optimistic bubble pushed INSIDE the send with the stable msgId.
        const msgId = 'cc' + (ccMsgIdRef.current++);
        const { session } = await seatLeaseSendChain(
          ccEnsureInFlightRef.current, pid, ccGetCurrentSession, mainSelAid,
          (plan) => ccRunSwitchAndSpawn(pid, mainSelAid, plan),
          async (sess2) => {
            ccPendingUserRef.current[pid] = text;
            ccPushThread(pid, { id: msgId, role: 'user', text, delivered: true });
            return ccPostChatMessage(pid, sess2, text, msgId);
          }
        );
        if (!session || !session.sid) { setCcErr(ccSessConnecting[pid] ? 'connecting to the agent — try again in a moment' : 'could not switch to the selected agent'); return; }
      }
      setCcComposer('');
    } catch (e) { setCcErr('send failed'); }
  };
  // ── CC-CHAT-1 B3: project agent-chat session helpers (Studio parity over the fenced B1 endpoints)
  // Phase defaults come only from the backend ownership resolver. Names never choose a seat.
  const persistCcFavs = (favs) => { localStorage.setItem('helm_cc_fav_agents', JSON.stringify(favs)); setCcFavAgents(favs); };
  const toggleCcFav = (aid) => { if (!aid) return; persistCcFavs(ccFavAgents.includes(aid) ? ccFavAgents.filter(x => x !== aid) : [...ccFavAgents, aid]); };
  const resolvePhaseAgents = async (projectId, phase) => {
    const response = await authedFetch(`/api/projects/${projectId}/phase-agents/${phase}`);
    if (!response.ok) throw new Error(`phase staffing failed (${response.status})`);
    return response.json();
  };
  const ccBrainIds = (pid) => {
    const phases = ccPhaseAgents[pid] || {};
    return [phaseBrainAgentId(phases.planning), phaseBrainAgentId(phases.discovery)].filter(Boolean);
  };
  const isCcBrainAgent = (pid, agentId) => ccBrainIds(pid).includes(Number(agentId));
  // Picker order: resolved planning brain pinned on top, then favorites, then assignment order.
  const orderedCcAgents = (pid) => {
    const rows = ccAgents[pid] || [];
    const planningBrainId = phaseBrainAgentId((ccPhaseAgents[pid] || {}).planning);
    const brain = rows.filter(r => r.agent_id === planningBrainId);
    const favs = rows.filter(r => r.agent_id !== planningBrainId && ccFavAgents.includes(r.agent_id));
    const rest = rows.filter(r => r.agent_id !== planningBrainId && !ccFavAgents.includes(r.agent_id));
    return [...brain, ...favs, ...rest];
  };
  const loadCcAgents = async (pid) => {
    if (!pid) return;
    try {
      const [r, discovery, planning] = await Promise.all([
        authedFetch(`/api/projects/${pid}/agents`),
        resolvePhaseAgents(pid, 'discovery'),
        resolvePhaseAgents(pid, 'planning'),
      ]);
      const d = await r.json();
      const rows = d.projectAgents || [];
      setCcAgents(p => ({...p, [pid]: rows}));
      setCcPhaseAgents(p => ({...p, [pid]: { discovery, planning }}));
      const planningId = phaseBrainAgentId(planning);
      const discoveryId = phaseBrainAgentId(discovery);
      if (planningId) setCcSelectedAgentId(p => ({
        ...p,
        [pid]: preferredPhaseAgentId(planning, p[pid], !!ccExplicitAgentRef.current[pid]),
      }));
      if (discoveryId) setCcDiscSelectedAgentId(p => ({
        ...p,
        [pid]: preferredPhaseAgentId(discovery, p[pid], !!ccDiscExplicitAgentRef.current[pid]),
      }));
    } catch {}
  };
  // F2: respect a caller-supplied stable `id` (the message id threaded to the backend for delivery-failed
  // correlation); only mint one when absent. `id` is authoritative (placed last, after the spread).
  const ccPushThread = (pid, msg) => setCcThread(p => ({...p, [pid]: [...(p[pid]||[]), { ts: Date.now(), ...msg, id: msg.id || ('cc' + (ccMsgIdRef.current++)) }]}));
  const ccLastUserPrompt = (pid) => {
    const pending = ccPendingUserRef.current[pid];
    if (pending) return pending;
    const arr = ccThread[pid] || [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] && arr[i].role === 'user' && arr[i].text) return arr[i].text;
    }
    return '';
  };
  // E8 FIX3: the strip shows the agent's LAST REPLY ONLY, taken from the last COMPLETE ⟦HELM_REPLY⟧
  // pair in the raw pane — never the whole raw pane. The prior implementation handed the strip the
  // entire pane text, which is why tmux's own pager chrome ("+65 lines (ctrl+o to expand)") could show
  // up in it. No complete pair present → '' (the caller renders "Waiting for live output…", never chrome).
  const ccLiveReplyText = (pid, fallbackPane) => lastCompleteHelmReplyText(stripAnsiForDisplay(ccLivePane[pid] || fallbackPane || ''));
  const ccHasLiveTurn = (pid, fallbackPane) => !!(ccLastUserPrompt(pid) || ccLiveReplyText(pid, fallbackPane));
  const ccLastReplyMode = (pid) => ccLastReplyStrip[pid] || 'collapsed';
  const setCcLastReplyMode = (pid, mode) => setCcLastReplyStrip((p) => ({ ...p, [pid]: mode }));
  // B6 / R6.24: sticky last-reply-only strip (not last-prompt). Distinct surface; collapse / expand / hide.
  // De-dupe: strip owns the live agent text — no second copy in .cc-live-stream below.
  const renderCcLiveReply = (pid, agentLabel, fallbackPane) => {
    const raw = ccLiveReplyText(pid, fallbackPane);
    const mode = ccLastReplyMode(pid);
    if (mode === 'hidden') {
      return html`<div class="cc-last-reply-restore-wrap" data-testid="cc-last-reply-hidden">
        <button type="button" class="btn btn-sm" data-testid="cc-last-reply-show"
          onclick=${() => setCcLastReplyMode(pid, 'collapsed')}>Show last reply</button>
      </div>`;
    }
    const body = raw || 'Waiting for live output…';
    const expanded = mode === 'expanded';
    return html`<div class="cc-last-reply-strip" data-testid="cc-last-reply-strip" data-mode=${mode}>
      <div class="cc-last-reply-strip-header">
        <span class="cc-live-label" data-testid="cc-last-reply-label">${agentLabel || 'Agent'} · last reply</span>
        <div class="cc-last-reply-strip-controls" data-testid="cc-last-reply-controls">
          ${expanded
            ? html`<button type="button" class="btn btn-sm" data-testid="cc-last-reply-collapse"
                onclick=${() => setCcLastReplyMode(pid, 'collapsed')}>Collapse</button>`
            : html`<button type="button" class="btn btn-sm" data-testid="cc-last-reply-expand"
                onclick=${() => setCcLastReplyMode(pid, 'expanded')} title="Expand last reply">…</button>`}
          <button type="button" class="btn btn-sm" data-testid="cc-last-reply-hide"
            onclick=${() => setCcLastReplyMode(pid, 'hidden')}>Hide</button>
        </div>
      </div>
      <div class=${`cc-last-reply-body ${expanded ? 'is-expanded' : 'is-collapsed'}`}
        data-testid="cc-last-reply-body"
        data-expanded=${expanded ? '1' : '0'}>${body}</div>
    </div>`;
  };
  const ccIngestPane = (pid, pane) => {
    // B6 site-1/3: capture Discovery scroll intent BEFORE content mutation (was unconditional stream stick).
    const bodyEl = discChatBodyRef.current;
    const intent = captureStickIntent(bodyEl);
    discChatStickRef.current = intent;
    setCcLivePane(p => ({...p, [pid]: pane || ''}));
    // Marker-based, idempotent recompute of the current turn's agent bubble (thinking → reply) —
    // the SAME extractHelmReply pipeline the Studio chat uses.
    const pending = ccPendingUserRef.current[pid];
    const r = extractHelmReply(pane, pending);
    // DC-R1: the "thinking…" flag tracks the LIVE pane generating signal (esc-to-interrupt /
    // spinner), NOT marker presence — so a finished reply whose close marker scrolled off the
    // capture window is no longer stuck "thinking" forever.
    const thinking = paneLooksGenerating(pane);
    const fallback = r.state === 'fallback';
    let text = r.text || '';
    // When idle and the extractor yielded no text, fall back to the plain-prose segmenter so a
    // completed reply still renders (rather than an empty / stuck-thinking bubble).
    if (!thinking && !text) text = extractAgentPaneSegment('', pane, pending) || '';
    if (!thinking && !text) {
      requestAnimationFrame(() => applyStick(discChatBodyRef.current, intent));
      return;
    }
    setCcThread(prev => {
      const arr = prev[pid] || [];
      const last = arr[arr.length - 1];
      const bubble = { role: 'agent', text, thinking, fallback };
      if (last && last.role === 'agent') return {...prev, [pid]: [...arr.slice(0, -1), { ...last, ...bubble }]};
      return {...prev, [pid]: [...arr, { id: 'cc' + (ccMsgIdRef.current++), ts: Date.now(), ...bubble }]};
    });
    requestAnimationFrame(() => applyStick(discChatBodyRef.current, intent));
    // iter3: do NOT clear pending on reply/fallback — keep as persistent current-turn anchor until next send (fixes wrapped-prompt scope loss)
  };
  // E8 FIX1: ref-parameterized core — ccChatEsRef (old CC-chat route) and ccDiscChatEsRef (Discovery)
  // each get their own independent EventSource lifecycle; detaching/attaching one must never touch
  // the other's connection.
  const ccDetachStreamOn = (ref) => { if (ref.current) { try { ref.current.close(); } catch {} ref.current = null; } };
  const ccDetachStream = () => ccDetachStreamOn(ccChatEsRef);
  const ccDiscDetachStream = () => ccDetachStreamOn(ccDiscChatEsRef);
  // F2: an HTTP-acked message whose delivery failed → correct the EXACT optimistic user bubble to
  // delivered=false, matched by the stable msgId (the bubble's id) — NEVER by text (duplicate text would
  // mis-mark the wrong bubble and a reconnect replay would re-mark another same-text message).
  const ccMarkUndelivered = (pid, msgId) => {
    if (!msgId) return;
    setCcThread(p => ({ ...p, [pid]: markUndeliveredById(p[pid] || [], msgId) }));
  };
  // F2 round-6/7: explicit high-watermark ACK — POSTed AFTER the UI applies a delivery-failed event or renders a
  // gap. Only acknowledged payloads may be freed server-side (an SSE write alone is NOT an ack). round-7
  // (finding #1): POSTed to the SCOPED route so the channel is derived server-side — the client never names it.
  const ccAckDelivery = (ackUrl, throughSeq) => {
    if (!ackUrl || typeof throughSeq !== 'number') return;
    try { authedFetch(ackUrl, { method: 'POST', body: JSON.stringify({ throughSeq }) }).catch(() => {}); } catch {}
  };
  const ccChannelForPid = (pid) => `project:${pid}`;
  // E8 FIX1: shared attach core, parameterized by WHICH ref owns the connection. `ccAttachStream`
  // (below) preserves the old ccChatEsRef behavior byte-for-byte; `ccDiscAttachStream` is the same
  // logic against Discovery's own independent ref, so closing one stream can never silently starve
  // the other surface.
  const ccAttachStreamOn = (ref, pid, aid, sid) => {
    ccDetachStreamOn(ref);
    // F2 round-6/7: delivery notifications are keyed by LOGICAL CHANNEL (project:<pid>), so a REPLACEMENT sid's
    // stream still surfaces a failure produced by the OLD sid. round-7 (finding #1): stream via the PROJECT
    // route so the server derives channel=project:<pid> itself (no client ?channel=). Resume from this channel's
    // last-seen seq + last-seen epoch (a cross-epoch cursor is ignored server-side so a stale high cursor can't
    // suppress). `channel` is the CLIENT's own cursor-map key; the ack URL is the server-scoped ack endpoint.
    const channel = ccChannelForPid(pid);
    const ackUrl = `/api/projects/${pid}/agent-chat/${sid}/chat-delivery-ack`;
    const sinceFailSeq = ccChannelCursorRef.current[channel] || 0;
    const epoch = ccDeliveryEpochRef.current || '';
    const es = new EventSource(`/api/projects/${pid}/agent-chat/${sid}/stream?access_token=${encodeURIComponent(token)}&sinceFailSeq=${sinceFailSeq}&epoch=${encodeURIComponent(epoch)}`);
    ref.current = es;
    const noteLoss = (gen) => {
      if (typeof gen !== 'number') return;
      if (gen > (ccLastLossGenRef.current || 0)) ccLastLossGenRef.current = gen;
      if (gen > (ccLossGenAckedRef.current || 0)) setCcGlobalLossWarn(true);
    };
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'pane') ccIngestPane(pid, msg.content);
        else if (msg.type === 'delivery-epoch') {
          // Backend (re)start = a DEGRADATION, not just a cursor reset: reset per-channel cursors AND, since
          // exact payloads did not survive the restart, show a gap for any prior (unacknowledged) optimistic
          // state on this pid so uncertain status is never silently dropped. round-7 (finding #5): read the LIVE
          // thread ref, not the stale attachment closure — a bubble added after attach must still count.
          if (ccDeliveryEpochRef.current && ccDeliveryEpochRef.current !== msg.epoch) {
            ccChannelCursorRef.current = {};
            if (hasOutstandingOptimistic((ccThreadRef.current || {})[pid])) setCcDeliveryGap(p => ({ ...p, [pid]: true }));
          }
          ccDeliveryEpochRef.current = msg.epoch;
          noteLoss(msg.lossGeneration);
        } else if (msg.type === 'loss-generation') {
          noteLoss(msg.lossGeneration);
        } else if (msg.type === 'delivery-failed') {
          // round-7 (finding #3): RENDER-before-ack. Apply the visible change first; if the failed msgId's bubble
          // is gone (prior seat, cleared on an F3 switch) surface a channel-level prior-seat GAP instead of a
          // silent no-op. ACK only AFTER the visible transition.
          const { matched } = applyDeliveryFailedById((ccThreadRef.current || {})[pid] || [], msg.msgId);
          if (matched) ccMarkUndelivered(pid, msg.msgId);
          else setCcDeliveryGap(p => ({ ...p, [pid]: true }));
          if (typeof msg.seq === 'number') { ccChannelCursorRef.current[channel] = Math.max(ccChannelCursorRef.current[channel] || 0, msg.seq); ccAckDelivery(ackUrl, msg.seq); }
        } else if (msg.type === 'delivery-failed-gap') {
          // Some failures were compacted to a gap before this client saw them — never a silent loss: flag the
          // session (a visible gap) FIRST, then advance/ack the cursor so we resume cleanly.
          setCcDeliveryGap(p => ({ ...p, [pid]: true }));
          if (typeof msg.throughSeq === 'number') { ccChannelCursorRef.current[channel] = Math.max(ccChannelCursorRef.current[channel] || 0, msg.throughSeq); ccAckDelivery(ackUrl, msg.throughSeq); }
        } else if (msg.type === 'error') { setCcErr(msg.error); ccClearSession(pid); }
      } catch {}
    };
    // E8 FIX1 (SOL proposed-correction #5): a dropped connection is a RECONCILIATION TRIGGER, not a
    // no-op. Only reclaim OUR OWN ref, and only once the browser has genuinely given up reconnecting
    // (readyState CLOSED) — while it's still CONNECTING the native EventSource retry is in flight and
    // must not be fought. Nulling the ref lets the owning surface's reconciliation (Discovery's mount/
    // route-change/timer effect, or the CC-chat route's re-attach-on-dep-change) reattach cleanly.
    es.onerror = () => {
      if (ref.current === es && es.readyState === EventSource.CLOSED) ref.current = null;
    };
  };
  const ccAttachStream = (pid, aid, sid) => ccAttachStreamOn(ccChatEsRef, pid, aid, sid);
  const ccDiscAttachStream = (pid, aid, sid) => ccAttachStreamOn(ccDiscChatEsRef, pid, aid, sid);
  // F2 round-6: the owner acknowledges the app-wide loss uncertainty — clears the sticky global warning.
  const ccAckGlobalLoss = () => { ccLossGenAckedRef.current = ccLastLossGenRef.current || 0; setCcGlobalLossWarn(false); };
  const ccClearSession = (pid) => {
    ccDetachStream();
    setCcSession(p => { const n = {...p}; delete n[pid]; ccSessionRef.current = n; return n; });
    setCcLivePane(p => { const n = {...p}; delete n[pid]; return n; });
  };
  const ccSetSession = (pid, next) => {
    setCcSession(p => { const n = {...p, [pid]: next}; ccSessionRef.current = n; return n; });
    if (pid && next && next.sid) stopCcTerminalPoll();
  };
  // Re-reads the LIVE session mirror so a chained (leased) switch sees the prior switch's result.
  const ccGetCurrentSession = (p) => (ccSessionRef.current && ccSessionRef.current[p]) || ccSession[p] || null;
  // DC-R7 / F3: the switch-close + spawn/attach for a seat. Runs INSIDE the serialized lease
  // (seatLeaseSendChain), so a different-agent switch never overlaps a prior caller's POST. On switch, closes
  // the replaced seat (never orphans it) and resets the shared per-pid thread/stream/pending so the new
  // agent's conversation never inherits the previous agent's bubbles (no cross-surface bleed). Returns the
  // live session, or null if it couldn't be established.
  const ccRunSwitchAndSpawn = async (pid, aid, plan) => {
    if (plan.action === 'switch') {
      ccClearSession(pid); // detaches the live stream + drops ccSession[pid] + livePane
      try { await authedFetch(`/api/projects/${pid}/agent-chat/${plan.closeSid}`, { method: 'DELETE' }); } catch {}
      setCcThread(p => ({ ...p, [pid]: [] }));
      ccPendingUserRef.current[pid] = '';
    }
    setCcSessConnecting(p => ({...p, [pid]: true})); setCcErr('');
    try {
      const body = ccWsCycleId ? { cycle_id: ccWsCycleId } : {};
      const r = await authedFetch(`/api/projects/${pid}/agent-chat/${aid}`, { method: 'POST', body: JSON.stringify(body), allowStatuses: [409] });
      const d = await r.json();
      if (r.status === 409 && d.session_id && d.code !== 'SESSION_NAME_COLLISION') {
        // Agent already live (e.g. a Studio session) — attach instead of double-spawning.
        // B09: collision 409 has code SESSION_NAME_COLLISION and no attachable session_id path.
        // E8 FIX2: surfaces which provider conversation this seat is attached to, and whether it was
        // resumed — absent on the "already live, attach" 409 path (create() was never called there).
        const next = { sid: d.session_id, agentId: aid, tmux: d.tmux_session || null, conversationId: d.conversation_id || null, resumed: !!d.resumed };
        ccSetSession(pid, next);
        ccAttachStream(pid, aid, d.session_id);
        return next;
      } else if (!r.ok) {
        if (d && d.code === 'SESSION_NAME_COLLISION') {
          throw new Error(d.error || ('session name collision refused (' + (d.reason || 'unknown') + ')'));
        }
        throw new Error(d.error || ('session start failed (' + r.status + ')'));
      } else {
        // E8 FIX2: surfaces which provider conversation this seat is attached to, and whether it was
        // resumed — absent on the "already live, attach" 409 path (create() was never called there).
        const next = { sid: d.session_id, agentId: aid, tmux: d.tmux_session || null, conversationId: d.conversation_id || null, resumed: !!d.resumed };
        ccSetSession(pid, next);
        setCcThread(p => ({...p, [pid]: []}));
        setCcLivePane(p => ({...p, [pid]: ''}));
        ccPendingUserRef.current[pid] = '';
        ccAttachStream(pid, aid, d.session_id);
        return next;
      }
    } catch (e) { setCcErr(String(e.message || e)); return null; }
    finally { setCcSessConnecting(p => ({...p, [pid]: false})); }
  };
  // Ensure-only (Session On toggle): run the lease with a no-op send (no message to POST). Still goes through
  // the per-pid chain so a concurrent send serializes correctly against the toggle's spawn.
  const ccEnsureSession = async (pid, agentId) => {
    if (!pid) return null;
    const aid = agentId || ccSelectedAgentId[pid];
    if (!aid) { setCcErr('pick an agent first'); return null; }
    const { session } = await seatLeaseSendChain(
      ccEnsureInFlightRef.current, pid, ccGetCurrentSession, aid,
      (plan) => ccRunSwitchAndSpawn(pid, aid, plan),
      async () => {}
    );
    return session;
  };
  // F2: POST a chat message with its STABLE msgId, correcting the optimistic bubble to delivered=false on an
  // IMMEDIATE failure (404/409/network). A later PERMANENT background failure arrives via the SSE
  // `delivery-failed{msgId}` event, which also calls ccMarkUndelivered(pid, msgId). Correlate by ID, not text.
  const ccPostChatMessage = async (pid, sess, text, msgId) => {
    try {
      const r = await authedFetch(`/api/projects/${pid}/agent-chat/${sess.sid}/message`, { method: 'POST', body: JSON.stringify({ text, msgId }), allowStatuses: [404, 409] });
      if (r.status === 404) { setCcErr('session is gone — toggle Session On again'); ccClearSession(pid); ccMarkUndelivered(pid, msgId); return false; }
      if (r.status === 409) { const d = await r.json().catch(() => ({})); setCcErr(d.error || 'agent is busy — try again in a moment'); ccMarkUndelivered(pid, msgId); return false; }
      if (!r.ok) { ccMarkUndelivered(pid, msgId); return false; }
      return true;
    } catch (e) { setCcErr('send failed'); ccMarkUndelivered(pid, msgId); return false; }
  };
  const ccToggleSession = async (pid, agentIdOverride) => {
    if (!pid || ccSessConnecting[pid]) return;
    const sess = ccSession[pid];
    if (sess && sess.sid) { // ON → OFF: graceful end (DELETE is idempotent)
      ccClearSession(pid);
      try { await authedFetch(`/api/projects/${pid}/agent-chat/${sess.sid}`, { method: 'DELETE' }); } catch {}
      return;
    }
    // BUG-2: the Discovery pane passes its own effective agent id; main CC passes none → shared selection.
    await ccEnsureSession(pid, agentIdOverride || ccSelectedAgentId[pid]);
  };
  // Force close: stuck-session affordance — maps to DELETE on the B1 endpoint.
  // R5b (CC-CHAT-4): sanctioned run stop — POST /api/runs/:id/stop marks the run terminal AND
  // signals the in-process loop (abort registry) so it stops spawning within one poll cycle.
  const ccStopRun = async (pid, runId) => {
    if (!runId) return;
    if (!confirm(`Stop run #${runId}? The orchestrator loop aborts within one cycle and its worker sessions are reaped. This cannot be undone.`)) return;
    setCcErr('');
    try {
      await authedFetch(`/api/runs/${runId}/stop`, { method: 'POST', body: JSON.stringify({ reason: 'stopped from CC run panel' }) });
      // refresh the run panel state right away (polling would catch it anyway)
      try {
        const r = await authedFetch(`/api/projects/${pid}/runs`);
        const d = await r.json();
        setRunByPid(prev => ({ ...prev, [pid]: d.run || null }));
      } catch {}
    } catch (e) { /* setError already surfaced by authedFetch */ }
  };
  const ccForceCloseSession = async (pid) => {
    const sess = ccSession[pid];
    if (!sess || !sess.sid) { setCcErr('no live chat session'); return; }
    if (!confirm('Force close this agent chat session?')) return;
    ccClearSession(pid);
    try { await authedFetch(`/api/projects/${pid}/agent-chat/${sess.sid}`, { method: 'DELETE' }); } catch {}
  };
  const ccCtxAction = async (pid, action) => {
    const sess = ccSession[pid];
    if (!sess || !sess.sid) return;
    setCcErr('');
    try {
      const r = await authedFetch(`/api/projects/${pid}/agent-chat/${sess.sid}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      const d = await r.json();
      if (!d.issued) throw new Error(d.error || (action + ' failed'));
      setCcErr('Context ' + (action === 'clear' ? 'cleared' : 'compacted'));
    } catch (e) { setCcErr(String(e.message || e)); }
  };
  const forceCloseMaster=async()=>{ const pid=ccCurrentId; if(!pid)return; if(!confirm('Force close the active phase-brain session? (will kill the tmux session)')) return;
    setCcErr('');
    try{ await authedFetch(`/api/projects/${pid}/master/close`, { method:'POST' }); }
    catch(e){ setCcErr('close failed (or already closed)'); }
    // refresh terminal view (will show no session or updated)
    loadTerminal(pid);
  };
  const clearTerminal = () => { const pid=ccCurrentId; if(!pid) return; setCcTerminal(p => ({...p, [pid]: {...(p[pid]||{}), content: '' }})); };
  const compactTerminal = () => { const pid=ccCurrentId; if(!pid) return; const cur = (ccTerminal[pid]&&ccTerminal[pid].content)||''; const lines=String(cur).split(/\r?\n/); setCcTerminal(p => ({...p, [pid]: {...(p[pid]||{}), content: lines.slice(-30).join('\n') }})); };

  const applyTheme = (t) => {
    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    root.classList.add(t === 'light' ? 'theme-light' : 'theme-dark');
    setTheme(t);
  };

  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  };

  const authedFetch = async (url, opts = {}) => {
    const { allowStatuses, ...fetchOpts } = opts;
    const allowed = Array.isArray(allowStatuses) ? allowStatuses : [];
    const headers = { ...(fetchOpts.headers || {}) };
    if (fetchOpts.body != null) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(url, { ...fetchOpts, headers });
    if (r.status === 401) {
      setError('401 unauthorized - please re-login');
      sessionStorage.removeItem('helm_token');
      setToken('');
      throw new Error('401');
    }
    if (allowed.includes(r.status)) return r;
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      setError(`Error ${r.status}: ${txt.slice(0,100)}`);
      throw new Error('fetch fail');
    }
    return r;
  };

  const doLogin = async () => {
    setError('');
    setTgLogin({ phase: 'idle', challengeId: '', displayNumber: null, message: '', timeoutAt: 0 });
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: loginCred })
      });
      if (res.ok) {
        const data = await res.json();
        const t = data.token || data;
        setToken(t);
        sessionStorage.setItem('helm_token', t);
        setLoginCred('');
      } else {
        setError('login failed (invalid credential)');
      }
    } catch (e) {
      setError('login error');
    }
  };

  const clearTgPoll = () => {
    if (tgPollRef.current) {
      clearInterval(tgPollRef.current);
      tgPollRef.current = null;
    }
  };

  const finishTelegramLogin = (data) => {
    const t = data.token || data;
    setToken(t);
    sessionStorage.setItem('helm_token', t);
    setLoginCred('');
    setError('');
    setTgLogin({ phase: 'idle', challengeId: '', displayNumber: null, message: '', timeoutAt: 0 });
  };

  const pollTelegramLogin = async (challengeId, timeoutAt) => {
    if (!challengeId) return;
    if (Date.now() > timeoutAt) {
      clearTgPoll();
      setTgLogin(p => ({ ...p, phase: 'expired', message: 'Expired - try again' }));
      return;
    }
    try {
      const res = await fetch(`/api/auth/tg-status?challengeId=${encodeURIComponent(challengeId)}`);
      const data = await res.json();
      if (data.status === 'pass' && data.token) {
        clearTgPoll();
        finishTelegramLogin(data);
      } else if (data.status === 'fail') {
        clearTgPoll();
        setTgLogin(p => ({ ...p, phase: 'fail', message: 'Sign-in denied - try again' }));
      } else if (data.status === 'expired') {
        clearTgPoll();
        setTgLogin(p => ({ ...p, phase: 'expired', message: 'Expired - try again' }));
      }
    } catch {
      clearTgPoll();
      setTgLogin(p => ({ ...p, phase: 'fail', message: 'Telegram login error - try again' }));
    }
  };

  const startTelegramLogin = async () => {
    clearTgPoll();
    setError('');
    setTgLogin({ phase: 'starting', challengeId: '', displayNumber: null, message: '', timeoutAt: 0 });
    try {
      const res = await fetch('/api/auth/tg-login-start', { method: 'POST' });
      if (!res.ok) {
        setTgLogin({ phase: 'fail', challengeId: '', displayNumber: null, message: 'Telegram unavailable - try again', timeoutAt: 0 });
        return;
      }
      const data = await res.json();
      const timeoutAt = Date.now() + 150000;
      setTgLogin({ phase: 'pending', challengeId: data.challengeId, displayNumber: data.displayNumber, message: '', timeoutAt });
      await pollTelegramLogin(data.challengeId, timeoutAt);
      tgPollRef.current = setInterval(() => pollTelegramLogin(data.challengeId, timeoutAt), 2000);
    } catch {
      setTgLogin({ phase: 'fail', challengeId: '', displayNumber: null, message: 'Telegram login error - try again', timeoutAt: 0 });
    }
  };

  const cancelTelegramLogin = () => {
    clearTgPoll();
    setTgLogin({ phase: 'idle', challengeId: '', displayNumber: null, message: '', timeoutAt: 0 });
  };

  useEffect(() => {
    return () => clearTgPoll();
  }, []);

  useEffect(() => {
    const handleHash = () => {
      const h = (location.hash || '').replace('#', '');
      if (h && h !== '00-login' && h !== 'login') {
        setCurrentSlug(h);
      }
    };
    window.addEventListener('hashchange', handleHash);
    const init = (location.hash || '').replace('#', '') || '02-studio-agents';
    if (init !== '00-login' && init !== 'login') setCurrentSlug(init);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  useEffect(() => {
    if (token) {
      loadTeams();
      loadAgents();
      loadModels();
    }
  }, [token]);

  useEffect(() => {
    if (currentSlug === '02-studio-agents' && token) {
      authedFetch('/api/agents')
        .then(r => r.json())
        .then(d => setAgentsList(d.agents || []))
        .catch(() => setAgentsList([]));
      loadModels();
      loadAllToolkits();
      loadTeams();
    }
  }, [currentSlug, token]);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = () => setStudioLayoutMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => { chatTmuxSessionRef.current = chatTmuxSession; }, [chatTmuxSession]);

  // B09 fix1 / AC12: keep refusal banners fully readable (scroll into view if layout still overflows).
  useEffect(() => {
    if (!chatErr) return;
    const id = requestAnimationFrame(() => {
      const el = document.querySelector('[data-testid="chat-err"]');
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [chatErr]);
  useEffect(() => {
    if (!ccErr) return;
    const id = requestAnimationFrame(() => {
      const el = document.querySelector('[data-testid="cc-session-err"]');
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(id);
  }, [ccErr]);

  useEffect(() => {
    // E8 FIX1: this was Studio-only, so Discovery had no way to discover a live session on a full
    // reload landing directly on 07-command-center-overview — activeSessions stayed [] forever and
    // the LIVE-ATTACH reconcile effect above had nothing to match against. Widen to Discovery's route.
    const onDiscoveryRoute = currentSlug === '07-command-center-overview';
    if (!token || !(currentSlug.startsWith('02-studio') || onDiscoveryRoute)) return;
    loadActiveSessions();
    const iv = setInterval(loadActiveSessions, 3000);
    return () => clearInterval(iv);
  }, [token, currentSlug, chatSid]);

  // Session Logs: poll raw tmux pane while Logs tab OR Split mode is active + session is live.
  useEffect(() => {
    const logsVisible = chatCenterTab === 'logs' || effectiveChatCenterMode === 'split';
    if (!logsVisible || !chatSid || !selectedAgentId) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await authedFetch(`/api/agents/${selectedAgentId}/chat-session/${chatSid}/logs`);
        if (r.ok && alive) { const d = await r.json(); setChatLogs(d.logs || ''); }
      } catch {}
    };
    poll();
    const iv = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [chatCenterTab, effectiveChatCenterMode, chatSid, selectedAgentId, token]);

  useEffect(() => {
    if (currentSlug === '02-studio-agents' && token) {
      authedFetch('/api/memory?scope=app')
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('memory load failed'))))
        .then(d => setStudioAppMemCount((d.memories || []).length))
        .catch(() => setStudioAppMemCount(null));
    }
  }, [currentSlug, token]);

  const loadStudioContextMemories = async (agentId) => {
    if (!agentId || !token) {
      setStudioContextMemories([]);
      return;
    }
    try {
      let projects = projectsList;
      if ((projects || []).length === 0) {
        try {
          const pr = await authedFetch('/api/projects');
          const pd = await pr.json();
          projects = pd.projects || [];
          setProjectsList(projects);
        } catch {}
      }
      const fetches = [
        authedFetch('/api/memory?scope=app').then(r => (r.ok ? r.json() : { memories: [] })),
        authedFetch(`/api/memory?scope=agent&agent_id=${agentId}`).then(r => (r.ok ? r.json() : { memories: [] })),
      ];
      const projectId = projects && projects[0] && projects[0].id;
      if (projectId != null) {
        fetches.push(
          authedFetch(`/api/memory?scope=project&project_id=${projectId}`).then(r => (r.ok ? r.json() : { memories: [] }))
        );
      }
      const results = await Promise.all(fetches);
      const merged = results.flatMap(d => d.memories || []);
      merged.sort((a, b) => {
        const oa = MEMORY_SCOPE_ORDER[a.scope] ?? 9;
        const ob = MEMORY_SCOPE_ORDER[b.scope] ?? 9;
        if (oa !== ob) return oa - ob;
        const ta = a.updated_at || a.created_at || '';
        const tb = b.updated_at || b.created_at || '';
        return tb.localeCompare(ta);
      });
      setStudioContextMemories(merged);
    } catch {
      setStudioContextMemories([]);
    }
  };

  useEffect(() => {
    if (currentSlug === '02-studio-agents' && token && selectedAgentId) {
      loadStudioContextMemories(selectedAgentId);
    } else if (currentSlug === '02-studio-agents') {
      setStudioContextMemories([]);
    }
  }, [currentSlug, token, selectedAgentId]);

  const loadStudioContextActivity = async () => {
    setStudioContextActivityLoaded(false);
    if (!token) {
      setStudioContextActivity([]);
      setStudioContextActivityLoaded(true);
      return;
    }
    try {
      let projects = projectsList;
      if ((projects || []).length === 0) {
        try {
          const pr = await authedFetch('/api/projects');
          const pd = await pr.json();
          projects = pd.projects || [];
          setProjectsList(projects);
        } catch {}
      }
      const projectId = projects && projects[0] && projects[0].id;
      if (projectId == null) {
        setStudioContextActivity([]);
        setStudioContextActivityLoaded(true);
        return;
      }
      const [sseRecent, chatRecent] = await Promise.all([
        fetchActivitySnapshot(projectId, token),
        authedFetch(`/api/projects/${projectId}/chat`, { allowStatuses: [400, 404] })
          .then(r => (r.ok ? r.json() : { messages: [] }))
          .then(d => d.messages || [])
          .catch(() => []),
      ]);
      const byId = new Map();
      for (const ev of [...(sseRecent || []), ...(chatRecent || [])]) {
        if (ev && ev.id != null) byId.set(ev.id, ev);
      }
      setStudioContextActivity(normalizeActivityFeed([...byId.values()]));
    } catch {
      setStudioContextActivity([]);
    } finally {
      setStudioContextActivityLoaded(true);
    }
  };

  useEffect(() => {
    if (currentSlug === '02-studio-agents' && token && selectedAgentId) {
      loadStudioContextActivity();
    } else if (currentSlug === '02-studio-agents') {
      setStudioContextActivity([]);
    }
  }, [currentSlug, token, selectedAgentId]);

  useEffect(() => {
    if (!agentsActionMenuOpen) return;
    const close = () => setAgentsActionMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [agentsActionMenuOpen]);

  useEffect(() => {
    setContextIdentityExpanded(false);
    setStudioActivitySortAsc(false);
  }, [selectedAgentId]);

  useEffect(() => {
    chatThreadMessagesRef.current = chatThreadMessages;
  }, [chatThreadMessages]);

  // B6 site-2 / R6.23: Studio chat — stick only when reader was near bottom (B3 applyStick).
  useEffect(() => {
    const el = chatThreadScrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => applyStick(el, chatThreadStickRef.current));
  }, [chatThreadMessages, chatPaneContent]);

  // B1 + B06: load models + CLI facet when Models tab active
  useEffect(() => {
    if (currentSlug === '01-studio-models' && token) {
      authedFetch('/api/models')
        .then(r => r.json())
        .then(d => setModelsList(d.models || []))
        .catch(() => setModelsList([]));
      // Prefetch CLIs so the New-model form cascade is ready (B05 GET /api/models/clis).
      authedFetch('/api/models/clis')
        .then(r => r.json())
        .then(d => {
          const fromApi = Array.isArray(d.clis) ? d.clis.map(String) : [];
          setModelClis([...new Set([...fromApi, 'claude', 'codex', 'grok', 'kloo'])].sort());
        })
        .catch(() => setModelClis(['claude', 'codex', 'grok', 'kloo']));
    }
  }, [currentSlug, token]);

  // B12c: load role_tiers + models when Tiers tab active
  useEffect(() => {
    if (currentSlug === '05-studio-tiers' && token) {
      loadRoleTiers();
    }
  }, [currentSlug, token]);

  // B17: load team_tiers + models when Teams tab active
  useEffect(() => {
    if (currentSlug === '07-studio-teams' && token) {
      loadTeamTiers();
    }
  }, [currentSlug, token]);

  // B15c: load impl-L3 telemetry when Telemetry tab active
  const loadTelemetry = async () => {
    setTelemetryErr('');
    try {
      const r = await authedFetch('/api/telemetry/impl-l3');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setTelemetryErr(d.error || 'Load failed'); setTelemetryView(null); return; }
      setTelemetryView(d);
    } catch (e) {
      setTelemetryErr('Load failed (network)');
      setTelemetryView(null);
    }
  };
  const loadIntendedActual = async () => {
    try {
      const r = await authedFetch('/api/telemetry/intended-vs-actual');
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setIntendedActualView(null); return; }
      setIntendedActualView(d);
    } catch (e) {
      setIntendedActualView(null);
    }
  };
  const loadTelemetryFixtures = async () => {
    setTelemetryBusy(true);
    setTelemetryErr('');
    setTelemetryOk('');
    try {
      const r = await authedFetch('/api/telemetry/fixtures/r315', {
        method: 'POST',
        body: JSON.stringify({}),
        allowStatuses: [400, 403]
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setTelemetryErr(d.error || 'Fixture load failed'); return; }
      setTelemetryOk(`Loaded ${ (d.loaded || []).length } real-path fixtures · denom=${d.denominator}`);
      setTelemetryView(d);
    } catch (e) {
      setTelemetryErr('Fixture load failed (network)');
    } finally {
      setTelemetryBusy(false);
    }
  };
  // B20: real-path R5.23 fixture — freeze cycle + DIFFICULTY + COUPLING (B15b path)
  const loadIntendedActualFixtures = async () => {
    setTelemetryBusy(true);
    setTelemetryErr('');
    setIntendedActualOk('');
    try {
      const r = await authedFetch('/api/telemetry/fixtures/r523', {
        method: 'POST',
        body: JSON.stringify({}),
        allowStatuses: [400, 403, 500]
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setTelemetryErr(d.error || 'R5.23 fixture load failed'); return; }
      setIntendedActualOk(`R5.23 loaded · cycle=${d.cycle_id} · deltas=${(d.deltas || []).length} · coupling=${d.coupling_rows || 0}`);
      setIntendedActualView(d);
    } catch (e) {
      setTelemetryErr('R5.23 fixture load failed (network)');
    } finally {
      setTelemetryBusy(false);
    }
  };
  useEffect(() => {
    if (currentSlug === '06-studio-telemetry' && token) {
      loadTelemetry();
      loadIntendedActual();
    }
  }, [currentSlug, token]);

  // A5: load routing rules + validation when Routing tab active
  const loadRoutingRules = () => {
    authedFetch('/api/routing-rules')
      .then(r => r.json())
      .then(d => {
        setRoutingRulesList(d.rules || []);
        setRoutingValidation(d.validation || { ok: true, problems: [] });
      })
      .catch(() => {
        setRoutingRulesList([]);
        setRoutingValidation({ ok: true, problems: [] });
      });
  };
  useEffect(() => {
    if (currentSlug === '04-studio-routing' && token) {
      loadRoutingRules();
    }
  }, [currentSlug, token]);

  // A6: mutation handlers — add / edit / toggle. Every 400 carries {error, problems?} which is
  // surfaced verbatim in the routing-op-err banner (never silently dropped).
  const startEditRule = (rule) => {
    setRoutingOpErr(null);
    setEditingRuleId(rule.id);
    setRoutingEditForm({ handler_role: rule.handler_role, action: rule.action, note: rule.note || '' });
  };
  const cancelEditRule = () => {
    setEditingRuleId(null);
    setRoutingOpErr(null);
  };
  const saveEditRule = async (id) => {
    setRoutingOpErr(null);
    try {
      const r = await authedFetch(`/api/routing-rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(routingEditForm),
        allowStatuses: [400, 404]
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setRoutingOpErr(d); return; }
      setEditingRuleId(null);
      loadRoutingRules();
    } catch (e) { setRoutingOpErr({ error: 'Save failed (network)' }); }
  };
  const toggleRuleEnabled = async (rule) => {
    setRoutingOpErr(null);
    try {
      const r = await authedFetch(`/api/routing-rules/${rule.id}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: rule.enabled !== 1 }),
        allowStatuses: [400, 404]
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setRoutingOpErr(d); return; }
      loadRoutingRules();
    } catch (e) { setRoutingOpErr({ error: 'Toggle failed (network)' }); }
  };
  const addRoutingRule = async () => {
    setRoutingOpErr(null);
    const { emitter_role, when_status, handler_role, action, note } = routingAddForm;
    if (!emitter_role.trim() || !when_status.trim() || !handler_role.trim() || !action.trim()) {
      setRoutingOpErr({ error: 'emitter_role, when_status, handler_role, action are required' });
      return;
    }
    try {
      const r = await authedFetch('/api/routing-rules', {
        method: 'POST',
        body: JSON.stringify({ emitter_role, when_status, handler_role, action, note: note || null }),
        allowStatuses: [400]
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setRoutingOpErr(d); return; }
      setRoutingAddForm({ emitter_role: '', when_status: '', handler_role: '', action: '', note: '' });
      loadRoutingRules();
    } catch (e) { setRoutingOpErr({ error: 'Add failed (network)' }); }
  };

  useEffect(() => {
    let saved = localStorage.getItem(THEME_KEY);
    if (!saved) {
      const mql = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
      const prefersLight = mql ? mql.matches : false;
      saved = prefersLight ? 'light' : 'dark';
    }
    applyTheme(saved);

    const mql = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    const listener = (e) => {
      if (!localStorage.getItem(THEME_KEY)) {
        applyTheme(e.matches ? 'light' : 'dark');
      }
    };
    if (mql && mql.addEventListener) {
      mql.addEventListener('change', listener);
    }
    return () => {
      if (mql && mql.removeEventListener) {
        mql.removeEventListener('change', listener);
      }
    };
  }, []);

  const navigateTo = (slug) => {
    setCurrentSlug(slug);
    history.replaceState(null, '', '#' + slug);
  };

  const onNav = (sec) => {
    const s = SECTIONS[sec];
    if (s) {
      navigateTo(s.tabs[0].slug);
      setDrawerOpen(false);
    }
  };

  const onTab = (slug) => {
    navigateTo(slug);
    setDrawerOpen(false);
  };

  const goStudioAddMemory = () => {
    onTab('10-memory');
    startNewMemory();
  };
  const goStudioSearchMemories = () => {
    onTab('10-memory');
  };

  // B1 helpers (scoped to App; use existing authedFetch for all API; surface server errs inline in editor card)
  const loadModels = async () => {
    try {
      const r = await authedFetch('/api/models');
      const d = await r.json();
      setModelsList(d.models || []);
    } catch {}
  };
  // B06 R1.1: cascade facet loaders (B05 APIs). Fail soft → empty lists.
  const KNOWN_CLIS = ['claude', 'codex', 'grok', 'kloo'];
  const loadModelClis = async () => {
    try {
      const r = await authedFetch('/api/models/clis');
      const d = await r.json();
      const fromApi = Array.isArray(d.clis) ? d.clis.map(String) : [];
      const merged = [...new Set([...fromApi, ...KNOWN_CLIS])].sort();
      setModelClis(merged);
    } catch {
      setModelClis(KNOWN_CLIS.slice());
    }
  };
  const loadModelProviders = async (cli) => {
    if (!cli) { setModelProviders([]); return; }
    try {
      const r = await authedFetch(`/api/models/providers?cli=${encodeURIComponent(cli)}`);
      const d = await r.json();
      const fromApi = Array.isArray(d.providers) ? d.providers.map(String) : [];
      // Ensure the selected CLI itself is always choosable as provider (1:1 cli→provider families).
      const merged = [...new Set(fromApi.length ? fromApi : [cli])].sort();
      setModelProviders(merged);
    } catch {
      setModelProviders([cli]);
    }
  };
  const loadCascadeModels = async (cli, provider) => {
    if (!cli || !provider) { setCascadeModels([]); return; }
    try {
      const qs = `cli=${encodeURIComponent(cli)}&provider=${encodeURIComponent(provider)}`;
      const r = await authedFetch(`/api/models?${qs}`);
      const d = await r.json();
      setCascadeModels(Array.isArray(d.models) ? d.models : []);
    } catch {
      setCascadeModels([]);
    }
  };
  const onModelCliChange = (cli) => {
    setModelForm((prev) => ({
      ...prev,
      cli,
      provider: '',
      model_id: '',
      slug: '',
      route: '',
    }));
    setCascadeModels([]);
    setKlooModelFilter('');
    setKlooModels({ models: [], cached: false, note: '' });
    loadModelProviders(cli);
  };
  const onModelProviderChange = (provider) => {
    setModelForm((prev) => ({
      ...prev,
      provider,
      model_id: provider === 'kloo' ? '' : prev.model_id,
      slug: '',
      route: provider === 'kloo' ? prev.route : '',
    }));
    setKlooModelFilter('');
    if (provider === 'kloo') loadKlooRoutes();
    else setKlooModels({ models: [], cached: false, note: '' });
    loadCascadeModels(modelForm.cli, provider);
  };
  // B3 (kloo): routes list + per-route model catalog. Never throws — mirrors authedFetch's
  // banner-on-error behavior but degrades the cascading dropdowns to empty instead of blocking the form.
  const loadKlooRoutes = async () => {
    setKlooRoutesLoading(true);
    try {
      const r = await authedFetch('/api/kloo/routes');
      const d = await r.json();
      setKlooRoutesList(d.routes || []);
    } catch {
      setKlooRoutesList([]);
    } finally {
      setKlooRoutesLoading(false);
    }
  };
  const loadKlooModels = async (route, refresh) => {
    if (!route) { setKlooModels({ models: [], cached: false, note: '' }); return; }
    setKlooModelsLoading(true);
    try {
      const r = await authedFetch(`/api/kloo/routes/${encodeURIComponent(route)}/models${refresh ? '?refresh=1' : ''}`);
      const d = await r.json();
      setKlooModels({ models: d.models || [], cached: !!d.cached, note: d.note || '' });
    } catch {
      setKlooModels({ models: [], cached: false, note: 'failed to load models' });
    } finally {
      setKlooModelsLoading(false);
    }
  };
  const startNewModel = () => {
    setEditingModel({});
    setModelForm({ name: '', cli: '', provider: '', model_id: '', slug: '', display_name: '', effort: 'medium', approval: 'auto', flags: '', route: '' });
    setModelErr('');
    setModelProviders([]);
    setCascadeModels([]);
    setKlooModelFilter('');
    setKlooModels({ models: [], cached: false, note: '' });
    loadModelClis();
  };
  const startEditModel = (m) => {
    setEditingModel(m);
    const cli = m.cli || m.provider || '';
    const provider = m.provider || '';
    setModelForm({
      name: m.name || '',
      cli,
      provider,
      model_id: m.model_id || '',
      slug: m.slug || '',
      display_name: m.display_name || m.name || '',
      effort: m.effort || 'medium',
      approval: m.approval || 'auto',
      flags: m.flags || '',
      route: m.route || ''
    });
    setModelErr('');
    setKlooModelFilter('');
    setKlooModels({ models: [], cached: false, note: '' });
    loadModelClis();
    if (cli) loadModelProviders(cli);
    if (cli && provider) loadCascadeModels(cli, provider);
    if (provider === 'kloo' || cli === 'kloo') {
      loadKlooRoutes();
      if (m.route) loadKlooModels(m.route, false);
    }
  };
  const cancelEditModel = () => {
    setEditingModel(null);
    setModelErr('');
  };
  const validateModel = async (id) => {
    setModelErr('');
    setValidatingModelIds((prev) => new Set(prev).add(id));
    try {
      await authedFetch(`/api/models/${id}/validate`, { method: 'POST', body: JSON.stringify({}) });
      await loadModels();
    } catch (e) {
      setModelErr('Validation failed (see banner for details)');
    } finally {
      setValidatingModelIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };
  const saveModel = async () => {
    setModelErr('');
    // B06 R1.2: visible client-side reject when CLI missing (I1).
    const cliTrim = String(modelForm.cli || '').trim();
    if (!cliTrim) {
      setModelErr('CLI is required — pick a CLI before saving.');
      return;
    }
    try {
      const payload = {
        name: modelForm.name,
        cli: cliTrim,
        provider: modelForm.provider,
        model_id: modelForm.model_id,
        display_name: modelForm.display_name || modelForm.name || undefined,
        slug: modelForm.slug || undefined,
        effort: modelForm.effort,
        approval: modelForm.approval,
        flags: modelForm.flags,
        route: modelForm.provider === 'kloo' ? (modelForm.route || null) : null,
      };
      if (editingModel && editingModel.id) {
        const r = await authedFetch(`/api/models/${editingModel.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
          allowStatuses: [400],
        });
        if (r.status === 400) {
          const d = await r.json().catch(() => ({}));
          if (d && d.field === 'cli') {
            setModelErr(d.error || 'CLI is required');
            return;
          }
          setModelErr((d && d.error) || 'Save failed');
          return;
        }
        setEditingModel(null);
        await loadModels();
        await loadModelClis();
      } else {
        const r = await authedFetch('/api/models', {
          method: 'POST',
          body: JSON.stringify(payload),
          allowStatuses: [400],
        });
        if (r.status === 400) {
          const d = await r.json().catch(() => ({}));
          if (d && d.field === 'cli') {
            setModelErr(d.error || 'CLI is required');
            return;
          }
          setModelErr((d && d.error) || 'Save failed');
          return;
        }
        const d = await r.json();
        setEditingModel(null);
        await loadModels();
        await loadModelClis();
        if (d.model && d.model.id) {
          await validateModel(d.model.id);
        }
      }
    } catch (e) {
      setModelErr('Save failed (see banner for details)');
    }
  };
  const deleteModel = async (idOrNull) => {
    const id = idOrNull || (editingModel && editingModel.id);
    if (!id) return;
    setModelErr('');
    try {
      await authedFetch(`/api/models/${id}`, { method: 'DELETE' });
      if (editingModel && editingModel.id === id) setEditingModel(null);
      await loadModels();
    } catch (e) {
      setModelErr('Delete failed (see banner)');
    }
  };

  // B12c / R3.12: studio role_tiers load + save (B13 invariants surface as 400 error)
  const ROLE_TIER_UI_ROLES = ['implementer', 'validator'];
  const ROLE_TIER_UI_LEVELS = ['L1', 'L2', 'L3'];
  const loadRoleTiers = async () => {
    try {
      const [rtR, mR] = await Promise.all([
        authedFetch('/api/role-tiers'),
        authedFetch('/api/models'),
      ]);
      const rtD = await rtR.json();
      const mD = await mR.json();
      setModelsList(mD.models || []);
      const rows = rtD.role_tiers || [];
      const draft = {};
      for (const role of ROLE_TIER_UI_ROLES) {
        for (const tier of ROLE_TIER_UI_LEVELS) {
          const hit = rows.find(r => r.role === role && r.tier === tier);
          draft[`${role}/${tier}`] = {
            primary_model_id: hit && hit.primary_model_id != null ? String(hit.primary_model_id) : '',
            backup_model_id: hit && hit.backup_model_id != null ? String(hit.backup_model_id) : '',
            exists: !!hit,
          };
        }
      }
      setRoleTiersDraft(draft);
      setRoleTiersLoaded(true);
      setRoleTiersErr('');
    } catch (e) {
      setRoleTiersLoaded(true);
      setRoleTiersErr('Failed to load role tiers');
    }
  };
  const setRoleTierField = (role, tier, field, value) => {
    const key = `${role}/${tier}`;
    setRoleTiersDraft(d => ({
      ...d,
      [key]: Object.assign({}, d[key] || { primary_model_id: '', backup_model_id: '', exists: false }, { [field]: value }),
    }));
    setRoleTiersErr('');
    setRoleTiersOk('');
  };
  const saveRoleTier = async (role, tier) => {
    const key = `${role}/${tier}`;
    const row = roleTiersDraft[key] || {};
    const body = {
      primary_model_id: row.primary_model_id ? Number(row.primary_model_id) : null,
      backup_model_id: row.backup_model_id ? Number(row.backup_model_id) : null,
    };
    setRoleTiersSaving(true);
    setRoleTiersErr('');
    setRoleTiersOk('');
    try {
      const exists = row.exists !== false && row.exists !== undefined
        ? row.exists
        : true; // seeded seats: prefer PUT; POST if known missing
      let r;
      if (exists) {
        r = await authedFetch(`/api/role-tiers/${role}/${tier}`, {
          method: 'PUT',
          body: JSON.stringify(body),
          allowStatuses: [400, 404, 409],
        });
        // If row missing on server, create once.
        if (r.status === 404) {
          r = await authedFetch('/api/role-tiers', {
            method: 'POST',
            body: JSON.stringify({ role, tier, ...body }),
            allowStatuses: [400, 409],
          });
        }
      } else {
        r = await authedFetch('/api/role-tiers', {
          method: 'POST',
          body: JSON.stringify({ role, tier, ...body }),
          allowStatuses: [400, 409],
        });
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setRoleTiersErr((d && d.error) || `Save failed for ${role}/${tier} (${r.status})`);
        return false;
      }
      setRoleTiersOk(`Saved ${role}/${tier}`);
      await loadRoleTiers();
      return true;
    } catch (e) {
      setRoleTiersErr('Save failed (see banner)');
      return false;
    } finally {
      setRoleTiersSaving(false);
    }
  };
  const saveAllRoleTiers = async () => {
    setRoleTiersSaving(true);
    setRoleTiersErr('');
    setRoleTiersOk('');
    try {
      for (const role of ROLE_TIER_UI_ROLES) {
        for (const tier of ROLE_TIER_UI_LEVELS) {
          const key = `${role}/${tier}`;
          const row = roleTiersDraft[key] || {};
          const body = {
            primary_model_id: row.primary_model_id ? Number(row.primary_model_id) : null,
            backup_model_id: row.backup_model_id ? Number(row.backup_model_id) : null,
          };
          let r = await authedFetch(`/api/role-tiers/${role}/${tier}`, {
            method: 'PUT',
            body: JSON.stringify(body),
            allowStatuses: [400, 404, 409],
          });
          if (r.status === 404) {
            r = await authedFetch('/api/role-tiers', {
              method: 'POST',
              body: JSON.stringify({ role, tier, ...body }),
              allowStatuses: [400, 409],
            });
          }
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            setRoleTiersErr((d && d.error) || `Save failed for ${role}/${tier} (${r.status})`);
            return;
          }
        }
      }
      setRoleTiersOk('All role tiers saved');
      await loadRoleTiers();
    } catch (e) {
      setRoleTiersErr('Save failed (see banner)');
    } finally {
      setRoleTiersSaving(false);
    }
  };

  // B17 / R4: studio team_tiers load + save (B16 API)
  const TEAM_TIER_UI_TYPES = ['deliberation', 'red-team'];
  const TEAM_TIER_UI_LEVELS = ['budget', 'standard', 'elite'];
  const loadTeamTiers = async () => {
    try {
      const [ttR, mR] = await Promise.all([
        authedFetch('/api/team-tiers'),
        authedFetch('/api/models'),
      ]);
      const ttD = await ttR.json();
      const mD = await mR.json();
      setModelsList(mD.models || []);
      const rows = ttD.team_tiers || [];
      const draft = {};
      for (const teamType of TEAM_TIER_UI_TYPES) {
        for (const tier of TEAM_TIER_UI_LEVELS) {
          const hit = rows.find(r => r.team_type === teamType && r.tier === tier);
          draft[`${teamType}/${tier}`] = {
            model_ids: hit && Array.isArray(hit.models)
              ? hit.models.map(m => Number(m.model_id)).filter(n => Number.isFinite(n) && n > 0)
              : [],
          };
        }
      }
      setTeamTiersDraft(draft);
      setTeamTiersLoaded(true);
      setTeamTiersErr('');
    } catch (e) {
      setTeamTiersLoaded(true);
      setTeamTiersErr('Failed to load team tiers');
    }
  };
  const setTeamTierModels = (teamType, tier, modelIds) => {
    const key = `${teamType}/${tier}`;
    setTeamTiersDraft(d => ({
      ...d,
      [key]: { model_ids: modelIds.slice() },
    }));
    setTeamTiersErr('');
    setTeamTiersOk('');
  };
  const addTeamTierModel = (teamType, tier) => {
    const key = `${teamType}/${tier}`;
    const pick = teamTiersAddPick[key];
    if (!pick) return;
    const mid = Number(pick);
    if (!Number.isFinite(mid) || mid <= 0) return;
    const row = teamTiersDraft[key] || { model_ids: [] };
    const ids = row.model_ids || [];
    if (ids.map(Number).includes(mid)) {
      setTeamTiersErr(`${teamType}/${tier}: model already in roster`);
      return;
    }
    setTeamTierModels(teamType, tier, ids.concat([mid]));
    setTeamTiersAddPick(p => ({ ...p, [key]: '' }));
  };
  const removeTeamTierModel = (teamType, tier, modelId) => {
    const key = `${teamType}/${tier}`;
    const row = teamTiersDraft[key] || { model_ids: [] };
    setTeamTierModels(teamType, tier, (row.model_ids || []).filter(id => Number(id) !== Number(modelId)));
  };
  const moveTeamTierModel = (teamType, tier, index, dir) => {
    const key = `${teamType}/${tier}`;
    const row = teamTiersDraft[key] || { model_ids: [] };
    const ids = (row.model_ids || []).slice();
    const j = index + dir;
    if (index < 0 || j < 0 || index >= ids.length || j >= ids.length) return;
    const tmp = ids[index];
    ids[index] = ids[j];
    ids[j] = tmp;
    setTeamTierModels(teamType, tier, ids);
  };
  const saveTeamTier = async (teamType, tier) => {
    const key = `${teamType}/${tier}`;
    const row = teamTiersDraft[key] || { model_ids: [] };
    const model_ids = (row.model_ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    setTeamTiersSaving(true);
    setTeamTiersErr('');
    setTeamTiersOk('');
    try {
      const r = await authedFetch(`/api/team-tiers/${teamType}/${tier}`, {
        method: 'PUT',
        body: JSON.stringify({ model_ids }),
        allowStatuses: [400, 404, 409],
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setTeamTiersErr((d && d.error) || `Save failed for ${teamType}/${tier} (${r.status})`);
        return false;
      }
      setTeamTiersOk(`Saved ${teamType}/${tier}`);
      await loadTeamTiers();
      return true;
    } catch (e) {
      setTeamTiersErr('Save failed (see banner)');
      return false;
    } finally {
      setTeamTiersSaving(false);
    }
  };
  const saveAllTeamTiers = async () => {
    setTeamTiersSaving(true);
    setTeamTiersErr('');
    setTeamTiersOk('');
    try {
      for (const teamType of TEAM_TIER_UI_TYPES) {
        for (const tier of TEAM_TIER_UI_LEVELS) {
          const key = `${teamType}/${tier}`;
          const row = teamTiersDraft[key] || { model_ids: [] };
          const model_ids = (row.model_ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
          const r = await authedFetch(`/api/team-tiers/${teamType}/${tier}`, {
            method: 'PUT',
            body: JSON.stringify({ model_ids }),
            allowStatuses: [400, 404, 409],
          });
          if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            setTeamTiersErr((d && d.error) || `Save failed for ${teamType}/${tier} (${r.status})`);
            return;
          }
        }
      }
      setTeamTiersOk('All team tiers saved');
      await loadTeamTiers();
    } catch (e) {
      setTeamTiersErr('Save failed (see banner)');
    } finally {
      setTeamTiersSaving(false);
    }
  };

  // B2 helpers (reuse authedFetch body-aware, loadModels, existing /agents + /toolkits + /models endpoints)
  const loadAgents = async () => {
    try {
      const r = await authedFetch('/api/agents');
      const d = await r.json();
      setAgentsList(d.agents || []);
    } catch {}
  };
  const loadActiveSessions = async () => {
    if (!token) return;
    try {
      const r = await authedFetch('/api/agents/active-sessions');
      if (r.ok) { const d = await r.json(); setActiveSessions(d.sessions || []); }
    } catch {}
  };
  const closeActiveSession = async (sess) => {
    if (!sess?.session_id || !sess?.agent_id) return;
    try {
      await authedFetch(`/api/agents/${sess.agent_id}/chat-session/${sess.session_id}`, { method: 'DELETE' });
    } catch {}
    if (selectedAgentId === sess.agent_id && chatSid === sess.session_id) {
      detachChatStream();
      setChatSid(null);
      setChatTmuxSession(null);
      setChatLogs('');
      setChatPaneContent('');
      setChatThreadMessages([]);
      chatThreadMessagesRef.current = [];
      chatPaneBaselineRef.current = '';
      chatPendingUserRef.current = '';
      delete agentChatCacheRef.current[sess.agent_id];
    } else if (agentChatCacheRef.current[sess.agent_id]?.sid === sess.session_id) {
      delete agentChatCacheRef.current[sess.agent_id];
    }
    await loadActiveSessions();
  };
  const saveAgentRename = async () => {
    const name = String(agentRenameDraft || '').trim();
    if (!selectedAgentId) return;
    if (!name) { setChatErr('Agent name cannot be empty'); return; }
    setChatErr('');
    try {
      const r = await authedFetch(`/api/agents/${selectedAgentId}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
        allowStatuses: [400],
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setChatErr(d.error || 'Rename failed');
        return;
      }
      const d = await r.json();
      const updated = d.agent || {};
      setAgentName(updated.name || name);
      setAgentRenameEditing(false);
      await loadAgents();
      await loadActiveSessions();
    } catch (e) {
      setChatErr(String(e.message || e));
    }
  };
  const loadAllToolkits = async () => {
    try {
      const r = await authedFetch('/api/toolkits');
      const d = await r.json();
      setAllToolkits(d.toolkits || []);
    } catch {}
  };
  const loadAttached = async (agentId) => {
    try {
      const r = await authedFetch(`/api/agents/${agentId}/toolkits`);
      const d = await r.json();
      setAttachedToolkits(d.toolkits || []);
    } catch {}
  };
  const loadAgentEscalations = async (agentId) => {
    try {
      const r = await authedFetch(`/api/agents/${agentId}/escalations`);
      const d = await r.json();
      setAgentEscalations(d.escalations || []);
    } catch { setAgentEscalations([]); }
  };
  const loadTeams = async () => {
    try {
      const r = await authedFetch('/api/teams');
      const d = await r.json();
      const teams = d.teams || [];
      setTeamsList(teams);
      const memberEntries = await Promise.all(teams.map(async (t) => {
        try {
          const mr = await authedFetch(`/api/teams/${t.id}`);
          const md = await mr.json();
          return [t.id, md.members || []];
        } catch {
          return [t.id, []];
        }
      }));
      setTeamMembersByTeamId(Object.fromEntries(memberEntries));
    } catch {
      setTeamsList([]);
      setTeamMembersByTeamId({});
    }
  };
  const loadTeam = async (tid) => {
    try {
      const r = await authedFetch(`/api/teams/${tid}`);
      const d = await r.json();
      setTeamForm({ name: d.team?.name || '', type: d.team?.type || 'deliberation', consensus_rule: d.team?.consensus_rule || '', protocol_note: d.team?.protocol_note || '' });
      setTeamMembers(d.members || []);
      setTeamErr('');
    } catch {}
  };
  const getEndedSessionsForAgent = (agentId) => {
    if (!agentId) return [];
    return agentChatCacheRef.current._ended?.[agentId] || [];
  };
  const loadPastSessionsForAgent = (agentId) => {
    setStudioPastSessions(getEndedSessionsForAgent(agentId));
  };
  const archiveEndedSession = (agentId) => {
    if (!agentId) return;
    const msgs = chatThreadMessagesRef.current;
    if (!msgs || msgs.length === 0) return;
    const firstUser = msgs.find(m => m.role === 'user');
    const summary = (firstUser?.text || '').split('\n')[0].trim().slice(0, 100)
      || `${msgs.length} message${msgs.length === 1 ? '' : 's'}`;
    const row = {
      id: chatSid || `ended-${Date.now()}`,
      endedAt: Date.now(),
      summary,
      messages: msgs.map(m => ({ ...m })),
      paneContent: chatPaneContent,
    };
    if (!agentChatCacheRef.current._ended) agentChatCacheRef.current._ended = {};
    const list = agentChatCacheRef.current._ended[agentId] || [];
    const dup = list.some(r => r.id === row.id && Math.abs(r.endedAt - row.endedAt) < 2000);
    if (!dup) {
      agentChatCacheRef.current._ended[agentId] = [row, ...list].slice(0, 30);
    }
    if (agentId === selectedAgentId) loadPastSessionsForAgent(agentId);
  };
  const viewPastSession = (row) => {
    const msgs = row.messages || [];
    setChatThreadMessages(msgs);
    chatThreadMessagesRef.current = msgs;
    setChatPaneContent(row.paneContent || '');
    chatPaneBaselineRef.current = row.paneContent || '';
    setChatSid(null);
    detachChatStream();
    setStudioChatOpen(true);
    setStudioCenterView('chat');
    setChatInput('');
    setChatErr('');
  };
  const syncChatCache = (agentId, sid, pane, messages, tmuxSession) => {
    if (!agentId || !sid) return;
    agentChatCacheRef.current[agentId] = {
      sid,
      paneContent: pane,
      messages: messages ?? chatThreadMessagesRef.current,
      paneBaseline: chatPaneBaselineRef.current,
      tmuxSession: tmuxSession ?? chatTmuxSessionRef.current ?? null,
    };
  };
  const ingestPaneForThread = (nextPane) => {
    // Marker-based, idempotent recompute of the current turn's agent bubble (thinking → reply).
    const pending = chatPendingUserRef.current;
    const r = extractHelmReply(nextPane, pending);
    // DC-R1: drive "thinking…" off the LIVE pane generating signal, not marker presence.
    const thinking = paneLooksGenerating(nextPane);
    const fallback = r.state === 'fallback';
    let text = r.text || '';
    if (!thinking && !text) text = extractAgentPaneSegment('', nextPane, pending) || '';
    if (!thinking && !text) return;
    setChatThreadMessages(prev => {
      const last = prev[prev.length - 1];
      const bubble = { role: 'agent', text, thinking, fallback };
      // E7 fix: only merge into the last bubble when this is the SAME reply still forming
      // (growing/shrinking text). A second, distinct reply — even one that starts by
      // re-entering "thinking" — must append a new bubble instead of overwriting the first.
      if (isAgentReplyContinuation(last, text)) {
        return [...prev.slice(0, -1), { ...last, ...bubble, ts: last.ts || Date.now() }];
      }
      return [...prev, { id: nextChatMsgId(), ts: Date.now(), ...bubble }];
    });
    chatPaneBaselineRef.current = nextPane;
    // iter3: do NOT clear on reply/fallback to keep persistent anchor (mirrors cc; studio re-tested)
  };
  const detachChatStream = () => {
    if (chatEsRef.current) { chatEsRef.current.close(); chatEsRef.current = null; }
  };
  const cacheChatForAgent = (agentId) => {
    if (!agentId || !chatSid) return;
    syncChatCache(agentId, chatSid, chatPaneContent);
  };
  const restoreChatForAgent = (agentId) => {
    const cached = agentId ? agentChatCacheRef.current[agentId] : null;
    if (cached?.sid) {
      setChatSid(cached.sid);
      setChatTmuxSession(cached.tmuxSession || null);
      setChatPaneContent(cached.paneContent || '');
      setChatThreadMessages(cached.messages || []);
      chatThreadMessagesRef.current = cached.messages || [];
      chatPaneBaselineRef.current = cached.paneBaseline || cached.paneContent || '';
    } else {
      setChatSid(null);
      setChatTmuxSession(null);
      setChatPaneContent('');
      setChatThreadMessages([]);
      chatThreadMessagesRef.current = [];
      chatPaneBaselineRef.current = '';
    }
    chatPendingUserRef.current = '';
    setChatInput('');
    setChatErr('');
  };
  const attachChatStream = (agentId, sessionId) => {
    detachChatStream();
    // F2 round-6/7: Studio channel = `studio:<agentId>`, derived SERVER-SIDE from the agent route (finding #1;
    // no client ?channel=). Shares the process-wide epoch/loss refs + the channel-keyed cursor map with CC.
    // Resume from this channel's seq + the last-seen epoch. `channel` is the CLIENT cursor-map key; `ackUrl` is
    // the server-scoped ack endpoint.
    const channel = `studio:${agentId}`;
    const ackUrl = `/api/agents/${agentId}/chat-session/${sessionId}/chat-delivery-ack`;
    const sinceFailSeq = ccChannelCursorRef.current[channel] || 0;
    const epoch = ccDeliveryEpochRef.current || '';
    const es = new EventSource(`/api/agents/${agentId}/chat-session/${sessionId}/stream?access_token=${encodeURIComponent(token)}&sinceFailSeq=${sinceFailSeq}&epoch=${encodeURIComponent(epoch)}`);
    chatEsRef.current = es;
    const noteLoss = (gen) => {
      if (typeof gen !== 'number') return;
      if (gen > (ccLastLossGenRef.current || 0)) ccLastLossGenRef.current = gen;
      if (gen > (ccLossGenAckedRef.current || 0)) setCcGlobalLossWarn(true);
    };
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'pane') {
          setChatPaneContent(msg.content);
          ingestPaneForThread(msg.content);
          syncChatCache(agentId, sessionId, msg.content);
        } else if (msg.type === 'delivery-epoch') {
          if (ccDeliveryEpochRef.current && ccDeliveryEpochRef.current !== msg.epoch) {
            ccChannelCursorRef.current = {};
            if ((chatThreadMessagesRef.current || []).some(m => m && m.role === 'user' && m.delivered !== false)) setChatDeliveryGap(true);
          }
          ccDeliveryEpochRef.current = msg.epoch;
          noteLoss(msg.lossGeneration);
        } else if (msg.type === 'loss-generation') {
          noteLoss(msg.lossGeneration);
        } else if (msg.type === 'delivery-failed') {
          // round-7 (finding #3): RENDER-before-ack. Correct the EXACT optimistic user message (by stable msgId,
          // never text); if its bubble is gone (prior seat, cleared on an F3 switch) show a channel-level gap
          // instead of a silent no-op. ACK only AFTER the visible transition.
          const { matched } = applyDeliveryFailedById(chatThreadMessagesRef.current || [], msg.msgId);
          if (matched) setChatThreadMessages(prev => markUndeliveredById(prev, msg.msgId));
          else setChatDeliveryGap(true);
          if (typeof msg.seq === 'number') { ccChannelCursorRef.current[channel] = Math.max(ccChannelCursorRef.current[channel] || 0, msg.seq); ccAckDelivery(ackUrl, msg.seq); }
        } else if (msg.type === 'delivery-failed-gap') {
          setChatDeliveryGap(true);
          if (typeof msg.throughSeq === 'number') { ccChannelCursorRef.current[channel] = Math.max(ccChannelCursorRef.current[channel] || 0, msg.throughSeq); ccAckDelivery(ackUrl, msg.throughSeq); }
        } else if (msg.type === 'error') { setChatErr(msg.error); endChat(agentId, sessionId); }
      } catch {}
    };
    es.onerror = () => { setChatErr('SSE connection lost'); };
  };
  const spawnChatSession = async (agentId) => {
    // AGENTROLE T5: pass model_id override for PROJECT agents (helm agents always use their configured model).
    const selectedAgent = (agentsList || []).find(a => a.id === agentId);
    const isHelmAgent = selectedAgent?.kind === 'house' || selectedAgent?.agent_type === 'house' || selectedAgent?.agent_type === 'helm';
    const body = (!isHelmAgent && chatSpawnModelOverride)
      ? JSON.stringify({ model_id: chatSpawnModelOverride })
      : undefined;
    // B09 / AC12: allow 409 so collision body reaches setChatErr (not global "fetch fail").
    const r = await authedFetch(`/api/agents/${agentId}/chat-session`, {
      method: 'POST',
      allowStatuses: [409],
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body } : {})
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      // Busy-attach is project-chat only; Studio has no session_id attach path on this POST.
      if (d && d.code === 'SESSION_NAME_COLLISION') {
        throw new Error(d.error || ('session name collision refused (' + (d.reason || 'unknown') + ')'));
      }
      throw new Error(d.error || r.status);
    }
    const { session_id, tmux_session, spawn_model } = d;
    setChatSid(session_id);
    setChatTmuxSession(tmux_session || null);
    setChatActualSpawnModel(spawn_model || '');
    setChatPaneContent('');
    setChatThreadMessages([]);
    chatThreadMessagesRef.current = [];
    chatPaneBaselineRef.current = '';
    chatPendingUserRef.current = '';
    syncChatCache(agentId, session_id, '', [], tmux_session || null);
    attachChatStream(agentId, session_id);
    loadActiveSessions();
    return session_id;
  };
  const ensureChatSession = async () => {
    if (!selectedAgentId || chatConnecting) return null;
    if (chatSid) {
      if (!chatEsRef.current) attachChatStream(selectedAgentId, chatSid);
      return chatSid;
    }
    setChatConnecting(true);
    setChatErr('');
    try {
      const cached = agentChatCacheRef.current[selectedAgentId];
      if (cached?.sid) {
        setChatSid(cached.sid);
        setChatTmuxSession(cached.tmuxSession || null);
        setChatPaneContent(cached.paneContent || '');
        attachChatStream(selectedAgentId, cached.sid);
        return cached.sid;
      }
      return await spawnChatSession(selectedAgentId);
    } catch (e) {
      setChatErr(String(e.message || e));
      return null;
    } finally {
      setChatConnecting(false);
    }
  };
  const closeChatSurface = () => {
    if (selectedAgentId) cacheChatForAgent(selectedAgentId);
    detachChatStream();
    setStudioChatOpen(false);
    setChatInput('');
    setChatErr('');
  };
  const selectAgent = (a) => {
    if (selectedAgentId) {
      archiveEndedSession(selectedAgentId);
      cacheChatForAgent(selectedAgentId);
    }
    detachChatStream();
    setSelectedAgentId(a.id);
    setSelectedTeamId(null);
    setStudioCenterView('configure');
    setStudioChatOpen(true);
    setAgentDetailTab('models');
    setAgentName(a.name || '');
    setAgentDefMd(a.definition_md || '');
    setDefMdMode('rendered');
    setExpandedSkillId(null);
    setBindings({
      default_model_id: a.default_model_id != null ? String(a.default_model_id) : '',
      backup_model_id: a.backup_model_id != null ? String(a.backup_model_id) : '',
      spawn_pref: a.spawn_pref || 'tmux'
    });
    setAgentClassification(a.classification === 'tiered' || a.classification === 'team' ? a.classification : 'solo');
    setAgentDefaultEffort(a.default_effort || 'medium');
    setAgentErr('');
    setAgentInDev(!!a.in_development);
    setAgentRenameEditing(false);
    setChatSpawnModelOverride(''); // AGENTROLE T5: reset model override on agent switch
    setChatActualSpawnModel('');
    restoreChatForAgent(a.id);
    loadPastSessionsForAgent(a.id);
    loadAttached(a.id);
    loadAgentEscalations(a.id);
    loadAgentProposals(a.id);
  };
  const attachToActiveSession = (agent, session) => {
    if (selectedAgentId === agent.id && chatSid === session.session_id) {
      if (!chatEsRef.current) attachChatStream(agent.id, session.session_id);
      return;
    }
    selectAgent(agent);
    setStudioCenterView('chat');
    setChatSid(session.session_id);
    setChatTmuxSession(session.tmux_session || null);
    attachChatStream(agent.id, session.session_id);
  };
  const startNewAgent = () => {
    if (selectedAgentId) {
      archiveEndedSession(selectedAgentId);
      cacheChatForAgent(selectedAgentId);
    }
    detachChatStream();
    setSelectedAgentId(null);
    setSelectedTeamId(null);
    setStudioCenterView('configure');
    setAgentDetailTab('identity');
    setAgentName('');
    setAgentDefMd('');
    setDefMdMode('rendered');
    setExpandedSkillId(null);
    setBindings({ default_model_id: '', backup_model_id: '', spawn_pref: 'tmux' });
    setAttachedToolkits([]);
    setAgentEscalations([]);
    setAgentClassification('solo');
    setAgentDefaultEffort('medium');
    setAgentErr('');
    setAgentInDev(false);
    setAgentProposals([]);
    setChatSid(null);
    setChatTmuxSession(null);
    setChatPaneContent('');
    setChatInput('');
    setChatErr('');
    setStudioPastSessions([]);
  };
  /** B9/AC-14: change classification; confirm when editing a saved agent; soft-keep rungs/members. */
  const onAgentClassificationChange = (next) => {
    const cls = (next === 'tiered' || next === 'team') ? next : 'solo';
    if (cls === agentClassification) return;
    if (selectedAgentId) {
      const ok = window.confirm(
        'Changing classification hides prior tiered/team config until you switch back. Existing rungs/members are kept (not deleted). Continue?'
      );
      if (!ok) return;
    }
    setAgentClassification(cls);
  };
  const endChat = async (agentId, sid) => {
    const aid = agentId ?? selectedAgentId;
    const s = sid ?? chatSid;
    archiveEndedSession(aid);
    detachChatStream();
    setChatSid(null);
    setChatTmuxSession(null);
    setChatLogs('');
    setChatPaneContent('');
    setChatThreadMessages([]);
    chatThreadMessagesRef.current = [];
    chatPaneBaselineRef.current = '';
    chatPendingUserRef.current = '';
    setChatInput('');
    setChatErr('');
    if (aid) delete agentChatCacheRef.current[aid];
    if (aid) loadPastSessionsForAgent(aid);
    if (aid && s) authedFetch(`/api/agents/${aid}/chat-session/${s}`, { method: 'DELETE' }).catch(() => {});
    loadActiveSessions();
  };
  // A2: Clear/Compact context controls for the active test-chat session.
  const clearChatContext = async () => {
    if (!selectedAgentId || !chatSid || chatCtxPending) return;
    setChatCtxPending(true);
    setChatErr('');
    try {
      const r = await authedFetch(`/api/agents/${selectedAgentId}/chat-session/${chatSid}/clear`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok || !d.issued) throw new Error(d.error || 'Clear failed');
      setChatErr('Context cleared');
    } catch (e) {
      setChatErr(String(e.message || e));
    } finally {
      setChatCtxPending(false);
    }
  };
  const compactChatContext = async () => {
    if (!selectedAgentId || !chatSid || chatCtxPending) return;
    setChatCtxPending(true);
    setChatErr('');
    try {
      const r = await authedFetch(`/api/agents/${selectedAgentId}/chat-session/${chatSid}/compact`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok || !d.issued) throw new Error(d.error || 'Compact failed');
      setChatErr('Context compacted');
    } catch (e) {
      setChatErr(String(e.message || e));
    } finally {
      setChatCtxPending(false);
    }
  };
  const sendChatMsg = async () => {
    if (!chatInput.trim() || !selectedAgentId || sendPending) return;
    const text = chatInput.trim();
    setChatInput('');
    const ts = Date.now();
    // F2: stable message id threaded to the backend so a delivery-failed SSE event corrects THIS exact bubble
    // (by id), never by text.
    const msgId = nextChatMsgId();
    chatPaneBaselineRef.current = chatPaneContent;
    chatPendingUserRef.current = text;
    setChatThreadMessages(prev => {
      const next = [...prev, { id: msgId, role: 'user', text, ts, delivered: true }];
      chatThreadMessagesRef.current = next;
      return next;
    });
    setSendPending(true);
    setChatQueued(true);
    setChatErr('');
    try {
      let sid = await ensureChatSession();
      if (!sid) return;
      const msgFetchOpts = { method: 'POST', body: JSON.stringify({ text, msgId }), allowStatuses: [404, 409] };
      let r = await authedFetch(`/api/agents/${selectedAgentId}/chat-session/${sid}/message`, msgFetchOpts);
      if (r.status === 404) {
        delete agentChatCacheRef.current[selectedAgentId];
        setChatSid(null);
        detachChatStream();
        sid = await spawnChatSession(selectedAgentId);
        if (!sid) return;
        r = await authedFetch(`/api/agents/${selectedAgentId}/chat-session/${sid}/message`, msgFetchOpts);
      }
      if (r.status === 409) {
        const d = await r.json().catch(() => ({}));
        setChatErr(d.error || 'Could not send — the agent is busy or a message is already queued.');
        setChatInput(text);
        setChatThreadMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'user' && last.ts === ts) {
            const next = prev.slice(0, -1);
            chatThreadMessagesRef.current = next;
            return next;
          }
          return prev;
        });
        chatPendingUserRef.current = '';
        chatPaneBaselineRef.current = chatPaneContent;
      } else if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setChatErr(d.error || ('send failed (' + r.status + ')'));
      }
    } catch (e) { setChatErr(String(e.message || e)); }
    finally { setSendPending(false); setChatQueued(false); }
  };
  // E1: agent definition proposals
  const loadAgentProposals = async (agentId) => {
    if (!token || !agentId) return;
    try {
      const r = await authedFetch(`/api/proposals?agent_id=${agentId}&status=pending`);
      if (r.ok) { const d = await r.json(); setAgentProposals(d.proposals || []); }
    } catch {}
  };
  const approveProposal = async (propId) => {
    try {
      await authedFetch(`/api/proposals/${propId}/approve`, { method: 'POST' });
      if (selectedAgentId) loadAgentProposals(selectedAgentId);
    } catch {}
  };
  const rejectProposal = async (propId) => {
    try {
      await authedFetch(`/api/proposals/${propId}/reject`, { method: 'POST' });
      if (selectedAgentId) loadAgentProposals(selectedAgentId);
    } catch {}
  };
  const saveAgent = async () => {
    setAgentErr('');
    try {
      const dId = bindings.default_model_id ? Number(bindings.default_model_id) : null;
      const bId = bindings.backup_model_id ? Number(bindings.backup_model_id) : null;
      // B9/AC-14: classification required on create (default solo); always sent on POST+PUT
      const classification = (agentClassification === 'tiered' || agentClassification === 'team')
        ? agentClassification
        : 'solo';
      let payload = {
        name: agentName,
        default_model_id: dId,
        backup_model_id: bId,
        spawn_pref: bindings.spawn_pref,
        definition_md: agentDefMd || null,
        in_development: agentInDev,
        classification,
        default_effort: agentDefaultEffort || 'medium'
      };
      if (!selectedAgentId) {
        // derive legacy provider+model (still required by service) from chosen default (or first seeded)
        // team-class may omit L1 model in UI — fall back to first valid/seeded model for legacy fields
        const chosenId = dId || (modelsList[0] && modelsList[0].id);
        const chosen = modelsList.find(m => m.id === chosenId);
        if (!chosen) { setAgentErr('Choose a default model for new agent (provides legacy provider/model)'); return; }
        payload.provider = chosen.provider;
        payload.model = chosen.model_id;
      }
      if (selectedAgentId) {
        await authedFetch(`/api/agents/${selectedAgentId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await authedFetch('/api/agents', { method: 'POST', body: JSON.stringify(payload) });
      }
      await loadAgents();
      const fresh = (await (await authedFetch('/api/agents')).json()).agents || [];
      const match = fresh.find(x => x.name === agentName);
      if (match) selectAgent(match);
    } catch (e) {
      setAgentErr('Save failed (see banner for details)');
    }
  };
  const deleteAgent = async () => {
    if (!selectedAgentId) return;
    setAgentErr('');
    try {
      await authedFetch(`/api/agents/${selectedAgentId}`, { method: 'DELETE' });
      setSelectedAgentId(null);
      await loadAgents();
    } catch (e) {
      setAgentErr('Delete failed (see banner)');
    }
  };
  const attachToolkit = async (toolkitId) => {
    if (!selectedAgentId) return;
    try {
      await authedFetch(`/api/agents/${selectedAgentId}/toolkits`, { method: 'POST', body: JSON.stringify({ toolkit_id: toolkitId }) });
      await loadAttached(selectedAgentId);
    } catch (e) { setAgentErr('Attach failed'); }
  };
  const detachToolkit = async (toolkitId) => {
    if (!selectedAgentId) return;
    try {
      await authedFetch(`/api/agents/${selectedAgentId}/toolkits/${toolkitId}`, { method: 'DELETE' });
      await loadAttached(selectedAgentId);
    } catch (e) { setAgentErr('Detach failed'); }
  };

  // B6d team editor helpers
  const startNewTeam = () => {
    setSelectedAgentId(null);
    setSelectedTeamId(null);
    setTeamForm({ name: '', type: 'deliberation', consensus_rule: '', protocol_note: '' });
    setTeamMembers([]);
    setTeamErr('');
  };
  const selectTeam = (t) => {
    setSelectedAgentId(null);
    setSelectedTeamId(t.id);
    loadTeam(t.id);
  };
  const onNavTeam = (t) => {
    onNav('studio');
    selectTeam(t);
    setDrawerOpen(false);
  };
  const saveTeam = async () => {
    setTeamErr('');
    try {
      if (selectedTeamId) {
        await authedFetch(`/api/teams/${selectedTeamId}`, { method: 'PUT', body: JSON.stringify(teamForm) });
      } else {
        const r = await authedFetch('/api/teams', { method: 'POST', body: JSON.stringify(teamForm) });
        const d = await r.json();
        if (d.team) setSelectedTeamId(d.team.id);
      }
      await loadTeams();
      if (selectedTeamId) loadTeam(selectedTeamId);
    } catch (e) { setTeamErr(e.message || 'save failed'); }
  };
  const deleteTeam = async () => {
    if (!selectedTeamId) return;
    setTeamErr('');
    try {
      await authedFetch(`/api/teams/${selectedTeamId}`, { method: 'DELETE' });
      setSelectedTeamId(null);
      await loadTeams();
      startNewTeam();
    } catch (e) { setTeamErr('Delete failed (bound?)'); }
  };
  const addTeamMember = async () => {
    if (!selectedTeamId) return;
    if (teamAddType === 'model' && !teamAddModel) return;
    if (teamAddType === 'agent' && !teamAddAgent) return;
    try {
      const payload = { member_type: teamAddType, lens: teamAddLens || null };
      if (teamAddType === 'model') payload.model_id = Number(teamAddModel);
      else payload.agent_id = Number(teamAddAgent);
      await authedFetch(`/api/teams/${selectedTeamId}/members`, { method: 'POST', body: JSON.stringify(payload) });
      setTeamAddModel('');
      setTeamAddAgent('');
      setTeamAddLens('');
      await loadTeam(selectedTeamId);
    } catch (e) { setTeamErr('add member failed'); }
  };
  const removeTeamMember = async (mid) => {
    if (!selectedTeamId) return;
    try {
      await authedFetch(`/api/teams/${selectedTeamId}/members/${mid}`, { method: 'DELETE' });
      await loadTeam(selectedTeamId);
    } catch (e) { setTeamErr('remove failed'); }
  };

  // B3b helpers (reuse authedFetch body-aware; load on tab; live via EventSource to project activity (plumbing- events now forwarded); save JROM override)
  const loadPlumbing = async () => {
    setPlumbingErr('');
    try {
      const r = await authedFetch('/api/plumbing/configs');
      const d = await r.json();
      setPlumbingConfigs(d.configs || []);
      setWatchStates(d.watchStates || []);
      if ((d.configs || []).length > 0 && !plumbingPid) {
        const first = d.configs[0].project_id;
        setPlumbingPid(first);
        const eff = (d.configs[0].effective || {});
        setPlumbingForm(f => ({ ...f, brain_agent_id: eff.brain_agent_id ? String(eff.brain_agent_id) : '', backup_brain_agent_id: eff.backup_brain_agent_id ? String(eff.backup_brain_agent_id) : '', refresh_every_tasks: eff.refresh_every_tasks || 10, context_watermark_pct: eff.context_watermark_pct || 80 }));
        setupPlumbingLive(first);
      }
    } catch (e) { setPlumbingErr('Failed to load plumbing config (see banner)'); }
  };
  const setupPlumbingLive = (pid) => {
    if (plumbingEs) { try { plumbingEs.close(); } catch {} }
    // EventSource uses ?access_token (sseAuthPre supports it; no custom headers)
    const es = new EventSource(`/api/projects/${pid}/activity?access_token=${encodeURIComponent(token)}`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data || '{}');
        const bid = (data && (data.batch_id || (data.body && data.body.batch_id))) || '';
        if (String(bid).startsWith('plumbing-')) {
          loadPlumbing(); // refresh real state (table + effective)
        }
      } catch {}
    };
    es.onerror = () => { /* silent; load on explicit refresh or save */ };
    setPlumbingEs(es);
  };
  const savePlumbingConfig = async () => {
    if (!plumbingPid) return;
    setPlumbingErr('');
    try {
      const override = {
        brain_agent_id: plumbingForm.brain_agent_id ? Number(plumbingForm.brain_agent_id) : null,
        backup_brain_agent_id: plumbingForm.backup_brain_agent_id ? Number(plumbingForm.backup_brain_agent_id) : null,
        refresh_every_tasks: Number(plumbingForm.refresh_every_tasks || 10),
        context_watermark_pct: Number(plumbingForm.context_watermark_pct || 80),
        escalation_policy: plumbingForm.escalation
      };
      await authedFetch(`/api/plumbing/configs/${plumbingPid}`, { method: 'PUT', body: JSON.stringify(override) });
      await loadPlumbing();
    } catch (e) {
      setPlumbingErr('Save failed (see banner for details)');
    }
  };

  // C1 loads (reuse authedFetch body-aware)
  const loadProjects = async () => {
    setProjectsLoading(true);
    try {
      const r = await authedFetch('/api/projects');
      const d = await r.json();
      setProjectsList(d.projects || []);
    } catch {} finally {
      setProjectsLoading(false);
    }
  };
  const loadProjectStatus = async (pid) => {
    if (!pid) return;
    try {
      const r = await authedFetch(`/api/projects/${pid}/status`, { allowStatuses: [400, 404] });
      if (!r.ok) return;
      const d = await r.json();
      setProjectStatusById(prev => ({ ...prev, [pid]: d.status || null }));
    } catch {}
  };
  const loadProjectTechStack = async (pid) => {
    if (!pid) return;
    try {
      const r = await authedFetch(`/api/projects/${pid}/tech-stack-summary`);
      if (!r.ok) return;
      const d = await r.json();
      setProjectTechStackById(prev => ({ ...prev, [pid]: d.summary || null }));
    } catch {}
  };
  const loadProjectConfig = async (pid) => {
    if (!pid) return;
    try {
      const r = await authedFetch(`/api/projects/${pid}/config`);
      if (!r.ok) return;
      const d = await r.json();
      setProjectAutonomyDefault(d.autonomy_default === 'autonomous_after_discovery' ? 'autonomous_after_discovery' : 'pause_after_planning');
    } catch {}
  };
  const saveProjectAutonomyDefault = async (pid, value) => {
    if (!pid) return;
    setProjectAutonomySaving(true);
    setProjectOpErr('');
    try {
      const cfgRes = await authedFetch(`/api/projects/${pid}/config`);
      const cfg = cfgRes.ok ? await cfgRes.json() : {};
      const r = await authedFetch(`/api/projects/${pid}/config`, {
        method: 'PUT',
        body: JSON.stringify({
          master_chain: cfg.master_chain || [],
          bindings: cfg.bindings || [],
          team_bindings: cfg.team_bindings || [],
          autonomy_default: value
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setProjectOpErr(d.error || `Autonomy save failed (${r.status})`);
        return;
      }
      setProjectAutonomyDefault(d.autonomy_default === 'autonomous_after_discovery' ? 'autonomous_after_discovery' : 'pause_after_planning');
      await loadProjectConfig(pid);
    } catch {
      setProjectOpErr('Autonomy save failed (network)');
    } finally {
      setProjectAutonomySaving(false);
    }
  };
  const createProject = async () => {
    const name = newProjName.trim(); const dir = newProjDir.trim();
    if (!name || !dir) return;
    setProjectOpErr('');
    try {
      const r = await authedFetch('/api/projects', { method: 'POST', body: JSON.stringify({ name, directory: dir }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setProjectOpErr(d.error || `Create failed (${r.status})`);
        return;
      }
      await loadProjects();
      setActiveProjectId(d.project.id);
      setProjectPage(0);
      setProjectSubTab('detail');
      setShowAddForm(false); setNewProjName(''); setNewProjDir('');
    } catch { setProjectOpErr('Create failed (network)'); }
  };
  const updateProject = async () => {
    if (!editingProject || !activeProjectId) return;
    const name = editingProject.name.trim(); const dir = editingProject.dir.trim();
    if (!name || !dir) return;
    setProjectOpErr('');
    try {
      const r = await authedFetch(`/api/projects/${activeProjectId}`, { method: 'PUT', body: JSON.stringify({
        name,
        directory: dir,
        description: editingProject.description,
        dev_url: normalizeOptionalText(editingProject.dev_url),
        qa_url: normalizeOptionalText(editingProject.qa_url),
        tags: normalizeTagList(editingProject.tags)
      }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setProjectOpErr(d.error || `Update failed (${r.status})`);
        return;
      }
      await loadProjects();
      setEditingProject(null);
      await loadProjectStatus(activeProjectId);
      await loadProjectTechStack(activeProjectId);
    } catch { setProjectOpErr('Update failed (network)'); }
  };
  const deleteProjectById = async (id) => {
    if (!window.confirm('Delete this project? This cannot be undone.')) return;
    setProjectOpErr('');
    try {
      const r = await authedFetch(`/api/projects/${id}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setProjectOpErr(d.error || `Delete failed (${r.status})`);
        return;
      }
      await loadProjects();
      if (activeProjectId === id) { setActiveProjectId(null); setProjectSubTab('detail'); setEditingProject(null); setDocSubTab('docs'); setViewedDoc(null); setHelmDocsTree([]); setDocsTree([]); }
      setProjectStatusById(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setProjectTechStackById(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch { setProjectOpErr('Delete failed (network)'); }
  };
  // C2 loads + actions (body-aware authedFetch: no Content-Type on bodyless POSTs like set-default/add-all)
  const loadPlannerPanel = async (pid) => {
    if (!pid) return;
    try {
      const r = await authedFetch(`/api/projects/${pid}/planner-panel`);
      if (!r.ok) return;
      const d = await r.json();
      const members = Array.isArray(d.members) ? d.members.map((m, i) => ({
        model_id: m.model_id != null ? Number(m.model_id) : '',
        is_lead: !!m.is_lead,
        effort: m.effort || '',
        slot_index: m.slot_index != null ? Number(m.slot_index) : i,
      })) : [];
      // Default panel size 2 when empty (UI starts with 2 empty slots)
      const seeded = members.length > 0 ? members : [
        { model_id: '', is_lead: true, effort: '', slot_index: 0 },
        { model_id: '', is_lead: false, effort: '', slot_index: 1 },
      ];
      setPlannerPanel({
        members: seeded,
        backups: Array.isArray(d.backups) ? d.backups.map((b, i) => ({
          model_id: b.model_id != null ? Number(b.model_id) : '',
          slot_index: b.slot_index != null ? Number(b.slot_index) : i,
        })) : [],
        default_effort: d.default_effort || 'med',
      });
      setPlannerPanelDirty(false);
      setPlannerPanelErr('');
    } catch {
      /* best-effort */
    }
  };
  const flashPlannerPanelSaved = () => {
    setPlannerPanelFlash(true);
    if (plannerPanelFlashTimerRef.current) clearTimeout(plannerPanelFlashTimerRef.current);
    plannerPanelFlashTimerRef.current = setTimeout(() => {
      setPlannerPanelFlash(false);
      plannerPanelFlashTimerRef.current = null;
    }, 2000);
  };
  const setPlannerPanelMemberCount = (n) => {
    const count = Math.max(1, Math.min(8, Number(n) || 1));
    setPlannerPanel((prev) => {
      let members = [...(prev.members || [])];
      if (members.length < count) {
        while (members.length < count) {
          members.push({ model_id: '', is_lead: false, effort: '', slot_index: members.length });
        }
      } else if (members.length > count) {
        members = members.slice(0, count);
      }
      // Ensure exactly one lead after resize
      if (!members.some((m) => m.is_lead) && members.length) members[0] = { ...members[0], is_lead: true };
      if (members.filter((m) => m.is_lead).length > 1) {
        let seen = false;
        members = members.map((m) => {
          if (m.is_lead && !seen) { seen = true; return m; }
          return { ...m, is_lead: false };
        });
      }
      return { ...prev, members };
    });
    setPlannerPanelDirty(true);
  };
  const updatePlannerPanelMember = (idx, patch) => {
    setPlannerPanel((prev) => {
      let members = (prev.members || []).map((m, i) => (i === idx ? { ...m, ...patch } : m));
      if (patch.is_lead) {
        members = members.map((m, i) => ({ ...m, is_lead: i === idx }));
      }
      return { ...prev, members };
    });
    setPlannerPanelDirty(true);
  };
  const addPlannerPanelBackup = () => {
    setPlannerPanel((prev) => ({
      ...prev,
      backups: [...(prev.backups || []), { model_id: '', slot_index: (prev.backups || []).length }],
    }));
    setPlannerPanelDirty(true);
  };
  const updatePlannerPanelBackup = (idx, modelId) => {
    setPlannerPanel((prev) => ({
      ...prev,
      backups: (prev.backups || []).map((b, i) => (i === idx ? { ...b, model_id: modelId } : b)),
    }));
    setPlannerPanelDirty(true);
  };
  const removePlannerPanelBackup = (idx) => {
    setPlannerPanel((prev) => ({
      ...prev,
      backups: (prev.backups || []).filter((_, i) => i !== idx).map((b, i) => ({ ...b, slot_index: i })),
    }));
    setPlannerPanelDirty(true);
  };
  const savePlannerPanel = async (pid) => {
    if (!pid) return;
    setPlannerPanelSaving(true);
    setPlannerPanelErr('');
    try {
      const members = (plannerPanel.members || [])
        .filter((m) => m.model_id !== '' && m.model_id != null)
        .map((m) => ({
          model_id: Number(m.model_id),
          is_lead: !!m.is_lead,
          effort: m.effort || null,
        }));
      if (!members.length) {
        setPlannerPanelErr('Add at least one member with a model');
        return;
      }
      if (members.filter((m) => m.is_lead).length !== 1) {
        setPlannerPanelErr('Exactly one member must be the lead');
        return;
      }
      const backups = (plannerPanel.backups || [])
        .filter((b) => b.model_id !== '' && b.model_id != null)
        .map((b) => ({ model_id: Number(b.model_id) }));
      const r = await authedFetch(`/api/projects/${pid}/planner-panel`, {
        method: 'PUT',
        body: JSON.stringify({
          members,
          backups,
          default_effort: plannerPanel.default_effort || 'med',
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPlannerPanelErr(d.error || `Save failed (${r.status})`);
        return;
      }
      await loadPlannerPanel(pid);
      flashPlannerPanelSaved();
    } catch {
      setPlannerPanelErr('Save failed (network)');
    } finally {
      setPlannerPanelSaving(false);
    }
  };

  const loadProjectAgents = async (pid) => {
    if (!pid) return;
    try {
      const r = await authedFetch(`/api/projects/${pid}/agents`);
      const d = await r.json();
      setProjectAgents(d.projectAgents || []);
      // load team bindings too for B3
      const rb = await authedFetch(`/api/projects/${pid}/bindings`);
      const rd = await rb.json();
      setProjectTeamBindings(rd.team_bindings || []);
    } catch {}
  };
  // (CC-CHAT-1: loadCcBindings removed — the CC picker now lists PROJECT-ASSIGNED agents via
  // loadCcAgents (/api/projects/:id/agents, project_agents join agents) with the coordinator pinned.)
  const addProjectAgent = async (pid, aid) => {
    setPaErr('');
    try {
      await authedFetch(`/api/projects/${pid}/agents`, { method: 'POST', body: JSON.stringify({ agent_id: aid }) });
      await loadProjectAgents(pid);
    } catch (e) { setPaErr('Add agent failed (see banner for details)'); }
  };
  const removeProjectAgent = async (pid, aid) => {
    setPaErr('');
    try {
      await authedFetch(`/api/projects/${pid}/agents/${aid}`, { method: 'DELETE' });
      await loadProjectAgents(pid);
    } catch (e) { setPaErr('Remove failed (see banner)'); }
  };
  const loadPaOverrideDetail = async (pid, aid) => {
    setPaOverrideLoading(true);
    setPaErr('');
    try {
      const r = await authedFetch(`/api/projects/${pid}/agents/${aid}`);
      const d = await r.json();
      setPaOverrideDetail(d.effective || null);
    } catch (e) {
      setPaOverrideDetail(null);
      setPaErr('Failed to load override detail');
    } finally {
      setPaOverrideLoading(false);
    }
  };
  const closePaDrawer = () => {
    setExpandedPaAgentId(null);
    setPaOverrideDetail(null);
    setPaDrawerExpandedToolkitId(null);
    setPaPersonaEditingAid(null);
    setPaPersonaDraft('');
    setPaPersonaErr('');
    setPaSaveFlash(false);
    if (paSaveFlashTimerRef.current) {
      clearTimeout(paSaveFlashTimerRef.current);
      paSaveFlashTimerRef.current = null;
    }
  };
  useEffect(() => {
    if (expandedPaAgentId == null) return;
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      closePaDrawer();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [expandedPaAgentId]);
  const flashPaSaved = () => {
    setPaSaveFlash(true);
    if (paSaveFlashTimerRef.current) clearTimeout(paSaveFlashTimerRef.current);
    paSaveFlashTimerRef.current = setTimeout(() => {
      setPaSaveFlash(false);
      paSaveFlashTimerRef.current = null;
    }, 2000);
  };
  const togglePaDrawer = async (pid, aid) => {
    if (expandedPaAgentId === aid) {
      closePaDrawer();
      return;
    }
    setExpandedPaAgentId(aid);
    setPaDrawerExpandedToolkitId(null);
    setPaPersonaEditingAid(null);
    setPaPersonaDraft('');
    setPaPersonaErr('');
    if (!allToolkits.length) await loadAllToolkits();
    await loadPaOverrideDetail(pid, aid);
  };
  const paToolkitsPayload = (toolkits) => (toolkits || []).map((t, i) => ({
    toolkit_id: Number(t.id),
    position: i
  }));
  const paEscalationsPayload = (escalations) => (escalations || [])
    .filter((e) => e.model_id != null)
    .map((e) => ({
      position: Number(e.position),
      model_id: Number(e.model_id),
      trigger: e.trigger || 'on-fail',
      // B5/AC-10: per-rung effort; null/empty = inherit L1/agent default
      effort: e.effort == null || e.effort === '' ? null : e.effort
    }));
  const savePaToolkits = async (pid, aid, toolkits, overridden = true) => {
    await applyPaOverrides(pid, aid, {
      toolkits: { overridden, toolkits: overridden ? paToolkitsPayload(toolkits) : [] }
    });
  };
  const resetPaToolkits = async (pid, aid) => {
    await applyPaOverrides(pid, aid, { toolkits: { overridden: false } });
  };
  const savePaEscalations = async (pid, aid, escalations, overridden = true) => {
    await applyPaOverrides(pid, aid, {
      escalations: { overridden, escalations: overridden ? paEscalationsPayload(escalations) : [] }
    });
  };
  const resetPaEscalations = async (pid, aid) => {
    await applyPaOverrides(pid, aid, { escalations: { overridden: false } });
  };
  const savePaPersona = async (pid, aid, text) => {
    const trimmed = (text || '').trim();
    if (trimmed.length > PA_DEFINITION_MAX) {
      setPaPersonaErr(`Persona too long (${trimmed.length.toLocaleString()} > ${PA_DEFINITION_MAX.toLocaleString()} chars)`);
      return false;
    }
    setPaPersonaErr('');
    await applyPaOverrides(pid, aid, { definition_md_override: trimmed ? trimmed : null });
    setPaPersonaEditingAid(null);
    setPaPersonaDraft('');
    return true;
  };
  const resetPaPersona = async (pid, aid) => {
    setPaPersonaErr('');
    setPaPersonaEditingAid(null);
    setPaPersonaDraft('');
    await applyPaOverrides(pid, aid, { definition_md_override: null });
  };
  const applyPaOverrides = async (pid, aid, body) => {
    setPaErr('');
    try {
      await authedFetch(`/api/projects/${pid}/agents/${aid}`, { method: 'PUT', body: JSON.stringify(body) });
      await loadProjectAgents(pid);
      if (expandedPaAgentId === aid) await loadPaOverrideDetail(pid, aid);
      flashPaSaved();
    } catch (e) {
      setPaErr('Override save failed (see banner)');
    }
  };
  const setAgentModel = async (pid, aid, val) => {
    let body = {};
    if (val === 'dynamic') body = { use_dynamic: 1 };
    else if (val === 'default') body = { model_id: null, use_dynamic: 0 };
    else if (val) body = { model_id: Number(val), use_dynamic: 0 };
    await applyPaOverrides(pid, aid, body);
  };
  const setAgentPrimary = async (pid, aid) => {
    setPaErr('');
    try {
      await authedFetch(`/api/projects/${pid}/agents/${aid}`, { method: 'PUT', body: JSON.stringify({ is_primary_driver: 1 }) });
      await loadProjectAgents(pid);
    } catch (e) { setPaErr('Set primary failed (see banner)'); }
  };
  const setAllToDefault = async (pid) => {
    setPaErr('');
    try {
      await authedFetch(`/api/projects/${pid}/agents/set-default`, { method: 'POST' });
      await loadProjectAgents(pid);
    } catch (e) { setPaErr('Set to default failed (see banner)'); }
  };
  const addAllAgentsToProject = async (pid) => {
    setPaErr('');
    try {
      await authedFetch(`/api/projects/${pid}/agents/add-all`, { method: 'POST' });
      await loadProjectAgents(pid);
    } catch (e) { setPaErr('Add all failed (see banner)'); }
  };
  const bindProjectTeam = async (pid, role, tid) => {
    setPaErr('');
    try {
      await authedFetch(`/api/projects/${pid}/bindings`, { method: 'POST', body: JSON.stringify({ role, team_id: tid }) });
      await loadProjectAgents(pid);
      await loadRoleRoster(pid, role);
    } catch (e) { setPaErr('Bind team failed'); }
  };
  // B8b / AC-12b: unbind Studio team for role (by-role DELETE; fixes undefined unbindProjectTeam)
  const unbindProjectTeam = async (pid, role) => {
    if (!pid || !role) return;
    setPaErr('');
    try {
      const r = await authedFetch(`/api/projects/${pid}/team-bindings/${encodeURIComponent(role)}`, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setPaErr(d.error || `Unbind failed (${r.status})`);
        return;
      }
      if (Array.isArray(d.team_bindings)) setProjectTeamBindings(d.team_bindings);
      else await loadProjectAgents(pid);
      await loadRoleRoster(pid, role);
    } catch (e) {
      setPaErr('Unbind team failed');
    }
  };
  // B8b / AC-12: GET effective roster (source studio|project + members)
  const loadRoleRoster = async (pid, role) => {
    if (!pid || !role) return;
    try {
      const r = await authedFetch(`/api/projects/${pid}/roles/${encodeURIComponent(role)}/roster`);
      if (!r.ok) return;
      const d = await r.json();
      const members = Array.isArray(d.members)
        ? d.members.map((m) => ({
            model_id: m.model_id != null ? Number(m.model_id) : '',
            lens: m.lens != null ? String(m.lens) : '',
          }))
        : [];
      setRoleRosters((prev) => ({
        ...prev,
        [role]: {
          ...emptyRoleRosterState(),
          members,
          source: d.source === 'project' ? 'project' : 'studio',
          team_id: d.team_id != null ? Number(d.team_id) : null,
        },
      }));
    } catch {
      /* best-effort */
    }
  };
  const loadAllRoleRosters = async (pid) => {
    if (!pid) return;
    await Promise.all(ROLE_ROSTER_ROLES.map((role) => loadRoleRoster(pid, role)));
  };
  const flashRoleRosterSaved = (role) => {
    setRoleRosters((prev) => ({
      ...prev,
      [role]: { ...(prev[role] || emptyRoleRosterState()), flash: true },
    }));
    if (roleRosterFlashTimersRef.current[role]) clearTimeout(roleRosterFlashTimersRef.current[role]);
    roleRosterFlashTimersRef.current[role] = setTimeout(() => {
      setRoleRosters((prev) => ({
        ...prev,
        [role]: { ...(prev[role] || emptyRoleRosterState()), flash: false },
      }));
      roleRosterFlashTimersRef.current[role] = null;
    }, 2000);
  };
  const updateRoleRosterMember = (role, idx, patch) => {
    setRoleRosters((prev) => {
      const cur = prev[role] || emptyRoleRosterState();
      const members = (cur.members || []).map((m, i) => (i === idx ? { ...m, ...patch } : m));
      return { ...prev, [role]: { ...cur, members, dirty: true } };
    });
  };
  const addRoleRosterMember = (role) => {
    setRoleRosters((prev) => {
      const cur = prev[role] || emptyRoleRosterState();
      return {
        ...prev,
        [role]: {
          ...cur,
          members: [...(cur.members || []), { model_id: '', lens: '' }],
          dirty: true,
        },
      };
    });
  };
  const removeRoleRosterMember = (role, idx) => {
    setRoleRosters((prev) => {
      const cur = prev[role] || emptyRoleRosterState();
      return {
        ...prev,
        [role]: {
          ...cur,
          members: (cur.members || []).filter((_, i) => i !== idx),
          dirty: true,
        },
      };
    });
  };
  // PUT full-replace project roster override
  const saveRoleRoster = async (pid, role) => {
    if (!pid || !role) return;
    const cur = roleRosters[role] || emptyRoleRosterState();
    setRoleRosters((prev) => ({
      ...prev,
      [role]: { ...(prev[role] || emptyRoleRosterState()), saving: true, err: '' },
    }));
    try {
      const members = (cur.members || [])
        .filter((m) => m.model_id !== '' && m.model_id != null)
        .map((m) => ({
          model_id: Number(m.model_id),
          lens: (m.lens != null && String(m.lens).trim()) ? String(m.lens).trim() : null,
        }));
      if (!members.length) {
        setRoleRosters((prev) => ({
          ...prev,
          [role]: {
            ...(prev[role] || emptyRoleRosterState()),
            saving: false,
            err: 'Add at least one member with a model',
          },
        }));
        return;
      }
      const r = await authedFetch(`/api/projects/${pid}/roles/${encodeURIComponent(role)}/roster`, {
        method: 'PUT',
        body: JSON.stringify({ members }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setRoleRosters((prev) => ({
          ...prev,
          [role]: {
            ...(prev[role] || emptyRoleRosterState()),
            saving: false,
            err: d.error || `Save failed (${r.status})`,
          },
        }));
        return;
      }
      await loadRoleRoster(pid, role);
      flashRoleRosterSaved(role);
    } catch {
      setRoleRosters((prev) => ({
        ...prev,
        [role]: {
          ...(prev[role] || emptyRoleRosterState()),
          saving: false,
          err: 'Save failed (network)',
        },
      }));
    } finally {
      setRoleRosters((prev) => ({
        ...prev,
        [role]: { ...(prev[role] || emptyRoleRosterState()), saving: false },
      }));
    }
  };
  // DELETE roster override → revert to Studio team members
  const resetRoleRoster = async (pid, role) => {
    if (!pid || !role) return;
    setRoleRosters((prev) => ({
      ...prev,
      [role]: { ...(prev[role] || emptyRoleRosterState()), saving: true, err: '' },
    }));
    try {
      const r = await authedFetch(`/api/projects/${pid}/roles/${encodeURIComponent(role)}/roster`, {
        method: 'DELETE',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setRoleRosters((prev) => ({
          ...prev,
          [role]: {
            ...(prev[role] || emptyRoleRosterState()),
            saving: false,
            err: d.error || `Reset failed (${r.status})`,
          },
        }));
        return;
      }
      await loadRoleRoster(pid, role);
      flashRoleRosterSaved(role);
    } catch {
      setRoleRosters((prev) => ({
        ...prev,
        [role]: {
          ...(prev[role] || emptyRoleRosterState()),
          saving: false,
          err: 'Reset failed (network)',
        },
      }));
    } finally {
      setRoleRosters((prev) => ({
        ...prev,
        [role]: { ...(prev[role] || emptyRoleRosterState()), saving: false },
      }));
    }
  };

  // E-b1: Documents now always uses server-scoped helm_tasks tree (per project dropdown filter).
  // Replaces prior full-dir recursive (which could include node_modules etc). relPaths under helm_tasks/<tasklist>/<task>/
  const normalizeHelmDocRel = (rel) => String(rel || '').replace(/^helm_docs[\\/]+/i, '');
  const slugifyDocPath = (rel) => String(rel || '').replace(/[\\/]/g, '-').replace(/[^a-zA-Z0-9._-]/g, '_');
  const activateOnEnterSpace = (e, action) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action(e);
    }
  };
  const groupHelmDocsByFolder = (docs) => {
    const groups = new Map();
    for (const doc of docs || []) {
      const apiRel = doc.relPath || doc.filename || '';
      const rel = normalizeHelmDocRel(apiRel);
      const slash = rel.lastIndexOf('/');
      const folder = slash >= 0 ? rel.slice(0, slash) : '';
      const key = folder || '(root)';
      if (!groups.has(key)) {
        groups.set(key, { folder: key, folderSlug: folder ? slugifyDocPath(folder) : 'root', files: [] });
      }
      groups.get(key).files.push({ ...doc, relPath: apiRel, displayRel: rel });
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.folder === '(root)') return -1;
      if (b.folder === '(root)') return 1;
      return a.folder.localeCompare(b.folder);
    });
  };
  // B15: helm_tasks path ↔ TaskRow.task_key slug (must match getTaskArtifactRoot safe() in run-artifact-service.ts)
  const normalizeHelmTaskRel = (rel) => String(rel || '').replace(/^helm_tasks[\\/]+/i, '');
  const slugTaskKey = (key) => {
    if (key == null || !String(key).trim()) return null;
    return String(key).replace(/[^a-z0-9_-]/gi, '_') || null;
  };
  const taskStatusChipClass = (status) => {
    if (status === 'completed') return 'chip-green';
    if (status === 'working') return 'chip-orange';
    return 'chip-gray';
  };
  const matchTaskRowForSlug = (taskSlug, taskRows, usedIds) => {
    if (!taskSlug) return null;
    for (const row of taskRows || []) {
      if (usedIds.has(row.id)) continue;
      const slug = slugTaskKey(row.task_key);
      if (slug && slug === taskSlug) {
        usedIds.add(row.id);
        return row;
      }
    }
    return null;
  };
  const groupHelmTasksByTasklist = (docs, taskRows) => {
    const usedIds = new Set();
    const lists = new Map();
    for (const doc of docs || []) {
      const apiRel = doc.relPath || doc.filename || '';
      const rel = normalizeHelmTaskRel(apiRel);
      const parts = rel.split('/').filter(Boolean);
      if (parts.length < 2) continue;
      const tasklist = parts[0];
      const taskSlug = parts[1];
      const unitKey = `${tasklist}/${taskSlug}`;
      if (!lists.has(tasklist)) {
        lists.set(tasklist, { tasklist, tasklistSlug: slugifyDocPath(tasklist), units: new Map() });
      }
      const listGrp = lists.get(tasklist);
      if (!listGrp.units.has(unitKey)) {
        listGrp.units.set(unitKey, {
          tasklist,
          taskSlug,
          taskSlugSlug: slugifyDocPath(taskSlug),
          taskRow: matchTaskRowForSlug(taskSlug, taskRows, usedIds),
          files: [],
        });
      }
      listGrp.units.get(unitKey).files.push({ ...doc, relPath: apiRel, displayRel: rel });
    }
    const groups = Array.from(lists.values()).map((g) => {
      const units = Array.from(g.units.values()).sort((a, b) => a.taskSlug.localeCompare(b.taskSlug));
      for (const u of units) u.files.sort((a, b) => (a.displayRel || '').localeCompare(b.displayRel || ''));
      const rollup = { completed: 0, working: 0, pending: 0 };
      for (const u of units) {
        const st = u.taskRow?.status;
        if (st && rollup[st] != null) rollup[st] += 1;
      }
      return { ...g, units, rollup };
    }).sort((a, b) => a.tasklist.localeCompare(b.tasklist));
    const unmapped = (taskRows || []).filter((t) => !usedIds.has(t.id)).length;
    return { groups, unmapped };
  };
  const loadProjectDocs = async (pid) => {
    if (!pid) {
      setProjectDocsList([]); setDocsTree([]); setHelmDocsTree([]); setViewedDoc(null);
      setProjectTaskRows((p) => { const n = { ...p }; delete n[pid]; return n; });
      setDocEditing(false); setDocEditDraft(''); setDocEditErr(''); setDocDeleteErr('');
      return;
    }
    setPrefsErr('');
    try {
      const [rHelm, rTasks, rStatus] = await Promise.all([
        authedFetch(`/api/projects/${pid}/docs?tree=1&base=helm_docs`),
        authedFetch(`/api/projects/${pid}/docs?tree=1&scope=helm_tasks`),
        authedFetch(`/api/projects/${pid}/tasks`),
      ]);
      const dHelm = await rHelm.json();
      const dTasks = await rTasks.json();
      const dStatus = await rStatus.json();
      const tHelm = dHelm.docs || dHelm.tree || [];
      const tTasks = dTasks.docs || dTasks.tree || [];
      setHelmDocsTree(tHelm);
      setDocsTree(tTasks);
      setProjectDocsList(tTasks); // compat
      setProjectTaskRows((p) => ({ ...p, [pid]: dStatus.tasks || [] }));
      setViewedDoc(null);
      setDocEditing(false); setDocEditDraft(''); setDocEditErr(''); setDocDeleteErr('');
    } catch (e) { setPrefsErr('Failed to load docs tree (see banner)'); }
  };
  const docApiBasename = (rel) => {
    const r = String(rel || '');
    return r.includes('/') ? r.slice(r.lastIndexOf('/') + 1) : r;
  };
  const viewProjectDoc = async (pid, relOrName) => {
    setPrefsErr('');
    setDocEditErr('');
    setDocDeleteErr('');
    setDocEditing(false);
    setDocEditDraft('');
    try {
      const enc = encodeURIComponent(docApiBasename(relOrName));
      const r = await authedFetch(`/api/projects/${pid}/docs/${enc}?path=${encodeURIComponent(relOrName)}`);
      const d = await r.json();
      if (!r.ok) {
        setPrefsErr(d.error || `Failed to load doc (${r.status})`);
        return;
      }
      const doc = d.doc || null;
      if (doc) doc.relPath = relOrName;
      setViewedDoc(doc);
    } catch (e) { setPrefsErr('Failed to load doc (see banner)'); }
  };
  const saveDocEdit = async () => {
    if (!activeProjectId || !viewedDoc?.relPath) return;
    setDocEditErr('');
    try {
      const rel = viewedDoc.relPath;
      const enc = encodeURIComponent(docApiBasename(rel));
      const r = await authedFetch(`/api/projects/${activeProjectId}/docs/${enc}?path=${encodeURIComponent(rel)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: docEditDraft }),
        allowStatuses: [400, 403, 404]
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setDocEditErr(d.error || `Save failed (${r.status})`);
        return;
      }
      setDocEditing(false);
      setDocEditDraft('');
      await loadProjectDocs(activeProjectId);
      await viewProjectDoc(activeProjectId, rel);
    } catch (e) { setDocEditErr('Save failed (network)'); }
  };
  const deleteViewedDoc = async () => {
    if (!activeProjectId || !viewedDoc?.relPath) return;
    if (!window.confirm(`Delete ${viewedDoc.relPath}?`)) return;
    setDocDeleteErr('');
    try {
      const rel = viewedDoc.relPath;
      const enc = encodeURIComponent(docApiBasename(rel));
      const r = await authedFetch(`/api/projects/${activeProjectId}/docs/${enc}?path=${encodeURIComponent(rel)}`, {
        method: 'DELETE',
        allowStatuses: [400, 403, 404]
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setDocDeleteErr(d.error || `Delete failed (${r.status})`);
        return;
      }
      setViewedDoc(null);
      setDocEditing(false);
      setDocEditDraft('');
      await loadProjectDocs(activeProjectId);
    } catch (e) { setDocDeleteErr('Delete failed (network)'); }
  };
  const createNewDoc = async () => {
    if (!activeProjectId) return;
    setDocsNewErr('');
    let name = (docsNewName || '').trim();
    if (!name) { setDocsNewErr('Filename required'); return; }
    if (!name.endsWith('.md')) name += '.md';
    let folder = (docsNewFolder || '').trim().replace(/^\/+|\/+$/g, '').replace(/^helm_docs\/?/i, '');
    const rel = folder ? `${folder}/${name}` : name;
    try {
      const enc = encodeURIComponent(docApiBasename(rel));
      const r = await authedFetch(`/api/projects/${activeProjectId}/docs/${enc}?path=${encodeURIComponent(rel)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: docsNewContent || '' }),
        allowStatuses: [400, 403, 404]
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setDocsNewErr(d.error || `Create failed (${r.status})`);
        return;
      }
      setDocsNewOpen(false);
      setDocsNewFolder('');
      setDocsNewName('');
      setDocsNewContent('');
      await loadProjectDocs(activeProjectId);
      const viewRel = rel.startsWith('helm_docs/') ? rel : `helm_docs/${rel}`;
      await viewProjectDoc(activeProjectId, viewRel);
    } catch (e) { setDocsNewErr('Create failed (network)'); }
  };

  // E2 Memory actions (body-aware: muts carry body:JSON, GET/DELETE do not)
  const setScope = (s) => {
    setMemScope(s);
    setMemSearch('');
    setExpandedMemId(null);
    setEditingMemory(null);
    setMemErr('');
    if (s === 'project') {
      loadProjectsForMem().then(() => {
        const first = (projectsList && projectsList[0] && projectsList[0].id) || memProjectId;
        if (first) { setMemProjectId(first); loadMemories(s, first); }
        else loadMemories(s, null);
      });
    } else {
      setMemProjectId(null);
      loadMemories(s, null);
    }
  };
  const changeMemProject = (pid) => {
    const n = pid ? Number(pid) : null;
    setMemProjectId(n);
    setMemSearch('');
    setExpandedMemId(null);
    setEditingMemory(null);
    loadMemories('project', n);
  };
  const startNewMemory = () => {
    setEditingMemory({});
    setMemForm({ title: '', description: '', type: 'reference', body: '' });
    setMemErr('');
  };
  const startEditMemory = (m) => {
    setEditingMemory(m);
    setMemForm({ title: m.title || '', description: m.description || '', type: m.type || 'reference', body: m.body || '' });
    setMemErr('');
  };
  const cancelEditMemory = () => { setEditingMemory(null); setMemErr(''); };
  const saveMemory = async () => {
    setMemErr('');
    try {
      const payload = {
        scope: memScope,
        project_id: memScope === 'project' ? memProjectId : undefined,
        title: memForm.title,
        description: memForm.description || null,
        type: memForm.type,
        body: memForm.body || null,
        horizon: memHorizon
      };
      if (editingMemory && editingMemory.id) {
        await authedFetch(`/api/memory/${editingMemory.id}`, { method: 'PUT', body: JSON.stringify({ title: payload.title, description: payload.description, type: payload.type, body: payload.body }) });
      } else {
        await authedFetch('/api/memory', { method: 'POST', body: JSON.stringify(payload) });
      }
      setEditingMemory(null);
      await loadMemories(memScope, memProjectId);
    } catch (e) {
      setMemErr('Save failed (see banner for details)');
    }
  };
  const deleteMemory = async (id) => {
    if (!id) return;
    if (!confirm('Delete memory?')) return;
    setMemErr('');
    try {
      await authedFetch(`/api/memory/${id}`, { method: 'DELETE' }); // no body
      if (editingMemory && editingMemory.id === id) setEditingMemory(null);
      await loadMemories(memScope, memProjectId);
    } catch (e) { setMemErr('Delete failed (see banner)'); }
  };
  const approveMemory = async (id) => {
    setMemErr('');
    try {
      await authedFetch(`/api/memory/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'approved' }) });
      await loadMemories(memScope, memProjectId);
    } catch (e) { setMemErr('Approve failed (see banner)'); }
  };
  const rejectMemory = async (id) => {
    setMemErr('');
    try {
      await authedFetch(`/api/memory/${id}`, { method: 'DELETE' }); // reject = delete per E1
      await loadMemories(memScope, memProjectId);
    } catch (e) { setMemErr('Reject failed (see banner)'); }
  };
  const toggleMemBody = (id) => setExpandedMemId(expandedMemId === id ? null : id);

  // B11 UI3 promote/purge actions (real API calls)
  const toggleShortSelect = (id) => {
    setShortSelected(prev => prev.includes(id) ? prev.filter(x=>x!==id) : [...prev, id]);
  };
  const promoteSelected = async () => {
    if (shortSelected.length === 0) return;
    setMemErr('');
    try {
      await authedFetch('/api/memory/promote', { method: 'POST', body: JSON.stringify({ ids: shortSelected }) });
      setShortSelected([]);
      await loadMemories(memScope, memProjectId, memHorizon);
    } catch (e) { setMemErr('Promote failed (see banner)'); }
  };
  const clearShortRest = async () => {
    setMemErr('');
    try {
      await authedFetch('/api/memory/clear-short', { method: 'POST', body: JSON.stringify({ scope: memScope, project_id: memProjectId }) });
      await loadMemories(memScope, memProjectId, memHorizon);
    } catch (e) { setMemErr('Clear failed (see banner)'); }
  };

  useEffect(() => {
    if (currentSlug === '03-studio-plumbing-watchers') {
      if ((agentsList || []).length === 0) loadAgents();
      loadPlumbing();
    } else if (plumbingEs) {
      try { plumbingEs.close(); } catch {}
      setPlumbingEs(null);
    }
  }, [currentSlug]);

  // B5-T01: Overview board data load (GET /api/cycles/overview) when its tab is active.
  // B5-T02: also ensure projectsList is loaded (name/description/dev_url/qa_url for the cards).
  // B5-T03: extracted so New Cycle create-success can refetch without duplicating the fetch.
  const loadCcOverview = () => {
    setCcOvLoading(true);
    setCcOvError('');
    return authedFetch('/api/cycles/overview')
      .then(r => { if (!r.ok) throw new Error(`overview load failed (${r.status})`); return r.json(); })
      .then(d => setCcOvData(d))
      .catch(e => setCcOvError(e.message || 'overview load failed'))
      .finally(() => setCcOvLoading(false));
  };
  useEffect(() => {
    if (currentSlug !== '07-command-center-overview' || !token) return;
    loadCcProjectsIfNeeded();
    loadCcOverview();
  }, [currentSlug, token]);

  // D2 Command Center live (top level hooks; fns declared early)
  useEffect(() => {
    if (currentSlug === '07-command-center-chat' && token) {
      loadCcProjectsIfNeeded();
      if (ccOpenTabs.length && !ccCurrentId) setCcCurrentId(ccOpenTabs[0]);
    }
  }, [currentSlug, token]);
  useEffect(() => {
    if (currentSlug !== '07-command-center-chat') {
      if (ccEsRef.current) { try { ccEsRef.current.close(); } catch {} ; ccEsRef.current = null; }
      ccDetachStream();
      stopCcTerminalPoll();
      stopRunPoll();
      return;
    }
    const pid = ccCurrentId;
    if (pid) {
      loadChat(pid);
      loadTerminal(pid);
      loadCcAgents(pid); // CC-CHAT-1: project-assigned agents for the picker (coordinator pinned)
      subscribeCc(pid);
      if (ccViewMode !== 'chat') startCcTerminalPoll(pid);
      loadRun(pid); // A3: discover latest run (if any) for this CC project
      // CC-CHAT-2 R4: always-on latest-run poll while the tab is open (was gated on a STALE
      // runByPid snapshot + pinned to that run's rid — showed a previous failed run during a
      // live one and never picked up runs started after tab activation).
      startRunPoll(pid);
      // CC-CHAT-1: re-attach the reply stream for this tab's live agent-chat session (if any)
      const s = ccSession[pid];
      if (s && s.sid) ccAttachStream(pid, s.agentId, s.sid); else ccDetachStream();
    }
    return () => {
      if (ccEsRef.current) { try { ccEsRef.current.close(); } catch {} ; ccEsRef.current = null; }
      ccDetachStream();
      stopCcTerminalPoll();
      stopRunPoll();
    };
  }, [currentSlug, ccCurrentId, ccViewMode, token]);

  // Discovery docs collapse choice persists across workspace visits.
  useEffect(() => { try { localStorage.setItem('helm_disc_docs_min', ccDiscDocsMin ? '1' : '0'); } catch {} }, [ccDiscDocsMin]);

  // D3: load Tasks tab (real render) when active; follow ccCurrentId (active project tab) or explicit tasksPid selector
  useEffect(() => {
    if (currentSlug === '08-command-center-tasks' && token) {
      loadCcProjectsIfNeeded();
      const pid = tasksPid || ccCurrentId;
      if (pid) loadTasks(pid);
    }
  }, [currentSlug, token, tasksPid, ccCurrentId]);

  useEffect(() => {
    if (currentSlug === '04-projects' && token) {
      if ((agentsList || []).length === 0) loadAgents();
      loadProjects();
      loadModels();
      loadTeams();
      if (activeProjectId) {
        loadProjectStatus(activeProjectId);
        loadProjectTechStack(activeProjectId);
        loadProjectAgents(activeProjectId);
        loadProjectConfig(activeProjectId);
        loadPlannerPanel(activeProjectId);
        loadAllRoleRosters(activeProjectId);
        if (projectSubTab === 'documents') loadProjectDocs(activeProjectId);
      }
    }
  }, [currentSlug, token, activeProjectId, projectSubTab]);

  useEffect(() => {
    setExpandedPaAgentId(null);
    setPaOverrideDetail(null);
  }, [activeProjectId]);

  // O6.2 Tracking load on tab (manual refresh only after that; no auto-poll — read-only, on-demand)
  useEffect(() => {
    if (currentSlug === '12-tracking' && token) loadTracking();
  }, [currentSlug, token]);

  // S14b Sessions load on tab (manual refresh only; no auto-poll)
  useEffect(() => {
    if (currentSlug === '13-sessions' && token) loadSessions();
  }, [currentSlug, token]);

  // E2 Memory load on tab (and on scope/project/horizon change)
  useEffect(() => {
    if (currentSlug === '10-memory' && token) {
      if (memScope === 'project') loadProjectsForMem();
      loadMemories(memScope, memProjectId, memHorizon);
    }
  }, [currentSlug, token, memScope, memProjectId, memHorizon]);

  // B11 timeline load when tab active
  useEffect(() => {
    if (currentSlug === '11-command-center-timeline' && token) {
      loadCcProjectsIfNeeded();
      const pid = timelinePid || ccCurrentId;
      if (pid) loadTimeline(pid);
    }
  }, [currentSlug, token, timelinePid, ccCurrentId]);

  // CC-MT: multi-terminal viewer — load workers + start live capture poll when tab active.
  useEffect(() => {
    if (currentSlug !== '10-command-center-terminals') { stopCcMtPoll(); return; }
    if (!token) return;
    loadCcProjectsIfNeeded();
    const pid = ccMtPid || ccCurrentId;
    if (pid) {
      loadMtWorkers(pid);
      startCcMtPoll(pid);
    }
    return () => stopCcMtPoll();
  }, [currentSlug, token, ccMtPid, ccCurrentId]);

  // CC-MT: when the selected panes change while the tab is open, refresh their captures immediately.
  useEffect(() => {
    if (currentSlug !== '10-command-center-terminals' || !token) return;
    const pid = ccMtPid || ccCurrentId;
    if (!pid) return;
    const sel = (ccMtSelected[pid] || []).filter(Boolean);
    if (sel.length) loadMtCaptures(pid, sel);
  }, [currentSlug, token, ccMtPid, ccCurrentId, ccMtSelected, ccMtGridSize]);

  let activeSection = 'studio';
  for (const [k, v] of Object.entries(SECTIONS)) {
    if (v.tabs.some(t => t.slug === currentSlug)) {
      activeSection = k;
      break;
    }
  }
  const secDef = SECTIONS[activeSection];
  const tabs = secDef.tabs;
  const isStudio = activeSection === 'studio';
  let studioAgentsCol = null;
  let studioCenterCol = null;

  const buildStudioAgentsRoster = () => {
    const filterQ = String(agentsFilterQuery || '').trim().toLowerCase();
    const nameMatchesFilter = (name) => !filterQ || String(name || '').toLowerCase().includes(filterQ);
    const sessionCache = agentChatCacheRef.current;
    const renderAgentRow = (a) => {
      const dotState = agentStatusDotState(a, modelsList, sessionCache, selectedAgentId, chatSid);
      const liveSession = agentHasLiveSession(a.id, sessionCache, selectedAgentId, chatSid);
      const l0 = isJkageL0Learner(a);
      const kind = agentKind(a);
      // B9/AC-14: classification chip next to kind (mirrors Project Setup)
      const cls = a.classification === 'tiered' || a.classification === 'team' ? a.classification : 'solo';
      const clsChip = cls === 'tiered' ? 'chip-blue' : cls === 'team' ? 'chip-purple' : 'chip-gray';
      return html`
      <div data-testid="agent-row" data-kind=${kind} data-classification=${cls} class="as-agent-row list-item ${selectedAgentId === a.id ? 'selected' : ''}" onclick=${() => selectAgent(a)}>
        <span class="as-agent-avatar" aria-hidden="true">${agentInitial(a.name)}</span>
        <div class="as-agent-row-body">
          <div class="as-agent-row-primary">
            <span class="as-agent-name">${a.name}</span>
            ${agentKindChip(kind)}
            <span data-testid=${`studio-agent-classification-chip-${a.id}`} data-class=${cls} class=${`chip ${clsChip}`} style="font-size:9px;margin-left:4px" title=${`classification: ${cls}`}>${cls}</span>
            ${l0 ? jkageL0LearnerBadge('as-jkage-l0-badge-roster') : null}
            <span class="chip chip-blue as-agent-provider-chip">${a.provider}</span>
          </div>
          <span class="as-agent-model-muted">${a.model}</span>
          ${liveSession ? html`<span data-testid="as-active-session" class="as-active-session-label">+ active session</span>` : null}
        </div>
        <span data-testid="as-agent-status-dot" class=${`as-agent-status-dot as-status-dot-${dotState}`} title=${dotState}></span>
      </div>`;
    };
    const activeFiltered = (activeSessions || []).filter(s => nameMatchesFilter(s.agent_name));
    const activeRows = activeFiltered.map(s => {
      const agent = (agentsList || []).find(a => a.id === s.agent_id);
      return html`
        <div data-testid="as-active-session-row" class="as-active-session-row" key=${s.session_id}>
          <button
            type="button"
            class="as-active-session-open"
            data-testid="as-active-session-open"
            onclick=${() => { if (agent) attachToActiveSession(agent, s); }}
          >${s.agent_name}</button>
          <button
            type="button"
            class="as-active-session-close"
            data-testid="as-active-session-close"
            title="End session"
            aria-label=${`End session for ${s.agent_name}`}
            onclick=${(e) => { e.stopPropagation(); closeActiveSession(s); }}
          >×</button>
        </div>`;
    });
    // B11 / R2: group roster by kind project | house (legacy HELM label → HOUSE).
    const houseAgents = (agentsList || []).filter(a => isHouseKind(a) && nameMatchesFilter(a.name));
    const projectAgents = (agentsList || []).filter(a => !isHouseKind(a) && nameMatchesFilter(a.name));
    const rosterSectionHeader = (testid, label, extraStyle) => html`
      <div data-testid=${testid} class="as-roster-section-label" style="${extraStyle || ''}">${label}</div>`;
    const teamRows = (teamsList || []).filter(t => nameMatchesFilter(t.name)).map(t => html`
      <div data-testid="team-row" class="list-item ${selectedTeamId === t.id ? 'selected' : ''}" style="${selectedTeamId === t.id ? 'background:rgba(32,178,170,.08);border-left:3px solid #20b2aa;' : ''}" onclick=${() => selectTeam(t)}>
        <span class="list-item-name">${t.name}</span>
        <span class="chip chip-teal" style="margin-left:6px">${t.type}</span>
      </div>`);
    const agentCount = (agentsList || []).length;
    const rosterBody = agentsList.length === 0 && (teamsList || []).length === 0
      ? html`<div style="padding:12px;font-size:12px;color:var(--text-sec)">No agents (or loading)</div>`
      : html`
          ${(!filterQ || activeRows.length) ? html`<div data-testid="roster-section-active-wrap">
            ${rosterSectionHeader('roster-section-active', 'ACTIVE', 'margin-bottom:4px')}
            ${activeRows.length ? activeRows : html`<div data-testid="as-active-sessions-empty" style="padding:8px 10px;font-size:11px;color:var(--text-sec)">No active sessions</div>`}
          </div>` : null}
          ${projectAgents.length || !filterQ ? html`<div data-testid="roster-section-project-wrap">
            ${rosterSectionHeader('roster-section-project', 'PROJECT AGENTS', '')}
            ${projectAgents.length ? projectAgents.map(renderAgentRow) : html`<div data-testid="roster-section-project-empty" style="padding:8px 10px;font-size:11px;color:var(--text-sec)">${filterQ ? 'No matching project agents' : 'No project agents'}</div>`}
          </div>` : null}
          ${houseAgents.length || !filterQ ? html`<div data-testid="roster-section-house-wrap">
            ${rosterSectionHeader('roster-section-house', 'HOUSE AGENTS', 'margin-top:8px;border-top:1px solid var(--border)')}
            ${houseAgents.length ? houseAgents.map(renderAgentRow) : html`<div data-testid="roster-section-house-empty" style="padding:8px 10px;font-size:11px;color:var(--text-sec)">${filterQ ? 'No matching house agents' : 'No house agents'}</div>`}
          </div>` : null}
          ${teamRows.length || (!filterQ && (teamsList || []).length) ? html`<div data-testid="roster-section-teams-wrap">
            ${rosterSectionHeader('roster-section-teams', 'TEAMS', 'margin-top:8px;border-top:1px solid var(--border)')}
            ${teamRows.length ? teamRows : html`<div style="padding:8px 10px;font-size:11px;color:var(--text-sec)">${filterQ ? 'No matching teams' : 'No teams'}</div>`}
          </div>` : null}
          ${filterQ && !houseAgents.length && !projectAgents.length && !teamRows.length ? html`<div data-testid="roster-filter-empty" style="padding:12px 10px;font-size:11px;color:var(--text-sec)">No agents or teams match “${agentsFilterQuery}”</div>` : null}
        `;
    return html`
      <div data-testid="as-col-agents" class="as-col-agents agents-list-col">
        <div class="as-agents-col-header" data-testid="as-agents-col-header">
          <span class="as-agents-col-title">AGENTS (${agentCount})</span>
          <div class="as-agents-action-wrap">
            <button
              data-testid="as-agents-action"
              class="as-agents-action btn btn-sm"
              type="button"
              aria-label="Agents actions"
              aria-expanded=${agentsActionMenuOpen}
              onclick=${(e) => { e.stopPropagation(); setAgentsActionMenuOpen(!agentsActionMenuOpen); }}
            >⋮</button>
            ${agentsActionMenuOpen ? html`
              <div class="as-agents-action-menu" data-testid="as-agents-action-menu" onclick=${e => e.stopPropagation()}>
                <button data-testid="team-new-btn" class="as-agents-action-menu-item" type="button" onclick=${() => { setAgentsActionMenuOpen(false); startNewTeam(); }}>+ New team</button>
              </div>` : null}
          </div>
        </div>
        <div class="as-agents-filter-wrap">
          <span class="as-agents-filter-icon" aria-hidden="true">⌕</span>
          <input
            data-testid="as-agents-filter"
            class="as-agents-filter"
            type="search"
            placeholder="Filter agents…"
            value=${agentsFilterQuery}
            oninput=${e => setAgentsFilterQuery(e.target.value)}
          />
        </div>
        <div class="as-agents-roster-body">${rosterBody}</div>
        <div class="as-agents-col-footer">
          <button data-testid="agent-new-btn" class="btn btn-primary as-agents-new-btn" type="button" onclick=${startNewAgent}>+ New Agent</button>
        </div>
      </div>`;
  };

  const studioSelectedAgent = (agentsList || []).find(a => a.id === selectedAgentId) || null;
  let mainContent = html`<div data-testid=${`content-${activeSection}`} style="color:var(--text-sec);font-size:12px">Placeholder for ${currentSlug} — coming in later batch</div>`;

  // B1-T01: Command Center render boundary — one closure for every CC slug
  // (chat/tasks/completed/terminals/timeline). Nested inside App() so it keeps
  // direct closure access to CC state/handlers with zero prop-drilling.
  // Pure extraction of the former inline else-if/if branches; no behavior change.
  // B5-T01: all-projects Overview board (R-A2) — parity ref v2.1-01-overview.png.
  // B5-T02: project cycle cards. Real fields always render; not-yet-backed fields
  // (task n/N+bar, WAITING/BLOCKED flags, usage meter, recent-completions) render
  // ONLY when real data exists (B10 wires those) — never faked/hardcoded.
  const CC_PHASE_META = {
    discovery: { label: 'DISCOVERY', chip: 'chip-blue' },
    planning: { label: 'PLANNING', chip: 'chip-purple' },
    implementation: { label: 'IMPLEMENTATION', chip: 'chip-teal' },
    final_tests: { label: 'FINAL TESTS', chip: 'chip-orange' },
    complete: { label: 'COMPLETE', chip: 'chip-gray' }
  };
  const ccAutonomyBadge = (autonomy) => autonomy === 'autonomous_after_discovery'
    ? { label: 'fully autonomous', chip: 'chip-green' }
    : { label: 'gate-after-planning', chip: 'chip-orange' };

  // B5-T03: New Cycle dialog (R-B4/E2/C1) — project dropdown + name + autonomy radios.
  const ccOpenNewCycle = () => {
    const first = (projectsList || [])[0];
    setCcNcProjectId(first ? first.id : null);
    setCcNcName('');
    setCcNcAutonomy((first && first.autonomy_default) || 'pause_after_planning');
    setCcNcError('');
    setCcNcOpen(true);
  };
  const ccCloseNewCycle = () => { setCcNcOpen(false); setCcNcError(''); };
  const ccSelectNewCycleProject = (id) => {
    setCcNcProjectId(id);
    const proj = (projectsList || []).find(p => String(p.id) === String(id));
    setCcNcAutonomy((proj && proj.autonomy_default) || 'pause_after_planning');
  };
  const ccSubmitNewCycle = async () => {
    if (!ccNcProjectId || ccNcSubmitting) return;
    setCcNcSubmitting(true);
    setCcNcError('');
    try {
      const r = await authedFetch(`/api/projects/${ccNcProjectId}/cycles`, {
        method: 'POST',
        body: JSON.stringify({ name: ccNcName, autonomy: ccNcAutonomy }),
        allowStatuses: [400, 409]
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setCcNcError(d.error || `Couldn't create cycle (${r.status})`);
        return;
      }
      setCcNcOpen(false);
      loadCcOverview();
    } catch (e) {
      setCcNcError(e.message || 'Couldn\'t create cycle');
    } finally {
      setCcNcSubmitting(false);
    }
  };
  // Groups bucket rows (already sorted created_at DESC by the API) by project, preserving that order.
  const ccGroupCyclesByProject = (rows) => {
    const order = [];
    const byId = new Map();
    for (const row of (rows || [])) {
      if (!byId.has(row.project_id)) {
        byId.set(row.project_id, { project_id: row.project_id, project_name: row.project_name, cycles: [] });
        order.push(row.project_id);
      }
      byId.get(row.project_id).cycles.push(row);
    }
    return order.map(id => byId.get(id));
  };
  // B6-T01: workspace shell (R-A3/E2) — header (back/title/cycle switcher/autonomy badge) + phase tab
  // strip. Tab bodies are placeholders; real bodies land B7 (Discovery) / B8 (Planning) / B9
  // (Implementation) / B11 (Final Tests) / a later batch (History).
  const CC_WORKSPACE_TABS = [
    { key: 'discovery', label: 'Discovery', lands: 'B7' },
    { key: 'planning', label: 'Planning', lands: 'B8' },
    { key: 'implementation', label: 'Implementation', lands: 'B9' },
    { key: 'final_tests', label: 'Final Tests', lands: 'B11' },
    { key: 'history', label: 'History', lands: 'a later batch' }
  ];
  const ccProjectCycles = (projectId) => [
    ...((ccOvData && ccOvData.active) || []),
    ...((ccOvData && ccOvData.pending) || []),
    ...((ccOvData && ccOvData.completed) || [])
  ].filter(c => c.project_id === projectId);
  const ccOpenWorkspace = (projectId, cycleId, phase) => {
    setCcWsProjectId(projectId);
    setCcWsCycleId(cycleId);
    setCcWsTab(CC_WORKSPACE_TABS.some(t => t.key === phase) ? phase : 'discovery');
    setCcWsSwitcherOpen(false);
    setCcWsAutonomyOpen(false);
    setCcWsAutonomyErr('');
    setCcDiscChatMin(false);
    // DC-R4: do NOT force-open the docs rail on cycle-select — respect the persisted collapsed default.
    setCcDiscDocEditing(false);
    setCcDiscDocEditDraft('');
    setCcDiscDocEditErr('');
    setCcPlanSelectedTaskId(null);
    setCcPlanWatchLiveOpen(false);
    setCcPlanApproveNotice('');
    setCcImplExpandedTaskId(null);
  };
  const ccCloseWorkspace = () => {
    setCcWsProjectId(null);
    setCcWsCycleId(null);
    setCcWsSwitcherOpen(false);
    setCcWsAutonomyOpen(false);
  };
  // B7-T01: load the cycle's living-docs listing + default-select a doc (prefer north-star.md).
  const loadDiscArtifacts = async (cycleId) => {
    if (!cycleId || !token) return;
    setCcDiscDocsErr('');
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/artifacts`);
      const d = await r.json();
      setCcDiscArtifacts(p => ({...p, [cycleId]: d}));
      const docs = (d && d.docs) || [];
      if (docs.length && !ccDiscSelectedDoc[cycleId]) {
        const preferred = docs.find(f => f.name === 'north-star.md') || docs[0];
        setCcDiscSelectedDoc(p => ({...p, [cycleId]: preferred.path}));
      }
    } catch (e) { setCcDiscDocsErr('living docs load failed'); }
  };
  // B7-T03: fetch a saved attachment image's bytes (auth-protected) and cache a blob object URL
  // for thumbnail/full-screen <img> src. No-op if already cached.
  const loadDiscImage = async (cycleId, relPath) => {
    if (!cycleId || !relPath || !token) return;
    const key = `${cycleId}::${relPath}`;
    if (ccDiscImageUrl[key]) return;
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/artifact-image?path=${encodeURIComponent(relPath)}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      setCcDiscImageUrl(p => ({ ...p, [key]: url }));
    } catch (e) { /* thumbnail stays blank; doesn't block the rest of the pane */ }
  };
  // B8 / R6.27: safe basename for chat-file upload (no path segments; keep extension).
  const ccSafeChatFilename = (name, fallbackBase = 'paste') => {
    const raw = String(name || '').trim() || fallbackBase;
    const base = raw.split(/[/\\]/).pop() || fallbackBase;
    const cleaned = base.replace(/[^\w.\-()+@ ]+/g, '_').replace(/^\.+/, '').slice(0, 120);
    return cleaned || fallbackBase;
  };
  // Deterministic safe .txt name for pasted plain text (collision → caller retries with salt).
  const ccPasteTextFilename = (salt = '') => {
    const d = new Date();
    const utc = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const s = salt ? `-${String(salt).replace(/[^\w]/g, '').slice(0, 8)}` : '';
    return `paste-${utc}${s}.txt`;
  };
  // Insert project-relative path into Discovery composer without discarding draft.
  const ccInsertComposerRef = (refPath) => {
    const ref = String(refPath || '').trim();
    if (!ref) return;
    setCcComposer((prev) => {
      const cur = String(prev || '');
      if (!cur) return ref;
      if (cur.endsWith(' ') || cur.endsWith('\n')) return cur + ref;
      return cur + ' ' + ref;
    });
  };
  // B8: upload to B7 chat-file writer (POST /api/cycles/:id/chat-files). Returns path or null.
  // Never clears composer draft on error.
  const ccUploadChatFile = async (cycleId, filename, opts = {}) => {
    if (!cycleId || !filename) return null;
    const body = { filename };
    if (opts.contentBase64 != null) body.contentBase64 = opts.contentBase64;
    else if (opts.content != null) body.content = opts.content;
    else return null;
    const r = await authedFetch(`/api/cycles/${cycleId}/chat-files`, {
      method: 'POST',
      body: JSON.stringify(body),
      allowStatuses: [400, 404, 409, 413],
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(d.error || `Upload failed (${r.status})`);
      err.status = r.status;
      err.code = r.status === 409 ? 'CONFLICT' : r.status === 413 ? 'TOO_LARGE' : 'UPLOAD';
      throw err;
    }
    return d.path || null;
  };
  // B8 / R6.27: attach image via chat-files (same contract as paste), then insert path into composer.
  const ccAttachImage = async (cycleId, file) => {
    if (!cycleId || !file) return;
    setCcDiscAttachErr('');
    if (!file.type || !file.type.startsWith('image/')) {
      setCcDiscAttachErr('Only image files can be attached');
      return;
    }
    setCcDiscAttaching(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('file read failed'));
        reader.readAsDataURL(file);
      });
      const contentBase64 = String(dataUrl).split(',').pop();
      let filename = ccSafeChatFilename(file.name || 'paste.png', 'paste.png');
      if (!/\.(png|jpe?g|webp|gif)$/i.test(filename)) filename = `${filename}.png`;
      let pathRef = null;
      for (let attempt = 0; attempt < 4 && !pathRef; attempt++) {
        const tryName = attempt === 0 ? filename : ccSafeChatFilename(
          filename.replace(/(\.[^.]+)?$/, `-${Date.now()}-${attempt}$1` || '.png'),
          'paste.png'
        );
        try {
          pathRef = await ccUploadChatFile(cycleId, tryName, { contentBase64 });
        } catch (e) {
          if (e && e.code === 'CONFLICT' && attempt < 3) continue;
          throw e;
        }
      }
      if (pathRef) {
        ccInsertComposerRef(pathRef);
        setCcDiscAttachErr('');
      }
    } catch (e) {
      setCcDiscAttachErr(e.message || 'Attach failed');
    } finally {
      setCcDiscAttaching(false);
    }
  };
  // B8 / R6.27: Discovery composer paste — files/images keep safe name; text → deterministic .txt.
  // Upload first, then insert project-relative ref. Errors do not discard draft.
  const ccDiscComposerPaste = async (cycleId, e) => {
    if (!cycleId || !e) return;
    const cd = e.clipboardData;
    if (!cd) return;

    // Prefer file items (image/file paste)
    const files = cd.files && cd.files.length ? Array.from(cd.files) : [];
    if (files.length) {
      e.preventDefault();
      const file = files[0];
      setCcDiscAttachErr('');
      setCcDiscAttaching(true);
      try {
        const isImage = file.type && file.type.startsWith('image/');
        if (isImage || file.type) {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const contentBase64 = btoa(binary);
          let filename = ccSafeChatFilename(file.name || (isImage ? 'paste.png' : 'paste.bin'), isImage ? 'paste.png' : 'paste.bin');
          let pathRef = null;
          for (let attempt = 0; attempt < 4 && !pathRef; attempt++) {
            const tryName = attempt === 0 ? filename : ccSafeChatFilename(
              `${filename.replace(/(\.[^.]+)$/, '')}-${Date.now()}-${attempt}${filename.match(/(\.[^.]+)$/) ? filename.match(/(\.[^.]+)$/)[1] : ''}`,
              filename
            );
            try {
              pathRef = await ccUploadChatFile(cycleId, tryName, { contentBase64 });
            } catch (err) {
              if (err && err.code === 'CONFLICT' && attempt < 3) continue;
              throw err;
            }
          }
          if (pathRef) ccInsertComposerRef(pathRef);
        }
      } catch (err) {
        setCcDiscAttachErr(err.message || 'Paste upload failed');
      } finally {
        setCcDiscAttaching(false);
      }
      return;
    }

    // Plain-text paste → deterministic .txt under project tmp (R6.27); ref inserted into composer.
    const text = cd.getData('text/plain');
    if (text == null || text === '') return;

    e.preventDefault();
    setCcDiscAttachErr('');
    setCcDiscAttaching(true);
    try {
      let pathRef = null;
      for (let attempt = 0; attempt < 4 && !pathRef; attempt++) {
        const filename = ccPasteTextFilename(attempt ? `${Date.now()}${attempt}` : '');
        try {
          pathRef = await ccUploadChatFile(cycleId, filename, { content: text });
        } catch (err) {
          if (err && err.code === 'CONFLICT' && attempt < 3) continue;
          throw err;
        }
      }
      if (pathRef) ccInsertComposerRef(pathRef);
    } catch (err) {
      setCcDiscAttachErr(err.message || 'Paste upload failed');
    } finally {
      setCcDiscAttaching(false);
    }
  };
  // B7-T03: whenever the open cycle's image artifacts list changes (initial load or right after
  // a fresh attach), lazily fetch+cache blob URLs for any thumbnails not already cached.
  useEffect(() => {
    const cycleId = ccWsCycleId;
    if (!cycleId) return;
    const images = (ccDiscArtifacts[cycleId] && ccDiscArtifacts[cycleId].images) || [];
    images.forEach(f => { if (!ccDiscImageUrl[`${cycleId}::${f.path}`]) loadDiscImage(cycleId, f.path); });
  }, [ccDiscArtifacts, ccWsCycleId]);
  const loadDiscDoc = async (cycleId, relPath) => {
    if (!cycleId || !relPath || !token) return null;
    const key = `${cycleId}::${relPath}`;
    if (ccDiscDocContent[key]) return ccDiscDocContent[key];
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/docs/${encodeURIComponent(relPath)}?path=${encodeURIComponent(relPath)}`);
      const d = await r.json();
      setCcDiscDocContent(p => ({...p, [key]: d.doc || null}));
      return d.doc || null;
    } catch (e) { setCcDiscDocsErr('doc load failed'); return null; }
  };
  // B8-T01: fetch og-requirements.md + plan.md for the Planning tab doc cards. A 404 means the
  // cycle hasn't produced that doc yet — recorded as 'absent' so the card shows a graceful empty
  // state instead of erroring (a young cycle legitimately has no og-requirements.md/plan.md).
  const loadPlanDocs = async (cycleId) => {
    if (!cycleId || !token) return;
    const fetchOne = async (filename) => {
      try {
        const r = await authedFetch(`/api/cycles/${cycleId}/docs/${filename}`, { allowStatuses: [404] });
        if (r.status === 404) return 'absent';
        const d = await r.json();
        return d.doc || 'absent';
      } catch (e) { return 'absent'; }
    };
    // north-star.md is the DISCOVERY deliverable (the discovery brain's callback contract is
    // NORTH-STAR-READY). It gates Start Planning, so it is loaded here alongside the planning docs.
    const [ogreq, execplan, northstar] = await Promise.all([
      fetchOne('og-requirements.md'),
      fetchOne('plan.md'),
      fetchOne('north-star.md')
    ]);
    setCcPlanDocs(p => ({ ...p, [cycleId]: { ogreq, execplan, northstar } }));
  };
  // B11-T04: fetch the Final Tests tab's single real-data payload (R-G3). A fetch failure
  // degrades to 'absent' so the tab renders graceful empty sections, never a crash.
  const loadFinalTestsStatus = async (cycleId) => {
    if (!cycleId || !token) return;
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/final-tests-status`, { allowStatuses: [404] });
      if (!r.ok) { setCcFinalTestsStatus(p => ({ ...p, [cycleId]: 'absent' })); return; }
      const d = await r.json();
      setCcFinalTestsStatus(p => ({ ...p, [cycleId]: d }));
    } catch (e) {
      setCcFinalTestsStatus(p => ({ ...p, [cycleId]: 'absent' }));
    }
  };
  // B13-T01b: fetch the Implementation tab's real per-task run-state payload (R-I4/F6). A fetch
  // failure degrades to 'absent' (same honest all-pending render as a run-less cycle), never a crash.
  const loadRunState = async (cycleId) => {
    if (!cycleId || !token) return;
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/run-state`, { allowStatuses: [404] });
      if (!r.ok) { setCcRunState(p => ({ ...p, [cycleId]: 'absent' })); return; }
      const d = await r.json();
      setCcRunState(p => ({ ...p, [cycleId]: d }));
    } catch (e) {
      setCcRunState(p => ({ ...p, [cycleId]: 'absent' }));
    }
  };
  // A3 SEAM-1: cycle-scoped seats (worker_runtimes JOIN runs). Failure → 'absent', never crash.
  const loadCycleSeats = async (cycleId) => {
    if (!cycleId || !token) return;
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/seats`, { allowStatuses: [404] });
      if (!r.ok) { setCcPlanSeats(p => ({ ...p, [cycleId]: 'absent' })); return; }
      const d = await r.json();
      setCcPlanSeats(p => ({ ...p, [cycleId]: d }));
    } catch (e) {
      setCcPlanSeats(p => ({ ...p, [cycleId]: 'absent' }));
    }
  };
  // B4 (R5.19): path-safe capture for one seat — session resolved server-side from (cycleId, runtimeId) only.
  // NEVER send client session names. Bottom-stick: capture intent before content write, apply after paint.
  const loadSeatPaneCapture = async (cycleId, seat) => {
    if (!cycleId || !token || !seat || seat.id == null) return;
    if (!seat.live) return; // historical: no capture spam
    const runtimeId = Number(seat.id);
    const key = `${cycleId}::${runtimeId}`;
    const bodyEl = ccPlanPaneBodyRefs.current[runtimeId];
    const intent = captureStickIntent(bodyEl);
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/seats/${runtimeId}`, { allowStatuses: [404] });
      if (!r.ok) return;
      const d = await r.json();
      const content = d && d.content != null ? String(d.content) : '';
      setCcPlanSeatPanes((p) => ({
        ...p,
        [key]: { content, session: d.session || null, live: true },
      }));
      requestAnimationFrame(() => {
        applyStick(ccPlanPaneBodyRefs.current[runtimeId], intent);
      });
    } catch (e) {
      /* keep last snapshot */
    }
  };
  // A4 (R4.18): cycle-scoped step trail from run_events. No plan.md dependency. Failure → 'absent'.
  const loadCycleEvents = async (cycleId) => {
    if (!cycleId || !token) return;
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/events`, { allowStatuses: [404] });
      if (!r.ok) { setCcPlanEvents(p => ({ ...p, [cycleId]: 'absent' })); return; }
      const d = await r.json();
      setCcPlanEvents(p => ({ ...p, [cycleId]: d }));
    } catch (e) {
      setCcPlanEvents(p => ({ ...p, [cycleId]: 'absent' }));
    }
  };
  // LV-R3: fetch a role's live terminal pane (server-derives the running worker). Failure keeps the
  // last snapshot (no crash, no flicker to empty); empty text / null session → placeholder in render.
  // B6 site-4 / R6.23: capture stick intent before content write; apply after paint (no unconditional ref stick).
  const loadTaskTerminal = async (cycleId, role) => {
    if (!cycleId || !token) return;
    const bodyEl = implTermBodyRefs.current[role];
    const intent = captureStickIntent(bodyEl);
    implTermStickRefs.current[role] = intent;
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/task-terminal?role=${role}`, { allowStatuses: [400, 404] });
      if (!r.ok) return;
      const d = await r.json();
      setCcImplTerm(p => ({ ...p, [`${cycleId}::${role}`]: { session: d.session ?? null, text: d.text || '' } }));
      requestAnimationFrame(() => applyStick(implTermBodyRefs.current[role], intent));
    } catch (e) { /* keep last snapshot */ }
  };
  // B9-T02: lazy per-task docs fetch (R-F6) — tasks/<id>/changes.md + independent-validation.md.
  // The B3-T01 docs route is a single-segment :filename; this nested path is expected to 404 or
  // not match pre-live (later-batch wiring) — any failure degrades to 'absent', never a crash.
  const loadImplTaskDocs = async (cycleId, taskId) => {
    if (!cycleId || !taskId || !token) return;
    const key = `${cycleId}::${taskId}`;
    if (ccImplTaskDocs[key]) return;
    const fetchOne = async (rel) => {
      try {
        const r = await authedFetch(`/api/cycles/${cycleId}/docs/${encodeURIComponent(rel)}?path=${encodeURIComponent(rel)}`, { allowStatuses: [400, 404] });
        if (!r.ok) return 'absent';
        const d = await r.json();
        return d.doc || 'absent';
      } catch (e) { return 'absent'; }
    };
    const [changes, validation] = await Promise.all([
      fetchOne(`tasks/${taskId}/changes.md`),
      fetchOne(`tasks/${taskId}/independent-validation.md`)
    ]);
    setCcImplTaskDocs(p => ({ ...p, [key]: { changes, validation } }));
  };
  // B8-T04: JROM approves a gate-mode cycle (R-E3) — POST flips phase→implementation via the
  // existing B6-T03 endpoint. Refresh ccOvData (workspace cycle object source) so banner +
  // progress line reflect the new state; 409 races refresh too so the UI never sticks busy.
  const ccApprovePlanning = async (cycleId) => {
    if (ccPlanApproving) return;
    setCcPlanApproving(true);
    setCcPlanApproveNotice('');
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/approve`, {
        method: 'POST',
        allowStatuses: [400, 404, 409]
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        await loadCcOverview();
        setCcWsTab('implementation');
        return;
      }
      if (r.status === 409) {
        setCcPlanApproveNotice('Already approved / no longer awaiting');
        await loadCcOverview();
        return;
      }
      setCcPlanApproveNotice(d.error || `Approve failed (${r.status})`);
    } catch (e) {
      setCcPlanApproveNotice(e.message || 'Approve failed');
    } finally {
      setCcPlanApproving(false);
    }
  };
  // B7-T02: Save via the same PUT the read side already targets (B3-T01). On success, write
  // the response's doc straight into the cache (no extra GET). On error (e.g. B3-T04's
  // plan.md validate-on-save 400), stay in edit mode and leave the draft untouched.
  const saveDiscDocEdit = async (cycleId, relPath) => {
    if (!cycleId || !relPath) return;
    setCcDiscDocEditErr('');
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/docs/${encodeURIComponent(relPath)}?path=${encodeURIComponent(relPath)}`, {
        method: 'PUT',
        body: JSON.stringify({ content: ccDiscDocEditDraft }),
        allowStatuses: [400, 403, 404]
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setCcDiscDocEditErr(d.error || `Save failed (${r.status})`);
        return;
      }
      setCcDiscDocContent(p => ({...p, [`${cycleId}::${relPath}`]: d.doc || null}));
      setCcDiscDocEditing(false);
      setCcDiscDocEditDraft('');
    } catch (e) { setCcDiscDocEditErr('Save failed (network)'); }
  };
  // B7-T01: pid-parameterized send — mirrors sendCc's plain agent-chat-session branch only
  // (Discovery pre-implementation has no active run to merge with, so that branch doesn't apply).
  const ccWsSendChat = async (pid, agentIdOverride) => {
    const text = (ccComposer || '').trim();
    if (!pid || !text) return;
    setCcErr('');
    // BUG-2: Discovery pane passes its own effective agent id (the `discovery` agent by default).
    const selAid = agentIdOverride || ccSelectedAgentId[pid];
    if (!selAid) { setCcErr('pick an agent to chat with'); return; }
    const msgId = 'cc' + (ccMsgIdRef.current++);
    // F3: the WHOLE ensure→POST is one LEASED unit — a concurrent different-agent switch cannot tear this seat
    // down until this POST has landed. F2: the optimistic bubble is pushed INSIDE the send (after any switch
    // reset, so it lands in the correct target agent's thread) and carries the stable msgId for correlation.
    const { session } = await seatLeaseSendChain(
      ccEnsureInFlightRef.current, pid, ccGetCurrentSession, selAid,
      (plan) => ccRunSwitchAndSpawn(pid, selAid, plan),
      async (sess) => {
        ccPendingUserRef.current[pid] = text;
        ccPushThread(pid, { id: msgId, role: 'user', text, delivered: true });
        return ccPostChatMessage(pid, sess, text, msgId);
      }
    );
    if (!session || !session.sid) { setCcErr(ccSessConnecting[pid] ? 'connecting to the agent — try again in a moment' : 'pick an agent to chat with'); return; }
    setCcComposer('');
  };
  const CC_LOCKED_PHASES = ['implementation', 'final_tests', 'complete'];
  // B6-T02: PATCH the cycle's autonomy (R-E2/E3). Server re-guards the phase lock; this
  // is only reachable pre-implementation since the popover hides the radios once locked.
  const ccSetCycleAutonomy = async (cycleId, value) => {
    if (ccWsAutonomySaving) return;
    setCcWsAutonomySaving(true);
    setCcWsAutonomyErr('');
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/autonomy`, {
        method: 'PATCH',
        body: JSON.stringify({ autonomy: value }),
        allowStatuses: [400, 409]
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setCcWsAutonomyErr(d.error || `Couldn't update autonomy (${r.status})`);
        return;
      }
      loadCcOverview();
    } catch (e) {
      setCcWsAutonomyErr(e.message || 'Couldn\'t update autonomy');
    } finally {
      setCcWsAutonomySaving(false);
    }
  };
  // B9-T05 (R-F7): single seam for the Graceful Stop control. No safe cycle-level stop signal
  // R-F7 (wired): graceful stop targets THIS cycle's live run via the real halt signal
  // (POST /api/runs/:id/stop -> run-abort-registry; OrchestratorLoop halts at the next safe
  // boundary + reaps workers). Uses ccRunState[cycleId].runId/runActive (from getCycleRunState).
  // No-op with an honest note when there is no active run to stop.
  const requestGracefulStop = async (cycleId) => {
    const rs = ccRunState[cycleId];
    const runId = (rs && typeof rs === 'object') ? rs.runId : null;
    const active = (rs && typeof rs === 'object') ? rs.runActive : false;
    if (!runId || !active) {
      setCcGracefulStopNote(p => ({ ...p, [cycleId]: 'No active run to gracefully stop for this cycle.' }));
      return;
    }
    if (!confirm('Graceful stop will halt this run for replan. It stops at the next safe boundary and reaps workers; you can resume with an additive brief. Continue?')) return;
    try {
      const r = await authedFetch(`/api/runs/${runId}/stop`, { method: 'POST', body: JSON.stringify({ reason: 'graceful stop from Command Center' }), allowStatuses: [404, 409] });
      if (r.ok) {
        setCcGracefulStopNote(p => ({ ...p, [cycleId]: 'Graceful stop requested — run halting for replan at the next safe boundary.' }));
        loadRunState(cycleId);
      } else {
        setCcGracefulStopNote(p => ({ ...p, [cycleId]: 'Stop request was not accepted (run may have already ended). Refresh and retry if needed.' }));
      }
    } catch (e) {
      setCcGracefulStopNote(p => ({ ...p, [cycleId]: 'Stop request failed to send — check the run panel and retry.' }));
    }
  };
  // IS-R2 (impl-start): manual Start Implementation. POST /api/cycles/:id/start-implementation with
  // an empty body — the server uses the project's role bindings + ingests the cycle's own
  // plan.md (no seedPlan). On success, refresh run-state so the 4s Impl poll shows progress.
  // 400 => "author a plan first"; 409 => already running (both surfaced inline, never a crash).
  // Manual Start Planning. POST /api/cycles/:id/start-planning with an empty body — planning is what
  // PRODUCES plan.md, so unlike start-implementation there is no plan gate. 409 => a run is already
  // active for this cycle. Mirrors startImplementation's error handling exactly.
  const startPlanning = async (cycleId) => {
    if (ccPlanStarting[cycleId]) return;
    setCcPlanStarting(p => ({ ...p, [cycleId]: true }));
    setCcPlanStartNotice(p => ({ ...p, [cycleId]: '' }));
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/start-planning`, {
        method: 'POST',
        body: JSON.stringify({}),
        allowStatuses: [400, 404, 409]
      });
      if (r.ok) {
        await loadRunState(cycleId);
        return;
      }
      if (r.status === 409) {
        setCcPlanStartNotice(p => ({ ...p, [cycleId]: 'A run is already active for this cycle.' }));
        loadRunState(cycleId);
      } else if (r.status === 404) {
        setCcPlanStartNotice(p => ({ ...p, [cycleId]: 'Could not start planning (cycle not found). Refresh and retry.' }));
      } else {
        setCcPlanStartNotice(p => ({ ...p, [cycleId]: 'Could not start planning. Check the run panel and retry.' }));
      }
    } catch (e) {
      setCcPlanStartNotice(p => ({ ...p, [cycleId]: 'Start request failed to send — check the run panel and retry.' }));
    } finally {
      setCcPlanStarting(p => ({ ...p, [cycleId]: false }));
    }
  };
  const startImplementation = async (cycleId) => {
    if (ccImplStarting[cycleId]) return;
    setCcImplStarting(p => ({ ...p, [cycleId]: true }));
    setCcImplStartNotice(p => ({ ...p, [cycleId]: '' }));
    try {
      const r = await authedFetch(`/api/cycles/${cycleId}/start-implementation`, {
        method: 'POST',
        body: JSON.stringify({}),
        allowStatuses: [400, 404, 409]
      });
      if (r.ok) {
        await loadRunState(cycleId);
        return;
      }
      if (r.status === 409) {
        setCcImplStartNotice(p => ({ ...p, [cycleId]: 'Implementation is already running for this cycle.' }));
        loadRunState(cycleId);
      } else if (r.status === 400) {
        setCcImplStartNotice(p => ({ ...p, [cycleId]: 'Author a valid plan.md first — the plan is not ready yet.' }));
      } else {
        setCcImplStartNotice(p => ({ ...p, [cycleId]: 'Could not start implementation (cycle not found). Refresh and retry.' }));
      }
    } catch (e) {
      setCcImplStartNotice(p => ({ ...p, [cycleId]: 'Start request failed to send — check the run panel and retry.' }));
    } finally {
      setCcImplStarting(p => ({ ...p, [cycleId]: false }));
    }
  };
  const renderCommandCenterWorkspace = () => {
    const proj = (projectsList || []).find(p => p.id === ccWsProjectId);
    const cycles = ccProjectCycles(ccWsProjectId);
    const cycle = cycles.find(c => c.id === ccWsCycleId);
    if (!cycle) {
      return html`<div key="cc-workspace" data-testid="content-cmd-workspace">
        <button class="btn btn-sm" data-testid="ws-back" onclick=${ccCloseWorkspace}>← Back</button>
        <div class="text-sec" style="font-size:12px;padding:16px 0">Cycle not found — it may have been removed.</div>
      </div>`;
    }
    const autonomyBadge = ccAutonomyBadge(cycle.autonomy);
    const autonomyLocked = CC_LOCKED_PHASES.includes(cycle.phase);
    const activeTabDef = CC_WORKSPACE_TABS.find(t => t.key === ccWsTab) || CC_WORKSPACE_TABS[0];
    const implementationSubtitle = () => {
      const runState = ccRunState[cycle.id];
      const planDocs = ccPlanDocs[cycle.id] || {};
      const execDoc = planDocs.execplan;
      const planReady = execDoc && execDoc !== 'absent' && execDoc.valid === true;
      if (runState && runState !== 'absent' && runState.hasRun && runState.runActive) {
        return 'Implementation running. Additive changes still enter through Discovery chat; graceful stop is available for replan.';
      }
      if (runState && runState !== 'absent' && runState.hasRun) {
        const phase = String(runState.phase || '').toLowerCase();
        const status = String(runState.status || '').toLowerCase();
        if (phase === 'failed' || phase === 'blocked' || status === 'failed' || status === 'blocked') {
          return planReady
            ? 'Last implementation attempt failed or blocked. The plan is ready; start a new attempt when ready.'
            : 'Last implementation attempt failed or blocked. Fix the plan before starting again.';
        }
      }
      return planReady
        ? 'Plan is ready. Start Implementation when ready.'
        : 'Implementation waits for a valid execution plan.';
    };

    // B7-T01: Discovery tab body — split chat (reuses ccSession/ccThread/agent-chat plumbing,
    // keyed by ccWsProjectId) + living docs, either pane minimizable to a rail (R-C1, R-H3).
    const renderDiscoveryBody = () => {
      const pid = ccWsProjectId;
      const cycleId = cycle.id;
      const sess = ccSession[pid] || null;
      const sessOn = !!(sess && sess.sid);
      const connecting = !!ccSessConnecting[pid];
      // BUG-2: the backend-resolved Discovery brain ID is authoritative. A deliberate operator
      // selection is preserved, but there is no agent-name comparison or planning-brain fallback.
      const agentsForPid = orderedCcAgents(pid);
      const discoveryResolution = (ccPhaseAgents[pid] || {}).discovery;
      const discSelAid = preferredPhaseAgentId(
        discoveryResolution,
        ccDiscSelectedAgentId[pid],
        !!ccDiscExplicitAgentRef.current[pid]
      );
      const selRow = agentsForPid.find(x => x.agent_id === discSelAid);
      const discAgentId = (selRow && selRow.agent_id) || null;
      const brainName = (selRow && selRow.agent && selRow.agent.name) || 'discovery';
      const thread = ccThread[pid] || [];
      // DC-R7: transparent send — an agent being selectable is enough; a session is auto-ensured on send.
      const canChat = !!discAgentId;
      const discLiveActive = sessOn && ccHasLiveTurn(pid);
      // E7: default view is the 1:1 mirror; 'bubbles' is the opt-in reconstructed-chat toggle.
      const discMirrorMode = ccDiscViewMode[pid] !== 'bubbles';

      // DC-R7: compact "who am I talking to" selector — default is the resolved Discovery brain.
      const agentSelect = html`<select class="cc-disc-agent-select" data-testid="ws-disc-agent-select"
          title="Who you're talking to" disabled=${connecting}
          value=${discAgentId || ''}
          onchange=${e => { ccDiscExplicitAgentRef.current[pid] = true; setCcDiscSelectedAgentId(p => ({...p, [pid]: Number(e.target.value)})); }}
          style="font-size:11px;max-width:140px;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:1px 3px">
          ${agentsForPid.length
            ? agentsForPid.map(b => html`<option value=${b.agent_id} key=${b.agent_id}>${(b.agent && b.agent.name) || b.agent_id}${isCcBrainAgent(pid, b.agent_id) ? ' ★' : ''}</option>`)
            : html`<option value="">no agents assigned</option>`}
        </select>`;

      // E8 FIX3 (JROM design ruling, settled — do not re-open): the last-reply strip sits at the TOP of
      // the chat body regardless of view mode (mirror OR bubbles). Duplication with the mirror/thread
      // below is fine now — R6.24's original "not duplicated in the stream below" constraint is relaxed.
      const chatPane = ccDiscChatMin
        ? html`<div class="cc-disc-rail" data-testid="ws-disc-chat-rail" role="button" tabindex="0"
            onclick=${() => setCcDiscChatMin(false)}>
            <span class="cc-disc-rail-label">Chat collapsed</span>
            <button class="btn btn-sm" data-testid="ws-disc-chat-restore" onclick=${(e) => { e.stopPropagation(); setCcDiscChatMin(false); }}>Restore chat</button>
          </div>`
        : html`<div class="cc-disc-pane" data-testid="ws-disc-chat-pane">
            <div class="cc-disc-pane-header" data-testid="ws-disc-chat-header">
              <span>Discovery chat</span>
              <div data-testid="ws-disc-chat-header-controls" style="display:flex;gap:4px;align-items:center;flex-wrap:nowrap">
                ${agentSelect}
                <button class="btn btn-sm" data-testid="ws-disc-session-toggle" disabled=${connecting}
                  title=${sess && sess.sid
                    ? `tmux: ${sess.tmux || '—'}${sess.conversationId ? ` · conversation: ${sess.conversationId}${sess.resumed ? ' (resumed)' : ''}` : ''}`
                    : 'No live session'}
                  onclick=${() => ccToggleSession(pid, discAgentId)}>${connecting ? '⏳ Connecting…' : sessOn ? '⏻ Session On' : '⏻ Session Off'}</button>
                <button class="btn btn-sm" data-testid="ws-disc-view-toggle"
                  title=${discMirrorMode
                    ? 'Showing the raw session mirror — switch to reconstructed chat bubbles'
                    : 'Showing reconstructed chat bubbles — switch to the raw session mirror'}
                  onclick=${() => setCcDiscViewMode(p => ({...p, [pid]: discMirrorMode ? 'bubbles' : 'mirror'}))}
                  >${discMirrorMode ? 'View: Mirror' : 'View: Bubbles'}</button>
                <button class="btn btn-sm" data-testid="ws-disc-chat-minimize" onclick=${() => setCcDiscChatMin(true)}>Minimize</button>
              </div>
            </div>
            <div class="cc-disc-pane-body cc-chat-scroll" data-testid="ws-disc-chat-body"
              ref=${(el) => {
                discChatBodyRef.current = el;
                if (el) discChatStickRef.current = captureStickIntent(el);
              }}
              onscroll=${() => {
                if (discChatBodyRef.current) discChatStickRef.current = captureStickIntent(discChatBodyRef.current);
              }}>
              ${discLiveActive ? renderCcLiveReply(pid, brainName) : null}
              ${discMirrorMode
                ? html`<div class="disc-mirror-wrap" data-testid="ws-disc-mirror-wrap"
                    ref=${(el) => { if (el) el.innerHTML = buildDiscoveryMirrorHtml(stripAnsiForDisplay(ccLivePane[pid] || '')); }}>
                  </div>`
                : [
                    ccDeliveryGap[pid] ? html`<div data-testid="ws-disc-delivery-gap" style="color:#d29922;font-size:10px;padding:3px 6px;">⚠ some delivery statuses may be incomplete — reload to re-sync.</div>` : null,
                    ccGlobalLossWarn ? html`<div data-testid="ws-disc-loss-warn" style="color:#f85149;font-size:10px;padding:3px 6px;">⚠ delivery-status notifications were dropped under load — some sent messages' status is uncertain. <button class="btn btn-sm" style="padding:0 4px;font-size:9px" onclick=${ccAckGlobalLoss}>Dismiss</button></div>` : null,
                    thread.length ? thread.map(m => {
                      const isU = m.role === 'user';
                      return html`<div class=${`cc-bubble ${isU ? 'user' : ''}`} data-testid=${isU ? 'ws-disc-chat-message' : 'ws-disc-chat-bubble-agent'} key=${m.id}>
                        <span class="who">${isU ? 'JROM' : brainName}</span>
                        ${m.thinking
                          ? html`<div class="text-sec" style="font-style:italic">thinking…</div>`
                          : html`<div style="white-space:pre-wrap">${m.text}</div>`}
                        ${m.fallback ? html`<div class="text-sec" style="font-size:9px" title="Agent didn't wrap its reply in the Helm reply markers — showing raw output.">⚠ unstructured reply</div>` : null}
                        ${isU && m.delivered === false ? html`<span style="color:#f85149;font-size:8px;">⚠ not delivered</span>` : null}
                      </div>`;
                    }) : (discLiveActive ? null : html`<div class="text-sec" data-testid="ws-disc-chat-empty" style="padding:6px;font-size:11px">No messages yet. ${canChat ? `Type a message to start chatting with ${brainName}.` : 'Assign an agent to this project to chat.'}</div>`),
                  ]}
            </div>
            <div class="cc-disc-pane-footer cc-composer" data-testid="ws-disc-composer">
              <textarea data-testid="ws-disc-chat-composer" disabled=${!canChat}
                placeholder=${canChat ? 'talk to discovery… (paste text/image → project tmp ref)' : 'Assign an agent to chat…'}
                value=${ccComposer} oninput=${e=>setCcComposer(e.target.value)}
                onkeydown=${e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();ccWsSendChat(pid, discAgentId);}}}
                onpaste=${(e) => ccDiscComposerPaste(cycleId, e)}
                style="width:100%;height:56px;font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px;background:var(--surface-2);"></textarea>
              ${ccDiscAttachErr ? html`<div data-testid="ws-disc-attach-err" style="color:#f85149;font-size:11px;padding:2px 0">${ccDiscAttachErr}</div>` : null}
              ${ccDiscAttaching ? html`<div data-testid="ws-disc-chat-file-uploading" class="text-sec" style="font-size:10px;padding:2px 0">Uploading paste/file…</div>` : null}
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px">
                <input ref=${ccDiscAttachInputRef} type="file" accept="image/*" data-testid="ws-disc-attach-input"
                  style="display:none" onchange=${e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) ccAttachImage(cycleId, f); }} />
                <button data-testid="ws-disc-chat-attach" class="btn btn-sm" disabled=${ccDiscAttaching}
                  onclick=${() => ccDiscAttachInputRef.current && ccDiscAttachInputRef.current.click()}>${ccDiscAttaching ? 'Uploading…' : 'Attach image'}</button>
                <button data-testid="ws-disc-chat-send" class="btn btn-primary btn-sm" disabled=${!canChat} onclick=${() => ccWsSendChat(pid, discAgentId)}>Send</button>
              </div>
            </div>
          </div>`;

      const artifacts = ccDiscArtifacts[cycleId] || {};
      const docs = artifacts.docs || [];
      const flow = artifacts.flow || [];
      const allImages = artifacts.images || [];
      // B7-T04: approved mockups (mockups/ prefix, R-C4) get their own gallery entry — keep the
      // B7-T03 "Image artifacts" rail scoped to chat-attached images so nothing double-shows.
      const mockupImages = allImages.filter(f => f.path.indexOf('mockups/') === 0);
      const images = allImages.filter(f => f.path.indexOf('mockups/') !== 0);
      const selectedPath = ccDiscSelectedDoc[cycleId];
      const mockupsSelected = selectedPath === CC_DISC_MOCKUPS_KEY;
      const selectedDoc = selectedPath && !mockupsSelected ? ccDiscDocContent[`${cycleId}::${selectedPath}`] : null;
      const selectedFlow = !mockupsSelected && flow.find(f => f.path === selectedPath);

      const docsPane = ccDiscDocsMin
        ? html`<div class="cc-disc-rail" data-testid="ws-disc-docs-rail" role="button" tabindex="0"
            onclick=${() => setCcDiscDocsMin(false)}>
            <span class="cc-disc-rail-label">Docs collapsed</span>
            <button class="btn btn-sm" data-testid="ws-disc-docs-restore" onclick=${(e) => { e.stopPropagation(); setCcDiscDocsMin(false); }}>Restore docs</button>
          </div>`
        : html`<div class="cc-disc-pane cc-disc-pane-docs" data-testid="ws-disc-docs-pane">
            <div class="cc-disc-pane-header">
              <span>Living docs</span>
              <div style="display:flex;gap:4px;align-items:center">
                ${selectedDoc && !ccDiscDocEditing ? html`<button class="btn btn-sm" data-testid="ws-disc-docs-fullscreen"
                    onclick=${() => openFullScreen('doc', selectedDoc.filename || selectedPath, selectedDoc.content || '')}>Full screen</button>` : null}
                ${selectedDoc && !ccDiscDocEditing ? html`<button class="btn btn-sm" data-testid="ws-disc-docs-edit"
                    onclick=${() => { setCcDiscDocEditDraft(selectedDoc.content || ''); setCcDiscDocEditErr(''); setCcDiscDocEditing(true); }}>Edit</button>` : null}
                ${ccDiscDocEditing ? html`<button class="btn btn-sm btn-primary" data-testid="ws-disc-docs-save"
                    onclick=${() => saveDiscDocEdit(cycleId, selectedPath)}>Save</button>
                    <button class="btn btn-sm" data-testid="ws-disc-docs-cancel"
                      onclick=${() => { setCcDiscDocEditing(false); setCcDiscDocEditDraft(''); setCcDiscDocEditErr(''); }}>Cancel</button>` : null}
                <button class="btn btn-sm" data-testid="ws-disc-docs-refresh" onclick=${() => loadDiscArtifacts(cycleId)}>Refresh</button>
                <button class="btn btn-sm" data-testid="ws-disc-docs-minimize" onclick=${() => setCcDiscDocsMin(true)}>Minimize</button>
              </div>
            </div>
            <div class="cc-disc-docs-body">
              <div class="cc-disc-docs-list" data-testid="ws-disc-docs-list">
                ${(docs.length || flow.length || mockupImages.length) ? [
                    ...docs.map(f => html`<div class=${`cc-disc-doc-item ${f.path === selectedPath ? 'sel' : ''}`} key=${f.path}
                        data-testid=${`ws-disc-doc-${f.name}`} onclick=${() => { setCcDiscSelectedDoc(p => ({...p, [cycleId]: f.path})); setCcDiscDocEditing(false); setCcDiscDocEditDraft(''); setCcDiscDocEditErr(''); }}>${f.name}</div>`),
                    // B7-T04: flow_NN.md artifacts (optional Discovery deliverable, R-C4) — same
                    // doc-list + doc-viewer plumbing as regular docs, tagged with a chart chip.
                    ...flow.map(f => html`<div class=${`cc-disc-doc-item cc-disc-doc-item-flow ${f.path === selectedPath ? 'sel' : ''}`} key=${f.path}
                        data-testid=${`ws-disc-doc-${f.name}`} onclick=${() => { setCcDiscSelectedDoc(p => ({...p, [cycleId]: f.path})); setCcDiscDocEditing(false); setCcDiscDocEditDraft(''); setCcDiscDocEditErr(''); }}>
                        <span class="cc-disc-doc-item-label">${f.name}</span><span class="chip chip-gray cc-disc-flow-chip" data-testid=${`ws-disc-flow-badge-${f.name}`}>chart</span>
                      </div>`),
                    mockupImages.length ? html`<div class=${`cc-disc-doc-item cc-disc-doc-item-flow ${mockupsSelected ? 'sel' : ''}`} key="mockups"
                        data-testid="ws-disc-doc-mockups" onclick=${() => { setCcDiscSelectedDoc(p => ({...p, [cycleId]: CC_DISC_MOCKUPS_KEY})); setCcDiscDocEditing(false); setCcDiscDocEditDraft(''); setCcDiscDocEditErr(''); }}>
                        <span class="cc-disc-doc-item-label">mockups/</span><span class="chip chip-gray cc-disc-flow-chip">${mockupImages.length}</span>
                      </div>` : null
                  ]
                  : html`<div class="text-sec" data-testid="ws-disc-docs-empty" style="font-size:11px;padding:6px">No docs yet.</div>`}
              </div>
              <div class="cc-disc-docs-view" data-testid="ws-disc-docs-render">
                ${ccDiscDocsErr ? html`<div style="color:#f85149;font-size:11px;padding:4px">${ccDiscDocsErr}</div>` : null}
                ${ccDiscDocEditErr ? html`<div data-testid="ws-disc-docs-edit-err" style="color:#f85149;font-size:11px;padding:4px">${ccDiscDocEditErr}</div>` : null}
                ${!ccDiscDocEditing && selectedFlow ? html`<div class="text-sec" data-testid="ws-disc-flow-note" style="font-size:11px;margin-bottom:4px">Flow chart source — rendered as markdown (chart rendering is a later enhancement).</div>` : null}
                ${ccDiscDocEditing
                  ? html`<textarea data-testid="ws-disc-docs-edit-textarea" aria-label="Edit document content"
                      style="width:100%;height:100%;min-height:300px;font-family:ui-monospace,monospace;font-size:12px;resize:vertical"
                      value=${ccDiscDocEditDraft} oninput=${e => setCcDiscDocEditDraft(e.target.value)}></textarea>`
                  : mockupsSelected
                    ? html`<div class="cc-disc-mockups-grid" data-testid="ws-disc-mockups-grid">
                        ${mockupImages.map(f => {
                          const url = ccDiscImageUrl[`${cycleId}::${f.path}`];
                          return html`<img class="cc-disc-mockup-thumb" key=${f.path} data-testid=${`ws-disc-mockup-${f.name}`}
                            src=${url || ''} alt=${f.name} title=${f.name}
                            onclick=${() => url && openFullScreen('image', f.name, url)} />`;
                        })}
                      </div>`
                    : selectedDoc
                      ? html`<${MdViewer} content=${selectedDoc.content} testId="ws-disc-doc-view" maxHeight="none" />`
                      : html`<div class="text-sec" style="font-size:11px;padding:6px">${(docs.length || flow.length || mockupImages.length) ? 'Select a doc' : ''}</div>`}
              </div>
            </div>
            <div class="cc-disc-images" data-testid="ws-disc-images">
              <div class="cc-disc-images-label">Image artifacts</div>
              <div class="cc-disc-images-rail">
                ${images.length ? images.map(f => {
                    const url = ccDiscImageUrl[`${cycleId}::${f.path}`];
                    return html`<img class="cc-disc-image-thumb" key=${f.path} data-testid=${`ws-disc-image-${f.name}`}
                      src=${url || ''} alt=${f.name} title=${f.name}
                      onclick=${() => url && openFullScreen('image', f.name, url)} />`;
                  })
                  : html`<div class="text-sec" data-testid="ws-disc-images-empty" style="font-size:11px;padding:6px">No image artifacts yet — attach one from the chat composer.</div>`}
              </div>
            </div>
          </div>`;

      return html`<div class="cc-disc-split cc-disc-view-chat" data-testid="ws-disc-split">${chatPane}${docsPane}</div>`;
    };

    // Start Planning control. Rendered on BOTH the Planning and Implementation tabs so the action is
    // reachable from wherever the operator is standing (JROM 2026-07-26).
    //
    // Gate: discovery must have written the cycle's north-star.md — existence + non-empty content,
    // NOT `doc.valid`. `valid` is computed only for plan.md (cycle-docs-service), so it is undefined
    // for north-star.md and testing it would grey the button permanently.
    //
    // Reads ccRunState directly rather than a `runState` local: the only other binding of that name
    // lives inside implementationSubtitle(), a sibling function, so referencing it from here would be
    // a ReferenceError that blanks the tab.
    const renderStartPlanningRow = (testIdPrefix) => {
      const cycleId = cycle.id;
      const planDocs = ccPlanDocs[cycleId] || {};
      const nsDoc = planDocs.northstar;
      const execDoc = planDocs.execplan;
      const runState = ccRunState[cycleId];
      const discoveryReady = !!(nsDoc && nsDoc !== 'absent' && String(nsDoc.content || '').trim().length > 0);
      const planExists = !!(execDoc && execDoc !== 'absent');
      const planStarting = !!ccPlanStarting[cycleId];
      const planStartNotice = ccPlanStartNotice[cycleId];
      const runActive = !!(runState && runState !== 'absent' && runState.hasRun && runState.runActive);
      const title = !discoveryReady
        ? 'Start enables once discovery has written north-star.md'
        : planExists
          ? 'Re-run interview + planning for this cycle (a plan.md already exists)'
          : 'Start the interview + planning run for this cycle';
      return html`<div class="cc-plan-start-row" data-testid=${`${testIdPrefix}-plan-start-row`} style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0">
        ${runActive
          ? html`<span class="chip chip-blue" data-testid=${`${testIdPrefix}-plan-running`}>Run in progress</span>`
          : html`<button class=${planExists ? 'btn btn-sm' : 'btn btn-primary btn-sm'} data-testid=${`${testIdPrefix}-plan-start`}
              disabled=${!discoveryReady || planStarting}
              title=${title}
              onclick=${() => startPlanning(cycleId)}>
              ${planStarting ? 'Starting…' : (planExists ? 'Re-run Planning' : 'Start Planning')}
            </button>`}
        ${!runActive && !discoveryReady
          ? html`<span class="text-sec" data-testid=${`${testIdPrefix}-plan-start-hint`} style="font-size:11px">Start enables once discovery has written north-star.md.</span>`
          : null}
        ${planStartNotice
          ? html`<span class="text-sec" data-testid=${`${testIdPrefix}-plan-start-notice`} style="font-size:11px">${planStartNotice}</span>`
          : null}
      </div>`;
    };

    // B8-T01: Planning tab — og-requirements.md + plan.md as full-screen-able doc cards (R-D1/D3).
    // 'absent' = doc not produced yet (young cycle) -> graceful empty state, no fake content.
    const renderPlanningBody = () => {
      const cycleId = cycle.id;
      const planDocs = ccPlanDocs[cycleId] || {};
      const docCard = (filename, doc, testKey) => {
        const loaded = doc && doc !== 'absent';
        const badge = filename === 'og-requirements.md'
          ? (loaded ? html`<span class="chip chip-green" data-testid=${`ws-plan-badge-${testKey}`}>rendered</span>` : null)
          : (loaded ? html`<span class="chip ${doc.valid ? 'chip-purple' : 'chip-red'}" data-testid=${`ws-plan-badge-${testKey}`}>${doc.valid ? 'schema valid' : 'invalid'}</span>` : null);
        return html`<div class="card cc-plan-card" data-testid=${`ws-plan-card-${testKey}`}>
          <div class="card-header">
            <div class="card-title">${filename}</div>
            ${badge}
            ${loaded ? html`<button class="btn btn-sm" data-testid=${`ws-plan-fullscreen-${testKey}`}
                onclick=${() => openFullScreen('doc', filename, doc.content)}>Full screen</button>` : null}
          </div>
          ${loaded
            ? html`<${MdViewer} content=${doc.content} testId=${`ws-plan-view-${testKey}`} maxHeight="320px" />`
            : html`<div class="text-sec" data-testid=${`ws-plan-empty-${testKey}`} style="font-size:11px;padding:6px">Not yet produced.</div>`}
        </div>`;
      };

      // B2 (R2.9/R2.10/R2.11): task rows from getCycleRunState / run_tasks — NOT parsePlanTasksClient(plan.md).
      // Document cards above still render authored plan.md; execution view never depends on the file.
      const execDoc = planDocs.execplan;
      const execLoaded = execDoc && execDoc !== 'absent';
      const planRunState = ccRunState[cycleId];
      const planRunLoaded = planRunState && planRunState !== 'absent';
      const tasks = (planRunLoaded && planRunState.hasRun && Array.isArray(planRunState.tasks))
        ? planRunState.tasks
        : [];
      const planStatusChip = (s) => {
        const st = String(s || 'pending');
        const chip =
          st === 'complete' ? 'chip-green' :
          st === 'working' ? 'chip-blue' :
          st === 'failed' ? 'chip-red' :
          st === 'deferred' ? 'chip-orange' : 'chip-gray';
        return html`<span class="chip ${chip}" data-testid="ws-plan-task-status">${st}</span>`;
      };
      const selectedTask = tasks.find(t => String(t.taskKey || t.id) === String(ccPlanSelectedTaskId)) || null;
      const awaitingApproval = cycle.autonomy === 'pause_after_planning' && cycle.awaiting_approval;

      // B8-T03: planner-progress line (R-D1/D3/H4) — derived from the REAL cycle.phase +
      // awaiting_approval columns (no task-count denominator exists anywhere yet, so no
      // "task N/M" claim — that lands with the B10 helm-algo planner integration).
      const progressLine = cycle.phase === 'discovery'
        ? 'Planning not started'
        : cycle.phase === 'planning'
          ? (cycle.awaiting_approval ? 'Planning docs ready — awaiting approval' : 'Planning in progress — plancore × co-planner')
          : 'Planning complete';

      const tableSection = () => {
        if (!planRunLoaded) {
          return html`<div class="text-sec" data-testid="ws-plan-table-empty" style="font-size:11px;padding:6px">Loading task rows…</div>`;
        }
        if (!planRunState.hasRun || tasks.length === 0) {
          return html`<div class="text-sec" data-testid="ws-plan-table-empty" style="font-size:11px;padding:6px">No tasks ingested yet.</div>`;
        }
        return html`<table class="cc-plan-table" data-testid="ws-plan-table">
          <thead><tr><th>Task</th><th>Key</th><th>Batch</th><th>Status</th><th>Attempts</th></tr></thead>
          <tbody>
            ${tasks.map(t => {
              const rowKey = String(t.taskKey || t.id);
              return html`<tr key=${t.id} data-testid="ws-plan-task-row" data-task-key=${rowKey} data-task-status=${t.status}
                  class=${String(ccPlanSelectedTaskId) === rowKey ? 'sel' : ''}
                  onclick=${() => setCcPlanSelectedTaskId(String(ccPlanSelectedTaskId) === rowKey ? null : rowKey)}>
                <td>${t.label || '—'}</td>
                <td class="text-sec">${t.taskKey || '—'}</td>
                <td class="text-sec">${t.batch || '—'}</td>
                <td>${planStatusChip(t.status)}</td>
                <td class="text-sec">${typeof t.attempts === 'number' ? t.attempts : '—'}</td>
              </tr>`;
            })}
          </tbody>
        </table>`;
      };

      // A3 (R4.17) + B4 (R5.19/R5.20): seats list + one shared B3 pane per seat (keyed by worker_runtimes.id).
      const seatsPayload = ccPlanSeats[cycleId];
      const seatsList = (seatsPayload && seatsPayload !== 'absent' && Array.isArray(seatsPayload.seats))
        ? seatsPayload.seats : [];
      const renderSeatsList = () => {
        if (!seatsPayload) {
          return html`<div class="text-sec" data-testid="ws-plan-seats-loading" style="font-size:11px;padding:4px 0">Loading seats…</div>`;
        }
        if (seatsPayload === 'absent') {
          return html`<div class="text-sec" data-testid="ws-plan-seats-empty" style="font-size:11px;padding:4px 0">No seats recorded for this cycle yet.</div>`;
        }
        if (seatsList.length === 0) {
          return html`<div class="text-sec" data-testid="ws-plan-seats-empty" style="font-size:11px;padding:4px 0">No seats recorded for this cycle yet.</div>`;
        }
        return html`<div class="cc-plan-seats-list" data-testid="ws-plan-seats" style="display:flex;flex-direction:column;gap:4px;padding:4px 0 8px">
          ${seatsList.map((s, idx) => {
            const label = `${s.role || 'seat'}${seatsList.filter(x => x.role === s.role).length > 1 ? ` #${idx + 1}` : ''}`;
            const liveChip = s.live
              ? html`<span class="chip chip-green" data-testid=${`ws-plan-seat-live-${s.id}`}>live</span>`
              : html`<span class="chip chip-orange" data-testid=${`ws-plan-seat-historical-${s.id}`}>historical</span>`;
            return html`<div class="cc-plan-seat-row" data-testid=${`ws-plan-seat-${s.id}`}
                style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;padding:4px 6px;border:1px solid var(--border, #30363d);border-radius:4px">
              <span data-testid=${`ws-plan-seat-role-${s.id}`} style="font-weight:600">${label}</span>
              <span class="text-sec" data-testid=${`ws-plan-seat-model-${s.id}`}>${s.model || '—'}</span>
              <span class="text-sec" data-testid=${`ws-plan-seat-state-${s.id}`}>${s.state || '—'}</span>
              ${liveChip}
            </div>`;
          })}
        </div>`;
      };
      // B4: one shared session-pane per seat (B3 .sp-pane shell + path-safe capture + bottom-stick).
      const renderPlanPanes = () => {
        if (!seatsPayload) {
          return html`<div class="text-sec" data-testid="ws-plan-panes-loading" style="font-size:11px;padding:4px 0">Loading panes…</div>`;
        }
        if (seatsPayload === 'absent' || seatsList.length === 0) {
          return html`<div class="text-sec" data-testid="ws-plan-panes-empty" style="font-size:11px;padding:6px">No seat panes for this cycle yet. Start Planning to record co-planner seats.</div>`;
        }
        // B4 send-back: data-pane-count = all seats (honest roster); data-live-pane-count = live only
        // so e2e can fail if only historical rows satisfy a count contract (HIGH-2).
        const livePaneCount = seatsList.filter((s) => s && s.live).length;
        return html`<div class="cc-plan-panes" data-testid="ws-plan-panes"
            data-pane-count=${seatsList.length}
            data-live-pane-count=${livePaneCount}>
          ${seatsList.map((s) => {
            const rid = Number(s.id);
            const key = `${cycleId}::${rid}`;
            const snap = ccPlanSeatPanes[key];
            const content = snap && snap.content != null ? String(snap.content) : '';
            const title = `${s.role || 'seat'}${s.model ? ` · ${s.model}` : ''}`;
            const liveChip = s.live
              ? html`<span class="chip chip-green" data-testid=${`ws-plan-pane-live-${rid}`}>live</span>`
              : html`<span class="chip chip-orange" data-testid=${`ws-plan-pane-historical-${rid}`}>historical</span>`;
            return html`<div class=${SESSION_PANE_CLASSES.pane} data-testid=${`ws-plan-pane-${rid}`}
                data-runtime-id=${rid} data-role=${s.role || ''} data-live=${s.live ? '1' : '0'}>
              <div class=${SESSION_PANE_CLASSES.header}>
                <span class="sp-pane-title" data-testid=${`ws-plan-pane-title-${rid}`}>${title}</span>
                ${liveChip}
              </div>
              <div class="${SESSION_PANE_CLASSES.body} ${SESSION_PANE_CLASSES.scrollOwner}"
                data-testid=${`ws-plan-pane-body-${rid}`}
                ref=${(el) => { if (el) ccPlanPaneBodyRefs.current[rid] = el; else delete ccPlanPaneBodyRefs.current[rid]; }}>
                ${content
                  ? html`<pre class=${SESSION_PANE_CLASSES.payload} data-testid=${`ws-plan-pane-payload-${rid}`}>${content}</pre>`
                  : html`<div class="${SESSION_PANE_CLASSES.empty} text-sec" data-testid=${`ws-plan-pane-empty-${rid}`}>
                      ${s.live ? 'Waiting for live pane output…' : 'No live terminal — historical / session unavailable.'}
                    </div>`}
              </div>
            </div>`;
          })}
        </div>`;
      };

      // A4 (R4.18): compact step-level event trail from run_events — "what happened at 1, 2, 3".
      // Explicitly not full transcripts. Independent of plan.md presence.
      const eventsPayload = ccPlanEvents[cycleId];
      const eventsList = (eventsPayload && eventsPayload !== 'absent' && Array.isArray(eventsPayload.events))
        ? eventsPayload.events : [];
      const renderEventTrail = () => {
        if (!eventsPayload) {
          return html`<div class="text-sec" data-testid="ws-plan-event-trail-loading" style="font-size:11px;padding:4px 0">Loading event trail…</div>`;
        }
        if (eventsPayload === 'absent') {
          return html`<div class="text-sec" data-testid="ws-plan-event-trail-empty" style="font-size:11px;padding:4px 0">No event trail for this cycle yet.</div>`;
        }
        if (!eventsPayload.hasRun || eventsList.length === 0) {
          return html`<div class="text-sec" data-testid="ws-plan-event-trail-empty" style="font-size:11px;padding:4px 0">No events recorded for this run yet.</div>`;
        }
        return html`<ol class="cc-plan-event-trail-list" data-testid="ws-plan-event-trail" style="margin:0;padding:4px 0 8px 20px;font-size:12px;line-height:1.35">
          ${eventsList.map((ev, idx) => html`<li key=${ev.id || idx} data-testid=${`ws-plan-event-${idx + 1}`}
              style="margin:2px 0;padding:2px 0">
            <span data-testid=${`ws-plan-event-type-${idx + 1}`} style="font-weight:600">${ev.type || 'event'}</span>
            <span class="text-sec" data-testid=${`ws-plan-event-ts-${idx + 1}`} style="margin-left:8px">${ev.createdAt || '—'}</span>
            ${ev.summary && ev.summary !== ev.type
              ? html`<span class="text-sec" data-testid=${`ws-plan-event-summary-${idx + 1}`} style="margin-left:8px">${ev.summary}</span>`
              : null}
          </li>`)}
        </ol>`;
      };

      return html`<div data-testid="ws-plan-progress-wrap">
        <div class="cc-plan-progress-row" data-testid="ws-plan-progress-row">
          <div class="cc-plan-progress-line" data-testid="ws-plan-progress-line">${progressLine}</div>
          <button class="btn btn-sm" data-testid="ws-plan-watch-live-toggle"
            onclick=${() => setCcPlanWatchLiveOpen(!ccPlanWatchLiveOpen)}>${ccPlanWatchLiveOpen ? 'Hide live' : 'Watch live'}</button>
        </div>
        ${renderStartPlanningRow('ws')}
        <div class="cc-plan-seats-block" data-testid="ws-plan-seats-block" style="margin:4px 0 8px">
          <div class="card-title" style="margin-bottom:4px;font-size:12px">Seats</div>
          ${renderSeatsList()}
        </div>
        <div class="cc-plan-event-trail-block" data-testid="ws-plan-event-trail-block" style="margin:4px 0 8px">
          <div class="card-title" style="margin-bottom:4px;font-size:12px">Event trail</div>
          ${renderEventTrail()}
        </div>
        ${ccPlanWatchLiveOpen ? html`<div class="cc-plan-watch-live-pane" data-testid="ws-plan-watch-live-pane">
          ${renderPlanPanes()}
        </div>` : null}
        ${awaitingApproval ? html`<div class="cc-plan-approve-banner" data-testid="ws-plan-approve-banner">
          <div class="cc-plan-approve-banner-text">
            <div class="cc-plan-approve-banner-title">Awaiting your approval</div>
            <div class="cc-plan-approve-banner-body">Review og-requirements.md and plan.md. Approving starts Implementation with the current task table.</div>
            ${ccPlanApproveNotice ? html`<div class="cc-plan-approve-notice" data-testid="ws-plan-approve-notice">${ccPlanApproveNotice}</div>` : null}
          </div>
          <button class="btn btn-primary btn-sm" data-testid="ws-plan-approve-btn" disabled=${ccPlanApproving}
            onclick=${() => ccApprovePlanning(cycleId)}>${ccPlanApproving ? 'Approving…' : 'Approve'}</button>
        </div>` : null}
        <div class="cc-plan-layout" data-testid="ws-plan-docs">
        <div class="cc-plan-docs">
          ${docCard('og-requirements.md', planDocs.ogreq, 'ogreq')}
          ${docCard('plan.md', planDocs.execplan, 'execplan')}
        </div>
        <div class="cc-plan-table-col" data-testid="ws-plan-table-col">
          <div class="card-title" style="margin-bottom:8px">Per-task planning view</div>
          ${tableSection()}
          ${selectedTask ? html`<div class="cc-plan-detail" data-testid="ws-plan-detail">
            <div class="cc-plan-detail-cell">
              <div class="cc-plan-detail-label">Selected task</div>
              <div data-testid="ws-plan-detail-task">${selectedTask.label || selectedTask.taskKey || '—'}</div>
            </div>
            <div class="cc-plan-detail-cell">
              <div class="cc-plan-detail-label">Status</div>
              <div data-testid="ws-plan-detail-inputs">${selectedTask.status || '—'}</div>
            </div>
            <div class="cc-plan-detail-cell">
              <div class="cc-plan-detail-label">Attempts</div>
              <div data-testid="ws-plan-detail-gate">${typeof selectedTask.attempts === 'number' ? selectedTask.attempts : '—'}</div>
            </div>
          </div>` : null}
        </div>
        </div>
      </div>`;
    };

    // B2 (R2.10/R2.11) + B9/B13: Implementation tab — task rows + every execution status from
    // getCycleRunState / run_tasks (ORDER BY id). No parsePlanTasksClient(plan.md) dependency.
    // hasRun:false → honest empty (not plan-invalid). plan.md still gates Start Implementation only.
    const renderImplementationBody = () => {
      const cycleId = cycle.id;
      const planDocs = ccPlanDocs[cycleId] || {};
      const execDoc = planDocs.execplan;
      const execLoaded = execDoc && execDoc !== 'absent';
      const runState = ccRunState[cycleId];
      const runLoaded = runState && runState !== 'absent';
      const tasks = (runLoaded && runState.hasRun && Array.isArray(runState.tasks))
        ? runState.tasks
        : [];
      // B3: honest failed vs parked. failed is now its own bucket (enables structural stop + parked rarity).
      // deferred remains parked. Supersedes prior 4-bucket comment.
      const bucketForStatus = (s) => (
        s === 'complete' ? 'done' :
        s === 'working' ? 'working' :
        s === 'failed' ? 'failed' :
        s === 'deferred' ? 'parked' : 'pending'
      );
      // Row is already the run_tasks payload — status is first-class, not joined from plan ids.
      const taskState = (t) => bucketForStatus(t.status);
      const taskRowKey = (t) => String(t.taskKey || t.id);
      const formatTaskDuration = (sec) => {
        if (sec == null || sec < 0) return '—';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return m > 0 ? `${m}m ${s}s` : `${s}s`;
      };
      const STATE_META = {
        done: { chip: 'chip-green', marker: 'OK', label: 'done' },
        working: { chip: 'chip-blue', marker: 'RUN', label: 'working' },
        pending: { chip: 'chip-gray', marker: '--', label: 'pending' },
        failed: { chip: 'chip-red', marker: 'FAIL', label: 'failed' },
        parked: { chip: 'chip-orange', marker: '!!', label: 'parked' }
      };
      const counts = tasks.reduce((acc, t) => {
        const s = taskState(t);
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      }, { done: 0, working: 0, pending: 0, failed: 0, parked: 0 });

      // IS-R2 (impl-start): Start Implementation control. Enable condition (quoted in the report):
      //   planReady (valid plan.md exists) AND NOT runActive.
      // - runActive → hide the button, show "Implementation running".
      // - !planReady → button DISABLED with a hint ("Start enables once the plan is ready").
      // - planReady && !runActive → button ENABLED (this is the manual start; NOT gated behind Approve).
      const planReady = execLoaded && execDoc.valid === true;
      const runActive = !!(runState && runState !== 'absent' && runState.hasRun && runState.runActive);
      const implStarting = !!ccImplStarting[cycleId];
      const implStartNotice = ccImplStartNotice[cycleId];
      const startImplRow = html`<div class="cc-impl-start-row" data-testid="ws-impl-start-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0">
        ${runActive
          ? html`<span class="chip chip-blue" data-testid="ws-impl-running">Implementation running</span>`
          : html`<button class="btn btn-primary btn-sm" data-testid="ws-impl-start"
              disabled=${!planReady || implStarting}
              title=${planReady ? 'Start the helm-algo run from this cycle’s plan.md' : 'Start enables once the plan is ready'}
              onclick=${() => startImplementation(cycleId)}>
              ${implStarting ? 'Starting…' : 'Start Implementation'}
            </button>`}
        ${!runActive && !planReady
          ? html`<span class="text-sec" data-testid="ws-impl-start-hint" style="font-size:11px">Start enables once the plan is ready — use Start Planning below.</span>`
          : null}
        ${implStartNotice
          ? html`<span class="text-sec" data-testid="ws-impl-start-notice" style="font-size:11px">${implStartNotice}</span>`
          : null}
      </div>
      ${renderStartPlanningRow('ws-impl')}`;

      // No deploy_target/deploy_env field exists on Cycle (cycle-service.ts) — graceful label,
      // not a fabricated "DEV deploy after batch".
      const deployLabel = 'Deploy target not set';

      const metricsRow = html`<div class="cc-impl-metrics" data-testid="ws-impl-metrics">
        <div class="cc-impl-metric" data-testid="ws-impl-metric-done">
          <div class="cc-impl-metric-value">${counts.done}/${tasks.length}</div>
          <div class="cc-impl-metric-label">done</div>
        </div>
        <div class="cc-impl-metric" data-testid="ws-impl-metric-working">
          <div class="cc-impl-metric-value">${counts.working}</div>
          <div class="cc-impl-metric-label">working</div>
        </div>
        <div class="cc-impl-metric" data-testid="ws-impl-metric-pending">
          <div class="cc-impl-metric-value">${counts.pending}</div>
          <div class="cc-impl-metric-label">pending</div>
        </div>
        <div class="cc-impl-metric" data-testid="ws-impl-metric-failed">
          <div class="cc-impl-metric-value">${counts.failed}</div>
          <div class="cc-impl-metric-label">failed</div>
        </div>
        <div class="cc-impl-metric" data-testid="ws-impl-metric-parked">
          <div class="cc-impl-metric-value">${counts.parked}</div>
          <div class="cc-impl-metric-label">parked</div>
        </div>
        <div class="cc-impl-metric cc-impl-metric-deploy" data-testid="ws-impl-metric-deploy">
          <div class="cc-impl-metric-value">${deployLabel}</div>
        </div>
      </div>`;

      const subtitleFor = (t) => {
        const parts = [t.batch ? `batch ${t.batch}` : null, t.status].filter(Boolean);
        return parts.length ? parts.join(' · ') : '—';
      };
      const refsText = (v) => Array.isArray(v) ? (v.length ? v.join(', ') : '—') : (v ? String(v) : '—');

      // B2/B9/B13: per-task detail from the run_tasks row itself (already the status-bearing record).
      const taskDetail = (t) => {
        if (!t) return { attempts: 'No attempts yet', escalation: 'Not started', duration: '—', commit: '—' };
        const notes = t.validationNotes || [];
        const failNote = [...notes].reverse().find(n => n.result === 'FAIL');
        return {
          attempts: t.attempts > 0 ? `${t.attempts} attempt${t.attempts === 1 ? '' : 's'}` : 'No attempts yet',
          escalation: failNote ? (failNote.note || failNote.result) : (notes.length ? 'No escalation' : 'Not started'),
          duration: formatTaskDuration(t.durationSec),
          commit: t.commit ? (t.commit.sha ? t.commit.sha.slice(0, 7) : t.commit.path) : '—'
        };
      };

      // B9-T03: implementer/validator terminal panes for the running task (R-F6). worker_runtimes
      // has run_id but NO task_id/cycle_id (schema.ts:284), and a single run spans many tasks, so
      // no runtime row can be reliably attributed to THIS task pre-B10 — fetching /terminals here
      // and guessing would risk showing a DIFFERENT task's/cycle's pane, which is a form of fake.
      // taskPanes() is the single seam: shape-compatible with loadTerminal/terminals ({model,
      // content}) so B10 only has to swap this function's body, never the chrome below.
      const runningTask = tasks.find(t => taskState(t) === 'working') || null;
      // LV-R3: pull the live pane text from the ccImplTerm poll (server-derived running worker). ANSI
      // control codes are stripped for the plain monospace panes; empty text → null → placeholder.
      const stripAnsiForPane = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
      const termText = (role) => {
        const e = ccImplTerm[`${cycleId}::${role}`];
        const t = e && e.text ? stripAnsiForPane(e.text) : '';
        return t.trim() ? t : null;
      };
      const taskPanes = (t) => ({
        implementer: { model: (t && (t.taskKey || t.label)) || null, content: termText('implementer') },
        validator: { model: null, content: termText('validator') }
      });
      // Feature 3: a minimized worker collapses to a thin vertical rail; clicking it (or its
      // expand button) restores both panes. Testid ws-impl-term-${role} is preserved in both states.
      const termPaneCollapsed = (role) => html`<div class="cmt-pane cc-impl-pane-rail" data-testid=${`ws-impl-term-${role}`}
        role="button" tabindex="0" title=${`Expand ${role} terminal`} onclick=${() => setCcImplCollapsedPane(null)}>
        <div class="cmt-term-header">
          <button type="button" class="cc-impl-pane-toolbtn" data-testid=${`impl-pane-collapse-${role}`}
            title=${`Expand ${role} terminal`} onclick=${(e) => { e.stopPropagation(); setCcImplCollapsedPane(null); }}>⇔</button>
          <span class="cc-impl-pane-rail-label">${role}</span>
        </div>
      </div>`;
      const termPane = (role, p) => html`<div class="cmt-pane ${p.content ? '' : 'cmt-pane-empty'}" data-testid=${`ws-impl-term-${role}`}>
        <div class="cmt-term-header">
          <div class="cmt-term-title">
            <div class="cmt-term-role">${role}${p.model ? ` - ${p.model}` : ''}</div>
          </div>
          <button type="button" class="cc-impl-pane-toolbtn" data-testid=${`impl-pane-collapse-${role}`}
            title=${`Minimize ${role} pane fully to a rail (manual)`} onclick=${() => setCcImplCollapsedPane(role)}>–</button>
        </div>
        <div class="cmt-term-body" data-testid=${`ws-impl-term-${role}-body`}
          ref=${(el) => {
            implTermBodyRefs.current[role] = el;
            if (el) implTermStickRefs.current[role] = captureStickIntent(el);
          }}
          onscroll=${() => {
            const el = implTermBodyRefs.current[role];
            if (el) implTermStickRefs.current[role] = captureStickIntent(el);
          }}>
          ${p.content
            ? p.content.split(/\r?\n/).map((line, i) => html`<div key=${i} class="cmt-line">${line || ' '}</div>`)
            : html`<div class="text-sec" data-testid=${`ws-impl-term-${role}-empty`}>No live terminal for this task yet.</div>`}
        </div>
      </div>`;
      const termRow = () => {
        const panes = taskPanes(runningTask);
        const manual = ccImplCollapsedPane;   // explicit full-collapse to a rail (overrides auto)
        const autoOn = ccImplAutoFocus;        // dynamic auto-resize on/off
        const active = ccImplActiveWorker;     // live-derived worker that is streaming right now
        // Row-class precedence: manual rail > auto-focus resize > equal 50/50 split.
        let rowCls = '';
        if (manual === 'implementer') rowCls = 'impl-collapsed-implementer';
        else if (manual === 'validator') rowCls = 'impl-collapsed-validator';
        else if (autoOn && active === 'implementer') rowCls = 'impl-focus-implementer';
        else if (autoOn && active === 'validator') rowCls = 'impl-focus-validator';
        // Show both (equal): drop any manual rail AND turn auto-resize off → 50/50.
        const showBothEqual = () => {
          setCcImplCollapsedPane(null);
          setCcImplAutoFocus(false);
          localStorage.setItem('helm_impl_autofocus', '0');
        };
        const focused = autoOn && !manual && active ? active : '';
        return html`<div>
          <div class="cc-impl-term-controls" data-testid="ws-impl-term-controls">
            <span class="text-sec" style="font-size:11px">Workers</span>
            <button type="button" class=${`cc-impl-pane-toolbtn ${autoOn ? 'cc-impl-toolbtn-on' : ''}`.trim()}
              data-testid="impl-pane-focus-active" aria-pressed=${autoOn ? 'true' : 'false'}
              title="Auto-focus: grow whoever is actively working and shrink the idle worker (both stay visible); follows the run live"
              onclick=${toggleImplAutoFocus}>${autoOn ? 'Auto-focus: On' : 'Auto-focus: Off'}</button>
            <button type="button" class="cc-impl-pane-toolbtn" data-testid="impl-pane-show-both"
              title="Show both panes at equal size" onclick=${showBothEqual}>Show both</button>
            ${focused ? html`<span class="text-sec" data-testid="impl-active-worker" style="font-size:11px">· ${focused} active</span>` : null}
          </div>
          <div class=${`cc-impl-term-row ${rowCls}`.trim()} data-testid="ws-impl-term-row" data-active-worker=${focused}>
            ${manual === 'implementer' ? termPaneCollapsed('implementer') : termPane('implementer', panes.implementer)}
            ${manual === 'validator' ? termPaneCollapsed('validator') : termPane('validator', panes.validator)}
          </div>
        </div>`;
      };

      const docsCell = (t) => {
        const rk = taskRowKey(t);
        const key = `${cycleId}::${rk}`;
        const docs = ccImplTaskDocs[key];
        const linkFor = (label, doc) => {
          const loaded = doc && doc !== 'absent';
          return loaded
            ? html`<div><button class="btn btn-sm" data-testid=${`ws-impl-doclink-${rk}-${label}`}
                onclick=${() => openFullScreen('doc', doc.filename || label, doc.content)}>${label}</button></div>`
            : html`<div class="text-sec" data-testid=${`ws-impl-doclink-${rk}-${label}-empty`}>${label}: no docs yet</div>`;
        };
        return html`<div>
          ${linkFor('changes.md', docs && docs.changes)}
          ${linkFor('validation notes', docs && docs.validation)}
        </div>`;
      };

      const toggleExpanded = (t) => {
        const rk = taskRowKey(t);
        const next = ccImplExpandedTaskId === rk ? null : rk;
        setCcImplExpandedTaskId(next);
        if (next) loadImplTaskDocs(cycleId, rk);
      };

      const renderTaskRow = (t) => {
            const state = taskState(t);
            const meta = STATE_META[state];
            const rk = taskRowKey(t);
            const expanded = ccImplExpandedTaskId === rk;
            const detail = taskDetail(t);
            return html`<div key=${t.id}>
              <div class="cc-impl-task-row ${expanded ? 'sel' : ''}" data-testid="ws-impl-task-row" data-task-key=${rk} data-task-status=${t.status}
                onclick=${() => toggleExpanded(t)}>
                <div class="cc-impl-task-marker cc-impl-task-marker-${state}">${meta.marker}</div>
                <div class="cc-impl-task-main">
                  <div class="cc-impl-task-title">${rk} ${t.label || ''}</div>
                  <div class="cc-impl-task-sub text-sec">${subtitleFor(t)}</div>
                </div>
                <div class="cc-impl-task-state"><span class="chip ${meta.chip}">${meta.label}</span></div>
                <div class="cc-impl-task-duration text-sec">${detail.duration}</div>
                <div class="cc-impl-task-commit text-sec">${detail.commit}</div>
              </div>
              ${expanded ? html`<div class="cc-impl-task-detail" data-testid=${`ws-impl-task-detail-${rk}`}>
                <div class="cc-impl-task-detail-strip">
                  <div class="cc-impl-task-detail-cell">
                    <div class="cc-impl-task-detail-label">Key</div>
                    <div data-testid="ws-impl-detail-reqs">${t.taskKey || '—'}</div>
                  </div>
                  <div class="cc-impl-task-detail-cell">
                    <div class="cc-impl-task-detail-label">Batch</div>
                    <div data-testid="ws-impl-detail-deps">${t.batch || '—'}</div>
                  </div>
                  <div class="cc-impl-task-detail-cell">
                    <div class="cc-impl-task-detail-label">Status</div>
                    <div data-testid="ws-impl-detail-gate">${t.status || '—'}</div>
                  </div>
                </div>
                <div class="cc-impl-task-detail-quad">
                  <div class="cc-impl-task-detail-cell">
                    <div class="cc-impl-task-detail-label">Attempts</div>
                    <div data-testid="ws-impl-detail-attempts">${detail.attempts}</div>
                  </div>
                  <div class="cc-impl-task-detail-cell">
                    <div class="cc-impl-task-detail-label">Escalation log</div>
                    <div data-testid="ws-impl-detail-escalation">${detail.escalation}</div>
                  </div>
                  <div class="cc-impl-task-detail-cell">
                    <div class="cc-impl-task-detail-label">Duration</div>
                    <div data-testid="ws-impl-detail-duration">${detail.duration}</div>
                  </div>
                  <div class="cc-impl-task-detail-cell">
                    <div class="cc-impl-task-detail-label">Docs</div>
                    ${docsCell(t)}
                  </div>
                </div>
              </div>` : null}
            </div>`;
      };

      // Feature 4: the task list defaults collapsed to the currently-working task(s); the toggle
      // reveals the full T01..Tnn list. Nothing is lost — the full list is one click away.
      const taskListSection = () => {
        if (!runLoaded) {
          return html`<div class="text-sec" data-testid="ws-impl-list-empty" style="font-size:11px;padding:6px">Loading task rows…</div>`;
        }
        if (!runState.hasRun || tasks.length === 0) {
          return html`<div class="text-sec" data-testid="ws-impl-list-empty" style="font-size:11px;padding:6px">No tasks ingested yet.</div>`;
        }
        const expandedList = ccImplTasklistExpanded;
        const activeTasks = tasks.filter(t => taskState(t) === 'working');
        const visible = expandedList ? tasks : activeTasks;
        return html`<div class="cc-impl-task-list" data-testid="ws-impl-task-list">
          <div class="cc-impl-tasklist-header" data-testid="ws-impl-tasklist-header">
            <span class="text-sec" style="font-size:11px">${expandedList ? `All tasks (${tasks.length})` : (activeTasks.length ? `Active task${activeTasks.length > 1 ? `s (${activeTasks.length})` : ''} · ${counts.done}/${tasks.length} done` : `No task currently working · ${counts.done}/${tasks.length} done`)}</span>
            <button type="button" class="cc-impl-pane-toolbtn" data-testid="impl-tasklist-toggle"
              title=${expandedList ? 'Collapse to the active task' : 'Show the full task list'}
              onclick=${toggleImplTasklist}>${expandedList ? 'Collapse to active' : `Show all ${tasks.length}`}</button>
          </div>
          ${visible.length
            ? visible.map(renderTaskRow)
            : html`<div class="text-sec" data-testid="ws-impl-tasklist-collapsed-empty" style="font-size:11px;padding:8px">No task is currently working. <button type="button" class="cc-impl-pane-toolbtn" onclick=${toggleImplTasklist}>Show all ${tasks.length}</button></div>`}
        </div>`;
      };

      // B9-T04: collapsed-by-default Docs rail on the right (R-F6) — reuses the cycle's real
      // artifacts (B3-T03 API, loaded above into ccDiscArtifacts) and the openFullScreen viewer.
      // Per-task nested docs (tasks/<id>/*.md) don't resolve pre-B10 (same gap as taskDetail()
      // above) — the rail intentionally shows only the cycle-level docs/flow artifacts that do.
      const railArtifacts = ccDiscArtifacts[cycleId] || {};
      const railItems = [...(railArtifacts.docs || []), ...(railArtifacts.flow || [])];
      const railTaskRef = runningTask ? `tasks/${taskRowKey(runningTask)}` : null;
      const openRailDoc = async (f) => {
        const doc = await loadDiscDoc(cycleId, f.path);
        if (doc) openFullScreen('doc', doc.filename || f.name, doc.content);
      };
      const docsRail = !ccImplDocsRailOpen
        ? html`<div class="cc-disc-rail cc-impl-docs-rail" data-testid="ws-impl-docs-rail" role="button" tabindex="0"
            onclick=${() => setCcImplDocsRailOpen(true)}>
            <span class="cc-disc-rail-label">Docs collapsed</span>
            ${railTaskRef ? html`<span class="cc-impl-docs-rail-task text-sec" data-testid="ws-impl-docs-rail-task">${railTaskRef}</span>` : null}
            <button class="btn btn-sm" data-testid="ws-impl-docs-expand" onclick=${(e) => { e.stopPropagation(); setCcImplDocsRailOpen(true); }}>Expand</button>
          </div>`
        : html`<div class="cc-disc-pane cc-impl-docs-pane" data-testid="ws-impl-docs-pane">
            <div class="cc-disc-pane-header">
              <span>Docs</span>
              <button class="btn btn-sm" data-testid="ws-impl-docs-collapse" onclick=${() => setCcImplDocsRailOpen(false)}>Collapse</button>
            </div>
            <div class="cc-impl-docs-list" data-testid="ws-impl-docs-list">
              ${railItems.length
                ? railItems.map(f => html`<div class="cc-disc-doc-item" key=${f.path} data-testid=${`ws-impl-doc-${f.name}`}
                    onclick=${() => openRailDoc(f)}>${f.name}</div>`)
                : html`<div class="text-sec" data-testid="ws-impl-docs-empty" style="font-size:11px;padding:6px">No docs yet.</div>`}
            </div>
          </div>`;

      return html`<div class="cc-impl-split" data-testid="ws-impl-wrap">
        <div class="cc-impl-main">
          ${startImplRow}
          ${metricsRow}
          ${termRow()}
          ${taskListSection()}
        </div>
        ${docsRail}
      </div>`;
    };

    // B11-T04: Final Tests tab — 6 sections over the single GET /api/cycles/:id/final-tests-status
    // payload (R-G3). Real data per section when the underlying artifact exists; graceful empty
    // text otherwise. TestResult (final-test-service.ts) carries only {success, note} — no pass/
    // fail counts — so unlike the v2-05 mockup's illustrative "18/18"/"41/42", the smoke/e2e cards
    // show a real pass/fail chip + the real cmd/note text (same honest-gap precedent as B9's
    // deployLabel graceful substitute above). Single seam: this function is the only place that
    // reads ccFinalTestsStatus, so a later batch (B11-T05 cycle-complete) only has to enrich the
    // endpoint payload, never this render.
    const renderFinalTestsBody = () => {
      const cycleId = cycle.id;
      const raw = ccFinalTestsStatus[cycleId];
      const loaded = raw && raw !== 'absent';
      const data = loaded ? raw : {};
      const completion = data.completion || null;
      const smoke = data.smoke || null;
      const e2e = data.e2e || null;
      const runHistory = data.runHistory || [];
      const deploys = data.deploys || [];
      const historyCycles = data.historyCycles || [];
      const recurrencePause = data.recurrencePause || null;

      const banner = completion
        ? html`<div class="cc-ft-banner" data-testid="ws-ft-banner">
            <div class="cc-ft-banner-main">
              <div class="cc-ft-banner-title">Cycle complete after auto-fix loop</div>
              <div class="cc-ft-banner-sub text-sec" data-testid="ws-ft-banner-sub">
                ${completion.tasksDone}/${completion.tasksTotal} tasks complete${completion.parked ? `, ${completion.parked} parked non-blocking` : ''}
              </div>
            </div>
            <span class="chip chip-green" data-testid="ws-ft-banner-chip">ready for review</span>
          </div>`
        : html`<div class="text-sec" data-testid="ws-ft-banner-empty" style="font-size:11px;padding:6px">Cycle not complete yet.</div>`;

      const resultCard = (title, testid, res) => html`<div class="cc-ft-card" data-testid=${testid}>
        <div class="cc-ft-card-head">
          <div class="cc-ft-card-title">${title}</div>
          ${res ? html`<span class="chip ${res.success ? 'chip-green' : 'chip-red'}" data-testid=${`${testid}-chip`}>${res.success ? 'passed' : 'failed'}</span>` : null}
        </div>
        ${res
          ? html`<div class="cc-ft-card-body">
              <div class="cc-ft-card-cmd text-sec" data-testid=${`${testid}-cmd`}>$ ${res.cmd}</div>
              <div class="cc-ft-card-note" data-testid=${`${testid}-note`}>${res.note}</div>
            </div>`
          : html`<div class="text-sec" data-testid=${`${testid}-empty`} style="font-size:11px;padding:6px">No final-test run yet.</div>`}
      </div>`;

      const deployHistory = html`<div class="cc-ft-side-box" data-testid="ws-ft-deploy-history">
        <div class="cc-ft-side-box-title">Batch DEV deploy history</div>
        ${deploys.length
          ? html`<table class="cc-ft-table" data-testid="ws-ft-deploy-table">
              <thead><tr><th>Batch</th><th>URL</th><th>Status</th></tr></thead>
              <tbody>
                ${deploys.map((d, i) => html`<tr key=${i}>
                  <td>${d.batch}</td>
                  <td class="cc-ft-table-url">${d.url}</td>
                  <td><span class="chip ${d.status === 'passed' ? 'chip-green' : 'chip-red'}">${d.status}</span></td>
                </tr>`)}
              </tbody>
            </table>`
          : html`<div class="text-sec" data-testid="ws-ft-deploy-empty" style="font-size:11px;padding:6px">No deploys yet.</div>`}
      </div>`;

      const runHistoryTable = html`<div class="cc-ft-main-box" data-testid="ws-ft-run-history">
        <div class="cc-ft-side-box-title">Final-test run history</div>
        ${runHistory.length
          ? html`<table class="cc-ft-table" data-testid="ws-ft-run-history-table">
              <thead><tr><th>Check</th><th>Env</th><th>First run</th><th>Loop result</th><th>Spawned task</th></tr></thead>
              <tbody>
                ${runHistory.map((r, i) => html`<tr key=${i}>
                  <td>${r.check}</td>
                  <td>${r.env}</td>
                  <td><span class="chip ${r.firstRun === 'passed' ? 'chip-green' : 'chip-red'}">${r.firstRun}</span></td>
                  <td><span class="chip ${r.loopResult === 'cleared' ? 'chip-green' : 'chip-gray'}">${r.loopResult}</span></td>
                  <td>${r.spawnedTask ? html`<span class="cc-ft-spawned-link">${r.spawnedTask}</span>` : '—'}</td>
                </tr>`)}
              </tbody>
            </table>`
          : html`<div class="text-sec" data-testid="ws-ft-run-history-empty" style="font-size:11px;padding:6px">No final-test run yet.</div>`}
        <div class="cc-ft-cli" data-testid="ws-ft-cli">
          ${smoke ? html`<div>$ ${smoke.cmd}</div><div>${smoke.note}</div>` : null}
          ${e2e ? html`<div>$ ${e2e.cmd}</div><div>${e2e.note}</div>` : null}
          ${recurrencePause ? html`<div class="cc-ft-cli-pause" data-testid="ws-ft-recurrence-pause">${recurrencePause.note}</div>` : null}
          ${!smoke && !e2e && !recurrencePause ? html`<div class="text-sec" data-testid="ws-ft-cli-empty">No output yet.</div>` : null}
        </div>
      </div>`;

      const historyStrip = html`<div class="cc-ft-side-box" data-testid="ws-ft-history-strip">
        <div class="cc-ft-side-box-title">History strip</div>
        ${historyCycles.length
          ? html`<div class="cc-ft-history-list" data-testid="ws-ft-history-list">
              ${historyCycles.map(h => html`<div class="cc-ft-history-item" key=${h.id} data-testid=${`ws-ft-history-${h.id}`}>
                <span>${h.name}</span>
                <span class="chip chip-green">complete</span>
              </div>`)}
            </div>`
          : html`<div class="text-sec" data-testid="ws-ft-history-empty" style="font-size:11px;padding:6px">No completed cycles yet.</div>`}
      </div>`;

      return html`<div class="cc-ft-split" data-testid="ws-ft-wrap">
        <div class="cc-ft-main">
          ${banner}
          <div class="cc-ft-cards-row">
            ${resultCard('Local smoke', 'ws-ft-smoke-card', smoke)}
            ${resultCard('DEV e2e authoritative', 'ws-ft-e2e-card', e2e)}
          </div>
          ${runHistoryTable}
        </div>
        <div class="cc-ft-side">
          ${deployHistory}
          ${historyStrip}
        </div>
      </div>`;
    };

    return html`<div key="cc-workspace" data-testid="content-cmd-workspace">
      <div class="cc-ws-header">
        <button class="btn btn-sm" data-testid="ws-back" onclick=${ccCloseWorkspace}>← Back</button>
        <div class="cc-ws-title" data-testid="ws-title">${(proj && proj.name) || cycle.project_name} / ${cycle.name}</div>
        <div class="cc-ws-actions">
          <div class="cc-ws-autonomy-wrap">
            <button type="button" class="chip ${autonomyBadge.chip} cc-ws-autonomy-badge" data-testid="ws-autonomy-badge"
              onclick=${() => setCcWsAutonomyOpen(!ccWsAutonomyOpen)}>${autonomyBadge.label}</button>
            ${ccWsAutonomyOpen ? html`<div class="cc-ws-autonomy-menu" data-testid="ws-autonomy-menu">
              <div class="cc-ws-autonomy-title">Autonomy — this cycle</div>
              ${autonomyLocked ? html`
                <div class="text-sec" style="font-size:11px;margin:6px 0" data-testid="ws-autonomy-locked-note">Locked — implementation started.</div>
                <div class="chip ${autonomyBadge.chip}" data-testid="ws-autonomy-locked-value">${autonomyBadge.label}</div>
              ` : html`
                <div class="chip chip-orange cc-ws-autonomy-note" data-testid="ws-autonomy-editable-note">editable until Implementation starts</div>
                <div class="text-sec cc-ws-autonomy-hint" data-testid="ws-autonomy-inherited-hint">Inherited from Project Setup default.</div>
                <label class="cc-nc-radio ${cycle.autonomy === 'autonomous_after_discovery' ? 'sel' : ''}">
                  <input type="radio" name="ws-autonomy" data-testid="ws-autonomy-full" value="autonomous_after_discovery"
                    checked=${cycle.autonomy === 'autonomous_after_discovery'} disabled=${ccWsAutonomySaving}
                    onchange=${() => ccSetCycleAutonomy(cycle.id, 'autonomous_after_discovery')} />
                  <div>
                    <div class="cc-nc-radio-title">Fully autonomous after Discovery</div>
                    <div class="cc-nc-radio-sub text-sec">Implementation begins automatically after planning.</div>
                  </div>
                </label>
                <label class="cc-nc-radio ${cycle.autonomy === 'pause_after_planning' ? 'sel' : ''}">
                  <input type="radio" name="ws-autonomy" data-testid="ws-autonomy-pause" value="pause_after_planning"
                    checked=${cycle.autonomy === 'pause_after_planning'} disabled=${ccWsAutonomySaving}
                    onchange=${() => ccSetCycleAutonomy(cycle.id, 'pause_after_planning')} />
                  <div>
                    <div class="cc-nc-radio-title">Pause after Planning for my approval</div>
                    <div class="cc-nc-radio-sub text-sec">${cycle.phase === 'planning' ? 'Current cycle is waiting here.' : 'Implementation waits for your approval.'}</div>
                  </div>
                </label>
                ${ccWsAutonomyErr ? html`<div class="text-sec" data-testid="ws-autonomy-error" style="font-size:11px;color:var(--danger);padding:4px 0">${ccWsAutonomyErr}</div>` : null}
              `}
            </div>` : null}
          </div>
          ${ccWsTab === 'implementation' ? html`<button type="button" class="btn btn-sm btn-danger" data-testid="ws-graceful-stop"
            onclick=${() => requestGracefulStop(cycle.id)}>Graceful Stop</button>` : null}
          <div class="cc-ws-switcher-wrap">
            <button class="btn btn-sm" data-testid="ws-cycle-switcher-btn" onclick=${() => setCcWsSwitcherOpen(!ccWsSwitcherOpen)}>Cycle switcher</button>
            ${ccWsSwitcherOpen ? html`<div class="cc-ws-switcher-menu" data-testid="ws-cycle-switcher-menu">
              ${cycles.map(c => {
                const meta = CC_PHASE_META[c.phase] || { label: c.phase, chip: 'chip-gray' };
                return html`<button type="button" class=${`cc-ws-switcher-item ${c.id === cycle.id ? 'sel' : ''}`} key=${c.id}
                  data-testid=${`ws-cycle-switcher-item-${c.id}`}
                  onclick=${() => ccOpenWorkspace(ccWsProjectId, c.id, c.phase)}>
                  <span>${c.name}</span>
                  <span class="chip ${meta.chip}">${meta.label}</span>
                </button>`;
              })}
            </div>` : null}
          </div>
        </div>
        ${ccWsTab === 'implementation' ? html`<div class="cc-ws-impl-subtitle text-sec" data-testid="ws-impl-subtitle">${implementationSubtitle()}</div>` : null}
        ${ccWsTab === 'implementation' && ccGracefulStopNote[cycle.id] ? html`<div class="cc-ws-impl-subtitle text-sec" data-testid="ws-graceful-stop-note">${ccGracefulStopNote[cycle.id]}</div>` : null}
      </div>

      <div class="tab-strip" data-testid="ws-phase-tabs">
        ${CC_WORKSPACE_TABS.map(t => html`<div class=${`tab ${ccWsTab === t.key ? 'active' : ''}`} key=${t.key}
          data-testid=${`ws-tab-${t.key}`} onclick=${() => setCcWsTab(t.key)}>${t.label}</div>`)}
      </div>

      <div key=${activeTabDef.key} class="cc-ws-body ${activeTabDef.key === 'discovery' ? 'cc-ws-body-disc' : ''}" data-testid=${`ws-body-${activeTabDef.key}`}>
        ${activeTabDef.key === 'discovery' ? renderDiscoveryBody()
          : activeTabDef.key === 'planning' ? renderPlanningBody()
          : activeTabDef.key === 'implementation' ? renderImplementationBody()
          : activeTabDef.key === 'final_tests' ? renderFinalTestsBody()
          : html`${activeTabDef.label} — lands in ${activeTabDef.lands}.`}
      </div>
    </div>`;
  };

  const renderCommandCenterOverview = () => {
    const counts = (ccOvData && ccOvData.counts) || { pending: 0, active: 0, completed: 0 };
    const buckets = [
      { key: 'active', label: 'Active' },
      { key: 'pending', label: 'Pending (not started)' },
      { key: 'completed', label: 'Completed' }
    ];
    // B5-T04: R-E3 gate-mode cycle sitting in planning phase = genuinely waiting on JROM's approval to
    // advance to implementation — the only real "waiting on you" signal available today. Parked-task
    // contribution (R-F5) has no data source yet — wires in fully at B10.
    const needCount = [...(ccOvData?.pending || []), ...(ccOvData?.active || [])]
      .filter(c => c.autonomy === 'pause_after_planning' && c.phase === 'planning').length;
    const bucketCount = counts[ccOvBucket] || 0;
    const bucketRows = (ccOvData && ccOvData[ccOvBucket]) || [];
    const projectById = new Map((projectsList || []).map(p => [p.id, p]));
    return html`<div key="cc-overview" data-testid="content-cmd-overview">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap">
        <div>
          <div style="font-size:18px;font-weight:700;color:var(--text)" data-testid="ov-title">All project cycles</div>
          <div class="text-sec" style="font-size:12px;margin-top:2px">Current phase, waits, environment health, recent completions, and agent usage.</div>
        </div>
        <div style="display:flex;gap:8px;flex:0 0 auto">
          <button class="btn btn-sm" data-testid="ov-usage-details-btn">Usage details</button>
          <button class="btn btn-sm btn-primary" data-testid="ov-new-cycle-btn" onclick=${ccOpenNewCycle}>New Cycle</button>
        </div>
      </div>

      ${ccNcOpen ? html`<div class="cc-nc-scrim" data-testid="ov-new-cycle-scrim" onclick=${ccCloseNewCycle}>
        <div class="cc-nc-dialog" data-testid="ov-new-cycle-dialog" onclick=${(e) => e.stopPropagation()}>
          <div class="cc-nc-head">
            <div class="cc-nc-title">New Cycle</div>
            <span class="chip chip-blue">Discovery start</span>
          </div>

          <label class="cc-nc-label">Cycle name</label>
          <input type="text" data-testid="ov-nc-name" placeholder="Cycle name" value=${ccNcName}
            oninput=${(e) => setCcNcName(e.target.value)} />

          <label class="cc-nc-label">Project</label>
          <select data-testid="ov-nc-project" value=${ccNcProjectId ?? ''} onchange=${(e) => ccSelectNewCycleProject(e.target.value)}>
            ${(projectsList || []).map(p => html`<option value=${p.id} key=${p.id}>${p.name}</option>`)}
          </select>
          ${(() => {
            const proj = (projectsList || []).find(p => String(p.id) === String(ccNcProjectId));
            if (!proj) return null;
            const badge = ccAutonomyBadge(proj.autonomy_default);
            return html`<div class="cc-nc-inherit" data-testid="ov-nc-inherit-hint">
              <span>Selected project: ${proj.name}</span>
              <span class="chip ${badge.chip}">default: ${badge.label}</span>
            </div>`;
          })()}
          <div class="text-sec cc-nc-note">Autonomy setting inherited from Project Setup, editable for this cycle</div>

          <label class="cc-nc-radio ${ccNcAutonomy === 'autonomous_after_discovery' ? 'sel' : ''}">
            <input type="radio" name="cc-nc-autonomy" data-testid="ov-nc-autonomy-full" value="autonomous_after_discovery"
              checked=${ccNcAutonomy === 'autonomous_after_discovery'} onchange=${() => setCcNcAutonomy('autonomous_after_discovery')} />
            <div>
              <div class="cc-nc-radio-title">Fully autonomous after Discovery</div>
              <div class="text-sec cc-nc-radio-sub">Planning starts after Discovery and Implementation starts when plan is ready.</div>
            </div>
          </label>
          <label class="cc-nc-radio ${ccNcAutonomy === 'pause_after_planning' ? 'sel' : ''}">
            <input type="radio" name="cc-nc-autonomy" data-testid="ov-nc-autonomy-pause" value="pause_after_planning"
              checked=${ccNcAutonomy === 'pause_after_planning'} onchange=${() => setCcNcAutonomy('pause_after_planning')} />
            <div>
              <div class="cc-nc-radio-title">Pause after Planning for my approval</div>
              <div class="text-sec cc-nc-radio-sub">Cycle waits on og-requirements.md and plan.md approval.</div>
            </div>
          </label>

          ${ccNcError ? html`<div class="text-sec" data-testid="ov-nc-error" style="font-size:12px;color:var(--danger);padding:4px 0">${ccNcError}</div>` : null}

          <div class="cc-nc-actions">
            <button class="btn btn-sm" data-testid="ov-nc-cancel" onclick=${ccCloseNewCycle}>Cancel</button>
            <button class="btn btn-sm btn-primary" data-testid="ov-nc-submit" disabled=${ccNcSubmitting || !ccNcName.trim() || !ccNcProjectId} onclick=${ccSubmitNewCycle}>Start Discovery</button>
          </div>
        </div>
      </div>` : null}

      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <div class="ov-seg-tabs" data-testid="ov-seg-tabs">
          ${buckets.map(b => html`<button
            type="button"
            class=${`ov-seg-tab ${ccOvBucket === b.key ? 'active' : ''}`}
            data-testid=${`ov-tab-${b.key}`}
            onclick=${() => setCcOvBucket(b.key)}
          >${b.label} <span class="ov-seg-badge">${counts[b.key] || 0}</span></button>`)}
        </div>
        <span class="chip chip-orange" data-testid="ov-attention">${needCount} need you</span>
      </div>

      ${ccOvError ? html`<div class="text-sec" data-testid="ov-error" style="font-size:12px;color:var(--danger);padding:6px 0">Couldn't load cycles: ${ccOvError}</div>` : null}
      ${ccOvLoading && !ccOvData ? html`<div class="text-sec" data-testid="ov-loading" style="font-size:12px;padding:6px 0">Loading cycles…</div>` : null}

      <div data-testid="ov-board" style="min-height:120px">
        ${!ccOvLoading && !ccOvError ? (
          bucketCount === 0
            ? html`<div class="text-sec" data-testid="ov-empty" style="font-size:12px;padding:16px 0">No ${ccOvBucket} cycles yet.</div>`
            : ccOvBucket === 'completed'
              ? html`<div class="cc-hist-list" data-testid="ov-hist-list">
                  ${bucketRows.map(row => html`<div class="cc-hist-row" key=${row.id} data-testid=${`ov-hist-row-${row.id}`}
                    onclick=${() => ccOpenWorkspace(row.project_id, row.id, row.phase)}>
                    <span class="cc-hist-project">${row.project_name}</span>
                    <span class="cc-hist-name">${row.name}</span>
                    <span class="chip chip-gray">${(CC_PHASE_META[row.phase] || { label: row.phase }).label}</span>
                    <span class="text-sec cc-hist-date">${row.created_at}</span>
                  </div>`)}
                </div>`
              : html`<div class="cc-cards-grid" data-testid="ov-cards-grid">
                  ${ccGroupCyclesByProject(bucketRows).map(group => {
                    const proj = projectById.get(group.project_id);
                    const primary = group.cycles[0];
                    const autonomyBadge = ccAutonomyBadge(primary.autonomy);
                    return html`<div class="cc-card" key=${group.project_id} data-testid=${`ov-card-${group.project_id}`}
                      onclick=${() => ccOpenWorkspace(group.project_id, primary.id, primary.phase)}>
                      <div class="cc-card-head">
                        <div>
                          <div class="cc-card-title" data-testid="ov-card-name">${group.project_name}</div>
                          ${proj && proj.description ? html`<div class="cc-card-desc">${proj.description}</div>` : null}
                        </div>
                        <span class="chip ${autonomyBadge.chip}" data-testid="ov-card-autonomy">${autonomyBadge.label}</span>
                      </div>
                      <div class="cc-card-chips" data-testid="ov-card-chips">
                        ${group.cycles.map(c => {
                          const meta = CC_PHASE_META[c.phase] || { label: c.phase, chip: 'chip-gray' };
                          return html`<span class="chip ${meta.chip}" key=${c.id} title=${c.name}>${meta.label}</span>`;
                        })}
                      </div>
                      ${primary.progress ? html`<div class="cc-card-progress" data-testid="ov-card-progress">
                        <span class="text-sec">${primary.progress.done}/${primary.progress.total} tasks done</span>
                        ${primary.blocked ? html`<span class="chip chip-orange" data-testid="ov-card-blocked">BLOCKED</span>` : null}
                      </div>` : null}
                      <!-- recent-completions: no data source yet (B10) — omitted, not faked. -->
                      <div class="cc-card-foot">
                        <span class="text-sec cc-card-created">Created ${primary.created_at}</span>
                        <div class="cc-card-env" data-testid="ov-card-env">
                          <span class="cc-env-dot ${proj && proj.dev_url ? 'on' : ''}"></span><span class="text-sec">DEV</span>
                          <span class="cc-env-dot ${proj && proj.qa_url ? 'on' : ''}"></span><span class="text-sec">QA</span>
                        </div>
                      </div>
                      <!-- Per-provider usage meter: no data source yet (B10) — omitted, not faked. -->
                    </div>`;
                  })}
                </div>`
        ) : null}
      </div>
    </div>`;
  };

  const renderCommandCenter = (slug) => {
    if (slug === '07-command-center-chat') {
    const pid = ccCurrentId;
    const raw = ccMessages[pid] || [];
    // CC-CHAT-2 R3: the run conversation is first-class — server-merged coordinator callbacks
    // The shared Helm PM face plus worker status lines render alongside owner/master bubbles.
    const chatOnly = raw.filter(m => String(m.batch_id || '').startsWith(`chat-${pid}`) && (m.role === 'owner' || m.role === 'master' || m.role === 'helm-pm' || m.run_cb));
    const term = ccTerminal[pid] || { session: null, content: '' };
    const run = runByPid[pid] || null;
    // CC-CHAT-1 B3: session-chat derived state (Studio parity)
    const ccSess = ccSession[pid] || null;
    const ccSessOn = !!(ccSess && ccSess.sid);
    const ccConnecting = !!ccSessConnecting[pid];
    const showChat = ccSessOn ? true : ccViewMode !== 'terminal';
    const showTerm = ccSessOn ? false : ccViewMode !== 'chat';
    // A3 gate fix (post-reject): show Run view for ANY run record ... 
    // G1 correction: active agent-chat session takes precedence in split terminal over run timeline (even stale/terminal run)
    const showRun = !!run && !ccSessOn;
    const runActive = !!(run && !isTerminalPhase(run.phase));
    const canChat = ccSessOn || runActive;
    const selAid = ccSelectedAgentId[pid] || '';
    const sessAgentRow = ccSess ? (ccAgents[pid] || []).find(x => x.agent_id === ccSess.agentId) : null;
    const sessAgentName = (sessAgentRow && sessAgentRow.agent && sessAgentRow.agent.name) || 'agent';
    const idle = (projectsList || []).filter(p => !ccOpenTabs.includes(p.id));
    const tabEls = ccOpenTabs.map(id => {
      const p = (projectsList || []).find(x => x.id == id) || { name: String(id) };
      const act = id === pid;
      return html`<div class=${`project-tab ${act?'active':''}`} data-testid=${`project-tab-${id}`} onclick=${() => setCcCurrentId(id)}>${p.name} <span class="close" onclick=${e=>closeCcTab(id,e)}>×</span></div>`;
    });
    // B11 slice 1: true 3-col shell (left project selector sidebar | chat bubbles w/ pinned composer | terminal live feed).
    // 3-way toggle retained (split=all cols; chat-only hides term col; terminal-only hides chat col). Left selector always visible.
    // Bubbles enhanced (telegram/viber rounded style). Composer in footer of chat col (pinned bottom of that col).
    // All data real (ccMessages from /chat events, term from /terminal capture of active master tmux pane via master_runtimes).
    // Desktop 3-col; mobile compact via CSS. Reuses existing state/effects/SSE/poll/send/switch/3way. Added testids for UI-PROOF.
    return html`<div data-testid="content-cmd-chat">
      <div class="card" style="padding:0;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius);">
        <div class="chat-top" style="padding:5px 8px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;background:var(--surface-2);">
          <div style="flex:1;min-width:0;">
            <div class="project-tabs" style="flex-wrap:wrap;">${tabEls.length ? tabEls : html`<span class="text-sec" style="font-size:10px">no open tabs</span>`}</div>
          </div>
          <div>
            <span class="chip warning" style="font-size:9px">● gate</span>
            ${ccSessOn ? null : html`<div class="view-toggle" data-testid="cc-3way-toggle" style="vertical-align:middle;margin-left:4px;">
              <button class=${ccViewMode==='split'?'active':''} onclick=${()=>setCcView('split')} data-testid="cc-3way-split">Split</button>
              <button class=${ccViewMode==='chat'?'active':''} onclick=${()=>setCcView('chat')} data-testid="cc-3way-chat">Chat only</button>
              <button class=${ccViewMode==='terminal'?'active':''} onclick=${()=>setCcView('terminal')} data-testid="cc-3way-terminal">Terminal only</button>
            </div>`}
          </div>
        </div>

        <div class=${`cc-3col cc-view-${ccViewMode}`} data-testid="cc-3col">
          <!-- left: sidebar / project selector (persistent) -->
          <div class="cc-col cc-col-left" data-testid="cc-col-left">
            <div class="cc-col-header" style="justify-content:space-between;"><span>Projects</span><span class="text-sec" style="font-size:9px">${(projectsList||[]).length} total</span></div>
            <div class="cc-col-body cc-proj-list">
              ${(ccOpenTabs||[]).length ? ccOpenTabs.map(id => {
                const p = (projectsList || []).find(x => x.id == id) || { name: String(id), id };
                const act = id === pid;
                return html`<div class=${`cc-proj-item ${act ? 'active' : ''}`} data-testid=${`cc-proj-item-${id}`} onclick=${() => setCcCurrentId(id)}>
                  <span style="flex:1;">${p.name || id}</span>
                  <span class="close" style="font-size:9px;border:1px solid var(--border);border-radius:50%;width:12px;height:12px;line-height:10px;text-align:center;color:var(--text-sec);" onclick=${e=>{e.stopPropagation(); closeCcTab(id,e);}}>×</span>
                </div>`;
              }) : html`<div class="text-sec" style="font-size:10px;padding:3px 2px">— open from setup or idle below —</div>`}
              <div style="margin-top:4px;padding-top:3px;border-top:1px solid var(--border);">
                <select style="width:100%;font-size:10px;padding:2px 3px;background:var(--surface-2);border:1px solid var(--border);border-radius:3px;" onchange=${e=>{const v=Number(e.target.value);if(v){openCcTab(v); e.target.value='';}}}>
                  <option value="">+ open idle…</option>
                  ${idle.map(p => html`<option value=${p.id}>${p.name || p.id}</option>`)}
                </select>
              </div>
            </div>
          </div>

          <!-- middle: chat bubbles + composer pinned at bottom of this col -->
          <div class="cc-col cc-col-chat" data-testid="cc-col-chat" style=${showChat ? '' : 'display:none'}>
            <div class="cc-col-header">Chat <span class="text-sec" style="font-size:9px">(${pid ? 'proj-'+pid : '—'})</span></div>
            ${ (runByPid[pid] && isTerminalPhase(runByPid[pid].phase)) ? html`<div data-testid="close-on-complete-banner" style="background:var(--surface-2);border:1px solid var(--border);padding:4px 6px;font-size:10px;margin:2px 4px;border-radius:4px">Run complete. Close phase-brain session? <button data-testid="close-phase-brain-confirm-btn" class="btn btn-sm" style="padding:1px 4px;font-size:9px" onclick=${forceCloseMaster}>Close now</button></div>` : null }
            <div class="cc-col-body cc-chat-scroll" data-testid="chat-pane">
              ${ccDeliveryGap[pid] ? html`<div data-testid="cc-delivery-gap" style="color:#d29922;font-size:10px;padding:3px 6px;">⚠ some delivery statuses may be incomplete — reload to re-sync.</div>` : null}
              ${ccGlobalLossWarn ? html`<div data-testid="cc-loss-warn" style="color:#f85149;font-size:10px;padding:3px 6px;">⚠ delivery-status notifications were dropped under load — some sent messages' status is uncertain. <button class="btn btn-sm" style="padding:0 4px;font-size:9px" onclick=${ccAckGlobalLoss}>Dismiss</button></div>` : null}
              ${chatOnly.length ? chatOnly.map(m => {
                const isO = m.role === 'owner';
                const txt = (m.body && m.body.text) || m.text || '';
                // A14 (D8/R4.31): the server now sends the TRUE resolved role (plancore/ibrain/
                // discovery/coord, or the honest 'helm_pm' fallback when dispatch context can't
                // disambiguate) — never a literal internal-role/model mask. Phase-brain roles still
                // render as the full agent bubble below; everything else (implementer/validator/
                // panelist/reviewer/...) renders as a COMPACT muted status bubble with a role chip.
                const isBrainRole = ['plancore', 'ibrain', 'discovery', 'coord', 'helm_pm'].includes(m.role);
                if (m.run_cb && !isBrainRole) {
                  const stCls = /DONE|PASS|READY/i.test(m.state||'') ? 'success' : /FAIL|BLOCKED/i.test(m.state||'') ? 'warning' : 'info';
                  return html`<div class="cc-bubble" data-testid="chat-status-message" style="opacity:.72;padding:3px 8px;font-size:10px;max-width:92%;">
                    <span class="chip" style="font-size:8px;padding:0 4px;margin-right:3px;">${m.role}</span>
                    <span class="chip ${stCls}" style="font-size:8px;padding:0 4px;">${m.state || ''}</span>
                    <span style="margin-left:4px;color:var(--text-sec);">${String(txt).slice(0,180)}</span>
                  </div>`;
                }
                // Human-facing label: true role, plus the actual model when the dispatch window
                // resolved one (A14 — "true internal role + actual model", never a bare face mask).
                const brainModel = m.run_cb && m.body && m.body.model;
                const who = isO ? 'JROM' : (brainModel ? `${m.role || 'master'} (${brainModel})` : (m.role || 'master'));
                const sm = txt.match(/(STATUS:\s*\w+|✓\s*APPROVED-PLAN|●\s*gate pending|APPROVED-PLAN|DONE|BLOCKED)/i);
                // Run coordinator bubbles carry a real state — chip it; else fall back to text sniff.
                const stateChip = m.run_cb && m.state ? html`<span class="chip ${/DONE|READY|PASS/i.test(m.state)?'success':/WORKING|PLANNING|DECIDING/i.test(m.state)?'info':'warning'}" style="font-size:8px;padding:0 3px;">${m.state}</span>` : (sm ? html`<span class="chip ${/DONE|APPROVED/i.test(sm[0])?'success':/WORKING|PROPOSED/i.test(sm[0])?'info':'warning'}" style="font-size:8px;padding:0 3px;">${sm[0]}</span>` : null);
                // CC-CHAT-2 R7: failed-delivery hint (backend patches delivered:false when the run
                // session didn't accept the message).
                const failedDeliver = isO && m.body && m.body.delivered === false;
                return html`<div class=${`cc-bubble ${isO ? 'user' : ''}`} data-testid="chat-message">
                  <span class="who">${who}</span>
                  <div>${txt}</div>
                  <div class="meta">${stateChip} ${failedDeliver ? html`<span data-testid="chat-deliver-failed" style="color:#f85149;font-size:8px;">⚠ not delivered to run session</span>` : null} ${m.ts ? new Date(m.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''}</div>
                </div>`;
              }) : ((ccThread[pid]||[]).length ? null : html`<div class="text-sec" style="padding:6px;font-size:11px">No messages yet. ${runActive ? 'Composer talks to the active run.' : 'Toggle Session On to chat with a project agent.'}</div>`)}
              ${(ccThread[pid]||[]).map(m => {
                // CC-CHAT-1 B3: live agent-chat session bubbles (Studio reply pipeline over the fenced session)
                const isU = m.role === 'user';
                return html`<div class=${`cc-bubble ${isU ? 'user' : ''}`} data-testid=${isU ? 'chat-message' : 'cc-chat-bubble-agent'} key=${m.id}>
                  <span class="who">${isU ? 'JROM' : sessAgentName}</span>
                  ${m.thinking
                    ? html`<div class="text-sec" data-testid="cc-chat-thinking" style="font-style:italic">reply streaming below…</div>`
                    : html`<div style="white-space:pre-wrap">${m.text}</div>`}
                  ${m.fallback ? html`<div class="text-sec" style="font-size:9px" title="Agent didn't wrap its reply in the Helm reply markers — showing raw output.">⚠ unstructured reply</div>` : null}
                  ${m.role === 'user' && m.delivered === false ? html`<span data-testid="cc-chat-deliver-failed" style="color:#f85149;font-size:8px;">⚠ not delivered</span>` : null}
                  <div class="meta">${m.ts ? new Date(m.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''}</div>
                </div>`;
              })}
              ${ccSessOn ? renderCcLiveReply(pid, sessAgentName, term.content) : null}
            </div>
            <div class="cc-col-footer cc-composer" data-testid="cc-composer-pinned">
              <div style="display:flex;gap:4px;margin-bottom:3px;align-items:center;">
                <select data-testid="cc-agent-picker" value=${selAid} disabled=${ccSessOn || ccConnecting} onchange=${e=>{const v=Number(e.target.value);if(v){ccExplicitAgentRef.current[pid]=true;setCcSelectedAgentId(p=>({...p,[pid]:v}));}}} style="flex:1;font-size:10px;padding:3px 4px;background:var(--surface-2);border:1px solid var(--border);border-radius:4px;" title="Agents assigned to this project — planning brain pinned on top">
                  ${orderedCcAgents(pid).map(b => {
                    const nm = (b.agent && b.agent.name) || ('agent-' + b.agent_id);
                    const coord = isCcBrainAgent(pid, b.agent_id);
                    const fav = ccFavAgents.includes(b.agent_id);
                    const label = coord ? `⭐ ${nm} — phase brain` : `${fav ? '⭐ ' : ''}${nm}${b.agent && b.agent.provider ? ` (${b.agent.provider})` : ''}`;
                    return html`<option value=${b.agent_id}>${label}</option>`;
                  })}
                </select>
                <button data-testid="cc-fav-toggle" class="btn btn-sm" style="padding:3px 6px;font-size:11px;" title="Toggle ⭐ favorite for the selected agent (pins it near the top)" disabled=${!selAid || isCcBrainAgent(pid, selAid)} onclick=${()=>toggleCcFav(selAid)}>${ccFavAgents.includes(selAid) ? '⭐' : '☆'}</button>
                <button data-testid="cc-session-toggle" class="btn btn-sm" style=${`padding:3px 8px;font-size:10px;white-space:nowrap;${ccSessOn ? 'color:#3fb950;border-color:#3fb950;' : ''}`} disabled=${ccConnecting} aria-pressed=${ccSessOn ? 'true' : 'false'} title=${ccSessOn ? 'Session ON — click to shut down the agent session' : 'Session OFF — click to spawn the agent in a fenced project session'} onclick=${()=>ccToggleSession(pid)}>${ccConnecting ? '⏳ Connecting…' : ccSessOn ? '⏻ Session On' : '⏻ Session Off'}</button>
              </div>
              ${/* B09 fix1 / AC12: session refusal next to Session On (not clipped under the fold) */ ''}
              ${ccErr ? html`<div data-testid="cc-session-err" role="alert" style="flex-shrink:0;color:#f85149;font-size:11px;line-height:1.35;padding:6px 8px;margin:0 0 4px;border:1px solid rgba(248,81,73,.45);border-radius:6px;background:rgba(248,81,73,.08);white-space:pre-wrap;word-break:break-word">${ccErr}</div>` : null}
              <div style="display:flex;gap:4px;margin-bottom:3px;align-items:center;">
                <button data-testid="cc-clear-ctx" class="btn btn-sm" style="padding:2px 6px;font-size:9px;" disabled=${!ccSessOn} title=${ccSessOn ? "Clear this session's context" : 'Turn on a session to enable Clear'} onclick=${()=>ccCtxAction(pid,'clear')}>Clear</button>
                <button data-testid="cc-compact-ctx" class="btn btn-sm" style="padding:2px 6px;font-size:9px;" disabled=${!ccSessOn} title=${ccSessOn ? "Compact this session's context" : 'Turn on a session to enable Compact'} onclick=${()=>ccCtxAction(pid,'compact')}>Compact</button>
                <button data-testid="cc-force-close" class="btn btn-sm" style="padding:2px 6px;font-size:9px;color:#f85149;border-color:#f85149" disabled=${!ccSessOn} title="Force close a stuck agent session" onclick=${()=>ccForceCloseSession(pid)}>Force close</button>
              </div>
              <textarea data-testid="chat-composer" disabled=${!canChat} placeholder=${canChat ? (runActive ? 'talk to the active phase brain...' : `talk to ${sessAgentName}...`) : 'Turn on a session to chat…'} value=${ccComposer} oninput=${e=>setCcComposer(e.target.value)} onkeydown=${e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendCc();}}} style="width:100%;height:46px;font-size:12px;border:1px solid var(--border);border-radius:4px;padding:4px;background:var(--surface-2);"></textarea>
              <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
                ${canChat
                  ? html`<div class="tiny" style="font-size:9px;color:var(--text-sec);flex:1;">Shift+Enter = nl · Enter = send (real backend)</div>`
                  : html`<div class="tiny" data-testid="cc-session-hint" style="font-size:9px;color:var(--text-sec);flex:1;">Turn on a session to chat — chatting never starts a run.</div>`}
                <button data-testid="chat-send" class="btn btn-primary btn-sm" style="padding:2px 8px;font-size:11px;" disabled=${!canChat} onclick=${sendCc}>Send</button>
              </div>
            </div>
          </div>

          <!-- right: terminal (master) or live Run view (A3: when chat send started a real run for this project; phase/tasks/current + run timeline reuse OBS1) -->
          <div class="cc-col cc-col-term" data-testid="cc-col-term" style=${showTerm ? '' : 'display:none'}>
            <div class="cc-col-header" style="justify-content:space-between;">
              ${showRun ? html`<span>Run #${run.runId}</span>` : html`<span>Terminal</span>`}
              ${showRun
                ? html`<span class="chip" data-testid="run-phase" style="font-size:9px;">${run.phase}</span><span class="text-sec" data-testid="run-status" style="font-size:9px;margin-left:4px;">${run.status}</span>${runActive ? html`<button data-testid="cc-run-stop" class="btn btn-sm" style="font-size:9px;padding:1px 6px;margin-left:6px;color:#f85149;border-color:#f85149;" title="Stop this run — marks it terminal and aborts the orchestrator loop (sessions reaped)" onclick=${()=>ccStopRun(pid, run.runId)}>■ Stop</button>` : null}`
                : html`<span class="text-mono" style="font-size:9px;color:var(--text-sec);">${term.session || '—'}</span>`}
              <span style="flex:1"></span>
              ${showRun ? null : html`<button class="btn btn-sm" style="font-size:9px;padding:1px 5px;" onclick=${compactTerminal} data-testid="term-compact-btn" title="Compact — keep only the last 30 lines">compact</button>`}
              ${showRun ? null : html`<button class="btn btn-sm" style="font-size:9px;padding:1px 5px;margin-left:2px;" onclick=${clearTerminal} data-testid="term-clear-btn" title="Clear the terminal view">clear</button>`}
            </div>
            <div class="cc-col-body" data-testid="terminal-pane" data-source=${ccSess && ccSess.sid ? 'chat-session' : 'master'}>
              ${showRun ? html`
                <div data-testid="run-timeline" style="margin-bottom:6px;font-size:10px;line-height:1.2;">
                  <div class="text-sec" style="font-size:9px;margin-bottom:2px;">Run timeline (OBS1 / agent_events)</div>
                  ${(timelineEvents || []).slice(-6).map((ev, i) => html`<div key=${i} style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(ev.type || ev.role || '')}: ${((ev.body && ev.body.text) || ev.state || '').toString().slice(0,60)}</div>`)}
                </div>
                <div style="font-size:10px;margin-bottom:3px;">Tasks:</div>
                ${(run.tasks || []).length ? (run.tasks || []).map((t) => html`<div class="task-row" data-testid="run-task-row" data-task-id=${t.id} data-task-status=${t.status}>${t.label || ('task ' + t.id)} <span class="chip" style="font-size:9px;">${t.status}</span>${(run.current && run.current.id === t.id) ? html` <span style="color:var(--accent);font-size:9px;">(current)</span>` : ''}</div>`) : html`<div class="text-sec">—</div>`}
                <div style="font-size:9px;margin-top:6px;color:var(--text-sec);">Agents: plancore (helm_cards) + red-team/panelist</div>
              ` : html`<div class="cc-term-content" style="min-height:80px;">${term.content || '(live read-only feed — polls real /api/projects/:id/terminal from active master tmux pane)'}</div>`}
            </div>
          </div>
        </div>

        ${!pid ? html`<div class="inline-note" style="padding:3px 6px;font-size:10px;">Select project in left sidebar (or open idle) to load chat + live terminal feed. 3-way above controls panes.</div>` : null}
      </div>
    </div>`;
    } else if (slug === '08-command-center-tasks') {
    const pid = tasksPid || ccCurrentId;
    const tasks = (tasksByPid[pid] || []);
    const roster = (rosterByPid[pid] || []);
    const byStatus = (s) => tasks.filter(t => t.status === s);
    const projOpts = (projectsList || []).map(p => html`<option value=${p.id}>${p.name}</option>`);
    const group = (title, status, testid) => {
      const rows = byStatus(status);
      return html`<div class="task-group" data-testid=${testid}>
        <div class="group-title">${title} <span class="text-sec">(${rows.length})</span></div>
        ${rows.length === 0 ? html`<div class="text-sec" style="font-size:11px;padding:4px 6px">—</div>` : rows.map(r => html`
          <div class="task-row" data-testid=${`task-row-${r.id || (r.task_key || '')}`}>
            <span class="task-label">${r.label}</span>
            ${r.agent ? html`<span class="chip chip-blue" style="margin-left:6px">${r.agent}</span>` : null}
            <span class="text-sec" style="margin-left:auto;font-size:10px">${r.updated_at ? new Date(r.updated_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''}</span>
          </div>`)}
      </div>`;
    };
    const rosterCard = (r, i) => html`<div class="roster-card" data-testid=${`roster-card-${i}`}>
      <div><strong>${r.name}</strong> <span class="chip chip-purple">${r.model}</span></div>
      <div style="margin-top:2px">
        <span class=${r.state==='working' ? 'chip chip-green' : r.state==='idle' ? 'chip chip-gray' : 'text-sec'}>${r.state}</span>
      </div>
    </div>`;
    return html`<div data-testid="content-cmd-tasks">
      <div class="top-toolbar">
        <div style="display:flex;align-items:center;gap:8px">
          <label style="margin:0;font-size:11px;color:var(--text-sec)">Project:</label>
          <select data-testid="tasks-project-select" style="width:auto" value=${pid||''} onchange=${(e)=>{ const v=Number(e.target.value)||null; setTasksPid(v); if(v) loadTasks(v); }}>
            <option value="">— select / follows chat tab —</option>
            ${projOpts}
          </select>
        </div>
        <button data-testid="tasks-refresh-btn" class="btn btn-sm" onclick=${refreshTasks}>Refresh</button>
      </div>
      <div style="display:flex;gap:16px">
        <div style="flex:2">
          <div class="card">
            <div class="card-title mb-8">Tasklist</div>
            ${group('COMPLETED', 'completed', 'tasks-completed')}
            ${group('WORKING ON', 'working', 'tasks-working')}
            ${group('PENDING', 'pending', 'tasks-pending')}
          </div>
        </div>
        <div style="flex:1;min-width:180px">
          <div class="card">
            <div class="card-title mb-8">Agent Roster</div>
            ${roster.length ? roster.map((r,i)=>rosterCard(r,i)) : html`<div class="text-sec" style="font-size:11px">No runtimes yet (master/workers spawn populates)</div>`}
            <div class="inline-note mt-8">working=active spawn; idle=parked/ended; not-spawned=no runtime row</div>
          </div>
        </div>
      </div>
      ${tasksErr && html`<div style="color:#f85149;font-size:12px;margin-top:6px">${tasksErr}</div>`}
      <div class="inline-note">Per-project (token-scoped ingest from coordinator). Live on refresh (SSE extend in D4+).</div>
    </div>`;
    } else if (slug === '09-command-center-completed') {
    const archs = completedArchives || [];
    return html`<div data-testid="content-cmd-completed">
      <div class="top-toolbar">
        <span class="text-sec" style="font-size:11px">${archs.length} completed task lists</span>
        <button data-testid="completed-refresh-btn" class="btn btn-sm" onclick=${refreshCompleted}>Refresh</button>
      </div>
      ${archs.length === 0
        ? html`<div class="card"><div class="inline-note">no completed task lists yet</div></div>`
        : archs.map(a => {
            const isExp = !!expandedCompleted[a.projectId];
            return html`<div class="completed-row" data-testid=${`completed-row-${a.projectId}`}>
              <div class="completed-header" data-testid=${`completed-header-${a.projectId}`} onclick=${() => toggleCompleted(a.projectId)}>
                <div style="flex:1">
                  <div class="completed-proj">${a.projectName} <span class="chip chip-green" style="font-size:9px;margin-left:4px">${a.count} tasks</span></div>
                  <div class="completed-meta">Completed ${a.latestAt ? new Date(a.latestAt).toLocaleString([],{month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'}) : ''}</div>
                </div>
                <span style="font-size:11px;color:var(--text-sec);margin-left:8px">${isExp ? '▾' : '▸'}</span>
              </div>
              ${isExp ? html`<div class="completed-list">
                ${a.tasks.map(t => html`<div class="task-row" data-testid=${`completed-task-${t.id || (t.task_key || '')}`}>
                  <span class="task-label">${t.label}</span>
                  ${t.agent ? html`<span class="chip chip-blue" style="margin-left:6px;font-size:9px">${t.agent}</span>` : null}
                  <span class="text-sec" style="margin-left:auto;font-size:10px">${t.updated_at ? new Date(t.updated_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : ''}</span>
                </div>`)}
              </div>` : null}
            </div>`;
          })
      }
      ${completedErr && html`<div style="color:#f85149;font-size:12px;margin-top:6px">${completedErr}</div>`}
      <div class="inline-note">Archive of finished task lists (status=completed) per project. Click header to expand.</div>
    </div>`;
    } else if (slug === '10-command-center-terminals') {
    const projOpts = (projectsList || []).map(p => html`<option value=${p.id}>${p.name}</option>`);
    const pid = ccMtPid || ccCurrentId;
    const workers = ccMtWorkers[pid] || [];
    const captures = ccMtCaptures[pid] || {};
    const byId = Object.fromEntries(workers.map(w => [w.id, w]));
    const gridSize = ccMtGridSize;
    const selected = (ccMtSelected[pid] || []).filter(Boolean);
    // Overflow grid tabs: page the roster into chunks of gridSize.
    const gridTabs = [];
    for (let i = 0; i < workers.length; i += gridSize) gridTabs.push(workers.slice(i, i + gridSize).map(w => w.id));
    const showOverflow = workers.length > gridSize;
    const activeTab = ccMtGridTab[pid] || 0;
    const mtStatusClass = (s) => ({ WORKING: 'chip-orange', DONE: 'chip-green', PASS: 'chip-green', FAIL: 'chip-red', BLOCKED: 'chip-red', idle: 'chip-gray' }[s] || 'chip-gray');
    const mtLineClass = (line) => {
      if (line.includes('[helm callback]')) return 'cmt-l-callback';
      if (/npm test|PASS|exit 0|✓/.test(line)) return 'cmt-l-test';
      if (/BLOCKED|FAIL|risk|pending verdict|waiting|error/i.test(line)) return 'cmt-l-warn';
      if (/^\s*\{/.test(line)) return 'cmt-l-json';
      return '';
    };
    // Summary counts across all workers.
    const counts = workers.reduce((a, w) => { const k = String(w.status); a[k] = (a[k] || 0) + 1; return a; }, {});
    const nWorking = counts.WORKING || 0;
    const nDone = (counts.DONE || 0) + (counts.PASS || 0);
    const nIdle = counts.idle || 0;
    const nFail = (counts.FAIL || 0) + (counts.BLOCKED || 0);
    const slots = Array.from({ length: gridSize }, (_, i) => selected[i] || null);
    const metric = (val, label, cls, testid) => html`<div class="cmt-metric" data-testid=${testid}>
      <div class=${`cmt-metric-value ${cls}`}>${val}</div><div class="cmt-metric-label">${label}</div></div>`;
    return html`<div data-testid="content-cmd-terminals">
      <div class="top-toolbar">
        <div style="display:flex;align-items:center;gap:8px">
          <label style="margin:0;font-size:11px;color:var(--text-sec)">Project:</label>
          <select data-testid="cmt-project-select" style="width:auto" value=${pid||''} onchange=${(e)=>{ const v=Number(e.target.value)||null; setCcMtPid(v); if(v){ loadMtWorkers(v); } }}>
            <option value="">— select / follows chat tab —</option>
            ${projOpts}
          </select>
          <span class="chip chip-green chip-dot" style="font-size:9px">live capture</span>
          <span class="chip chip-blue" style="font-size:9px">tmux mirror</span>
        </div>
        <button data-testid="cmt-refresh-btn" class="btn btn-sm" onclick=${()=>{ if(pid){ loadMtWorkers(pid); loadMtCaptures(pid, selected); } }}>Refresh</button>
      </div>

      <div class="cmt-summary" data-testid="cmt-summary">
        ${metric(nWorking, 'working now', 'cmt-mv-orange', 'cmt-metric-working')}
        ${metric(nDone, 'passed / done', 'cmt-mv-green', 'cmt-metric-done')}
        ${metric(nIdle, 'idle', 'cmt-mv-gray', 'cmt-metric-idle')}
        ${metric(nFail, 'fail / blocked', nFail ? 'cmt-mv-red' : 'cmt-mv-gray', 'cmt-metric-fail')}
      </div>

      <div class="cmt-control-bar">
        <div class="cmt-control-group">
          <span class="cmt-control-label">Visible grid</span>
          <div class="view-toggle" data-testid="cmt-grid-toggle" role="group" aria-label="Grid size">
            <button class=${gridSize===2?'active':''} data-testid="cmt-grid-2" onclick=${()=>mtSetGridSize(2)}>1x2</button>
            <button class=${gridSize===4?'active':''} data-testid="cmt-grid-4" onclick=${()=>mtSetGridSize(4)}>2x2</button>
          </div>
        </div>
        <div class="cmt-control-group" style="flex:1;min-width:0">
          <span class="cmt-control-label">Overflow tabs</span>
          <div class="cmt-grid-tabs" data-testid="cmt-grid-tabs">
            ${showOverflow ? gridTabs.map((ids, i) => html`<button class=${`cmt-grid-tab ${i===activeTab?'active':''}`} data-testid=${`cmt-grid-tab-${i}`} onclick=${()=>{ setCcMtGridTab(p=>({...p,[pid]:i})); mtFillFromTab(pid, ids); }}>Grid ${i+1} <span class="chip chip-gray" style="font-size:9px">${ids.length}</span></button>`) : html`<span class="text-sec" style="font-size:10px">${workers.length} ≤ ${gridSize} — all fit in one grid</span>`}
          </div>
        </div>
        <div class="cmt-control-group">
          <span class="cmt-control-label">Selected</span>
          <span class="chip chip-gray" data-testid="cmt-selected-count">${selected.length}/${gridSize} panes</span>
        </div>
      </div>

      <div class="cmt-viewer">
        <section class="cmt-stage">
          <div class=${`cmt-grid ${gridSize===2?'cmt-grid-two':'cmt-grid-four'}`} data-testid="cmt-terminal-grid" aria-label="Worker terminal grid">
            ${slots.map((wid, index) => {
              const w = wid ? byId[wid] : null;
              if (!w) return html`<article class="cmt-pane cmt-pane-empty" data-testid=${`cmt-pane-${index}`}>
                <div class="text-sec">Empty pane ${index+1}</div>
                <div class="text-sec text-mono">choose a worker from the roster →</div>
              </article>`;
              const cap = captures[w.id] || { content: '' };
              const rawLines = String(cap.content || '').split(/\r?\n/);
              const working = w.status === 'WORKING';
              return html`<article class=${`cmt-pane ${working?'cmt-pane-working':''}`} data-testid=${`cmt-pane-${index}`} data-worker-id=${w.id}>
                <header class="cmt-term-header">
                  ${working ? html`<span class="cmt-pulse" aria-label="active"></span>` : null}
                  <div class="cmt-term-title">
                    <div class="cmt-term-role"><span>${w.role}</span><span class="cmt-provider-pill">${w.provider}</span></div>
                    <div class="text-mono cmt-term-model">${w.model}</div>
                  </div>
                  <span class=${`chip ${mtStatusClass(w.status)}${(w.status==='WORKING'||w.status==='idle')?' chip-dot':''}`} data-testid=${`cmt-status-${w.id}`}>${w.status}</span>
                </header>
                <div class="cmt-term-body" tabindex="0" data-testid=${`cmt-body-${w.id}`}>${
                  (cap.content && cap.content.trim())
                    ? rawLines.map(line => html`<div class=${`cmt-line ${mtLineClass(line)}`}>${line || ' '}</div>`)
                    : html`<div class="text-sec">${w.session ? '(waiting for live tmux output…)' : '(no active tmux session — worker idle/not spawned)'}</div>`
                }</div>
                <footer class="cmt-term-footer">
                  <span class="text-mono">${w.session || '—'}</span>
                  <span style="flex:1"></span>
                  <button class="cmt-remove" data-testid=${`cmt-remove-${w.id}`} onclick=${()=>mtToggleWorker(pid, w.id)}>remove</button>
                </footer>
              </article>`;
            })}
          </div>
        </section>
        <aside class="cmt-roster" aria-label="Worker picker">
          <div class="cc-col-header" style="justify-content:space-between"><span>Workers</span><span class="text-sec" data-testid="cmt-worker-total">${workers.length} total</span></div>
          <div class="cmt-roster-tools">
            <button class="btn btn-sm" data-testid="cmt-fill-btn" onclick=${()=>mtFillFromTab(pid, (gridTabs[activeTab]||workers.map(w=>w.id)))}>Fill from active tab</button>
            <button class="btn btn-sm" data-testid="cmt-clear-btn" onclick=${()=>mtClearGrid(pid)}>Clear</button>
          </div>
          <div class="cmt-worker-list" data-testid="cmt-worker-list">
            ${workers.length ? workers.map(w => {
              const isSel = selected.includes(w.id);
              return html`<div class=${`cmt-worker-row ${isSel?'cmt-selected':''}`} data-testid=${`cmt-worker-row-${w.id}`}>
                <div class="cmt-worker-top">
                  <div style="flex:1;min-width:0">
                    <div class="cmt-worker-name">${w.role} · ${w.provider}</div>
                    <div class="cmt-worker-task">${w.task || w.kind}</div>
                  </div>
                  <span class=${`chip ${mtStatusClass(w.status)}`} data-testid=${`cmt-roster-status-${w.id}`}>${w.status}</span>
                </div>
                <div class="text-mono cmt-term-model">${w.model}</div>
                <div class="cmt-slot-buttons">
                  ${[0,1,2,3].map(slot => {
                    const disabled = slot >= gridSize;
                    const active = selected[slot] === w.id;
                    return html`<button class=${`cmt-slot-btn ${active?'active':''}`} data-testid=${`cmt-slot-${w.id}-${slot}`} disabled=${disabled} onclick=${()=>mtPlaceWorker(pid, w.id, slot)}>${slot+1}</button>`;
                  })}
                </div>
                <button class="btn btn-sm" data-testid=${`cmt-toggle-${w.id}`} onclick=${()=>mtToggleWorker(pid, w.id)}>${isSel?'Remove from grid':'Add to grid'}</button>
              </div>`;
            }) : html`<div class="text-sec" style="font-size:11px;padding:6px">No workers for this project's run yet. Panes show idle until a run spawns worker tmux sessions. Real source: /api/projects/:id/terminals (master_runtimes + worker_runtimes).</div>`}
          </div>
        </aside>
      </div>
      ${ccMtErr && html`<div style="color:#f85149;font-size:11px;margin-top:6px">${ccMtErr}</div>`}
      <div class="inline-note mt-12">CC-MT: live per-worker tmux tails via /api/projects/:id/terminals/:wid (capture-pane, poll 1.5s). Grid density + roster slot placement persist per project. Degrades to idle/empty panes when no live sessions.</div>
    </div>`;
    } else if (slug === '11-command-center-timeline') {
    const projOpts = (projectsList || []).map(p => html`<option value=${p.id}>${p.name}</option>`);
    const pid = timelinePid || ccCurrentId;
    return html`<div data-testid="content-cmd-timeline">
      <div class="top-toolbar">
        <div style="display:flex;align-items:center;gap:8px">
          <label style="margin:0;font-size:11px;color:var(--text-sec)">Project:</label>
          <select data-testid="timeline-project-select" style="width:auto" value=${pid||''} onchange=${(e)=>{ const v=Number(e.target.value)||null; setTimelinePid(v); if(v) loadTimeline(v); }}>
            <option value="">— select / follows chat tab —</option>
            ${projOpts}
          </select>
        </div>
        <button data-testid="timeline-refresh-btn" class="btn btn-sm" onclick=${refreshTimeline}>Refresh</button>
      </div>
      <div class="card">
        <div class="card-title mb-8">Run Timeline (agent_events sequence)</div>
        ${timelineErr && html`<div style="color:#f85149;font-size:12px;margin-bottom:8px">${timelineErr}</div>`}
        ${timelineEvents.length === 0 ? html`<div class="text-sec" style="font-size:12px">No events yet for this run (or select project). Real data from /api/projects/:id/timeline over agent_events (dispatch→callback→ACK→gate→validation...).</div>` : timelineEvents.map((e,i) => html`<div class="task-row" data-testid=${`timeline-event-${i}`} style="font-size:11px;">
          <span class="text-mono">${e.ts ? new Date(e.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : ''}</span>
          <span class="chip ${e.role==='owner'?'chip-blue':e.role==='master'?'chip-purple': 'chip-teal'}" style="margin-left:6px">${e.role}</span>
          <span style="margin-left:6px">${e.batch_id || ''}</span>
          <span class="chip" style="margin-left:6px">${e.type}${e.state ? ':'+e.state : ''}</span>
          <span class="text-sec" style="margin-left:6px;font-size:10px">${(e.body && (e.body.text || e.body.status || JSON.stringify(e.body).slice(0,60))) || ''}</span>
        </div>`)}
      </div>
      <div class="inline-note">OBS1: event sequence from agent_events + run/attempt tables (real backend). Per-project via current run_id.</div>
    </div>`;
    }
    return null;
  };

  if (currentSlug === '01-studio-models') {
    const provChip = (p) => html`<span class="chip chip-blue">${p}</span>`;
    const cliChip = (c) => html`<span class="chip chip-teal">${c || '—'}</span>`;
    const approvalChip = (a) => html`<span class="chip chip-gray">${a}</span>`;
    const effortChip = (e) => {
      const isDyn = String(e) === 'dynamic';
      return html`<span class="chip chip-orange">${e}${isDyn ? ' ★' : ''}</span>`;
    };
    const validationChip = (m) => {
      const st = m.validation_status || 'untested';
      const cls = st === 'valid' ? 'chip-green' : st === 'invalid' ? 'chip-red' : 'chip-gray';
      return html`<span class="chip ${cls}" data-testid="model-validation-chip" title=${m.validation_detail || ''}>${st}</span>`;
    };
    // B06: model cascade option label = display_name; value = slug (R1.3).
    const cascadeModelOptions = (cascadeModels || []).map((m) => html`
      <option value=${m.slug || ''} data-model-id=${m.id}>${m.display_name || m.name || m.slug}</option>
    `);
    mainContent = html`<div data-testid="content-studio-models">
      <div class="top-toolbar">
        <span class="text-sec" style="font-size:11px">${modelsList.length} model definitions</span>
        <button data-testid="model-new-btn" class="btn btn-primary btn-sm" onclick=${startNewModel}>+ New model</button>
      </div>
      ${editingModel !== null ? html`
        <div class="card mt-16" data-testid="model-editor-card">
          <div class="card-header"><div class="card-title">${editingModel && editingModel.id ? 'Edit' : 'New'} model definition</div></div>
          <div style="display:grid;gap:8px">
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Name</label>
              <input data-testid="model-name-input" style="flex:1" value=${modelForm.name} oninput=${e => setModelForm({...modelForm, name: e.target.value})} />
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">CLI</label>
              <select data-testid="model-cli-select" style="flex:1" value=${modelForm.cli} onchange=${e => onModelCliChange(e.target.value)}>
                <option value="">— select CLI —</option>
                ${(modelClis || []).map(c => html`<option value=${c}>${c}</option>`)}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Provider</label>
              <select data-testid="model-provider-select" style="flex:1" value=${modelForm.provider} disabled=${!modelForm.cli} onchange=${e => onModelProviderChange(e.target.value)}>
                <option value="">${modelForm.cli ? '— select provider —' : 'select CLI first'}</option>
                ${(modelProviders || []).map(p => html`<option value=${p}>${p}</option>`)}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Model</label>
              <select
                data-testid="model-slug-select"
                style="flex:1"
                value=${modelForm.slug || ''}
                disabled=${!modelForm.cli || !modelForm.provider || modelForm.provider === 'kloo'}
                onchange=${e => {
                  const slug = e.target.value;
                  if (!slug) {
                    setModelForm({...modelForm, slug: '', model_id: modelForm.provider === 'kloo' ? modelForm.model_id : '', display_name: modelForm.display_name});
                    return;
                  }
                  const hit = (cascadeModels || []).find(m => m.slug === slug);
                  if (hit) {
                    setModelForm({
                      ...modelForm,
                      slug: hit.slug || '',
                      model_id: hit.model_id || '',
                      display_name: hit.display_name || hit.name || '',
                      name: modelForm.name || hit.name || hit.display_name || '',
                      provider: hit.provider || modelForm.provider,
                      cli: hit.cli || modelForm.cli,
                      route: hit.route || modelForm.route || '',
                    });
                    // Prefer edit of the registry row when an existing slug is chosen.
                    if (hit.id && !(editingModel && editingModel.id)) setEditingModel(hit);
                    else if (hit.id) setEditingModel(hit);
                  } else {
                    setModelForm({...modelForm, slug});
                  }
                }}
              >
                <option value="">${!modelForm.cli || !modelForm.provider ? 'select CLI + provider first' : (cascadeModels.length ? '— pick model (display name) or enter below —' : '— no registry models; enter model id below —')}</option>
                ${cascadeModelOptions}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Display</label>
              <input data-testid="model-display-name-input" style="flex:1" placeholder="UI label (display_name)" value=${modelForm.display_name} oninput=${e => setModelForm({...modelForm, display_name: e.target.value})} />
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Slug</label>
              <input data-testid="model-slug-input" style="flex:1" class="text-mono" placeholder="canonical slug (optional on create)" value=${modelForm.slug} oninput=${e => setModelForm({...modelForm, slug: e.target.value})} />
            </div>
            ${modelForm.provider === 'kloo' ? (() => {
              const seedKlooModels = ['deepseek/deepseek-v4-flash', 'xiaomi/mimo-v2.5', 'qwen3-coder-30b-a3b-q4km'];
              const filterQ = String(klooModelFilter || '').trim().toLowerCase();
              const matches = (id) => !filterQ || String(id).toLowerCase().includes(filterQ);
              const available = klooModels.models || [];
              const pinned = seedKlooModels.filter(s => available.includes(s) && matches(s));
              const rest = available.filter(id => !seedKlooModels.includes(id) && matches(id));
              const orderedModels = [...pinned, ...rest];
              return html`
                <div style="display:flex;gap:8px;align-items:center">
                  <label style="width:80px;font-size:11px">Provider (route)</label>
                  <select data-testid="model-kloo-route-select" style="flex:1" value=${modelForm.route} onchange=${e => {
                    const rt = e.target.value;
                    setModelForm({...modelForm, route: rt, model_id: ''});
                    setKlooModelFilter('');
                    loadKlooModels(rt, false);
                  }}>
                    <option value="">${klooRoutesLoading ? 'loading routes…' : 'select a route…'}</option>
                    ${klooRoutesList.map(r => html`<option value=${r.name}>${r.name}</option>`)}
                  </select>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                  <label style="width:80px;font-size:11px">Model</label>
                  <input
                    data-testid="model-kloo-model-filter"
                    style="flex:1"
                    type="search"
                    placeholder="filter models…"
                    disabled=${!modelForm.route}
                    value=${klooModelFilter}
                    oninput=${e => setKlooModelFilter(e.target.value)}
                  />
                  <button
                    type="button"
                    class="btn btn-sm"
                    data-testid="model-kloo-refresh-btn"
                    title="Refresh model list"
                    disabled=${!modelForm.route || klooModelsLoading}
                    onclick=${() => loadKlooModels(modelForm.route, true)}
                  >${klooModelsLoading ? '…' : '⟳ refresh'}</button>
                </div>
                <div style="display:flex;gap:8px;align-items:start">
                  <label style="width:80px;font-size:11px"></label>
                  <select
                    data-testid="model-kloo-model-select"
                    size="6"
                    style="flex:1"
                    disabled=${!modelForm.route}
                    value=${modelForm.model_id}
                    onchange=${e => setModelForm({...modelForm, model_id: e.target.value})}
                  >
                    ${!modelForm.route
                      ? html`<option value="" disabled>select a route first</option>`
                      : orderedModels.length === 0
                        ? html`<option value="" disabled>${klooModelsLoading ? 'loading…' : 'no models found'}</option>`
                        : orderedModels.map(id => html`<option value=${id}>${seedKlooModels.includes(id) ? '★ ' : ''}${id}</option>`)}
                  </select>
                </div>
                ${modelForm.model_id ? html`<div class="text-sec" style="font-size:11px;margin-left:88px" data-testid="model-kloo-selected">selected: ${modelForm.model_id}</div>` : null}
                ${klooModels.note ? html`<div style="font-size:11px;color:#d29922;margin-left:88px" data-testid="model-kloo-note">${klooModels.note}</div>` : null}
              `;
            })() : html`
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Model ID</label>
              <input data-testid="model-model-id-input" style="flex:1" class="text-mono" placeholder="CLI model id string" value=${modelForm.model_id} oninput=${e => setModelForm({...modelForm, model_id: e.target.value})} />
            </div>`}
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Effort</label>
              <select data-testid="model-effort-select" value=${modelForm.effort} onchange=${e => setModelForm({...modelForm, effort: e.target.value})}>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="dynamic">dynamic</option>
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Approval</label>
              <select data-testid="model-approval-select" value=${modelForm.approval} onchange=${e => setModelForm({...modelForm, approval: e.target.value})}>
                <option value="auto">auto</option>
                <option value="always-approve">always-approve</option>
                <option value="bypass-sandbox">bypass-sandbox</option>
                <option value="bypass">bypass</option>
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Flags</label>
              <input data-testid="model-flags-input" style="flex:1" placeholder="--flag..." value=${modelForm.flags} oninput=${e => setModelForm({...modelForm, flags: e.target.value})} />
            </div>
          </div>
          ${modelErr && html`<div data-testid="model-form-error" style="color:#f85149;font-size:12px;margin-top:8px">${modelErr}</div>`}
          <div style="margin-top:12px;display:flex;gap:8px">
            <button data-testid="model-save-btn" class="btn btn-primary btn-sm" onclick=${saveModel}>Save</button>
            <button data-testid="model-cancel-btn" class="btn btn-sm" onclick=${cancelEditModel}>Cancel</button>
            ${editingModel && editingModel.id ? html`<button data-testid="model-delete-btn" class="btn btn-sm" style="margin-left:auto;color:#f85149" onclick=${() => deleteModel(editingModel.id)}>Delete</button>` : null}
          </div>
        </div>
      ` : null}
      <table>
        <thead><tr><th>Name</th><th>CLI</th><th>Provider</th><th>Display</th><th>Slug</th><th>Model ID</th><th>Effort</th><th>Approval</th><th>Validation</th><th>Flags</th><th></th></tr></thead>
        <tbody>
          ${modelsList.length === 0
            ? html`<tr><td colspan="11" class="text-sec" style="font-size:12px">No models yet</td></tr>`
            : modelsList.map(m => {
                const isValidating = validatingModelIds.has(m.id);
                return html`<tr key=${m.id} data-testid="model-row" data-model-id=${m.id} data-model-slug=${m.slug || ''}>
                <td>${m.name}</td>
                <td>${cliChip(m.cli)}</td>
                <td>${provChip(m.provider)}</td>
                <td data-testid="model-row-display-name">${m.display_name || m.name}</td>
                <td class="text-mono" data-testid="model-row-slug">${m.slug || '—'}</td>
                <td class="text-mono">${m.model_id}</td>
                <td>${effortChip(m.effort)}</td>
                <td>${approvalChip(m.approval)}</td>
                <td>${validationChip(m)}</td>
                <td class="text-sec text-mono">${m.flags || '—'}</td>
                <td>
                  <button data-testid="model-test-btn" class="btn btn-sm" disabled=${isValidating} onclick=${() => validateModel(m.id)}>${isValidating ? 'testing…' : '[test]'}</button>
                  <button class="btn btn-sm" onclick=${() => startEditModel(m)}>Edit</button>
                  <button class="btn btn-sm" style="color:#f85149;margin-left:4px" onclick=${(e) => { const id = Number(e.currentTarget.closest('tr').getAttribute('data-model-id') || 0); deleteModel(id); }}>×</button>
                </td>
              </tr>`;
              })}
        </tbody>
      </table>
      <div class="inline-note mt-12">B06: CLI→provider→model cascade (display_name shown, slug stored). CLI required on create. dynamic = agent profile decides effort at spawn time</div>
    </div>`;
  } else if (currentSlug === '05-studio-tiers') {
    // B12c / R3.12: studio role_tiers — both roles × L1/L2/L3 × primary+backup (not per-agent ladder)
    const roleTierModelOptions = (modelsList || []).map(m => {
      const label = m.display_name || m.name || m.slug || ('#' + m.id);
      const slugBit = m.slug || m.provider || '';
      return html`<option value=${m.id} data-slug=${m.slug || ''}>${label}${slugBit ? ` (${slugBit})` : ''}</option>`;
    });
    mainContent = html`<div data-testid="content-studio-tiers">
      <div class="top-toolbar">
        <span class="text-sec" style="font-size:11px">Studio role tiers — implementer + validator × L1/L2/L3 primary + backup</span>
        <button data-testid="role-tiers-save-all" class="btn btn-primary btn-sm" disabled=${roleTiersSaving} onclick=${saveAllRoleTiers}>${roleTiersSaving ? 'Saving…' : 'Save all'}</button>
        <button data-testid="role-tiers-reload" class="btn btn-sm" disabled=${roleTiersSaving} onclick=${loadRoleTiers}>Reload</button>
      </div>
      ${roleTiersErr ? html`<div data-testid="role-tiers-error" style="color:#f85149;font-size:12px;margin:8px 0">${roleTiersErr}</div>` : null}
      ${roleTiersOk ? html`<div data-testid="role-tiers-ok" style="color:#3fb950;font-size:12px;margin:8px 0">${roleTiersOk}</div>` : null}
      ${!roleTiersLoaded ? html`<div class="text-sec" style="font-size:12px;margin:12px 0" data-testid="role-tiers-loading">Loading role tiers…</div>` : null}
      <div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));margin-top:12px">
        ${ROLE_TIER_UI_ROLES.map(role => html`
          <div class="card" data-testid=${`role-tiers-role-${role}`} key=${role}>
            <div class="card-header"><div class="card-title">${role}</div></div>
            <div style="display:grid;gap:10px">
              ${ROLE_TIER_UI_LEVELS.map(tier => {
                const key = `${role}/${tier}`;
                const row = roleTiersDraft[key] || { primary_model_id: '', backup_model_id: '' };
                return html`<div data-testid=${`role-tiers-row-${role}-${tier}`} key=${key} style="border:1px solid var(--border);border-radius:6px;padding:8px;display:grid;gap:6px">
                  <div style="font-size:11px;font-weight:600;color:var(--text-sec)">${tier}</div>
                  <div style="display:flex;gap:8px;align-items:center">
                    <label style="width:70px;font-size:11px">Primary</label>
                    <select
                      data-testid=${`role-tiers-primary-${role}-${tier}`}
                      style="flex:1"
                      value=${row.primary_model_id || ''}
                      onchange=${e => setRoleTierField(role, tier, 'primary_model_id', e.target.value)}
                    >
                      <option value="">— none —</option>
                      ${roleTierModelOptions}
                    </select>
                  </div>
                  <div style="display:flex;gap:8px;align-items:center">
                    <label style="width:70px;font-size:11px">Backup</label>
                    <select
                      data-testid=${`role-tiers-backup-${role}-${tier}`}
                      style="flex:1"
                      value=${row.backup_model_id || ''}
                      onchange=${e => setRoleTierField(role, tier, 'backup_model_id', e.target.value)}
                    >
                      <option value="">— none —</option>
                      ${roleTierModelOptions}
                    </select>
                  </div>
                  <div style="display:flex;justify-content:flex-end">
                    <button
                      data-testid=${`role-tiers-save-${role}-${tier}`}
                      class="btn btn-sm"
                      disabled=${roleTiersSaving}
                      onclick=${() => saveRoleTier(role, tier)}
                    >Save ${tier}</button>
                  </div>
                </div>`;
              })}
            </div>
          </div>
        `)}
      </div>
      <div class="inline-note mt-12">R3.12 studio <span class="text-mono">role_tiers</span> (topology cost dial) — not the per-agent L1/backup/escalation ladder. B13 save-time invariants reject opus-on-implementer and backup = same-tier validator model; failures show above.</div>
    </div>`;
  } else if (currentSlug === '07-studio-teams') {
    // B17 / R4: studio team_tiers — deliberation|red-team × budget|standard|elite ordered model lists
    const modelById = {};
    (modelsList || []).forEach(m => { modelById[String(m.id)] = m; });
    const teamTierModelOptions = (modelsList || []).map(m => {
      const label = m.display_name || m.name || m.slug || ('#' + m.id);
      const slugBit = m.slug || m.provider || '';
      return html`<option value=${m.id} data-slug=${m.slug || ''}>${label}${slugBit ? ` (${slugBit})` : ''}</option>`;
    });
    const modelLabel = (id) => {
      const m = modelById[String(id)];
      if (!m) return `#${id}`;
      const label = m.display_name || m.name || m.slug || ('#' + m.id);
      return m.slug ? `${label} (${m.slug})` : label;
    };
    mainContent = html`<div data-testid="content-studio-teams">
      <div class="top-toolbar">
        <span class="text-sec" style="font-size:11px">Studio team tiers — deliberation + red-team × budget/standard/elite model rosters</span>
        <button data-testid="team-tiers-save-all" class="btn btn-primary btn-sm" disabled=${teamTiersSaving} onclick=${saveAllTeamTiers}>${teamTiersSaving ? 'Saving…' : 'Save all'}</button>
        <button data-testid="team-tiers-reload" class="btn btn-sm" disabled=${teamTiersSaving} onclick=${loadTeamTiers}>Reload</button>
      </div>
      ${teamTiersErr ? html`<div data-testid="team-tiers-error" style="color:#f85149;font-size:12px;margin:8px 0">${teamTiersErr}</div>` : null}
      ${teamTiersOk ? html`<div data-testid="team-tiers-ok" style="color:#3fb950;font-size:12px;margin:8px 0">${teamTiersOk}</div>` : null}
      ${!teamTiersLoaded ? html`<div class="text-sec" style="font-size:12px;margin:12px 0" data-testid="team-tiers-loading">Loading team tiers…</div>` : null}
      <div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));margin-top:12px">
        ${TEAM_TIER_UI_TYPES.map(teamType => html`
          <div class="card" data-testid=${`team-tiers-type-${teamType}`} key=${teamType}>
            <div class="card-header"><div class="card-title">${teamType}</div></div>
            <div style="display:grid;gap:10px">
              ${TEAM_TIER_UI_LEVELS.map(tier => {
                const key = `${teamType}/${tier}`;
                const row = teamTiersDraft[key] || { model_ids: [] };
                const ids = row.model_ids || [];
                return html`<div data-testid=${`team-tiers-row-${teamType}-${tier}`} key=${key} style="border:1px solid var(--border);border-radius:6px;padding:8px;display:grid;gap:6px">
                  <div style="font-size:11px;font-weight:600;color:var(--text-sec)">${tier}</div>
                  <div data-testid=${`team-tiers-models-${teamType}-${tier}`} style="display:grid;gap:4px">
                    ${ids.length === 0
                      ? html`<div class="text-sec" style="font-size:11px" data-testid=${`team-tiers-empty-${teamType}-${tier}`}>No models in roster</div>`
                      : ids.map((mid, idx) => html`<div data-testid=${`team-tiers-model-${teamType}-${tier}-${mid}`} key=${mid} style="display:flex;gap:6px;align-items:center;font-size:11px;border:1px solid var(--border);border-radius:4px;padding:4px 6px">
                          <span class="text-mono" style="flex:1">${idx + 1}. ${modelLabel(mid)}</span>
                          <button type="button" class="btn btn-sm" data-testid=${`team-tiers-up-${teamType}-${tier}-${mid}`} disabled=${idx === 0 || teamTiersSaving} onclick=${() => moveTeamTierModel(teamType, tier, idx, -1)}>↑</button>
                          <button type="button" class="btn btn-sm" data-testid=${`team-tiers-down-${teamType}-${tier}-${mid}`} disabled=${idx === ids.length - 1 || teamTiersSaving} onclick=${() => moveTeamTierModel(teamType, tier, idx, 1)}>↓</button>
                          <button type="button" class="btn btn-sm" style="color:#f85149" data-testid=${`team-tiers-remove-${teamType}-${tier}-${mid}`} disabled=${teamTiersSaving} onclick=${() => removeTeamTierModel(teamType, tier, mid)}>×</button>
                        </div>`)}
                  </div>
                  <div style="display:flex;gap:8px;align-items:center">
                    <select
                      data-testid=${`team-tiers-add-select-${teamType}-${tier}`}
                      style="flex:1"
                      value=${teamTiersAddPick[key] || ''}
                      onchange=${e => setTeamTiersAddPick(p => ({ ...p, [key]: e.target.value }))}
                    >
                      <option value="">— add model —</option>
                      ${teamTierModelOptions}
                    </select>
                    <button
                      type="button"
                      data-testid=${`team-tiers-add-${teamType}-${tier}`}
                      class="btn btn-sm"
                      disabled=${teamTiersSaving || !(teamTiersAddPick[key])}
                      onclick=${() => addTeamTierModel(teamType, tier)}
                    >Add</button>
                  </div>
                  <div style="display:flex;justify-content:flex-end">
                    <button
                      data-testid=${`team-tiers-save-${teamType}-${tier}`}
                      class="btn btn-sm"
                      disabled=${teamTiersSaving}
                      onclick=${() => saveTeamTier(teamType, tier)}
                    >Save ${tier}</button>
                  </div>
                </div>`;
              })}
            </div>
          </div>
        `)}
      </div>
      <div class="inline-note mt-12">R4 studio <span class="text-mono">team_tiers</span> — ordered model lists per deliberation/red-team × budget|standard|elite (B16 API). Not the flat B1 teams roster under Agents. Topology seeds load by default; Save replaces the roster.</div>
    </div>`;
  } else if (currentSlug === '06-studio-telemetry') {
    // B15c / R3.15 Reading B: implementer-only L3 inv; M2 denom unique resolve_id; M5 tier-entry cause; seat separate
    // B20 / R5.23: Intended vs actual panel (freeze vs resolve; structural reason incl. COUPLING)
    const buckets = (telemetryView && telemetryView.buckets) || { AS_INTENDED: 0, AVAILABILITY: 0, DIFFICULTY: 0 };
    const invs = (telemetryView && telemetryView.invocations) || [];
    const denom = telemetryView ? telemetryView.denominator : null;
    const iaDeltas = (intendedActualView && intendedActualView.deltas) || [];
    const iaCycle = intendedActualView && intendedActualView.cycle_id;
    mainContent = html`<div data-testid="content-studio-telemetry">
      <div class="top-toolbar">
        <span class="text-sec" style="font-size:11px">R3.15 — Of implementer L3 invocations, how many AVAILABILITY vs DIFFICULTY vs AS_INTENDED?</span>
        <button data-testid="telemetry-load-fixtures" class="btn btn-primary btn-sm" disabled=${telemetryBusy} onclick=${loadTelemetryFixtures}>${telemetryBusy ? 'Loading…' : 'Load R3.15 fixtures'}</button>
        <button data-testid="telemetry-reload" class="btn btn-sm" disabled=${telemetryBusy} onclick=${() => { loadTelemetry(); loadIntendedActual(); }}>Reload</button>
      </div>
      ${telemetryErr ? html`<div data-testid="telemetry-error" style="color:#f85149;font-size:12px;margin:8px 0">${telemetryErr}</div>` : null}
      ${telemetryOk ? html`<div data-testid="telemetry-ok" style="color:#3fb950;font-size:12px;margin:8px 0">${telemetryOk}</div>` : null}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:12px 0">
        <div class="card" data-testid="telemetry-denom">
          <div class="card-header"><div class="card-title">Denominator (M2)</div></div>
          <div style="font-size:28px;font-weight:700;padding:8px 0" data-testid="telemetry-denom-value">${denom == null ? '—' : denom}</div>
          <div class="text-sec" style="font-size:11px">unique resolve_id · final tier L3 · impl only</div>
        </div>
        <div class="card" data-testid="telemetry-bucket-DIFFICULTY">
          <div class="card-header"><div class="card-title">DIFFICULTY</div></div>
          <div style="font-size:28px;font-weight:700;padding:8px 0" data-testid="telemetry-bucket-DIFFICULTY-value">${buckets.DIFFICULTY ?? 0}</div>
          <div class="text-sec" style="font-size:11px">tier-entry (vertical)</div>
        </div>
        <div class="card" data-testid="telemetry-bucket-AVAILABILITY">
          <div class="card-header"><div class="card-title">AVAILABILITY</div></div>
          <div style="font-size:28px;font-weight:700;padding:8px 0" data-testid="telemetry-bucket-AVAILABILITY-value">${buckets.AVAILABILITY ?? 0}</div>
          <div class="text-sec" style="font-size:11px">lateral / no vertical</div>
        </div>
        <div class="card" data-testid="telemetry-bucket-AS_INTENDED">
          <div class="card-header"><div class="card-title">AS_INTENDED</div></div>
          <div style="font-size:28px;font-weight:700;padding:8px 0" data-testid="telemetry-bucket-AS_INTENDED-value">${buckets.AS_INTENDED ?? 0}</div>
          <div class="text-sec" style="font-size:11px">happy-path L3</div>
        </div>
      </div>
      <div class="card" style="margin-top:8px">
        <div class="card-header"><div class="card-title">Implementer L3 invocations</div></div>
        <table style="width:100%;font-size:12px;border-collapse:collapse" data-testid="telemetry-invocations-table">
          <thead>
            <tr style="text-align:left;color:var(--text-sec)">
              <th style="padding:6px 8px">resolve_id</th>
              <th style="padding:6px 8px">cause (tier-entry)</th>
              <th style="padding:6px 8px">seat</th>
              <th style="padding:6px 8px">slug</th>
              <th style="padding:6px 8px">records</th>
            </tr>
          </thead>
          <tbody>
            ${invs.length === 0
              ? html`<tr><td colspan="5" class="text-sec" style="padding:12px 8px" data-testid="telemetry-empty">No implementer L3 invocations yet. Load R3.15 fixtures to seed real-path chains.</td></tr>`
              : invs.map((inv) => html`<tr
                  key=${inv.resolve_id}
                  data-testid=${`telemetry-row-${inv.resolve_id}`}
                  data-cause=${inv.cause}
                  data-seat=${inv.seat || ''}
                  style="border-top:1px solid var(--border)"
                >
                  <td style="padding:6px 8px" class="text-mono">${inv.resolve_id}</td>
                  <td style="padding:6px 8px" data-testid=${`telemetry-cause-${inv.resolve_id}`}><span class="chip">${inv.cause}</span></td>
                  <td style="padding:6px 8px" data-testid=${`telemetry-seat-${inv.resolve_id}`}>${inv.seat || '—'}</td>
                  <td style="padding:6px 8px" class="text-mono">${inv.resolved_slug || '—'}</td>
                  <td style="padding:6px 8px">${inv.record_count}</td>
                </tr>`)}
          </tbody>
        </table>
      </div>
      <div class="inline-note mt-12">M2: denom = unique resolve_id final impl L3 (not raw chain records). M5: bucket by tier-entry cause (vertical), else seq=0; seat is a separate column. Validator COUPLING rows excluded. Fixtures use real resolveVertical/resolveLateral path.</div>

      <div class="card" style="margin-top:20px" data-testid="intended-actual-panel">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div>
            <div class="card-title">Intended vs actual (R5.23)</div>
            <div class="text-sec" style="font-size:11px;margin-top:2px">Freeze = intended · resolve stamps = actual · every delta has a structural reason (incl. COUPLING from B15b)</div>
          </div>
          <button data-testid="intended-actual-load-fixtures" class="btn btn-primary btn-sm" disabled=${telemetryBusy} onclick=${loadIntendedActualFixtures}>${telemetryBusy ? 'Loading…' : 'Load R5.23 fixtures'}</button>
        </div>
        ${intendedActualOk ? html`<div data-testid="intended-actual-ok" style="color:#3fb950;font-size:12px;margin:8px 0">${intendedActualOk}</div>` : null}
        <div class="text-sec" style="font-size:11px;margin:8px 0" data-testid="intended-actual-cycle">cycle: ${iaCycle == null ? '—' : iaCycle}</div>
        <table style="width:100%;font-size:12px;border-collapse:collapse" data-testid="intended-actual-table">
          <thead>
            <tr style="text-align:left;color:var(--text-sec)">
              <th style="padding:6px 8px">resolve_id</th>
              <th style="padding:6px 8px">seq</th>
              <th style="padding:6px 8px">role</th>
              <th style="padding:6px 8px">intended→actual tier</th>
              <th style="padding:6px 8px">intended→actual slug</th>
              <th style="padding:6px 8px">reason</th>
            </tr>
          </thead>
          <tbody>
            ${iaDeltas.length === 0
              ? html`<tr><td colspan="6" class="text-sec" style="padding:12px 8px" data-testid="intended-actual-empty">No deltas yet. Load R5.23 fixtures to seed a freeze + real resolve path (DIFFICULTY + COUPLING multi-cause).</td></tr>`
              : iaDeltas.map((d) => html`<tr
                  key=${`${d.resolve_id}-${d.seq}`}
                  data-testid=${`intended-actual-row-${d.resolve_id}-${d.seq}`}
                  data-reason=${d.reason}
                  data-role=${d.role}
                  style="border-top:1px solid var(--border)"
                >
                  <td style="padding:6px 8px" class="text-mono">${d.resolve_id}</td>
                  <td style="padding:6px 8px">${d.seq}</td>
                  <td style="padding:6px 8px">${d.role}</td>
                  <td style="padding:6px 8px" class="text-mono">${d.intended_tier}→${d.actual_tier}</td>
                  <td style="padding:6px 8px" class="text-mono">${d.intended_slug || '—'}→${d.actual_slug || '—'}</td>
                  <td style="padding:6px 8px" data-testid=${`intended-actual-reason-${d.resolve_id}-${d.seq}`}><span class="chip" data-testid=${d.reason === 'COUPLING' ? 'intended-actual-coupling-chip' : undefined}>${d.reason}</span></td>
                </tr>`)}
          </tbody>
        </table>
      </div>
      <div class="inline-note mt-12">R5.23: topology freeze records intended team; run record shows actual; reason is NOT NULL (AVAILABILITY|DIFFICULTY|COUPLING). Multi-cause chains share resolve_id. COUPLING rows come from real resolveCoupledValidator (B15b), not hand-inserted.</div>
    </div>`;
  } else if (currentSlug === '02-studio-agents') {
    // B11 note: live roster is buildStudioAgentsRoster(); these locals are unused legacy
    // (kept only so this branch still parses kind correctly if re-enabled).
    const renderAgentRow = (a) => {
      const kind = agentKind(a);
      return html`
      <div data-testid="agent-row" data-kind=${kind} class="list-item ${selectedAgentId === a.id ? 'selected' : ''}" style="${selectedAgentId === a.id ? 'background:rgba(88,166,255,.08);border-left:3px solid var(--accent);' : ''}" onclick=${() => selectAgent(a)}>
        <span class="list-item-name">${a.name}</span>
        ${agentKindChip(kind)}
        ${a.in_development ? html`<span class="chip chip-yellow" style="margin-left:4px;font-size:9px">in dev</span>` : null}
        <span class="chip chip-blue" style="margin-left:6px">${a.provider}</span>
        <span class="text-mono" style="font-size:11px;margin-left:4px">${a.model}</span>
      </div>`;
    };
    const houseAgents = (agentsList || []).filter(a => isHouseKind(a));
    const projectAgents = (agentsList || []).filter(a => !isHouseKind(a));
    const rosterSectionHeader = (testid, label, extraStyle) => html`
      <div data-testid=${testid} style="padding:8px 10px 6px;font-size:11px;font-weight:600;color:var(--text-sec);letter-spacing:0.03em;border-bottom:1px solid var(--border);${extraStyle || ''}">${label}</div>`;
    const houseRosterSection = html`
      <div data-testid="roster-section-house-wrap">
        ${rosterSectionHeader('roster-section-house', 'House Agents', 'margin-top:8px;border-top:1px solid var(--border)')}
        ${houseAgents.length ? houseAgents.map(renderAgentRow) : html`<div style="padding:8px 10px;font-size:11px;color:var(--text-sec)">No house agents</div>`}
      </div>`;
    const projectRosterSection = html`
      <div data-testid="roster-section-project-wrap">
        ${rosterSectionHeader('roster-section-project', 'Project Agents', '')}
        ${projectAgents.length ? projectAgents.map(renderAgentRow) : html`<div style="padding:8px 10px;font-size:11px;color:var(--text-sec)">No project agents</div>`}
      </div>`;
    // R1.3: prefer display_name for labels; value stays numeric id (agent bindings API).
    // B9/B8b: fresh option VNodes per select — never reuse one array across parents (Preact dual-parent risk).
    const modelOptions = () => (modelsList || []).map(m => {
      const valid = m.validation_status === 'valid';
      const status = m.validation_status || 'untested';
      const label = m.display_name || m.name;
      return html`<option value=${m.id} disabled=${!valid} data-slug=${m.slug || ''}>${label} (${m.provider})${!valid ? ` — ${status}` : ''}</option>`;
    });
    const availableForAttach = allToolkits.filter(t => !attachedToolkits.some(at => at.id === t.id));
    const teamRows = (teamsList || []).map(t => html`
      <div data-testid="team-row" class="list-item ${selectedTeamId === t.id ? 'selected' : ''}" style="${selectedTeamId === t.id ? 'background:rgba(32,178,170,.08);border-left:3px solid #20b2aa;' : ''}" onclick=${() => selectTeam(t)}>
        <span class="list-item-name">${t.name}</span>
        <span class="chip chip-teal" style="margin-left:6px">${t.type}</span>
      </div>`);
    const agentOpts = (agentsList || []).filter(a => isProjectAddCandidate(a)).map(a => html`<option value=${a.id}>${a.name}</option>`);
    const teamDetailPanel = html`
      <div class="card">
        <div class="card-header"><div class="card-title">${teamForm.name || 'New team'}</div></div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <label style="width:70px;font-size:11px">Name</label>
          <input data-testid="team-name-input" style="flex:1" value=${teamForm.name} oninput=${e => setTeamForm({...teamForm, name: e.target.value})} />
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <label style="width:70px;font-size:11px">Type</label>
          <select data-testid="team-type-select" value=${teamForm.type} onchange=${e => setTeamForm({...teamForm, type: e.target.value})}>
            <option value="deliberation">deliberation</option>
            <option value="red-team">red-team</option>
            <option value="generic">generic</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <label style="width:70px;font-size:11px">Consensus</label>
          <input data-testid="team-consensus-input" style="flex:1" value=${teamForm.consensus_rule} oninput=${e => setTeamForm({...teamForm, consensus_rule: e.target.value})} />
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <label style="width:70px;font-size:11px">Note</label>
          <input data-testid="team-protocol-note-input" style="flex:1" value=${teamForm.protocol_note} oninput=${e => setTeamForm({...teamForm, protocol_note: e.target.value})} />
        </div>
        <div style="margin:8px 0;font-size:11px;color:var(--text-sec)">Members</div>
        <div style="border:1px solid var(--border);padding:4px;min-height:60px">
          ${(teamMembers || []).map(m => {
            const memberLabel = m.member_type === 'agent'
              ? (agentsList.find(a => a.id === m.agent_id)?.name || 'agent:' + m.agent_id)
              : (m.model?.name || String(m.model_id));
            return html`<div style="font-size:12px;display:flex;justify-content:space-between;padding:2px" data-testid=${`team-member-${m.id}`}>
              <span><span class="chip ${m.member_type === 'agent' ? 'chip-purple' : 'chip-blue'}" style="font-size:9px;margin-right:4px">${m.member_type}</span>${memberLabel}${m.lens ? ' (' + m.lens + ')' : ''}</span>
              <button class="btn btn-sm" style="color:#f85149" onclick=${() => removeTeamMember(m.id)}>×</button>
            </div>`;
          })}
        </div>
        <div style="display:flex;gap:6px;margin-top:6px;align-items:center">
          <button data-testid="team-add-type-model" class="btn btn-sm ${teamAddType === 'model' ? 'btn-primary' : ''}" onclick=${() => { setTeamAddType('model'); setTeamAddAgent(''); }}>model</button>
          <button data-testid="team-add-type-agent" class="btn btn-sm ${teamAddType === 'agent' ? 'btn-primary' : ''}" onclick=${() => { setTeamAddType('agent'); setTeamAddModel(''); }}>agent</button>
          ${teamAddType === 'model'
            ? html`<select data-testid="team-add-model" style="flex:1;font-size:11px" value=${teamAddModel} onchange=${e => setTeamAddModel(e.target.value)}>
                <option value="">— model —</option>
                ${modelOptions()}
              </select>`
            : html`<select data-testid="team-add-agent" style="flex:1;font-size:11px" value=${teamAddAgent} onchange=${e => setTeamAddAgent(e.target.value)}>
                <option value="">— agent —</option>
                ${agentOpts}
              </select>`}
          <input data-testid="team-add-lens" style="width:80px;font-size:11px" placeholder="lens" value=${teamAddLens} oninput=${e => setTeamAddLens(e.target.value)} />
          <button class="btn btn-sm" onclick=${addTeamMember}>+ Add</button>
        </div>
        ${teamErr && html`<div style="color:#f85149;font-size:12px;margin-top:6px">${teamErr}</div>`}
        <div style="margin-top:10px;display:flex;gap:8px">
          <button data-testid="team-save-btn" class="btn btn-primary btn-sm" onclick=${saveTeam}>Save</button>
          <button data-testid="team-cancel-btn" class="btn btn-sm" onclick=${startNewTeam}>Cancel/New</button>
          ${selectedTeamId ? html`<button data-testid="team-delete-btn" class="btn btn-sm" style="margin-left:auto;color:#f85149" onclick=${deleteTeam}>Delete</button>` : null}
        </div>
      </div>`;
    const selectedAgent = (agentsList || []).find(a => a.id === selectedAgentId) || null;
    const agentProvider = selectedAgent?.provider || '—';
    // AGENTROLE T5: show actual spawned model when live (may differ from agent.model for PROJECT agents).
    const agentModel = (chatSid && chatActualSpawnModel) ? chatActualSpawnModel : (selectedAgent?.model || '—');
    const agentDescriptionText = deriveAgentDescription(agentDefMd) || 'No description available';
    const agentDetailTabDefs = [
      { key: 'identity', label: 'Identity', testid: 'agent-tab-identity' },
      { key: 'models', label: 'Models', testid: 'agent-tab-models' },
      { key: 'skills', label: 'Skills', testid: 'agent-tab-skills' },
      { key: 'memory', label: 'Memory', testid: 'agent-tab-memory' },
    ];
    // B9/AC-14: studioEscRungPayload shared by tiered ladder editors
    const studioEscRungPayload = (list) => (list || [])
      .filter((x) => x.model_id != null)
      .map((x) => ({
        position: Number(x.position),
        model_id: Number(x.model_id),
        trigger: x.trigger || 'on-fail',
        effort: x.effort == null || x.effort === '' ? null : x.effort
      }));
    const studioEscalationLadder = html`
      <div style="margin:14px 0 6px;font-size:11px;color:var(--text-sec)" data-testid="agent-section-escalation">L2 / L3 / L4 escalation ladder</div>
      <div style="border:1px solid var(--border);border-radius:6px;padding:8px">
        ${[1, 2, 3].map(pos => {
          const level = `L${pos + 1}`;
          const e = (agentEscalations || []).find(x => Number(x.position) === pos) || {};
          const curMid = e.model_id != null ? String(e.model_id) : '';
          const curTrig = e.trigger || 'on-fail';
          const curEffort = e.effort == null || e.effort === '' ? '' : String(e.effort);
          return html`<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px" data-testid=${`agent-escalation-rung-${pos}`}>
            <span style="width:74px;font-size:11px">${level}</span>
            <select data-testid=${`agent-model-${level.toLowerCase()}`} aria-label=${`${level} escalation model`} style="flex:1;font-size:11px" value=${curMid} onchange=${async ev => {
              if (!selectedAgentId) return;
              const newMid = ev.target.value ? Number(ev.target.value) : null;
              // Empty model = unused rung (esp. L4 default); omit from payload so no position-N row.
              const others = (agentEscalations || []).filter(x => Number(x.position) !== pos);
              const rungs = newMid
                ? studioEscRungPayload([{ position: pos, model_id: newMid, trigger: curTrig, effort: curEffort || null }, ...others])
                : studioEscRungPayload(others);
              try {
                const r = await authedFetch(`/api/agents/${selectedAgentId}/escalations`, {method:'PUT', body: JSON.stringify({rungs})});
                const d = await r.json();
                setAgentEscalations(d.escalations || []);
              } catch(err) { /* inline */ }
            }}>
              <option value="">— none —</option>
              ${modelOptions()}
            </select>
            <select data-testid=${`agent-model-${level.toLowerCase()}-effort`} aria-label=${`${level} escalation effort`} style="width:90px;font-size:11px" value=${curEffort} onchange=${async ev => {
              if (!selectedAgentId || !e.model_id) return;
              const newEffort = ev.target.value || null;
              const rungs = studioEscRungPayload((agentEscalations || []).map(x => ({
                ...x,
                effort: Number(x.position) === pos ? newEffort : (x.effort ?? null)
              })));
              try {
                const r = await authedFetch(`/api/agents/${selectedAgentId}/escalations`, {method:'PUT', body: JSON.stringify({rungs})});
                const d = await r.json();
                setAgentEscalations(d.escalations || []);
              } catch {}
            }}>
              <option value="">— inherit —</option>
              ${['low', 'medium', 'high', 'xhigh', 'max'].map(t => html`<option value=${t}>${t}</option>`)}
            </select>
            <select data-testid=${`agent-model-${level.toLowerCase()}-trigger`} aria-label=${`${level} escalation trigger`} style="width:90px;font-size:11px" value=${curTrig} onchange=${async ev => {
              if (!selectedAgentId) return;
              const newTrig = ev.target.value;
              const rungs = studioEscRungPayload((agentEscalations || []).map(x => ({
                ...x,
                trigger: Number(x.position) === pos ? newTrig : x.trigger,
                effort: x.effort ?? null
              })));
              try {
                const r = await authedFetch(`/api/agents/${selectedAgentId}/escalations`, {method:'PUT', body: JSON.stringify({rungs})});
                const d = await r.json();
                setAgentEscalations(d.escalations || []);
              } catch {}
            }}>
              <option value="on-fail">on-fail</option>
              <option value="plan-summon">plan-summon</option>
              <option value="ibrain">ibrain</option>
            </select>
          </div>`;
        })}
      </div>`;
    // B9/AC-14: configure-by-type Models panel (solo hide ladder; tiered show L1–L4; team = note)
    const studioCls = (agentClassification === 'tiered' || agentClassification === 'team') ? agentClassification : 'solo';
    let agentModelsPanel;
    if (studioCls === 'team') {
      agentModelsPanel = html`
        <div data-testid="agent-tab-models-panel" data-classification="team">
          <div data-testid="studio-agent-team-note" class="text-sec" style="font-size:12px;padding:10px;border:1px solid var(--border);border-radius:6px;line-height:1.45">
            <strong style="color:var(--text)">Team classification</strong>
            <div style="margin-top:6px">Team roster is configured <strong>per project</strong> (Team roles under Project Setup) or in the Studio <strong>Teams</strong> editor (deliberation / red-team members). There is no Studio default planner roster table.</div>
            <div style="margin-top:6px;font-size:11px">Use the ⋮ menu → + New team, or open a team row in the roster, to edit Studio team members. Planner panel defaults remain project-scoped.</div>
          </div>
        </div>`;
    } else if (studioCls === 'tiered') {
      agentModelsPanel = html`
        <div data-testid="agent-tab-models-panel" data-classification="tiered">
          <div style="margin:0 0 6px;font-size:11px;color:var(--text-sec)" data-testid="agent-section-models">L1 base + L2 / L3 / L4 ladder</div>
          <div style="border:1px solid var(--border);border-radius:6px;padding:8px;display:grid;gap:8px">
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">L1 default</label>
              <select data-testid="agent-model-l1" style="flex:1" value=${bindings.default_model_id} onchange=${e => setBindings({...bindings, default_model_id: e.target.value})}>
                <option value="">— pick L1 default model —</option>
                ${modelOptions()}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">L1 effort</label>
              <select data-testid="agent-model-effort" style="flex:1" value=${agentDefaultEffort || 'medium'} onchange=${e => setAgentDefaultEffort(e.target.value)}>
                ${['low', 'medium', 'high', 'xhigh', 'max'].map(t => html`<option value=${t}>${t}</option>`)}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">Backup</label>
              <select data-testid="agent-model-backup" style="flex:1" value=${bindings.backup_model_id} onchange=${e => setBindings({...bindings, backup_model_id: e.target.value})}>
                <option value="">— none —</option>
                ${modelOptions()}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">Spawn preference</label>
              <select data-testid="agent-model-spawn-pref" value=${bindings.spawn_pref} onchange=${e => setBindings({...bindings, spawn_pref: e.target.value})}>
                <option value="tmux">tmux (default)</option>
                <option value="in-process">in-process</option>
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">Readiness</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
                <input data-testid="agent-model-in-dev-toggle" type="checkbox" checked=${agentInDev} onchange=${e => setAgentInDev(e.target.checked)} />
                in development
              </label>
            </div>
          </div>
          <div class="inline-note" style="margin-top:4px">Save applies L1, effort, backup, spawn, readiness. Ladder rungs save immediately when changed (requires saved agent).</div>
          ${studioEscalationLadder}
        </div>`;
    } else {
      // solo: main + backup + effort + spawn + readiness; HIDE ladder
      agentModelsPanel = html`
        <div data-testid="agent-tab-models-panel" data-classification="solo">
          <div style="margin:0 0 6px;font-size:11px;color:var(--text-sec)" data-testid="agent-section-models">Default model</div>
          <div style="border:1px solid var(--border);border-radius:6px;padding:8px;display:grid;gap:8px">
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">Default model</label>
              <select data-testid="agent-model-l1" style="flex:1" value=${bindings.default_model_id} onchange=${e => setBindings({...bindings, default_model_id: e.target.value})}>
                <option value="">— pick default model —</option>
                ${modelOptions()}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">Backup</label>
              <select data-testid="agent-model-backup" style="flex:1" value=${bindings.backup_model_id} onchange=${e => setBindings({...bindings, backup_model_id: e.target.value})}>
                <option value="">— none —</option>
                ${modelOptions()}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">Effort</label>
              <select data-testid="agent-model-effort" style="flex:1" value=${agentDefaultEffort || 'medium'} onchange=${e => setAgentDefaultEffort(e.target.value)}>
                ${['low', 'medium', 'high', 'xhigh', 'max'].map(t => html`<option value=${t}>${t}</option>`)}
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">Spawn preference</label>
              <select data-testid="agent-model-spawn-pref" value=${bindings.spawn_pref} onchange=${e => setBindings({...bindings, spawn_pref: e.target.value})}>
                <option value="tmux">tmux (default)</option>
                <option value="in-process">in-process</option>
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:110px;font-size:11px">Readiness</label>
              <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
                <input data-testid="agent-model-in-dev-toggle" type="checkbox" checked=${agentInDev} onchange=${e => setAgentInDev(e.target.checked)} />
                in development
              </label>
            </div>
          </div>
          <div class="inline-note" style="margin-top:4px">Solo agents have no escalation ladder. Save applies model, backup, effort, spawn, and readiness.</div>
        </div>`;
    }
    const agentSkillsPanel = html`
      <div data-testid="agent-tab-skills-panel">
        <div style="margin:0 0 4px;font-size:11px;color:var(--text-sec)" data-testid="agent-section-skills">Side skills</div>
        <div style="border:1px solid var(--border);border-radius:6px;padding:4px 6px;min-height:60px">
          ${attachedToolkits.length === 0 ? html`<div class="text-sec" style="font-size:11px;padding:4px">none attached</div>` : attachedToolkits.map(t => html`<div data-testid=${`side-skill-${t.name}`}>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:2px 4px;font-size:12px">
              <span class="text-mono">${t.name}.md</span>
              <div style="display:flex;gap:4px">
                <button data-testid=${`skill-view-btn-${t.id}`} class="btn btn-sm" onclick=${() => setExpandedSkillId(expandedSkillId === t.id ? null : t.id)}>
                  ${expandedSkillId === t.id ? 'hide' : 'view'}
                </button>
                <button class="btn btn-sm" style="color:#f85149" onclick=${() => detachToolkit(t.id)}>×</button>
              </div>
            </div>
            ${expandedSkillId === t.id ? html`<${MdViewer} content=${t.body_md} testId=${'skill-rendered-' + t.id} maxHeight="200px" className="mt-4" />` : null}
          </div>`)}
          <div style="margin-top:4px;display:flex;gap:6px;align-items:center">
            <select data-testid="agent-toolkit-select" style="flex:1;font-size:11px" id="agent-toolkit-sel">
              ${availableForAttach.map(t => html`<option value=${t.id}>${t.name}</option>`)}
            </select>
            <button class="btn btn-sm" onclick=${() => { const sel = document.getElementById('agent-toolkit-sel'); if (sel && sel.value) attachToolkit(Number(sel.value)); }}>+ Add skill</button>
          </div>
        </div>
        <div class="inline-note">reuse agent_toolkits attach/list/detach</div>
      </div>`;
    const agentIdentityPanel = html`
      <div data-testid="agent-tab-identity-panel">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <label style="width:90px;font-size:11px">Name</label>
          <input data-testid="agent-name-input" style="flex:1" value=${agentName} oninput=${e => setAgentName(e.target.value)} />
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <label style="width:90px;font-size:11px">Classification</label>
          <select data-testid="studio-agent-classification" style="flex:1" value=${studioCls} onchange=${e => onAgentClassificationChange(e.target.value)} required>
            <option value="solo">solo</option>
            <option value="tiered">tiered</option>
            <option value="team">team</option>
          </select>
        </div>
        <div class="inline-note" style="margin:-2px 0 10px 98px">Required. Controls Models layout (solo / L1–L4 ladder / team note). Kind (house|project) is separate — default project.</div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
          <label style="width:90px;font-size:11px">Provider</label>
          <span data-testid="agent-provider-info" class="chip chip-blue">${agentProvider}</span>
          <span data-testid="agent-model-info" class="text-mono" style="font-size:11px;margin-left:4px">${agentModel}</span>
        </div>
        ${studioCls !== 'team' ? html`
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
            <label style="width:90px;font-size:11px">L1 model</label>
            <select data-testid="agent-identity-default-model" style="flex:1" value=${bindings.default_model_id} onchange=${e => setBindings({...bindings, default_model_id: e.target.value})}>
              <option value="">— pick a default model —</option>
              ${modelOptions()}
            </select>
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
            <label style="width:90px;font-size:11px">Backup</label>
            <select data-testid="agent-identity-backup-model" style="flex:1" value=${bindings.backup_model_id} onchange=${e => setBindings({...bindings, backup_model_id: e.target.value})}>
              <option value="">— none —</option>
              ${modelOptions()}
            </select>
          </div>
        ` : html`
          <div data-testid="studio-agent-team-identity-note" class="text-sec" style="font-size:11px;padding:8px;margin-bottom:8px;border:1px dashed var(--border);border-radius:6px;line-height:1.4">
            Team roster configured per project / in Teams. Identity only here — no Studio default roster table.
          </div>
        `}
        <div style="margin-bottom:10px">
          <div style="font-size:11px;color:var(--text-sec);margin-bottom:4px">Description</div>
          <div data-testid="agent-description" style="font-size:12px;color:var(--text);line-height:1.4;padding:8px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px">${agentDescriptionText}</div>
        </div>
        <div style="margin:10px 0 4px;font-size:11px;color:var(--text-sec)">Identity prompt</div>
        <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:12px;display:flex;align-items:center;justify-content:space-between">
          <span class="text-mono">${(agentName || 'agent') + '.md'}</span>
          <button data-testid="agent-def-md-view-btn" class="btn btn-sm" onclick=${() => setDefMdMode(defMdMode === 'hidden' ? 'rendered' : defMdMode === 'rendered' ? 'edit' : 'hidden')}>
            ${defMdMode === 'hidden' ? 'render >' : defMdMode === 'rendered' ? 'edit' : 'hide'}
          </button>
        </div>
        ${defMdMode === 'rendered' ? html`<${MdViewer} content=${agentDefMd} testId="agent-identity-rendered" maxHeight="300px" />` : null}
        ${defMdMode === 'edit' ? html`<textarea data-testid="agent-def-md" style="width:100%;height:140px;margin-top:6px;font-family:monospace;font-size:11px" value=${agentDefMd} oninput=${e => setAgentDefMd(e.target.value)}></textarea>` : null}
        <div class="inline-note" style="margin-top:4px">filename-first; render or edit body (JROM reviews)</div>
        <div style="margin:14px 0 4px;font-size:11px;font-weight:600;color:var(--text-sec);letter-spacing:.06em" data-testid="agent-section-proposals">PROPOSALS ${agentProposals.length > 0 ? html`<span class="chip chip-yellow" style="font-size:10px;margin-left:4px">${agentProposals.length} pending</span>` : ''}</div>
        <div data-testid="proposals-panel">
          ${agentProposals.length === 0
            ? html`<div style="font-size:11px;color:var(--text-sec);padding:4px 0">No pending proposals for this agent.</div>`
            : agentProposals.map(p => html`
              <div key=${p.id} data-testid=${`proposal-row-${p.id}`} style="border:1px solid var(--border);border-radius:6px;padding:8px;margin-bottom:8px">
                <div style="font-size:11px;color:var(--text-sec);margin-bottom:4px">Proposed ${p.created_at}${p.chat_session_id ? html` · <code style="font-size:10px">${p.chat_session_id.slice(0,8)}</code>` : ''}</div>
                <textarea readonly style="width:100%;box-sizing:border-box;height:100px;font-family:monospace;font-size:11px;resize:vertical;background:var(--surface-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px">${p.proposed_definition_md}</textarea>
                <div style="display:flex;gap:6px;margin-top:6px">
                  <button data-testid=${`approve-proposal-${p.id}`} class="btn btn-primary btn-sm" onclick=${() => approveProposal(p.id)}>✓ Approve</button>
                  <button data-testid=${`reject-proposal-${p.id}`} class="btn btn-sm" style="color:#f85149" onclick=${() => rejectProposal(p.id)}>✗ Reject</button>
                </div>
              </div>
            `)}
        </div>
      </div>`;
    const agentAvatarInitial = ((agentName || 'A').trim().charAt(0) || 'A').toUpperCase();
    const composerMemChipLabel = studioAppMemCount != null ? `${studioAppMemCount} memories` : 'memories';
    const renderThreadBubble = (m) => {
      const isUser = m.role === 'user';
      const who = isUser ? 'You' : (agentName || 'Agent');
      const initial = isUser ? 'Y' : agentAvatarInitial;
      const wrapCls = isUser ? 'as-chat-bubble-wrap as-chat-bubble-wrap-user' : 'as-chat-bubble-wrap as-chat-bubble-wrap-agent';
      const bubbleCls = isUser ? 'as-chat-bubble as-chat-bubble-user' : 'as-chat-bubble as-chat-bubble-agent';
      return html`
        <div class=${wrapCls} data-testid=${isUser ? 'as-chat-bubble-user' : 'as-chat-bubble-agent'} key=${m.id}>
          <div class="as-chat-bubble-header" data-testid="as-chat-bubble-header">
            <span class="as-chat-bubble-avatar">${initial}</span>
            <span class="as-chat-bubble-who">${who}</span>
            <span class="as-chat-bubble-time">${formatChatTime(m.ts)}</span>
          </div>
          <div class=${bubbleCls}>
            ${m.thinking
              ? html`<div class="as-chat-thinking" data-testid="as-chat-thinking"><span class="as-chat-thinking-dot"></span><span class="as-chat-thinking-dot"></span><span class="as-chat-thinking-dot"></span><span class="as-chat-thinking-label">thinking… (live in Session Logs)</span></div>`
              : html`<div class="as-chat-bubble-body">${renderChatMessageBody(m.text)}</div>`}
            ${m.fallback ? html`<div class="as-chat-fallback-tag" title="Agent didn't wrap its reply in the Helm reply markers — showing raw output. Full session in the Logs tab.">⚠ unstructured reply — see Session Logs</div>` : null}
          </div>
        </div>`;
    };
    const agentChatSurface = selectedAgentId ? html`
      <div data-testid="as-chat-surface" style="display:flex;flex-direction:column;height:100%;min-height:0">
        <div data-testid="as-chat-header" class="as-chat-header">
          <div class="as-chat-header-left">
            <div data-testid="as-chat-avatar" class="as-chat-avatar" aria-hidden="true">${agentAvatarInitial}</div>
            <div class="as-chat-header-meta">
              <div class="as-chat-header-title-row">
                ${agentRenameEditing ? html`
                  <span class="as-chat-rename-wrap" data-testid="as-chat-rename-wrap">
                    <input
                      data-testid="as-chat-rename-input"
                      class="as-chat-rename-input"
                      value=${agentRenameDraft}
                      oninput=${e => setAgentRenameDraft(e.target.value)}
                      onkeydown=${e => {
                        if (e.key === 'Enter') { e.preventDefault(); saveAgentRename(); }
                        if (e.key === 'Escape') { setAgentRenameEditing(false); setAgentRenameDraft(agentName || ''); }
                      }}
                    />
                    <button data-testid="as-chat-rename-save" type="button" class="btn btn-sm" onclick=${saveAgentRename}>Save</button>
                    <button data-testid="as-chat-rename-cancel" type="button" class="btn btn-sm" onclick=${() => { setAgentRenameEditing(false); setAgentRenameDraft(agentName || ''); }}>Cancel</button>
                  </span>
                ` : html`
                  <button
                    type="button"
                    data-testid="as-chat-agent-name"
                    class="as-chat-agent-name-btn"
                    title="Click to rename"
                    onclick=${() => { setAgentRenameDraft(agentName || ''); setAgentRenameEditing(true); }}
                  >${agentName || 'Agent'}</button>
                `}
                ${isJkageL0Learner(studioSelectedAgent, agentDefMd) ? jkageL0LearnerBadge('as-jkage-l0-badge-chat') : null}
                <span data-testid="as-chat-agent-model" class="text-mono text-sec" style="font-size:11px">${agentModel}</span>
                <span data-testid="as-chat-active" class=${`chip chip-dot ${chatSid ? 'chip-green' : chatConnecting ? 'chip-amber' : 'chip-gray'}`} style="font-size:10px">${chatSid ? 'live' : chatConnecting ? 'connecting…' : 'offline'}</span>
              </div>
              <div data-testid="as-chat-disclaimer" class="as-chat-disclaimer">${(studioSelectedAgent?.kind === 'house' || studioSelectedAgent?.agent_type === 'house' || studioSelectedAgent?.agent_type === 'helm') ? `${studioSelectedAgent.name}'s workspace — you're working with ${studioSelectedAgent.name} directly` : 'Test Chat — test & discuss only, not production orchestration'}${isJkageL0Learner(studioSelectedAgent, agentDefMd) ? ' · L0 learner — no routing · no decision authority' : ''}</div>
              ${studioSelectedAgent && !(studioSelectedAgent?.kind === 'house' || studioSelectedAgent?.agent_type === 'house' || studioSelectedAgent?.agent_type === 'helm') ? html`
                <div class="as-chat-model-picker" data-testid="as-chat-model-picker">
                  <label class="as-chat-model-picker-label" for="as-chat-model-select">Spawn model:</label>
                  <select
                    id="as-chat-model-select"
                    data-testid="as-chat-model-select"
                    class="as-chat-model-select"
                    disabled=${!!chatSid}
                    title=${chatSid ? 'Model applies to the next spawn (end session first to change)' : 'Select a model for the next session spawn'}
                    value=${chatSpawnModelOverride || studioSelectedAgent.model}
                    onchange=${e => setChatSpawnModelOverride(e.target.value === studioSelectedAgent.model ? '' : e.target.value)}
                  >
                    <option value=${studioSelectedAgent.model}>${studioSelectedAgent.model} (configured)</option>
                    ${(modelsList || []).filter(m => m.validation_status === 'valid' && m.model_id !== studioSelectedAgent.model).map(m => html`
                      <option key=${m.id} value=${m.model_id}>${m.model_id}</option>`)}
                  </select>
                </div>` : null}
            </div>
          </div>
          <div class="as-chat-header-actions">
            <button data-testid="as-configure-entry" class="btn btn-sm" onclick=${() => setStudioCenterView('configure')} title="Configure agent">⚙</button>
            <button data-testid="as-chat-clear-ctx" class="btn btn-sm" disabled=${chatCtxPending || !chatSid} onclick=${clearChatContext} title=${chatSid ? "Clear this session's context" : "Start a session to enable Clear"}>Clear</button>
            <button data-testid="as-chat-compact-ctx" class="btn btn-sm" disabled=${chatCtxPending || !chatSid} onclick=${compactChatContext} title=${chatSid ? "Compact this session's context" : "Start a session to enable Compact"}>Compact</button>
            <button data-testid="as-chat-session-toggle" class=${`btn btn-sm as-session-toggle ${chatSid ? 'as-session-on' : 'as-session-off'}`} disabled=${chatConnecting} onclick=${() => { if (chatConnecting) return; if (chatSid) { endChat(); } else { ensureChatSession(); } }} title=${chatSid ? 'Session ON — click to shut down the agent tmux session gracefully' : 'Session OFF — click to spawn a tmux session for this agent'} aria-pressed=${chatSid ? 'true' : 'false'}>${chatConnecting ? '⏳ Connecting…' : chatSid ? '⏻ Session On' : '⏻ Session Off'}</button>
            <button data-testid="as-chat-kebab" class="btn btn-sm as-chat-icon-btn" type="button" aria-label="More options">⋮</button>
            <button data-testid="as-chat-close" class="btn btn-sm as-chat-icon-btn" type="button" aria-label="Close chat" onclick=${closeChatSurface}>✕</button>
          </div>
        </div>
        <div data-testid="as-chat-tabs" class="as-chat-tabs">
          ${effectiveChatCenterMode === 'tabs' ? html`
            <button data-testid="as-chat-tab-chat" class=${`as-chat-tab ${chatCenterTab === 'chat' ? 'active' : ''}`} onclick=${() => setChatCenterTab('chat')}>Chat</button>
            <button data-testid="as-chat-tab-logs" class=${`as-chat-tab ${chatCenterTab === 'logs' ? 'active' : ''}`} onclick=${() => setChatCenterTab('logs')}>Session Logs</button>
          ` : html`<span class="as-chat-tab as-chat-tab-static">Chat + Session Logs</span>`}
          ${!studioLayoutMobile ? html`
            <span class="as-chat-view-mode" data-testid="as-chat-view-mode">
              <button data-testid="as-chat-view-tabs" type="button" class=${`as-chat-view-btn ${effectiveChatCenterMode === 'tabs' ? 'active' : ''}`} onclick=${() => persistChatCenterMode('tabs')}>Tabs</button>
              <button data-testid="as-chat-view-split" type="button" class=${`as-chat-view-btn ${effectiveChatCenterMode === 'split' ? 'active' : ''}`} onclick=${() => persistChatCenterMode('split')}>Split</button>
            </span>
          ` : null}
          ${chatTmuxSession ? html`<span class="as-chat-tmux-attach" data-testid="as-chat-tmux-attach" title="This agent's tmux session — attach in a terminal">tmux: <code>${chatTmuxSession}</code><button class="as-chat-tmux-copy" type="button" title="Copy attach command" onclick=${() => { try { navigator.clipboard.writeText('tmux attach -t ' + chatTmuxSession); setChatErr('Copied: tmux attach -t ' + chatTmuxSession); } catch {} }}>⧉ attach</button></span>` : null}
        </div>
        ${/* B09 fix1 / AC12: collision refusal under header (not after past-sessions below the fold) */ ''}
        ${chatErr ? html`<div data-testid="chat-err" role="alert" style="flex-shrink:0;color:#f85149;font-size:12px;line-height:1.35;padding:8px 10px;margin:0 0 8px;border:1px solid rgba(248,81,73,.45);border-radius:6px;background:rgba(248,81,73,.08);white-space:pre-wrap;word-break:break-word">${chatErr}</div>` : null}
        ${(() => {
          const logsPre = html`<pre data-testid="as-chat-logs" class="as-chat-logs">${chatLogs || (chatSid ? 'Loading session logs…' : 'No live session — turn the session On to view its tmux logs.')}</pre>`;
          const chatThread = html`
            <div data-testid="as-chat-thread" class="as-chat-thread" ref=${(el) => {
              chatThreadScrollRef.current = el;
              if (el) chatThreadStickRef.current = captureStickIntent(el);
            }}
              onscroll=${() => {
                if (chatThreadScrollRef.current) chatThreadStickRef.current = captureStickIntent(chatThreadScrollRef.current);
              }}
              style="flex:1;min-height:200px;overflow-y:auto;margin-bottom:8px">
              ${chatDeliveryGap ? html`<div data-testid="chat-delivery-gap" style="color:#d29922;font-size:10px;padding:3px 6px;">⚠ some delivery statuses may be incomplete — reload to re-sync.</div>` : null}
              ${ccGlobalLossWarn ? html`<div data-testid="chat-loss-warn" style="color:#f85149;font-size:10px;padding:3px 6px;">⚠ delivery-status notifications were dropped under load — some sent messages' status is uncertain. <button class="btn btn-sm" style="padding:0 4px;font-size:9px" onclick=${ccAckGlobalLoss}>Dismiss</button></div>` : null}
              ${chatThreadMessages.length
                ? chatThreadMessages.map(renderThreadBubble)
                : html`<div class="as-chat-thread-empty">${chatConnecting ? 'Connecting…' : 'Send a message to start the thread.'}</div>`}
            </div>`;
          const chatFooter = html`
            ${!chatSid && !chatConnecting ? html`
              <button data-testid="chat-connect-btn" class="btn btn-sm" style="align-self:flex-start;margin-bottom:8px" onclick=${ensureChatSession}>Connect test session</button>
            ` : null}
            <div data-testid="as-composer" class="as-composer">
              <div data-testid="as-composer-context" class="as-composer-context">
                <span data-testid="as-composer-chip-helm" class="as-composer-chip chip chip-blue">Helm</span>
                <span data-testid="as-composer-chip-memories" class="as-composer-chip chip chip-green">${composerMemChipLabel}</span>
                <span data-testid="as-composer-chip-queue" class="as-composer-chip chip chip-yellow">queue.md</span>
                <button data-testid="as-composer-attach" type="button" class="as-composer-attach btn btn-sm">📎 Attach</button>
              </div>
            ${chatQueued && sendPending ? html`<div data-testid="as-chat-queued" class="as-chat-queued">queued — waiting for the agent…</div>` : null}
            <div class="as-composer-input-row">
              <input data-testid="chat-input" style="flex:1;font-size:12px" placeholder="Message ${agentName || 'agent'}…" value=${chatInput} oninput=${e => setChatInput(e.target.value)} onkeydown=${e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMsg(); } }} disabled=${sendPending || chatConnecting} />
              <button data-testid="chat-send-btn" class="btn btn-primary btn-sm" onclick=${sendChatMsg} disabled=${sendPending || chatConnecting}>Send</button>
            </div>
            </div>
            <div data-testid="as-past-sessions" class="as-past-sessions">
              <div class="as-past-sessions-header">PAST SESSIONS</div>
              ${studioPastSessions.length
                ? studioPastSessions.map(row => {
                    const rowDate = new Date(row.endedAt).toISOString().slice(0, 10);
                    return html`
                      <div data-testid="as-past-session-row" class="as-past-session-row" key=${row.id}>
                        <span class="as-past-session-summary">${rowDate} · ${row.summary}</span>
                        <button data-testid="as-past-session-view" type="button" class="btn btn-sm as-past-session-view" onclick=${() => viewPastSession(row)}>View</button>
                      </div>`;
                  })
                : html`<div data-testid="as-past-sessions-empty" class="as-past-sessions-empty">No past sessions yet</div>`}
            </div>`;
          if (effectiveChatCenterMode === 'split') {
            const splitLogsW = clampChatLogsWidth(chatLogsWidth, chatCenterSplitRef.current?.offsetWidth || 900);
            return html`
              <div data-testid="chat-panel" class="as-chat-split" ref=${chatCenterSplitRef} style="--chat-logs-width:${splitLogsW}px">
                <div class="as-chat-split-chat" data-testid="as-chat-split-chat" style="display:flex;flex-direction:column;flex:1;min-width:${CHAT_MIN_DESKTOP}px;min-height:0">
                  ${chatThread}
                  ${chatFooter}
                </div>
                <div class="as-chat-split-handle" data-testid="as-chat-split-handle" onpointerdown=${startChatLogsDrag}></div>
                <div class="as-chat-split-logs" data-testid="as-chat-split-logs" style="width:var(--chat-logs-width);min-width:${CHAT_LOGS_MIN}px;flex:0 0 auto;display:flex;flex-direction:column;min-height:0">
                  ${logsPre}
                </div>
              </div>`;
          }
          return html`
            <div data-testid="chat-panel" style="display:flex;flex-direction:column;flex:1;min-height:0">
              ${chatCenterTab === 'logs' ? logsPre : chatThread}
              ${chatCenterTab !== 'logs' ? chatFooter : null}
            </div>`;
        })()}
      </div>` : html`<div data-testid="as-chat-surface" style="font-size:12px;color:var(--text-sec)">Save the agent before using chat.</div>`;
    const agentMemoryPanel = html`
      <div data-testid="agent-tab-memory-panel" style="padding:8px 4px;font-size:12px;color:var(--text-sec)">No agent memory configured.</div>`;
    const studioClsChip = studioCls === 'tiered' ? 'chip-blue' : studioCls === 'team' ? 'chip-purple' : 'chip-gray';
    const agentDetailPanel = html`
      <div class="card" data-testid="agent-detail-workspace" data-classification=${studioCls}>
        <div class="card-header" style="display:flex;align-items:center;gap:8px">
          <div class="card-title">${agentName || 'New agent'} ${isJkageL0Learner(selectedAgent, agentDefMd) ? jkageL0LearnerBadge('as-jkage-l0-badge-detail') : null} <span data-testid="studio-agent-classification-badge" data-class=${studioCls} class=${`chip ${studioClsChip}`} style="margin-left:6px;font-size:10px">${studioCls}</span> <span class="chip chip-purple" style="margin-left:4px">${bindings.spawn_pref}</span></div>
          ${selectedAgentId ? html`<button data-testid="as-configure-back" class="btn btn-sm" style="margin-left:auto" onclick=${() => setStudioCenterView('chat')}>← Back to chat</button>` : null}
        </div>
        <div class="tab-strip" data-testid="agent-detail-tabs" style="display:flex;gap:0;margin-bottom:12px;border-bottom:1px solid var(--border)">
          ${agentDetailTabDefs.map(t => html`<div class=${`tab ${agentDetailTab === t.key ? 'active' : ''}`} data-testid=${t.testid} onclick=${() => setAgentDetailTab(t.key)}>${t.label}</div>`)}
        </div>
        ${agentDetailTab === 'identity' ? agentIdentityPanel : null}
        ${agentDetailTab === 'models' ? agentModelsPanel : null}
        ${agentDetailTab === 'skills' ? agentSkillsPanel : null}
        ${agentDetailTab === 'memory' ? agentMemoryPanel : null}
        ${agentErr && html`<div style="color:#f85149;font-size:12px;margin-top:8px">${agentErr}</div>`}
        <div style="margin-top:12px;display:flex;gap:8px">
          <button data-testid="agent-save-btn" class="btn btn-primary btn-sm" onclick=${saveAgent}>Save</button>
          <button data-testid="agent-cancel-btn" class="btn btn-sm" onclick=${startNewAgent}>Cancel / New</button>
          ${selectedAgentId ? html`<button data-testid="agent-delete-btn" class="btn btn-sm" style="margin-left:auto;color:#f85149" onclick=${deleteAgent}>Delete</button>` : null}
        </div>
      </div>`;
    const agentChatClosed = html`
      <div data-testid="as-chat-closed" style="padding:24px 12px;font-size:12px;color:var(--text-sec);text-align:center">
        Chat closed.
        <button class="btn btn-sm" style="margin-left:8px" onclick=${() => setStudioChatOpen(true)}>Reopen chat</button>
      </div>`;
    const agentCenterContent = selectedTeamId
      ? teamDetailPanel
      : (!selectedAgentId || studioCenterView === 'configure')
        ? agentDetailPanel
        : (!studioChatOpen ? agentChatClosed : agentChatSurface);
    studioAgentsCol = buildStudioAgentsRoster();
    studioCenterCol = html`
      <div data-testid="as-col-center" class="as-col-center" style="padding:12px 14px;display:flex;flex-direction:column;min-height:0">
        ${agentCenterContent}
      </div>`;
    mainContent = html`<div data-testid="content-studio-agents" style="display:contents"></div>`;
  } else if (currentSlug === '03-studio-plumbing-watchers') {
    const agentOpts = (agentsList || []).map(a => html`<option value=${a.id}>${a.name} (${a.provider}/${a.model})</option>`);
    const stateChip = (s) => {
      const cls = (s === 'active') ? 'chip-green' : (s === 'stuck') ? 'chip-red' : 'chip-orange';
      return html`<span class="chip ${cls} chip-dot" data-testid="plumbing-state-chip">${s || 'active'}</span>`;
    };
    mainContent = html`<div data-testid="content-studio-plumbing-watchers">
      <div class="grid-2 mb-12">
        <div class="card">
          <div class="card-title mb-8">Brain model <span class="inline-note">(backstop — ~80–95% decisions are algorithmic)</span></div>
          <div class="form-row">
            <label>Primary brain</label>
            <select data-testid="plumbing-brain-primary" value=${plumbingForm.brain_agent_id} onchange=${e => setPlumbingForm({...plumbingForm, brain_agent_id: e.target.value})}>
              <option value="">— none —</option>
              ${agentOpts}
            </select>
          </div>
          <div class="form-row">
            <label>Backup brain</label>
            <select data-testid="plumbing-brain-backup" value=${plumbingForm.backup_brain_agent_id} onchange=${e => setPlumbingForm({...plumbingForm, backup_brain_agent_id: e.target.value})}>
              <option value="">— none —</option>
              ${agentOpts}
            </select>
          </div>
          <div class="section-note" style="margin-bottom:0">Brain handles only true edge cases. Refresh decisions are algorithmic by default.</div>
        </div>
        <div class="card">
          <div class="card-title mb-8">Refresh thresholds</div>
          <div class="form-row">
            <label>Task-count trigger</label>
            <input data-testid="plumbing-threshold-tasks" type="number" value=${plumbingForm.refresh_every_tasks} oninput=${e => setPlumbingForm({...plumbingForm, refresh_every_tasks: e.target.value})} />
          </div>
          <div class="form-row">
            <label>Context / token watermark</label>
            <input data-testid="plumbing-threshold-watermark" type="text" value=${(plumbingForm.context_watermark_pct || 80) + '%'} oninput=${e => setPlumbingForm({...plumbingForm, context_watermark_pct: parseInt(e.target.value) || 80})} />
          </div>
          <div class="form-row">
            <label>Time fallback</label>
            <input data-testid="plumbing-threshold-time" type="text" value="20 min" />
          </div>
        </div>
      </div>

      <div class="card mb-12">
        <div class="card-title mb-8">Escalation policy <span class="inline-note">(what's a real blocker — no spam)</span></div>
        <div class="form-row">
          <label>Ping JROM only when</label>
          <select data-testid="plumbing-escalation" value=${plumbingForm.escalation} onchange=${e => setPlumbingForm({...plumbingForm, escalation: e.target.value})}>
            <option>coordinator stuck AND self-remediation failed (3× attempts)</option>
            <option>total loss of context</option>
            <option>explicit URGENT flag</option>
          </select>
        </div>
        <div class="section-note" style="margin-bottom:0">De-dup mandatory. Prefer autonomous resolution. No progress/interim pings.</div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Context Steward — live coordinator view</div>
          <span class="inline-note">Coordinators self-configure their own alarm schedule</span>
        </div>
        <table>
          <thead><tr>
            <th>Coordinator</th><th>State</th><th>Last refresh</th><th>Last nudge</th><th>Checkpoint</th><th>Schedule (self-set)</th><th></th>
          </tr></thead>
          <tbody>
            ${watchStates.length === 0
              ? html`<tr><td colspan="7" class="text-sec" style="font-size:12px">No coordinator watch states yet (seed in e2e fixture for UI-PROOF)</td></tr>`
              : watchStates.map(st => {
                  const cfg = (plumbingConfigs || []).find(c => c.project_id === st.project_id) || {};
                  const eff = cfg.effective || {};
                  const schedule = eff.refresh_every_tasks ? `every ${eff.refresh_every_tasks} tasks` : '—';
                  return html`<tr key=${st.project_id} data-testid="plumbing-watch-row">
                    <td><strong>proj-${st.project_id} · ${cfg.role || 'plancore'}</strong></td>
                    <td>${stateChip(st.state)}</td>
                    <td class="text-sec">${st.last_progress_at ? 'recent' : '—'}</td>
                    <td class="text-sec">—</td>
                    <td class="text-mono">${st.last_watch_reason || st.last_task_hash || '—'}</td>
                    <td class="text-sec">${schedule}</td>
                    <td><button data-testid="plumbing-override-btn" class="btn btn-sm" onclick=${() => { setPlumbingErr('Override (JROM) — edit/save config above persists to effective'); }}>Override</button></td>
                  </tr>`;
                })
            }
          </tbody>
        </table>
        <div class="inline-note mt-8">JROM can view and override any coordinator's self-set schedule</div>
        ${plumbingErr && html`<div style="color:#f85149;font-size:12px;margin-top:8px">${plumbingErr}</div>`}
        <div style="margin-top:12px;display:flex;gap:8px">
          <button data-testid="plumbing-save-btn" class="btn btn-primary btn-sm" onclick=${savePlumbingConfig}>Save config (JROM override)</button>
          <button data-testid="plumbing-refresh-btn" class="btn btn-sm" onclick=${loadPlumbing}>Refresh</button>
        </div>
      </div>
    </div>`;
  } else if (currentSlug === '04-studio-routing') {
    const coreChip = (isCore) => isCore
      ? html`<span class="chip chip-gray" data-testid="routing-core-chip">🔒 core</span>`
      : html`<span class="chip chip-gray">custom</span>`;
    const enabledChip = (isEnabled) => isEnabled
      ? html`<span class="chip chip-green" data-testid="routing-enabled-chip">● enabled</span>`
      : html`<span class="chip chip-red" data-testid="routing-enabled-chip">○ disabled</span>`;
    mainContent = html`<div data-testid="content-studio-routing">
      ${routingValidation.ok
        ? html`<div class="card mb-12" data-testid="routing-validation-ok" style="color:var(--success);font-size:12px">✓ config valid — all core routes resolve, no conflicts</div>`
        : html`<div class="card mb-12" data-testid="routing-validation-problems" style="border-color:var(--danger)">
            <div class="card-title mb-8" style="color:var(--danger)">Routing config problems</div>
            <ul style="margin:0;padding-left:18px;font-size:12px;color:var(--danger)">
              ${routingValidation.problems.map(p => html`<li key=${p}>${p}</li>`)}
            </ul>
          </div>`
      }
      ${routingOpErr
        ? html`<div class="card mb-12" data-testid="routing-op-err" style="border-color:var(--danger)">
            <div style="color:var(--danger);font-size:12px">${routingOpErr.error || 'Operation failed'}</div>
            ${routingOpErr.problems && routingOpErr.problems.length
              ? html`<ul style="margin:4px 0 0;padding-left:18px;font-size:11px;color:var(--danger)">
                  ${routingOpErr.problems.map(p => html`<li key=${p}>${p}</li>`)}
                </ul>`
              : null}
          </div>`
        : null
      }
      <div class="card">
        <div class="card-header">
          <div class="card-title">Routing rules</div>
          <span class="inline-note">core rules are 🔒 locked (handler/action protected) — custom rules fully editable</span>
        </div>
        <table>
          <thead><tr><th>Emitter</th><th>When</th><th>→ Handler</th><th>Action</th><th>Core</th><th>Enabled</th><th>Note</th><th></th></tr></thead>
          <tbody>
            ${routingRulesList.length === 0
              ? html`<tr><td colspan="8" class="text-sec" style="font-size:12px">No routing rules</td></tr>`
              : routingRulesList.map(r => {
                  const isCore = r.is_core === 1;
                  const isEditing = editingRuleId === r.id;
                  if (isEditing) {
                    return html`<tr key=${r.id} data-testid="routing-rule-row">
                      <td class="text-mono">${r.emitter_role}</td>
                      <td class="text-mono">${r.when_status}</td>
                      <td>${isCore
                        ? html`<span class="text-mono">${r.handler_role}</span>`
                        : html`<input data-testid="routing-edit-handler" style="width:100%;font-size:11px" value=${routingEditForm.handler_role} oninput=${e => setRoutingEditForm({ ...routingEditForm, handler_role: e.target.value })} />`}
                      </td>
                      <td>${isCore
                        ? html`<span class="text-mono">${r.action}</span>`
                        : html`<input data-testid="routing-edit-action" style="width:100%;font-size:11px" value=${routingEditForm.action} oninput=${e => setRoutingEditForm({ ...routingEditForm, action: e.target.value })} />`}
                      </td>
                      <td>${coreChip(isCore)}</td>
                      <td>${enabledChip(r.enabled === 1)}</td>
                      <td><input data-testid="routing-edit-note" style="width:100%;font-size:11px" value=${routingEditForm.note} oninput=${e => setRoutingEditForm({ ...routingEditForm, note: e.target.value })} /></td>
                      <td style="white-space:nowrap">
                        <button data-testid="routing-save-btn" class="btn btn-primary btn-sm" onclick=${() => saveEditRule(r.id)}>Save</button>
                        <button data-testid="routing-cancel-btn" class="btn btn-sm" onclick=${cancelEditRule}>Cancel</button>
                      </td>
                    </tr>`;
                  }
                  return html`<tr key=${r.id} data-testid="routing-rule-row">
                    <td class="text-mono">${r.emitter_role}</td>
                    <td class="text-mono">${r.when_status}</td>
                    <td class="text-mono">${r.handler_role}</td>
                    <td class="text-mono">${r.action}</td>
                    <td>${coreChip(isCore)}</td>
                    <td>${enabledChip(r.enabled === 1)}</td>
                    <td class="text-sec" style="font-size:11px">${r.note || '—'}</td>
                    <td style="white-space:nowrap">
                      <button data-testid="routing-toggle-btn" class="btn btn-sm" onclick=${() => toggleRuleEnabled(r)}>${r.enabled === 1 ? 'Disable' : 'Enable'}</button>
                      ${!isCore ? html`<button data-testid="routing-edit-btn" class="btn btn-sm" onclick=${() => startEditRule(r)}>Edit</button>` : null}
                    </td>
                  </tr>`;
                })
            }
          </tbody>
        </table>
      </div>
      <div class="card mt-12">
        <div class="card-header">
          <div class="card-title">Add rule</div>
          <span class="inline-note">new rules are always custom (non-core)</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input data-testid="routing-add-emitter" style="width:110px;font-size:11px" placeholder="emitter_role" value=${routingAddForm.emitter_role} oninput=${e => setRoutingAddForm({ ...routingAddForm, emitter_role: e.target.value })} />
          <input data-testid="routing-add-when" style="width:110px;font-size:11px" placeholder="when_status" value=${routingAddForm.when_status} oninput=${e => setRoutingAddForm({ ...routingAddForm, when_status: e.target.value })} />
          <input data-testid="routing-add-handler" style="width:110px;font-size:11px" placeholder="handler_role" value=${routingAddForm.handler_role} oninput=${e => setRoutingAddForm({ ...routingAddForm, handler_role: e.target.value })} />
          <input data-testid="routing-add-action" style="width:110px;font-size:11px" placeholder="action" value=${routingAddForm.action} oninput=${e => setRoutingAddForm({ ...routingAddForm, action: e.target.value })} />
          <input data-testid="routing-add-note" style="width:140px;font-size:11px" placeholder="note (optional)" value=${routingAddForm.note} oninput=${e => setRoutingAddForm({ ...routingAddForm, note: e.target.value })} />
          <button data-testid="routing-add-btn" class="btn btn-primary btn-sm" onclick=${addRoutingRule}>+ Add rule</button>
        </div>
      </div>
    </div>`;
  } else if (currentSlug === '04-projects') {
    const allProjectTags = normalizeTagList((projectsList || []).flatMap(p => normalizeTagList(p.tags)));
    const filteredProjects = projectTagFilter
      ? (projectsList || []).filter(p => normalizeTagList(p.tags).some(tag => tag.toLowerCase() === projectTagFilter.toLowerCase()))
      : (projectsList || []);
    const totalPages = Math.ceil(filteredProjects.length / projectPageSize);
    const safeProjectPage = totalPages > 0 ? Math.min(projectPage, totalPages - 1) : 0;
    const pagedProjects = filteredProjects.slice(safeProjectPage * projectPageSize, (safeProjectPage + 1) * projectPageSize);
    const activeProject = activeProjectId ? (projectsList || []).find(p => p.id === activeProjectId) : null;
    const activeProjectStatus = activeProjectId ? projectStatusById[activeProjectId] : null;
    const activeTechStack = activeProjectId ? projectTechStackById[activeProjectId] : undefined;
    const validModelCount = (modelsList || []).filter(m => m.validation_status === 'valid').length;

    // --- Agents sub-tab helpers (moved from 05-setup-project-agents) ---
    // AC-13: Studio inherit option VALUE stays 'default' for save semantics; TEXT is Studio · {name}.
    const studioModelNameForPa = (pa) => {
      const studio =
        paOverrideDetail?.agent_id === pa.agent_id
          ? paOverrideDetail.agent
          : ((agentsList || []).find(a => a.id === pa.agent_id) || pa.agent);
      if (!studio) return null;
      const bound = resolveAgentBoundModel(studio, modelsList);
      if (bound) return bound.display_name || bound.name || bound.model_id || null;
      if (studio.default_model_id != null) {
        const m = (modelsList || []).find(x => x.id === Number(studio.default_model_id));
        if (m) return m.display_name || m.name || m.model_id;
      }
      const text = studio.model || pa.agent?.model || pa.resolved?.name || pa.effective?.model?.name;
      if (text && String(text).trim() && String(text) !== 'default' && String(text) !== '[Agent default]') {
        return String(text);
      }
      return null;
    };
    const projAgentModelOpts = (pa) => {
      const studioName = studioModelNameForPa(pa);
      const inheritLabel = studioName ? `Studio · ${studioName}` : 'Studio · —';
      return [
        html`<option value="default">${inheritLabel}</option>`,
        ...(modelsList || []).map((m) => {
          const valid = m.validation_status === 'valid';
          const status = m.validation_status || 'untested';
          return html`<option value=${m.id} disabled=${!valid}>${m.name} (${m.provider})${!valid ? ` — ${status}` : ''}</option>`;
        }),
        html`<option value="dynamic">Dynamic — coordinator picks from the global pool</option>`
      ];
    };
    const getCurrentModelVal = (pa) => {
      if (pa.use_dynamic) return 'dynamic';
      if (pa.model_id != null) return String(pa.model_id);
      return 'default';
    };
    const modelLabelById = (id) => {
      if (id == null) return '—';
      const m = (modelsList || []).find(x => x.id === Number(id));
      return m ? `${m.name} (${m.provider})` : `#${id}`;
    };
    /** AC-13: never show bare "default"/"[Agent default]" when a concrete model is known. */
    const resolvedModelLabel = (modelOrPa) => {
      // Accept either a full project-agent row or a resolved model object.
      const pa = modelOrPa && (modelOrPa.resolved != null || modelOrPa.effective != null || modelOrPa.agent != null || modelOrPa.use_dynamic != null)
        ? modelOrPa
        : null;
      const model = pa
        ? (pa.effective?.model || pa.resolved || null)
        : modelOrPa;
      const source = model?.source || pa?.resolved?.source || pa?.effective?.model?.source || null;
      if (pa && Number(pa.use_dynamic) === 1) return 'dynamic · coordinator';
      if (source === 'dynamic' || model?.type === 'dynamic') return 'dynamic · coordinator';

      let name =
        (pa?.resolved?.name) ||
        (pa?.effective?.model?.name) ||
        model?.name ||
        model?.model_id ||
        pa?.effective?.model?.model_id ||
        pa?.agent?.model ||
        null;
      if (typeof name === 'string') name = name.trim() || null;
      if (name === 'default' || name === '[Agent default]') name = null;
      if (!name && pa) name = studioModelNameForPa(pa);

      if (!name) return '—';

      const marker =
        source === 'override' || model?.type === 'override' ? 'override'
          : source === 'inherited' || model?.type === 'default' || model?.type === 'inherited' ? 'inherited'
            : source === 'unknown' ? null
              : null;
      return marker ? `${name} · ${marker}` : name;
    };
    const paHasOverrides = (pa) =>
      !!pa?.has_persona_override ||
      Number(pa?.toolkits_overridden) === 1 ||
      Number(pa?.escalations_overridden) === 1 ||
      pa?.backup_model_id != null ||
      pa?.effort_override != null ||
      pa?.spawn_pref_override != null ||
      pa?.disabled_override != null ||
      Number(pa?.use_dynamic) === 1 ||
      pa?.model_id != null;
    const studioAgentForPa = (pa) =>
      paOverrideDetail?.agent_id === pa.agent_id
        ? paOverrideDetail.agent
        : ((agentsList || []).find(a => a.id === pa.agent_id) || pa.agent);
    const inheritedHint = (text, overridden) =>
      overridden
        ? null
        : html`<div class="text-sec" style="font-size:10px;margin-top:2px" data-testid="pa-inherited-hint">inherited: ${text}</div>`;
    const resetInheritBtn = (testId, onClick) =>
      html`<button data-testid=${testId} class="btn btn-sm" style="font-size:10px;margin-top:4px" onclick=${onClick}>Reset to inherit</button>`;
    // Fresh option VNodes per call — never share one array across multiple <select> parents (preact dual-parent).
    const plannerPanelModelOpts = () => (modelsList || []).map((m) => {
      const valid = m.validation_status === 'valid';
      const status = m.validation_status || 'untested';
      return html`<option value=${m.id} disabled=${!valid}>${m.name} (${m.provider})${!valid ? ` — ${status}` : ''}</option>`;
    });
    const plannerPanelBlock = html`<div data-testid="planner-panel-config" style="margin-top:6px;padding-top:8px;border-top:1px dashed var(--border)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
        <div class="text-sec" style="font-size:11px;font-weight:600">Planner Panel <span class="inline-note" style="font-weight:400">(adaptive planner)</span></div>
        <div style="display:flex;align-items:center;gap:6px">
          ${plannerPanelFlash ? html`<span class="chip chip-green" data-testid="planner-panel-save-flash" style="font-size:10px">Saved ✓</span>` : null}
          <button data-testid="planner-panel-save" class="btn btn-primary btn-sm" disabled=${!activeProjectId || plannerPanelSaving || !plannerPanelDirty} onclick=${() => activeProjectId && savePlannerPanel(activeProjectId)}>
            ${plannerPanelSaving ? 'Saving…' : 'Save panel'}
          </button>
        </div>
      </div>
      ${!activeProjectId
        ? html`<div class="text-sec" style="font-size:12px;padding:8px">Select a project</div>`
        : html`<div style="display:grid;gap:10px;font-size:12px;padding-top:4px">
            <div class="text-sec" style="font-size:11px">Agent count, lead planner, backup planners (used when a slot CLI is unavailable), and default effort for the adaptive planner panel.</div>
            ${plannerPanelErr ? html`<div data-testid="planner-panel-err" style="color:#f85149;font-size:11px">${plannerPanelErr}</div>` : null}
            <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
              <label style="display:flex;align-items:center;gap:6px">
                <span class="text-sec" style="font-size:11px">Agent count</span>
                <input data-testid="planner-panel-agent-count" type="number" min="1" max="8" style="width:56px;font-size:11px" value=${(plannerPanel.members || []).length || 2}
                  oninput=${(e) => setPlannerPanelMemberCount(e.target.value)} />
              </label>
              <label style="display:flex;align-items:center;gap:6px">
                <span class="text-sec" style="font-size:11px">Default effort</span>
                <select data-testid="planner-panel-default-effort" style="font-size:11px" value=${plannerPanel.default_effort || 'med'}
                  onchange=${(e) => { setPlannerPanel((p) => ({ ...p, default_effort: e.target.value })); setPlannerPanelDirty(true); }}>
                  ${['low', 'med', 'high', 'xhigh'].map((t) => html`<option value=${t}>${t}</option>`)}
                </select>
              </label>
            </div>
            <div>
              <div class="text-sec" style="font-size:11px;margin-bottom:4px">Members <span class="inline-note">(exactly one Lead)</span></div>
              <div style="display:grid;gap:6px" data-testid="planner-panel-members">
                ${(plannerPanel.members || []).map((m, idx) => html`<div data-testid=${`planner-panel-member-${idx}`} style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;background:var(--bg-elevated, rgba(255,255,255,.02));border:1px solid var(--border);border-radius:6px">
                  <span class="text-sec" style="font-size:10px;width:28px">#${idx + 1}</span>
                  <select data-testid=${`planner-panel-member-model-${idx}`} aria-label=${`Panel member ${idx + 1} model`} style="flex:1;min-width:140px;font-size:11px"
                    value=${m.model_id !== '' && m.model_id != null ? String(m.model_id) : ''}
                    onchange=${(e) => updatePlannerPanelMember(idx, { model_id: e.target.value ? Number(e.target.value) : '' })}>
                    <option value="">— model —</option>
                    ${plannerPanelModelOpts()}
                  </select>
                  <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer" title="Lead planner">
                    <input type="radio" name="planner-panel-lead" data-testid=${`planner-panel-member-lead-${idx}`}
                      checked=${!!m.is_lead}
                      onchange=${() => updatePlannerPanelMember(idx, { is_lead: true })} />
                    Lead
                  </label>
                  <select data-testid=${`planner-panel-member-effort-${idx}`} aria-label=${`Panel member ${idx + 1} effort`} style="width:90px;font-size:11px"
                    value=${m.effort || ''}
                    onchange=${(e) => updatePlannerPanelMember(idx, { effort: e.target.value })}>
                    <option value="">default</option>
                    ${['low', 'med', 'high', 'xhigh'].map((t) => html`<option value=${t}>${t}</option>`)}
                  </select>
                </div>`)}
              </div>
            </div>
            <div>
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
                <span class="text-sec" style="font-size:11px">Backup planners <span class="inline-note">(ordered fallback)</span></span>
                <button data-testid="planner-panel-add-backup" class="btn btn-sm" onclick=${addPlannerPanelBackup}>+ Backup</button>
              </div>
              <div style="display:grid;gap:4px" data-testid="planner-panel-backups">
                ${(plannerPanel.backups || []).length === 0
                  ? html`<div class="text-sec" style="font-size:11px;padding:4px 0">No backups — unavailable member CLIs will not fall back</div>`
                  : (plannerPanel.backups || []).map((b, idx) => html`<div data-testid=${`planner-panel-backup-${idx}`} style="display:flex;gap:6px;align-items:center">
                      <span class="text-sec" style="font-size:10px;width:28px">B${idx + 1}</span>
                      <select data-testid=${`planner-panel-backup-model-${idx}`} aria-label=${`Backup ${idx + 1} model`} style="flex:1;font-size:11px"
                        value=${b.model_id !== '' && b.model_id != null ? String(b.model_id) : ''}
                        onchange=${(e) => updatePlannerPanelBackup(idx, e.target.value ? Number(e.target.value) : '')}>
                        <option value="">— model —</option>
                        ${plannerPanelModelOpts()}
                      </select>
                      <button class="btn btn-sm" style="color:#f85149" data-testid=${`planner-panel-backup-remove-${idx}`} aria-label="Remove backup"
                        onclick=${() => removePlannerPanelBackup(idx)}>×</button>
                    </div>`)}
              </div>
            </div>
          </div>`}
    </div>`;
    /** AC-5: layout gate by agents.classification; role fallback only when missing. */
    const resolvePaDrawerClassification = (pa) => {
      const cls = pa?.agent?.classification;
      if (cls === 'solo' || cls === 'tiered' || cls === 'team') return cls;
      const role = pa?.role || pa?.agent?.role || '';
      if (role === 'implementer' || role === 'validator') return 'tiered';
      if (role === 'planner' || role === 'deliberation' || role === 'red-team') return 'team';
      return 'solo';
    };
    const renderPaOverrideDrawer = (pa) => {
      const aid = pa.agent_id;
      const pid = activeProjectId;
      const studio = studioAgentForPa(pa);
      const studioInDev = !!(studio && studio.in_development);
      const modelOverridden = Number(pa.use_dynamic) === 1 || pa.model_id != null;
      const backupOverridden = pa.backup_model_id != null;
      const effortOverridden = pa.effort_override != null;
      const spawnOverridden = pa.spawn_pref_override != null;
      const readinessOverridden = pa.disabled_override != null;
      const inheritedModel = Number(pa.use_dynamic) === 1
        ? 'dynamic'
        : (studio?.default_model_id != null ? modelLabelById(studio.default_model_id) : (studio?.model || 'agent default'));
      const inheritedBackup = studio?.backup_model_id != null ? modelLabelById(studio.backup_model_id) : 'none';
      const inheritedEffort = studio?.default_effort || pa.effective?.effort || 'medium';
      const inheritedSpawn = studio?.spawn_pref || pa.effective?.spawn_pref || 'tmux';
      const inheritedReadiness = studioInDev ? 'in development (Studio)' : 'ready';
      const readinessVal = pa.disabled_override == null ? 'inherit' : (Number(pa.disabled_override) === 1 ? 'disabled' : 'enabled');
      const paDetail = (paOverrideDetail && paOverrideDetail.agent_id === aid) ? paOverrideDetail : null;
      const toolkitsOverridden = !!paDetail?.overrides?.toolkits_overridden;
      const escalationsOverridden = !!paDetail?.overrides?.escalations_overridden;
      const paToolkits = paDetail?.toolkits || [];
      const paEscalations = paDetail?.escalations || [];
      const inheritedToolkitsLabel = paToolkits.length ? paToolkits.map((t) => t.name).join(', ') : 'none';
      const inheritedEscalationsLabel = paEscalations.length
        ? paEscalations.map((e) => `L${Number(e.position) + 1}: ${e.model_name || e.model_id} (${e.trigger})`).join('; ')
        : 'none';
      const paToolkitAttachOptions = allToolkits.filter((t) => !paToolkits.some((at) => Number(at.id) === Number(t.id)));
      const personaOverridden = !!pa.has_persona_override || paDetail?.overrides?.definition_md_override != null;
      const studioPersona = paDetail?.agent?.definition_md ?? studio?.definition_md ?? '';
      const effectivePersona = paDetail?.definition_md ?? studioPersona;
      const isPersonaEditing = paPersonaEditingAid === aid;
      const paEscModelOpts = (modelsList || []).map((m) => {
        const valid = m.validation_status === 'valid';
        return html`<option value=${m.id} disabled=${!valid}>${m.name} (${m.provider})</option>`;
      });
      const stopRowClick = (e) => e.stopPropagation();
      const classification = resolvePaDrawerClassification(pa);

      // Field fragments — preserve ALL testids / save / reset / inherit (AC-5–8 UI).
      const modelField = html`<div>
        <label style="font-size:11px;color:var(--text-sec)">L1 default model</label>
        <select data-testid=${`project-agent-model-select-${aid}`} aria-label="Default model override" style="width:100%;font-size:11px;margin-top:2px" value=${getCurrentModelVal(pa)} onmousedown=${stopRowClick} onchange=${(e) => setAgentModel(pid, aid, e.target.value)}>
          ${projAgentModelOpts(pa)}
        </select>
        ${inheritedHint(inheritedModel, modelOverridden)}
        ${modelOverridden ? resetInheritBtn(`project-agent-model-reset-${aid}`, (e) => { e.stopPropagation(); applyPaOverrides(pid, aid, { model_id: null, use_dynamic: 0 }); }) : null}
      </div>`;
      const backupField = html`<div>
        <label style="font-size:11px;color:var(--text-sec)">Backup model</label>
        <select data-testid=${`project-agent-backup-select-${aid}`} aria-label="Backup model override" style="width:100%;font-size:11px;margin-top:2px" value=${pa.backup_model_id != null ? String(pa.backup_model_id) : ''} onmousedown=${stopRowClick} onchange=${(e) => {
          const v = e.target.value;
          applyPaOverrides(pid, aid, { backup_model_id: v ? Number(v) : null });
        }}>
          <option value="">— inherit —</option>
          ${(modelsList || []).map(m => {
            const valid = m.validation_status === 'valid';
            return html`<option value=${m.id} disabled=${!valid}>${m.name} (${m.provider})</option>`;
          })}
        </select>
        ${inheritedHint(inheritedBackup, backupOverridden)}
        ${backupOverridden ? resetInheritBtn(`project-agent-backup-reset-${aid}`, (e) => { e.stopPropagation(); applyPaOverrides(pid, aid, { backup_model_id: null }); }) : null}
      </div>`;
      const effortField = html`<div>
        <label style="font-size:11px;color:var(--text-sec)">Effort tier</label>
        <select data-testid=${`project-agent-effort-select-${aid}`} aria-label="Effort tier override" style="width:100%;font-size:11px;margin-top:2px" value=${pa.effort_override || ''} onmousedown=${stopRowClick} onchange=${(e) => {
          const v = e.target.value;
          applyPaOverrides(pid, aid, { effort_override: v || null });
        }}>
          <option value="">— inherit —</option>
          ${['low', 'medium', 'high', 'xhigh', 'max'].map(t => html`<option value=${t}>${t}</option>`)}
        </select>
        ${inheritedHint(inheritedEffort, effortOverridden)}
        ${effortOverridden ? resetInheritBtn(`project-agent-effort-reset-${aid}`, (e) => { e.stopPropagation(); applyPaOverrides(pid, aid, { effort_override: null }); }) : null}
      </div>`;
      const spawnField = html`<div>
        <label style="font-size:11px;color:var(--text-sec)">Spawn preference</label>
        <select data-testid=${`project-agent-spawn-select-${aid}`} aria-label="Spawn preference override" style="width:100%;font-size:11px;margin-top:2px" value=${pa.spawn_pref_override || ''} onmousedown=${stopRowClick} onchange=${(e) => {
          const v = e.target.value;
          applyPaOverrides(pid, aid, { spawn_pref_override: v || null });
        }}>
          <option value="">— inherit —</option>
          <option value="tmux">tmux</option>
          <option value="in-process">in-process</option>
        </select>
        ${inheritedHint(inheritedSpawn, spawnOverridden)}
        ${spawnOverridden ? resetInheritBtn(`project-agent-spawn-reset-${aid}`, (e) => { e.stopPropagation(); applyPaOverrides(pid, aid, { spawn_pref_override: null }); }) : null}
      </div>`;
      const readinessField = html`<div>
        <label style="font-size:11px;color:var(--text-sec)">Readiness</label>
        ${studioInDev
          ? html`<div style="font-size:11px;margin-top:4px">
              <span class="chip chip-yellow">in development (Studio)</span>
              <div class="text-sec" style="font-size:10px;margin-top:4px">Cannot enable — Studio marks this agent in development.</div>
            </div>`
          : html`<select data-testid=${`project-agent-readiness-select-${aid}`} aria-label="Readiness override" style="width:100%;font-size:11px;margin-top:2px" value=${readinessVal} onmousedown=${stopRowClick} onchange=${(e) => {
            const v = e.target.value;
            if (v === 'inherit') applyPaOverrides(pid, aid, { disabled_override: null });
            else if (v === 'disabled') applyPaOverrides(pid, aid, { disabled_override: 1 });
            else applyPaOverrides(pid, aid, { disabled_override: 0 });
          }}>
            <option value="inherit">— inherit —</option>
            <option value="enabled">Ready on this project</option>
            <option value="disabled">Disabled on this project</option>
          </select>`}
        ${!studioInDev ? inheritedHint(inheritedReadiness, readinessOverridden) : inheritedHint(inheritedReadiness, false)}
        ${readinessOverridden && !studioInDev ? resetInheritBtn(`project-agent-readiness-reset-${aid}`, (e) => { e.stopPropagation(); applyPaOverrides(pid, aid, { disabled_override: null }); }) : null}
      </div>`;
      const toolkitsSection = html`<div style="margin-top:6px;padding-top:8px;border-top:1px dashed var(--border)" data-testid=${`project-agent-toolkits-section-${aid}`}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span class="text-sec" style="font-size:10px">Skills / toolkits</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:10px;cursor:pointer" onmousedown=${stopRowClick}>
            <input data-testid=${`project-agent-toolkits-override-toggle-${aid}`} type="checkbox" aria-label="Override skills and toolkits on this project" checked=${toolkitsOverridden} onchange=${async (e) => {
              e.stopPropagation();
              if (e.target.checked) await savePaToolkits(pid, aid, paToolkits, true);
              else await resetPaToolkits(pid, aid);
            }} />
            Override on this project
          </label>
        </div>
        <div style="border:1px solid var(--border);border-radius:6px;padding:4px 6px;min-height:40px;${toolkitsOverridden ? '' : 'opacity:.65'}" data-testid=${`project-agent-toolkits-list-${aid}`}>
          ${paToolkits.length === 0
            ? html`<div class="text-sec" style="font-size:11px;padding:4px" data-testid=${`project-agent-toolkits-empty-${aid}`}>${toolkitsOverridden ? 'none (override empty)' : 'none attached'}</div>`
            : paToolkits.map((t, idx) => html`<div data-testid=${`project-agent-toolkit-row-${t.name}-${aid}`} key=${t.id}>
              <div style="display:flex;align-items:center;justify-content:space-between;padding:2px 4px;font-size:12px;gap:4px">
                <span class="text-mono" style=${toolkitsOverridden ? '' : 'color:var(--text-sec)'}>${t.name}.md</span>
                ${toolkitsOverridden ? html`<div style="display:flex;gap:2px">
                  <button class="btn btn-sm" style="font-size:10px;padding:0 4px" disabled=${idx === 0} onclick=${async (e) => {
                    e.stopPropagation();
                    const next = [...paToolkits];
                    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                    await savePaToolkits(pid, aid, next);
                  }}>↑</button>
                  <button class="btn btn-sm" style="font-size:10px;padding:0 4px" disabled=${idx === paToolkits.length - 1} onclick=${async (e) => {
                    e.stopPropagation();
                    const next = [...paToolkits];
                    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                    await savePaToolkits(pid, aid, next);
                  }}>↓</button>
                  <button class="btn btn-sm" style="color:#f85149" onclick=${async (e) => {
                    e.stopPropagation();
                    await savePaToolkits(pid, aid, paToolkits.filter((x) => Number(x.id) !== Number(t.id)));
                  }}>×</button>
                </div>` : null}
              </div>
            </div>`)}
          ${toolkitsOverridden ? html`<div style="margin-top:4px;display:flex;gap:6px;align-items:center">
            <select data-testid=${`project-agent-toolkit-attach-select-${aid}`} aria-label="Attach toolkit override" style="flex:1;font-size:11px" id=${`pa-toolkit-sel-${aid}`} onmousedown=${stopRowClick}>
              ${paToolkitAttachOptions.length === 0
                ? html`<option value="">— no more toolkits —</option>`
                : paToolkitAttachOptions.map((t) => html`<option value=${t.id}>${t.name}</option>`)}
            </select>
            <button data-testid=${`project-agent-toolkit-attach-btn-${aid}`} class="btn btn-sm" disabled=${paToolkitAttachOptions.length === 0} onclick=${async (e) => {
              e.stopPropagation();
              const sel = document.getElementById(`pa-toolkit-sel-${aid}`);
              if (!sel || !sel.value) return;
              const tk = allToolkits.find((x) => Number(x.id) === Number(sel.value));
              if (!tk) return;
              await savePaToolkits(pid, aid, [...paToolkits, tk]);
            }}>+ Add</button>
          </div>` : null}
        </div>
        ${!toolkitsOverridden ? inheritedHint(inheritedToolkitsLabel, false) : null}
        ${toolkitsOverridden ? resetInheritBtn(`project-agent-toolkits-reset-${aid}`, (e) => { e.stopPropagation(); resetPaToolkits(pid, aid); }) : null}
      </div>`;
      // B6b/AC-9+AC-10: L2/L3/L4 (positions 1–3); L4 empty = unused (no position-3 row).
      const escalationsSection = html`<div data-testid=${`project-agent-escalations-section-${aid}`}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span class="text-sec" style="font-size:10px">L2 / L3 / L4 escalation ladder</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:10px;cursor:pointer" onmousedown=${stopRowClick}>
            <input data-testid=${`project-agent-escalations-override-toggle-${aid}`} type="checkbox" aria-label="Override escalation ladder on this project" checked=${escalationsOverridden} onchange=${async (e) => {
              e.stopPropagation();
              if (e.target.checked) await savePaEscalations(pid, aid, paEscalations, true);
              else await resetPaEscalations(pid, aid);
            }} />
            Override on this project
          </label>
        </div>
        <div style="border:1px solid var(--border);border-radius:6px;padding:6px;${escalationsOverridden ? '' : 'opacity:.65'}">
          ${[1, 2, 3].map((pos) => {
            const level = `L${pos + 1}`;
            const rung = paEscalations.find((x) => Number(x.position) === pos) || {};
            const curMid = rung.model_id != null ? String(rung.model_id) : '';
            const curTrig = rung.trigger || 'on-fail';
            const curEffort = rung.effort == null || rung.effort === '' ? '' : String(rung.effort);
            const effortSuffix = rung.effort ? ` · ${rung.effort}` : '';
            const rungLabel = rung.model_name ? `${rung.model_name} (${curTrig}${effortSuffix})` : '— none —';
            return escalationsOverridden
              ? html`<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px" data-testid=${`project-agent-escalation-rung-${pos}-${aid}`}>
                <span style="width:74px;font-size:11px">${level}</span>
                <select data-testid=${`project-agent-escalation-model-${pos}-${aid}`} aria-label=${`${level} escalation model override`} style="flex:1;font-size:11px" value=${curMid} onmousedown=${stopRowClick} onchange=${async (ev) => {
                  ev.stopPropagation();
                  const newMid = ev.target.value ? Number(ev.target.value) : null;
                  const others = paEscalations.filter((x) => Number(x.position) !== pos);
                  // Empty model = unused rung (esp. L4); omit so payload has no position-N row.
                  if (!newMid) {
                    await savePaEscalations(pid, aid, others);
                    return;
                  }
                  const m = (modelsList || []).find((x) => x.id === newMid);
                  const next = [{
                    position: pos,
                    model_id: newMid,
                    trigger: curTrig,
                    effort: curEffort || null,
                    model_name: m?.name,
                    provider: m?.provider
                  }, ...others];
                  await savePaEscalations(pid, aid, next);
                }}>
                  <option value="">— none —</option>
                  ${paEscModelOpts}
                </select>
                <select data-testid=${`project-agent-escalation-effort-${pos}-${aid}`} data-pa-esc-effort=${`${aid}-${pos}`} aria-label=${`${level} escalation effort override`} style="width:90px;font-size:11px" value=${curEffort} onmousedown=${stopRowClick} onchange=${async (ev) => {
                  ev.stopPropagation();
                  if (!rung.model_id) return;
                  const newEffort = ev.target.value || null;
                  const next = paEscalations.map((x) => ({
                    ...x,
                    effort: Number(x.position) === pos ? newEffort : (x.effort ?? null)
                  }));
                  await savePaEscalations(pid, aid, next);
                }}>
                  <option value="">— inherit —</option>
                  ${['low', 'medium', 'high', 'xhigh', 'max'].map(t => html`<option value=${t}>${t}</option>`)}
                </select>
                <select data-testid=${`project-agent-escalation-trigger-${pos}-${aid}`} aria-label=${`${level} escalation trigger override`} style="width:90px;font-size:11px" value=${curTrig} onmousedown=${stopRowClick} onchange=${async (ev) => {
                  ev.stopPropagation();
                  if (!rung.model_id) return;
                  const next = paEscalations.map((x) => ({
                    ...x,
                    trigger: Number(x.position) === pos ? ev.target.value : x.trigger
                  }));
                  await savePaEscalations(pid, aid, next);
                }}>
                  <option value="on-fail">on-fail</option>
                  <option value="plan-summon">plan-summon</option>
                  <option value="ibrain">ibrain</option>
                </select>
              </div>`
              : html`<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;opacity:.65" title="inherited from Studio — check ‘Override on this project’ to edit" data-testid=${`project-agent-escalation-rung-${pos}-${aid}`}>
                <span style="width:74px;font-size:11px">${level}</span>
                <select data-testid=${`project-agent-escalation-inherited-${pos}-${aid}`} aria-label=${`${level} inherited escalation model (read-only)`} disabled style="flex:1;font-size:11px">
                  <option>${rung.model_name || '— none —'}</option>
                </select>
                <select aria-label=${`${level} inherited escalation effort (read-only)`} disabled style="width:90px;font-size:11px">
                  <option>${rung.effort || 'inherit'}</option>
                </select>
                <select aria-label=${`${level} inherited escalation trigger (read-only)`} disabled style="width:90px;font-size:11px">
                  <option>${rung.model_name ? curTrig : '—'}</option>
                </select>
              </div>`;
          })}
        </div>
        ${escalationsOverridden ? resetInheritBtn(`project-agent-escalations-reset-${aid}`, (e) => { e.stopPropagation(); resetPaEscalations(pid, aid); }) : null}
      </div>`;
      const personaSection = html`<div data-testid=${`project-agent-persona-section-${aid}`}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span class="text-sec" style="font-size:10px">Persona</span>
          ${personaOverridden && !isPersonaEditing
            ? html`<span class="chip chip-purple" data-testid=${`project-agent-persona-overridden-badge-${aid}`}>overridden</span>`
            : null}
        </div>
        ${isPersonaEditing
          ? html`<div>
              <textarea data-testid=${`project-agent-persona-textarea-${aid}`} aria-label="Persona override" style="width:100%;height:120px;margin-top:2px;font-family:monospace;font-size:11px;resize:vertical" value=${paPersonaDraft} onmousedown=${stopRowClick} oninput=${(e) => { e.stopPropagation(); setPaPersonaDraft(e.target.value); setPaPersonaErr(''); }}></textarea>
              <div style="font-size:10px;color:var(--text-sec);margin-top:2px">${(paPersonaDraft || '').length.toLocaleString()} / ${PA_DEFINITION_MAX.toLocaleString()} chars</div>
              ${paPersonaErr ? html`<div style="color:#f85149;font-size:11px;margin-top:4px" data-testid=${`project-agent-persona-cap-err-${aid}`}>${paPersonaErr}</div>` : null}
              <div style="display:flex;gap:6px;margin-top:6px">
                <button data-testid=${`project-agent-persona-save-${aid}`} class="btn btn-primary btn-sm" onclick=${async (e) => {
                  e.stopPropagation();
                  await savePaPersona(pid, aid, paPersonaDraft);
                }}>Save</button>
                <button data-testid=${`project-agent-persona-cancel-${aid}`} class="btn btn-sm" onclick=${(e) => {
                  e.stopPropagation();
                  setPaPersonaEditingAid(null);
                  setPaPersonaDraft('');
                  setPaPersonaErr('');
                }}>Cancel</button>
              </div>
            </div>`
          : html`<div style="border:1px solid var(--border);border-radius:6px;padding:6px;${personaOverridden ? '' : 'opacity:.65'}" data-testid=${`project-agent-persona-preview-${aid}`}>
              <textarea readonly data-testid=${`project-agent-persona-inherited-${aid}`} aria-label="Persona preview" style="width:100%;height:100px;font-family:monospace;font-size:11px;resize:vertical;background:var(--surface-2);color:var(--text-sec);border:none;outline:none" value=${effectivePersona || ''}></textarea>
            </div>`}
        ${!personaOverridden && !isPersonaEditing
          ? html`<div class="text-sec" style="font-size:10px;margin-top:2px" data-testid=${`project-agent-persona-inherited-hint-${aid}`}>inherited from Studio</div>`
          : null}
        ${!isPersonaEditing ? html`<div style="display:flex;gap:6px;margin-top:6px">
            <button data-testid=${`project-agent-persona-edit-${aid}`} class="btn btn-sm" onclick=${(e) => {
              e.stopPropagation();
              setPaPersonaEditingAid(aid);
              setPaPersonaDraft(effectivePersona || '');
              setPaPersonaErr('');
            }}>${personaOverridden ? 'Edit override' : 'Edit persona'}</button>
            ${personaOverridden ? resetInheritBtn(`project-agent-persona-reset-${aid}`, (e) => { e.stopPropagation(); resetPaPersona(pid, aid); }) : null}
          </div>` : null}
      </div>`;

      // Build only the active layout branch so field VNodes are not shared across parents.
      let bodyFields;
      if (classification === 'solo' || (classification === 'team' && pa.role === 'planner')) {
        // AC-6 solo: ≥2-col grid (col1 model+backup, col2 effort+spawn+readiness); hide empty L2+ ladder.
        // AC-8 final / DEC-10 (B10): team planner drawer = planner panel ONLY (strip L1/backup/effort/
        // spawn/readiness solo fields); keep toolkits/persona full-width BELOW the panel.
        if (classification === 'solo') {
          const soloFieldsBlock = html`<div data-testid=${`pa-drawer-grid-${aid}`} style="display:grid;grid-template-columns:1fr 1fr;gap:8px 12px">
            <div style="display:grid;gap:8px;align-content:start">${modelField}${backupField}</div>
            <div style="display:grid;gap:8px;align-content:start">${effortField}${spawnField}${readinessField}</div>
          </div>`;
          bodyFields = html`${soloFieldsBlock}${toolkitsSection}${personaSection}${pa.role === 'planner' ? plannerPanelBlock : ''}`;
        } else {
          // classification === 'team' && role === 'planner': panel-only + toolkits/persona below.
          bodyFields = html`${plannerPanelBlock}${toolkitsSection}${personaSection}`;
        }
      } else if (classification === 'tiered') {
        // AC-7 / B6b: dense L1–L4 ladder; L1 model+effort + backup; L2–L4 model+effort+trigger (L4 empty default).
        const tieredLadderBlock = html`<div data-testid=${`pa-drawer-ladder-${aid}`} style="display:grid;gap:6px">
          <div style="display:grid;grid-template-columns:48px 1fr 1fr;gap:6px 8px;align-items:start">
            <div class="text-sec" style="font-size:10px;font-weight:600;padding-top:18px">L1</div>
            <div>${modelField}</div>
            <div>${effortField}</div>
          </div>
          <div style="padding-left:56px">${backupField}</div>
          ${escalationsSection}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-top:4px">
            ${spawnField}
            ${readinessField}
          </div>
        </div>`;
        bodyFields = html`${tieredLadderBlock}${toolkitsSection}${personaSection}`;
      } else {
        // Two distinct cases land here, and conflating them sent operators to the wrong screen:
        //  (a) a genuine team non-planner (deliberation / red-team) → roster lives in Team roles (B8);
        //  (b) ANY team agent with no role bound at all — pa.role is null, so the planner branch above
        //      can't match even on the planner row, and the B8 note is misleading (Team roles is not
        //      where a missing role_bindings row gets fixed).
        const teamNonPlannerNote = pa.role
          ? html`<div data-testid=${`pa-drawer-team-note-${aid}`} class="text-sec" style="font-size:11px;padding:6px 0">
              Configured in Team roles (B8) — deliberation / red-team roster override not in this drawer yet.
            </div>`
          : html`<div data-testid=${`pa-drawer-unbound-role-note-${aid}`} class="text-sec" style="font-size:11px;padding:6px 0">
              No project role is bound to this agent, so its role-specific editor can’t load — a team
              agent bound to <b>planner</b> shows the Planner Panel here. New projects seed the standard
              role bindings at creation; add a missing one via the project config API (<code>bindings</code>).
            </div>`;
        bodyFields = html`${teamNonPlannerNote}${toolkitsSection}${personaSection}`;
      }

      return html`<tr data-testid=${`project-agent-override-drawer-${aid}`} data-classification=${classification}>
        <td colspan="6" style="padding:0;background:var(--bg-elevated, rgba(255,255,255,.02))">
          <div style="padding:10px 12px 12px;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px">
              <div style="display:flex;align-items:center;gap:8px;min-width:0">
                <span style="font-size:11px;font-weight:600">Override editor — ${projectAgentLabel(pa)}</span>
                ${paSaveFlash ? html`<span class="chip chip-green" data-testid="project-agent-save-flash" style="font-size:10px">Saved ✓</span>` : null}
              </div>
              <button data-testid=${`project-agent-drawer-close-${aid}`} class="btn btn-sm" title="Close editor" aria-label="Close override editor" onclick=${(e) => { e.stopPropagation(); closePaDrawer(); }}>×</button>
            </div>
            ${paOverrideLoading ? html`<div class="text-sec" style="font-size:11px">Loading…</div>` : html`
              <div style="display:grid;gap:8px">
                ${bodyFields}
              </div>
            `}
          </div>
        </td>
      </tr>`;
    };
    const projectAgentLabel = (pa) => pa.agent?.name || pa.agent_id || '—';
    const chipForProjectAgentValue = (value) => {
      const r = value || '—';
      const cls = (r.includes('plancore') || r.includes('ibrain') || r === 'claude') ? 'chip-blue' : (r.includes('codex') || r.includes('spark')) ? 'chip-teal' : r.includes('grok') ? 'chip-purple' : (r.includes('sonnet') || r === 'qa') ? 'chip-green' : 'chip-gray';
      return html`<span class="chip ${cls}">${r}</span>`;
    };
    const techStackValue = (value) => value || 'not specified';
    const techStackSummary = activeTechStack === undefined
      ? html`<span data-testid="project-detail-tech-stack-loading">—</span>`
      : activeTechStack === null
        ? html`<span data-testid="project-detail-tech-stack-missing">no tech-stack doc</span>`
        : html`<span data-testid="project-detail-tech-stack" style="display:inline-flex;flex-direction:column;gap:4px;vertical-align:top">
            <span style="display:inline-flex;gap:6px;flex-wrap:wrap">
              <span class="chip chip-gray">Language: ${techStackValue(activeTechStack.language)}</span>
              <span class="chip chip-gray">Framework: ${techStackValue(activeTechStack.framework)}</span>
              <span class="chip chip-gray">Key Dependencies: ${techStackValue(activeTechStack.key_dependencies)}</span>
            </span>
            <span data-testid="project-detail-tech-stack-caption" class="text-sec" style="font-size:10px">Auto-read from helm_docs/tech-stack.md — edit in the Documents tab</span>
          </span>`;
    const renderProjectUrl = (testId, value) => {
      const url = normalizeOptionalText(value);
      return url
        ? html`<a data-testid=${testId} href=${url} target="_blank" rel="noopener noreferrer">${url}</a>`
        : html`<span data-testid=${testId}>—</span>`;
    };
    const renderProjectTags = (tags) => {
      const normalized = normalizeTagList(tags);
      return normalized.length
        ? html`<span data-testid="project-detail-tags" style="display:inline-flex;gap:4px;flex-wrap:wrap;vertical-align:top">
            ${normalized.map(tag => html`<span class="chip chip-teal" data-testid="project-tag-chip">${tag}</span>`)}
          </span>`
        : html`<span data-testid="project-detail-tags">—</span>`;
    };
    const addEditingProjectTag = () => {
      if (!editingProject) return;
      const next = normalizeTagList([...(editingProject.tags || []), editingProject.tagInput || '']);
      setEditingProject({ ...editingProject, tags: next, tagInput: '' });
    };
    const removeEditingProjectTag = (tag) => {
      if (!editingProject) return;
      const key = String(tag).toLowerCase();
      setEditingProject({ ...editingProject, tags: normalizeTagList(editingProject.tags).filter(t => t.toLowerCase() !== key) });
    };

    const detailSubTab = html`<div>
      ${activeProject ? html`
        <div class="card mt-8" style="min-width:0;overflow:hidden">
          <div class="card-header">
            <div class="card-title" data-testid="project-detail-name">
              ${editingProject
                ? html`<input data-testid="edit-proj-name" aria-label="Project name" class="input" value=${editingProject.name} oninput=${e => setEditingProject({...editingProject, name: e.target.value})} style="font-size:13px;font-weight:600;width:100%" />`
                : html`<span class="truncate-ellipsis" style="width:100%" title=${activeProject.name}>${activeProject.name}</span>`}
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0">
              ${editingProject
                ? html`<button data-testid="save-edit-project-btn" class="btn btn-primary btn-sm" disabled=${!editingProject.name.trim()||!editingProject.dir.trim()} onclick=${updateProject}>Save</button>
                       <button class="btn btn-sm" onclick=${() => { setEditingProject(null); setProjectOpErr(''); }}>Cancel</button>`
                : html`<button data-testid="edit-project-btn" class="btn btn-sm" onclick=${() => { setProjectOpErr(''); setEditingProject({ name: activeProject.name, dir: activeProject.directory || '', description: activeProject.description || '', dev_url: activeProject.dev_url || '', qa_url: activeProject.qa_url || '', tags: normalizeTagList(activeProject.tags), tagInput: '' }); }}>Edit</button>`}
            </div>
          </div>
          <div style="display:grid;gap:6px;font-size:12px;margin-top:6px">
            <div>
              <span class="text-sec" style="width:100px;display:inline-block;vertical-align:top">Description</span>
              ${editingProject
                ? html`<textarea data-testid="edit-proj-description" aria-label="Project description" class="input" placeholder="Describe this project's purpose and goals" value=${editingProject.description} oninput=${e => setEditingProject({...editingProject, description: e.target.value})} rows="3" style="font-size:12px;width:calc(100% - 110px);resize:vertical;vertical-align:top"></textarea>`
                : html`<span data-testid="project-detail-description" style="display:inline-block;width:calc(100% - 110px);white-space:pre-wrap;vertical-align:top">${activeProject.description || '—'}</span>`}
            </div>
            <div style="display:flex;gap:6px;align-items:baseline;min-width:0">
              <span class="text-sec" style="width:100px;flex-shrink:0">Directory</span>
              ${editingProject
                ? html`<input data-testid="edit-proj-dir" aria-label="Project directory path" class="input" value=${editingProject.dir} oninput=${e => setEditingProject({...editingProject, dir: e.target.value})} style="font-size:11px;font-family:monospace;flex:1;min-width:0" />`
                : html`<span class="text-mono truncate-ellipsis" data-testid="project-detail-dir" title=${activeProject.directory || ''} style="flex:1;min-width:0">${activeProject.directory || '—'}</span>`}
            </div>
            <div><span class="text-sec" style="width:100px;display:inline-block">Agents</span><span data-testid="project-detail-agent-count">${(projectAgents || []).length} assigned</span></div>
            <div><span class="text-sec" style="width:100px;display:inline-block">Valid models</span><span data-testid="project-detail-model-count">${validModelCount} available</span></div>
            <div>
              <span class="text-sec" style="width:100px;display:inline-block">Status</span>
              <span data-testid="project-detail-status" title=${activeProjectStatus && activeProjectStatus.active ? 'Helm run in progress' : 'No active Helm run'} class=${`chip ${activeProjectStatus && activeProjectStatus.active ? 'chip-green' : 'chip-gray'}`}>${activeProjectStatus && activeProjectStatus.active ? 'Active' : 'Idle'}</span>
            </div>
            <div><span class="text-sec" style="width:100px;display:inline-block">Last activity</span><span data-testid="project-detail-last-activity">${formatDateTime(activeProjectStatus?.last_activity_at || activeProject.updated_at)}</span></div>
            <div><span class="text-sec" style="width:100px;display:inline-block">Branch</span><span class="text-mono" data-testid="project-detail-branch">${activeProjectStatus?.git_branch || '—'}</span></div>
            <div><span class="text-sec" style="width:100px;display:inline-block;vertical-align:top">Tech stack</span>${techStackSummary}</div>
            <div>
              <span class="text-sec" style="width:100px;display:inline-block">Dev URL</span>
              ${editingProject
                ? html`<input data-testid="edit-proj-dev-url" aria-label="Development deploy URL" class="input" value=${editingProject.dev_url} oninput=${e => setEditingProject({...editingProject, dev_url: e.target.value})} style="font-size:11px;width:calc(100% - 110px)" />`
                : renderProjectUrl('project-detail-dev-url', activeProject.dev_url)}
            </div>
            <div>
              <span class="text-sec" style="width:100px;display:inline-block">QA URL</span>
              ${editingProject
                ? html`<input data-testid="edit-proj-qa-url" aria-label="QA deploy URL" class="input" value=${editingProject.qa_url} oninput=${e => setEditingProject({...editingProject, qa_url: e.target.value})} style="font-size:11px;width:calc(100% - 110px)" />`
                : renderProjectUrl('project-detail-qa-url', activeProject.qa_url)}
            </div>
            <div>
              <span class="text-sec" style="width:100px;display:inline-block;vertical-align:top">Tags</span>
              ${editingProject
                ? html`<span data-testid="edit-proj-tags" style="display:inline-flex;width:calc(100% - 110px);gap:6px;flex-wrap:wrap;vertical-align:top">
                    ${normalizeTagList(editingProject.tags).map(tag => html`<button data-testid="edit-proj-tag-chip" class="chip chip-teal" style="border:0;cursor:pointer" onclick=${() => removeEditingProjectTag(tag)} title="Remove tag">${tag} ×</button>`)}
                    <input data-testid="edit-proj-tag-input" class="input" placeholder="Add tag" value=${editingProject.tagInput || ''} oninput=${e => setEditingProject({...editingProject, tagInput: e.target.value})} onkeydown=${e => { if (e.key === 'Enter') { e.preventDefault(); addEditingProjectTag(); } }} style="font-size:11px;width:120px" />
                    <button data-testid="add-proj-tag-btn" class="btn btn-sm" disabled=${!String(editingProject.tagInput || '').trim()} onclick=${addEditingProjectTag}>Add</button>
                  </span>`
                : renderProjectTags(activeProject.tags)}
            </div>
            <div><span class="text-sec" style="width:100px;display:inline-block">plancore</span><span class="text-mono">${activeProject.plancore_session || '—'}</span></div>
            <div data-testid="project-autonomy-default" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
              <div class="text-sec" style="font-size:11px;margin-bottom:6px">Autonomy default <span class="inline-note">(new cycles inherit this)</span></div>
              <div style="display:flex;flex-direction:column;gap:6px;font-size:12px">
                <label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer">
                  <input type="radio" name="project-autonomy-default" data-testid="autonomy-pause-after-planning" disabled=${projectAutonomySaving || !activeProjectId} checked=${projectAutonomyDefault === 'pause_after_planning'} onchange=${() => activeProjectId && saveProjectAutonomyDefault(activeProjectId, 'pause_after_planning')} />
                  <span><strong>Pause after Planning for approval</strong><span class="inline-note" style="display:block;font-size:10px">default: pause after planning</span></span>
                </label>
                <label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer">
                  <input type="radio" name="project-autonomy-default" data-testid="autonomy-autonomous-after-discovery" disabled=${projectAutonomySaving || !activeProjectId} checked=${projectAutonomyDefault === 'autonomous_after_discovery'} onchange=${() => activeProjectId && saveProjectAutonomyDefault(activeProjectId, 'autonomous_after_discovery')} />
                  <span><strong>Fully autonomous after Discovery</strong><span class="inline-note" style="display:block;font-size:10px">default: fully autonomous</span></span>
                </label>
              </div>
            </div>
          </div>
        </div>
      ` : null}
    </div>`;

    const classificationChip = (pa) => {
      const cls = pa.agent?.classification || 'solo';
      const chipCls = cls === 'tiered' ? 'chip-blue' : cls === 'team' ? 'chip-purple' : 'chip-gray';
      return html`<span data-testid=${`project-agent-classification-${pa.agent_id}`} data-class=${cls} class="chip ${chipCls}" style="font-size:10px">${cls}</span>`;
    };
    const agentsSubTab = html`<div data-testid="project-agents-panel">
      <div>
        <div class="top-toolbar" style="margin-bottom:8px">
          <div class="btn-group">
            <button data-testid="set-default-btn" title="Reset all agent model overrides to their Studio defaults" class="btn btn-sm" disabled=${!activeProjectId} onclick=${() => activeProjectId && setAllToDefault(activeProjectId)}>Set to default</button>
            <button data-testid="add-all-btn" class="btn btn-sm" disabled=${!activeProjectId} onclick=${() => activeProjectId && addAllAgentsToProject(activeProjectId)}>Add all agents</button>
            <button data-testid="add-agent-btn" class="btn btn-primary btn-sm" disabled=${!activeProjectId} onclick=${() => {
              if (!activeProjectId) return;
              const aid = addAgentSel ? Number(addAgentSel) : null;
              if (aid) {
                addProjectAgent(activeProjectId, aid);
                setAddAgentSel('');
              } else {
                const avail = (agentsList || []).filter(a => isProjectAddCandidate(a) && !projectAgents.some(pa => pa.agent_id === a.id));
                if (avail.length) addProjectAgent(activeProjectId, avail[0].id);
              }
            }}>+ Agent</button>
          </div>
        </div>
        ${paErr ? html`<div style="color:#f85149;font-size:12px;margin-bottom:6px" data-testid="project-agent-err">${paErr}</div>` : null}
        ${!activeProjectId
          ? html`<div class="text-sec" style="font-size:12px;padding:8px">Select a project from the list</div>`
          : projectAgents.length === 0
            ? html`<div class="text-sec" style="font-size:12px;padding:8px">No agents assigned yet</div>`
            : html`<table><thead><tr><th>Agent</th><th>Class</th><th>Provider</th><th>Role</th><th>Resolved model</th><th>Primary</th><th></th></tr></thead><tbody>
                ${projectAgents.flatMap(pa => {
                  const isOpen = expandedPaAgentId === pa.agent_id;
                  const stopRowClick = (e) => e.stopPropagation();
                  const rows = [html`<tr key=${`pa-row-${pa.agent_id}`} data-testid=${`project-agent-row-${pa.agent_id}`} style=${isOpen ? 'background:rgba(32,178,170,.06)' : 'cursor:pointer'} onclick=${() => activeProjectId && togglePaDrawer(activeProjectId, pa.agent_id)}>
                  <td>
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                      <span style="display:inline-flex;align-items:center;gap:5px;min-width:0">
                        ${paHasOverrides(pa)
                          ? html`<span data-testid=${`project-agent-has-overrides-${pa.agent_id}`} title="has project overrides" style="font-size:8px;color:var(--text-sec);opacity:.75;line-height:1" aria-label="has project overrides">●</span>`
                          : null}
                        <strong>${projectAgentLabel(pa)}</strong>
                      </span>
                      <span data-testid=${`project-agent-expand-caret-${pa.agent_id}`} data-expanded=${isOpen ? 'true' : 'false'} class="text-sec" style="font-size:10px;display:inline-block;transition:transform .15s ease;transform:rotate(${isOpen ? '180deg' : '0deg'})" aria-hidden="true">▾</span>
                    </div>
                  </td>
                  <td>${classificationChip(pa)}</td>
                  <td>${chipForProjectAgentValue(pa.agent?.provider)}</td>
                  <td>${pa.role ? chipForProjectAgentValue(pa.role) : html`<span class="text-sec">—</span>`}</td>
                  <td data-testid=${`project-agent-resolved-model-${pa.agent_id}`}><span class="chip chip-gray">${resolvedModelLabel(pa)}</span></td>
                  <td><input type="radio" name=${`primary-${activeProjectId || 'p'}`} checked=${pa.is_primary_driver === 1} onclick=${stopRowClick} onchange=${() => activeProjectId && setAgentPrimary(activeProjectId, pa.agent_id)} /> ${pa.is_primary_driver === 1 ? html`<span class="chip chip-green">★</span>` : null}</td>
                  <td><button class="btn btn-sm" style="color:#f85149" aria-label="Remove agent" onclick=${(e) => { e.stopPropagation(); removeProjectAgent(activeProjectId, pa.agent_id); }}>×</button></td>
                </tr>`];
                  if (isOpen) rows.push(renderPaOverrideDrawer(pa));
                  return rows;
                })}
              </tbody></table>`}
        <div style="margin-top:10px;display:flex;gap:6px;align-items:center">
          <select data-testid="add-agent-select" aria-label="Select agent to add" style="flex:1;font-size:11px" value=${addAgentSel} onchange=${e => setAddAgentSel(e.target.value)}>
            <option value="">— add agent —</option>
            ${(agentsList || []).filter(a => isProjectAddCandidate(a) && !(projectAgents || []).some(pa => pa.agent_id === a.id)).map(a => html`<option value=${a.id}>${a.name}</option>`)}
          </select>
        </div>
        ${activeProjectId ? html`<div data-testid="team-roles-strip" style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-sec);margin-bottom:8px;font-weight:600">Team roles <span class="inline-note" style="font-weight:400">(deliberation / red-team — Studio bind + optional project roster override)</span></div>
          ${ROLE_ROSTER_ROLES.map((role) => {
            const rr = roleRosters[role] || emptyRoleRosterState();
            const tb = (projectTeamBindings || []).find((b) => b.role === role);
            const boundTeamId = rr.team_id != null ? rr.team_id : (tb ? tb.team_id : null);
            const teamName = boundTeamId != null
              ? ((teamsList || []).find((t) => t.id === boundTeamId || Number(t.id) === Number(boundTeamId))?.name || boundTeamId)
              : null;
            const isOverride = rr.source === 'project';
            const members = rr.members || [];
            return html`<div key=${`team-roster-${role}`} data-testid=${`team-roster-${role}`} style="margin-bottom:12px;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-elevated, rgba(255,255,255,.02))">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                  <span class="chip chip-teal">${role}</span>
                  <span data-testid=${`team-roster-source-${role}`} class=${'chip ' + (isOverride ? 'chip-orange' : 'chip-gray')} style="font-size:10px" title=${isOverride ? 'Project roster override active' : 'Effective roster from Studio team (or empty if unbound)'}>
                    ${isOverride ? 'Project override' : 'Studio'}
                  </span>
                  ${teamName
                    ? html`<span class="text-sec" style="font-size:11px">team: ${teamName}</span>`
                    : html`<span class="text-sec" style="font-size:11px">${isOverride ? 'override (no Studio team bound)' : 'no team bound'}</span>`}
                  ${tb
                    ? html`<button data-testid=${`team-unbind-${role}`} class="btn btn-sm" style="color:#f85149" title="Unbind Studio team" aria-label=${`Unbind ${role} team`}
                        onclick=${() => unbindProjectTeam(activeProjectId, role)}>×</button>`
                    : null}
                </div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                  ${rr.flash ? html`<span class="chip chip-green" data-testid=${`team-roster-save-flash-${role}`} style="font-size:10px">Saved ✓</span>` : null}
                  <button data-testid=${`team-roster-save-${role}`} class="btn btn-primary btn-sm"
                    disabled=${!activeProjectId || rr.saving || !rr.dirty}
                    onclick=${() => activeProjectId && saveRoleRoster(activeProjectId, role)}>
                    ${rr.saving ? 'Saving…' : 'Save (override)'}
                  </button>
                  <button data-testid=${`team-roster-reset-${role}`} class="btn btn-sm"
                    disabled=${!activeProjectId || rr.saving || !isOverride}
                    title=${isOverride ? 'Clear project override; revert to Studio team roster' : 'No project override to reset'}
                    onclick=${() => activeProjectId && resetRoleRoster(activeProjectId, role)}>
                    Reset to Studio
                  </button>
                </div>
              </div>
              ${rr.err ? html`<div data-testid=${`team-roster-err-${role}`} style="color:#f85149;font-size:11px;margin-bottom:6px">${rr.err}</div>` : null}
              ${!tb && !isOverride && members.length === 0
                ? html`<div class="text-sec" style="font-size:11px;margin-bottom:6px" data-testid=${`team-roster-empty-${role}`}>No Studio team bound and no override — bind a team below, or add members and Save to set a project override.</div>`
                : null}
              <div style="display:grid;gap:6px" data-testid=${`team-roster-members-${role}`}>
                ${members.map((m, idx) => html`<div data-testid=${`team-roster-member-${role}-${idx}`} style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 8px;background:var(--bg, rgba(0,0,0,.15));border:1px solid var(--border);border-radius:6px">
                  <span class="text-sec" style="font-size:10px;width:28px">#${idx + 1}</span>
                  <select data-testid=${`team-roster-member-model-${role}-${idx}`} aria-label=${`${role} member ${idx + 1} model`} style="flex:1;min-width:140px;font-size:11px"
                    value=${m.model_id !== '' && m.model_id != null ? String(m.model_id) : ''}
                    onchange=${(e) => updateRoleRosterMember(role, idx, { model_id: e.target.value ? Number(e.target.value) : '' })}>
                    <option value="">— model —</option>
                    ${plannerPanelModelOpts()}
                  </select>
                  <input data-testid=${`team-roster-member-lens-${role}-${idx}`} aria-label=${`${role} member ${idx + 1} lens`} type="text" placeholder="lens (optional)" style="width:120px;font-size:11px"
                    value=${m.lens || ''}
                    oninput=${(e) => updateRoleRosterMember(role, idx, { lens: e.target.value })} />
                  <button class="btn btn-sm" style="color:#f85149" data-testid=${`team-roster-member-remove-${role}-${idx}`} aria-label=${`Remove ${role} member ${idx + 1}`}
                    onclick=${() => removeRoleRosterMember(role, idx)}>×</button>
                </div>`)}
              </div>
              <div style="margin-top:6px">
                <button data-testid=${`team-roster-add-${role}`} class="btn btn-sm" onclick=${() => addRoleRosterMember(role)}>+ Member</button>
              </div>
            </div>`;
          })}
          <div style="display:flex;gap:6px;margin-top:4px;align-items:center;flex-wrap:wrap">
            <select data-testid="add-team-select" aria-label="Select team to bind" style="flex:1;min-width:140px;font-size:11px" value=${addTeamSel} onchange=${e => setAddTeamSel(e.target.value)}>
              <option value="">— team —</option>
              ${(teamsList || []).map(t => html`<option value=${t.id}>${t.name}</option>`)}
            </select>
            <button data-testid="add-team-btn" class="btn btn-sm" disabled=${!activeProjectId || !addTeamSel} onclick=${()=>{ if(activeProjectId && addTeamSel){ bindProjectTeam(activeProjectId, 'deliberation', Number(addTeamSel)); setAddTeamSel(''); } }}>+ Bind deliberation</button>
            <button data-testid="bind-red-btn" class="btn btn-sm" disabled=${!activeProjectId || !addTeamSel} onclick=${()=>{ if(activeProjectId && addTeamSel){ bindProjectTeam(activeProjectId, 'red-team', Number(addTeamSel)); setAddTeamSel(''); } }}>+ Red-team</button>
          </div>
        </div>` : null}
      </div>
    </div>`;

    const docsSubTab = html`<div data-testid="project-docs-panel">
      <div style="display:flex;gap:4px;padding:8px 10px;border-bottom:1px solid var(--border)">
        <button data-testid="doc-subtab-docs" class=${'btn btn-sm' + (docSubTab === 'docs' ? ' btn-primary' : '')}
          onclick=${() => { setDocSubTab('docs'); setViewedDoc(null); }}>Docs</button>
        <button data-testid="doc-subtab-tasks" class=${'btn btn-sm' + (docSubTab === 'tasks' ? ' btn-primary' : '')}
          onclick=${() => { setDocSubTab('tasks'); setViewedDoc(null); }}>Tasks</button>
      </div>
      ${docSubTab === 'docs'
        ? html`<div>
            <div class="section-note">Docs — helm_docs/ reference. Grouped by folder. Click .md to view; edit or create below.</div>
            <div style="display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid var(--border)">
              <button data-testid="docs-new-btn" class="btn btn-sm btn-primary" disabled=${!activeProjectId} onclick=${() => { setDocsNewOpen(o => !o); setDocsNewErr(''); }}>+ New doc</button>
            </div>
            ${docsNewOpen ? html`<div data-testid="docs-new-form" class="card" style="margin:8px 10px;padding:10px;display:flex;flex-direction:column;gap:6px">
              <input data-testid="docs-new-folder" aria-label="New document folder" class="input" style="font-size:11px" placeholder="Folder (optional, e.g. reference)" value=${docsNewFolder} oninput=${e => setDocsNewFolder(e.target.value)} />
              <input data-testid="docs-new-name" aria-label="New document filename" class="input" style="font-size:11px" placeholder="Filename (e.g. notes.md)" value=${docsNewName} oninput=${e => setDocsNewName(e.target.value)} />
              <textarea data-testid="docs-new-content" aria-label="New document content" class="input" style="font-size:11px;min-height:80px;font-family:ui-monospace,monospace" placeholder="# New doc\n" value=${docsNewContent} oninput=${e => setDocsNewContent(e.target.value)}></textarea>
              ${docsNewErr ? html`<div data-testid="docs-new-err" style="font-size:11px;color:#f85149">${docsNewErr}</div>` : null}
              <div style="display:flex;gap:6px">
                <button data-testid="docs-new-save" class="btn btn-sm btn-primary" onclick=${createNewDoc}>Create</button>
                <button data-testid="docs-new-cancel" class="btn btn-sm" onclick=${() => { setDocsNewOpen(false); setDocsNewErr(''); }}>Cancel</button>
              </div>
            </div>` : null}
            <div class="file-list" data-testid="docs-tree">
              ${(helmDocsTree || []).length > 0
                ? groupHelmDocsByFolder(helmDocsTree).map((grp) => html`<div data-testid=${`docs-group-${grp.folderSlug}`} style="margin-bottom:8px">
                    <div class="text-sec" style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:6px 10px 4px;background:var(--surface-2);border-bottom:1px solid var(--border)">📁 ${grp.folder}</div>
                    ${grp.files.map((doc) => {
                      const rel = doc.relPath || doc.filename;
                      const displayRel = doc.displayRel || normalizeHelmDocRel(rel);
                      const slug = slugifyDocPath(displayRel);
                      const isMd = displayRel.endsWith('.md');
                      const viewedNorm = viewedDoc?.relPath ? normalizeHelmDocRel(viewedDoc.relPath) : null;
                      const isActiveDoc = !!viewedNorm && normalizeHelmDocRel(rel) === viewedNorm;
                      const openDocRow = () => { if (isMd && activeProjectId) viewProjectDoc(activeProjectId, rel); };
                      return html`<div class=${`file-row${isActiveDoc ? ' list-item selected' : ''}`} style=${`padding-left:12px${isActiveDoc ? ';background:var(--accent-surface);border-left:3px solid var(--accent)' : ''}`} role="button" tabindex="0" aria-label=${`View document ${displayRel}`} data-testid=${`doc-row-${slug}`} data-active-doc=${isActiveDoc ? 'true' : 'false'} onclick=${openDocRow} onkeydown=${(e) => activateOnEnterSpace(e, openDocRow)}>
                        <div style="flex:1;min-width:0"><div class="file-name" title=${displayRel}>${displayRel.includes('/') ? displayRel.slice(displayRel.lastIndexOf('/') + 1) : displayRel}</div></div>
                        ${isMd ? html`<button class="btn btn-sm" data-testid=${`view-doc-${slug}`}>view ↗</button>` : null}
                      </div>`;
                    })}
                  </div>`)
                : !activeProjectId
                  ? html`<div class="text-sec" style="font-size:12px;padding:8px">Select a project from the list</div>`
                  : html`<div class="text-sec" style="font-size:12px;padding:8px">No docs yet</div>`}
            </div>
          </div>`
        : (() => {
            const taskRows = (projectTaskRows[activeProjectId] || []);
            const { groups: taskGroups, unmapped } = groupHelmTasksByTasklist(docsTree, taskRows);
            return html`<div>
            <div class="section-note">Tasks — helm_tasks/ grouped by tasklist. Status from Helm run task state (read-only).</div>
            <div class="file-list" data-testid="tasks-tree">
              ${taskGroups.length > 0
                ? taskGroups.map((grp) => html`<div data-testid=${`tasks-group-${grp.tasklistSlug}`} style="margin-bottom:10px">
                    <div class="text-sec" style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:6px 10px 4px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                      <span>📁 ${grp.tasklist}</span>
                      ${grp.rollup.working ? html`<span class="chip chip-orange" style="font-size:9px" data-testid=${`tasks-group-rollup-${grp.tasklistSlug}`}>${grp.rollup.working} working</span>` : null}
                      ${grp.rollup.pending ? html`<span class="chip chip-gray" style="font-size:9px">${grp.rollup.pending} pending</span>` : null}
                      ${grp.rollup.completed ? html`<span class="chip chip-green" style="font-size:9px">${grp.rollup.completed} done</span>` : null}
                    </div>
                    ${grp.units.map((unit) => {
                      const st = unit.taskRow?.status;
                      const fileBase = (f) => {
                        const dr = f.displayRel || normalizeHelmTaskRel(f.relPath);
                        return dr.includes('/') ? dr.slice(dr.lastIndexOf('/') + 1) : dr;
                      };
                      return html`<div data-testid=${`task-unit-${unit.taskSlugSlug}`} style="margin:4px 0 6px">
                        <div class="file-row" style="padding-left:10px;background:var(--surface)">
                          <div style="flex:1;min-width:0;display:flex;align-items:center;gap:6px">
                            <div class="file-name" style="font-weight:600">${unit.taskSlug}</div>
                            ${st ? html`<span class=${`chip ${taskStatusChipClass(st)}`} style="font-size:9px" data-testid=${`task-status-${unit.taskSlugSlug}`}>${st}</span>` : null}
                          </div>
                        </div>
                        ${unit.files.map((doc) => {
                          const rel = doc.relPath || doc.filename;
                          const isMd = rel.endsWith('.md');
                          const fileSlug = slugifyDocPath(doc.displayRel || normalizeHelmTaskRel(rel));
                          const openTaskFile = () => { if (isMd && activeProjectId) viewProjectDoc(activeProjectId, rel); };
                          const taskFileLabel = fileBase(doc);
                          const taskFileRel = doc.displayRel || normalizeHelmTaskRel(rel);
                          return html`<div class="file-row" style="padding-left:22px" role="button" tabindex="0" aria-label=${`View task file ${taskFileLabel}`} data-testid=${`task-file-${fileSlug}`} onclick=${openTaskFile} onkeydown=${(e) => activateOnEnterSpace(e, openTaskFile)}>
                            <div style="flex:1;min-width:0"><div class="file-name" title=${taskFileRel}>${fileBase(doc)}</div></div>
                            ${isMd ? html`<button class="btn btn-sm" data-testid=${`view-task-${fileSlug}`}>view ↗</button>` : null}
                          </div>`;
                        })}
                      </div>`;
                    })}
                  </div>`)
                : !activeProjectId
                  ? html`<div class="text-sec" style="font-size:12px;padding:8px">Select a project from the list</div>`
                  : html`<div class="text-sec" style="font-size:12px;padding:8px">No tasks</div>`}
              ${unmapped > 0 ? html`<div class="text-sec" style="font-size:10px;padding:4px 10px" data-testid="tasks-unmapped-note">${unmapped} run task${unmapped === 1 ? '' : 's'} not shown (no matching helm_tasks folder)</div>` : null}
            </div>
          </div>`;
          })()}
      ${viewedDoc ? html`
        <div class="card mt-12" data-testid="viewed-doc-pane">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div class="card-title">${viewedDoc.relPath || viewedDoc.filename}</div>
            ${docSubTab === 'docs' ? html`<div style="display:flex;gap:6px;flex-shrink:0">
              ${docEditing
                ? html`<button data-testid="docs-edit-save" class="btn btn-sm btn-primary" onclick=${saveDocEdit}>Save</button>
                    <button data-testid="docs-edit-cancel" class="btn btn-sm" onclick=${() => { setDocEditing(false); setDocEditDraft(''); setDocEditErr(''); }}>Cancel</button>`
                : html`<button data-testid="docs-edit-btn" class="btn btn-sm" onclick=${() => { setDocEditDraft(viewedDoc.content || ''); setDocEditing(true); setDocEditErr(''); }}>Edit</button>
                    <button data-testid="docs-delete-btn" class="btn btn-sm" style="color:#f85149" onclick=${deleteViewedDoc}>Delete</button>`}
            </div>` : null}
          </div>
          ${docSubTab === 'docs' && docEditing
            ? html`<textarea data-testid="docs-edit-textarea" aria-label="Edit document content" class="input" style="width:100%;min-height:240px;font-size:11px;font-family:ui-monospace,monospace;margin-top:8px" value=${docEditDraft} oninput=${e => setDocEditDraft(e.target.value)}></textarea>`
            : html`<${MdViewer} content=${viewedDoc.content} testId="md-view" />`}
          ${docSubTab === 'docs' && docEditErr ? html`<div data-testid="docs-edit-err" style="font-size:11px;color:#f85149;margin-top:6px">${docEditErr}</div>` : null}
          ${docSubTab === 'docs' && docDeleteErr ? html`<div data-testid="docs-delete-err" style="font-size:11px;color:#f85149;margin-top:6px">${docDeleteErr}</div>` : null}
          <div class="inline-note mt-8">Safe markdown render. Source of truth is the file on disk.</div>
        </div>
      ` : null}
    </div>`;

    mainContent = html`<div data-testid="content-projects" style="display:flex;gap:0;height:100%;overflow:hidden">
      <div style="width:260px;min-width:220px;border-right:1px solid var(--border);overflow-y:auto;background:var(--surface)">
        <div class="top-toolbar" style="padding:8px 10px;border-bottom:1px solid var(--border)">
          <span class="text-sec" style="font-size:11px">${projectTagFilter ? `${filteredProjects.length}/${(projectsList || []).length}` : (projectsList || []).length} projects</span>
          <select data-testid="project-page-size" aria-label="Items per page" style="font-size:11px;padding:2px 4px" value=${projectPageSize} onchange=${e => { setProjectPageSize(Number(e.target.value)); setProjectPage(0); }}>
            <option value="5">5/page</option>
            <option value="10">10/page</option>
            <option value="15">15/page</option>
          </select>
          <button data-testid="add-project-btn" class="btn btn-primary btn-sm" onclick=${() => { setShowAddForm(s => !s); setNewProjName(''); setNewProjDir(''); setProjectOpErr(''); }}>+ New</button>
        </div>
        <div style="padding:8px 10px;border-bottom:1px solid var(--border);display:flex;gap:4px;align-items:center">
          <select data-testid="project-tag-filter" aria-label="Filter by project tag" style="min-width:0;flex:1;font-size:11px;padding:2px 4px" value=${projectTagFilter} onchange=${e => { setProjectTagFilter(e.target.value); setProjectPage(0); }}>
            <option value="">All tags</option>
            ${allProjectTags.map(tag => html`<option value=${tag}>${tag}</option>`)}
          </select>
          <button data-testid="clear-project-tag-filter" class="btn btn-sm" disabled=${!projectTagFilter} onclick=${() => { setProjectTagFilter(''); setProjectPage(0); }}>Clear</button>
        </div>
        ${showAddForm ? html`<div data-testid="add-project-form" style="padding:8px 10px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:4px;background:var(--surface-2)">
          <input data-testid="new-proj-name" aria-label="New project name" class="input" placeholder="Project name" maxLength=${120} value=${newProjName} oninput=${e => setNewProjName(e.target.value)} style="font-size:11px" />
          <input data-testid="new-proj-dir" aria-label="New project directory path" class="input" placeholder="/path/to/project" maxLength=${300} value=${newProjDir} oninput=${e => setNewProjDir(e.target.value)} style="font-size:11px;font-family:monospace" />
          <div style="display:flex;gap:4px">
            <button data-testid="save-project-btn" class="btn btn-primary btn-sm" disabled=${!newProjName.trim() || !newProjDir.trim()} onclick=${createProject}>Save</button>
            <button class="btn btn-sm" onclick=${() => { setShowAddForm(false); setNewProjName(''); setNewProjDir(''); setProjectOpErr(''); }}>Cancel</button>
          </div>
        </div>` : null}
        ${projectOpErr ? html`<div data-testid="project-op-err" style="font-size:11px;color:#f85149;padding:6px 10px;border-bottom:1px solid var(--border)">${projectOpErr}</div>` : null}
        <div data-testid="project-list">
          ${projectsLoading
            ? html`<div data-testid="projects-loading" class="text-sec" style="font-size:12px;padding:12px">Loading projects…</div>`
            : pagedProjects.length === 0
            ? html`<div class="text-sec" style="font-size:12px;padding:12px">${projectTagFilter ? 'No projects match this tag' : 'No projects yet'}</div>`
            : pagedProjects.map(p => {
              const projectTags = normalizeTagList(p.tags);
              const selectProjectRow = () => { setActiveProjectId(p.id); setProjectSubTab('detail'); setProjectPage(projectPage); setEditingProject(null); setShowAddForm(false); setProjectOpErr(''); setDocSubTab('docs'); setViewedDoc(null); };
              return html`<div
                data-testid=${`project-row-${p.id}`}
                role="button"
                tabindex="0"
                aria-label=${`Select project ${p.name}`}
                class=${'file-row' + (activeProjectId === p.id ? ' active' : '')}
                style=${'cursor:pointer;padding:8px 12px;align-items:flex-start;gap:6px;' + (activeProjectId === p.id ? 'background:var(--surface-2);border-left:3px solid var(--accent,#58a6ff)' : 'border-left:3px solid transparent')}
                onclick=${selectProjectRow}
                onkeydown=${(e) => activateOnEnterSpace(e, selectProjectRow)}>
                <div style="flex:1;min-width:0">
                  <div class="truncate-ellipsis" style="font-size:12px;font-weight:600" title=${p.name}>${p.name}</div>
                  <div class="text-mono truncate-ellipsis" style="font-size:10px;color:var(--text-sec)" title=${p.directory || ''}>${p.directory || '—'}</div>
                  ${projectTags.length ? html`<div data-testid="project-row-tags" style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px">${projectTags.map(tag => html`<span class="chip chip-gray" style="font-size:9px">${tag}</span>`)}</div>` : null}
                </div>
                <button data-testid=${`delete-project-${p.id}`} aria-label="Delete project" class="btn btn-sm" style="color:#f85149;flex-shrink:0" onclick=${(e) => { e.stopPropagation(); deleteProjectById(p.id); }}>×</button>
              </div>`;
            })}
        </div>
        ${totalPages > 1 ? html`<div style="display:flex;justify-content:space-between;padding:6px 10px;border-top:1px solid var(--border)">
          <button class="btn btn-sm" disabled=${projectPage === 0} onclick=${() => setProjectPage(projectPage - 1)}>‹ prev</button>
          <span class="text-sec" style="font-size:11px">${safeProjectPage + 1}/${totalPages}</span>
          <button class="btn btn-sm" disabled=${safeProjectPage >= totalPages - 1} onclick=${() => setProjectPage(safeProjectPage + 1)}>next ›</button>
        </div>` : null}
      </div>
      <div style="flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;padding:12px 14px" data-testid="project-content-pane">
        ${activeProject ? html`
          <div style="min-width:0">
            <div style="display:flex;gap:6px;flex-wrap:wrap;row-gap:6px;margin-bottom:10px" data-testid="project-sub-tabs">
              ${['detail','agents','documents'].map(tab => html`<button
                data-testid=${`project-subtab-${tab}`}
                class=${'btn btn-sm' + (projectSubTab === tab ? ' btn-primary' : '')}
                onclick=${() => { setProjectSubTab(tab); if (tab === 'documents' && activeProjectId) loadProjectDocs(activeProjectId); }}>
                ${tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>`)}
            </div>
            ${projectSubTab === 'detail' ? detailSubTab : projectSubTab === 'agents' ? agentsSubTab : docsSubTab}
          </div>
        ` : html`<div class="text-sec" style="padding:20px;font-size:12px">Select a project from the list to view details</div>`}
      </div>
    </div>`;
  } else if (currentSlug === '07-command-center-overview') {
    // B6-T01: card click opens the cycle workspace in place of the board (state, no slug change).
    mainContent = ccWsCycleId ? renderCommandCenterWorkspace() : renderCommandCenterOverview();
  } else if (['07-command-center-chat','08-command-center-tasks','09-command-center-completed','10-command-center-terminals','11-command-center-timeline'].includes(currentSlug)) {
    mainContent = renderCommandCenter(currentSlug);
  } else if (currentSlug === '10-memory') {
    const projOpts = (projectsList || []).map(p => html`<option value=${p.id}>${p.name}</option>`);
    const typeChip = (t) => {
      const cls = t === 'project' ? 'chip-blue' : t === 'feedback' ? 'chip-orange' : t === 'user' ? 'chip-teal' : 'chip-gray';
      return html`<span class="chip ${cls}">${t}</span>`;
    };
    // B11 helper row with optional short checkbox + horizon chip (for promote flow)
    const memRow = (m) => {
      const isShort = memHorizon === 'short';
      const checked = shortSelected.includes(m.id);
      return html`<div class="memory-row ${m.scope === 'app' && m.status === 'proposed' ? 'pending' : ''}" key=${m.id} data-testid=${`memory-row-${m.id}`} data-mem-id=${m.id}>
        ${isShort ? html`<input type="checkbox" style="margin-right:6px;" checked=${checked} onchange=${() => toggleShortSelect(m.id)} />` : null}
        <div style="flex:1;min-width:0">
          <div class="memory-title">${m.title} ${m.horizon ? html`<span class="chip ${m.horizon==='short'?'chip-orange':'chip-green'}" style="font-size:9px;margin-left:4px">${m.horizon}</span>` : null}</div>
          <div class="memory-desc">${m.description || '—'}</div>
        </div>
        <div style="flex-shrink:0">${typeChip(m.type)}</div>
        <div class="memory-actions">
          <button class="btn btn-sm" onclick=${() => toggleMemBody(m.id)}>view</button>
          ${!isShort ? html`<button class="btn btn-sm" data-testid=${`memory-edit-${m.id}`} onclick=${() => startEditMemory(m)}>edit</button>
          <button class="btn btn-sm" style="color:#f85149" data-testid=${`memory-delete-${m.id}`} onclick=${() => deleteMemory(m.id)}>×</button>` : null }
          ${m.scope === 'app' && m.status === 'proposed' ? html`<button class="btn btn-primary btn-sm" data-testid=${`memory-approve-${m.id}`} onclick=${() => approveMemory(m.id)}>Approve</button>
          <button class="btn btn-danger btn-sm" data-testid=${`memory-reject-${m.id}`} onclick=${() => rejectMemory(m.id)}>Reject</button>` : null }
        </div>
        ${expandedMemId === m.id ? html`<div class="memory-body" style="width:100%;margin-top:4px">${m.body || '(no body)'}</div>` : null}
      </div>`;
    };
    const q = (memSearch || '').toLowerCase().trim();
    const filtered = (memories || []).filter(m => !q || (m.title||'').toLowerCase().includes(q) || (m.description||'').toLowerCase().includes(q) || (m.body||'').toLowerCase().includes(q));
    const pending = filtered.filter(m => m.scope === 'app' && m.status === 'proposed');
    const approved = filtered.filter(m => !(m.scope === 'app' && m.status === 'proposed'));
    const showProjectSel = memScope === 'project';
    mainContent = html`<div data-testid="content-memory">
      <div class="top-toolbar">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="seg-control" data-testid="memory-scope-toggle">
            <button class=${memScope==='app' ? 'seg-btn active' : 'seg-btn'} data-testid="memory-scope-app" onclick=${() => setScope('app')}>App memory</button>
            <button class=${memScope==='project' ? 'seg-btn active' : 'seg-btn'} data-testid="memory-scope-project" onclick=${() => setScope('project')}>Project memory</button>
          </div>
          ${showProjectSel ? html`<select data-testid="memory-project-select" style="width:auto;padding:4px 8px" value=${memProjectId || ''} onchange=${(e) => changeMemProject(e.target.value)}>
            <option value="">— select project —</option>
            ${projOpts}
          </select>` : null}
          <!-- B11 long/short horizon seg (UI3) -->
          <div class="seg-control" data-testid="memory-horizon-toggle" style="margin-left:8px;">
            <button class=${memHorizon==='long' ? 'seg-btn active' : 'seg-btn'} data-testid="memory-horizon-long" onclick=${() => { setMemHorizon('long'); setShortSelected([]); }}>Long-term</button>
            <button class=${memHorizon==='short' ? 'seg-btn active' : 'seg-btn'} data-testid="memory-horizon-short" onclick=${() => { setMemHorizon('short'); setShortSelected([]); }}>Short-term</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <input data-testid="memory-search" style="max-width:220px" placeholder="Search memories..." value=${memSearch} oninput=${e => setMemSearch(e.target.value)} />
          <button data-testid="memory-add-btn" class="btn btn-primary btn-sm" onclick=${startNewMemory}>+ Add</button>
          <button data-testid="memory-refresh-btn" class="btn btn-sm" onclick=${refreshMemories}>Refresh</button>
        </div>
      </div>
      <div class="section-note">Memory is JIT-queried by agents — only relevant notes loaded per task. Agents <strong>propose</strong>; JROM approves app-global ones. Project memory is cross-project readable, write-siloed.</div>

      ${pending.length > 0 ? html`<div style="margin-bottom:8px">
        ${pending.map(m => memRow(m))}
      </div>` : null}

      ${approved.length === 0 && pending.length === 0
        ? html`<div class="card"><div class="inline-note">No memories for this scope${memSearch ? ' (search empty)' : ''}. Use + Add.</div></div>`
        : approved.map(m => memRow(m)) }

      ${memHorizon === 'short' ? html`<div class="card mt-8" style="padding:8px;" data-testid="memory-promote-bar">
        <div style="display:flex;gap:8px;align-items:center;">
          <span class="text-sec" style="font-size:11px;">Short-term items selected: ${shortSelected.length}</span>
          <button class="btn btn-primary btn-sm" data-testid="memory-promote-btn" disabled=${shortSelected.length===0} onclick=${promoteSelected}>Promote selected to long-term</button>
          <button class="btn btn-sm" data-testid="memory-clear-short-btn" onclick=${clearShortRest}>Clear remaining short</button>
        </div>
        <div class="inline-note mt-4" style="font-size:10px;">Select short-term (daily logs/decisions/chats) → promote (curator proposal + JROM approve) → clear the rest. Real backend.</div>
      </div>` : null }

      ${memErr && html`<div style="color:#f85149;font-size:12px;margin-top:8px">${memErr}</div>`}

      ${editingMemory !== null ? html`
        <div class="card mt-16">
          <div class="card-header"><div class="card-title">${editingMemory && editingMemory.id ? 'Edit' : 'New'} memory <span class="inline-note">(${memScope}${memScope==='project' && memProjectId ? ' · proj ' + memProjectId : ''})</span></div></div>
          <div style="display:grid;gap:8px">
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Title</label>
              <input data-testid="memory-form-title" style="flex:1" value=${memForm.title} oninput=${e => setMemForm({...memForm, title: e.target.value})} />
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Description</label>
              <input data-testid="memory-form-description" style="flex:1" value=${memForm.description} oninput=${e => setMemForm({...memForm, description: e.target.value})} placeholder="one-line summary" />
            </div>
            <div style="display:flex;gap:8px;align-items:center">
              <label style="width:80px;font-size:11px">Type</label>
              <select data-testid="memory-form-type" value=${memForm.type} onchange=${e => setMemForm({...memForm, type: e.target.value})}>
                <option value="user">user</option>
                <option value="feedback">feedback</option>
                <option value="project">project</option>
                <option value="reference">reference</option>
              </select>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start">
              <label style="width:80px;font-size:11px;padding-top:4px">Body</label>
              <textarea data-testid="memory-form-body" style="flex:1;height:90px" value=${memForm.body} oninput=${e => setMemForm({...memForm, body: e.target.value})}></textarea>
            </div>
          </div>
          ${memErr && html`<div style="color:#f85149;font-size:12px;margin-top:8px">${memErr}</div>`}
          <div style="margin-top:12px;display:flex;gap:8px">
            <button data-testid="memory-save-btn" class="btn btn-primary btn-sm" onclick=${saveMemory}>Save</button>
            <button data-testid="memory-cancel-btn" class="btn btn-sm" onclick=${cancelEditMemory}>Cancel</button>
            ${editingMemory && editingMemory.id ? html`<button data-testid="memory-delete-btn" class="btn btn-sm" style="margin-left:auto;color:#f85149" onclick=${() => deleteMemory(editingMemory.id)}>Delete</button>` : null}
          </div>
          <div class="inline-note mt-8">Owner creates are approved immediately. App proposed (from agents) require explicit Approve.</div>
        </div>
      ` : null}

      <div class="inline-note mt-12">App scope: proposed (agent) shown first with Approve/Reject; approved shown below. Project scope: always approved, write-siloed to selected project. Search is client-side on loaded (title/desc/body). View expands body inline.</div>
    </div>`;
  } else if (currentSlug === '12-tracking') {
    const snap = trackingSnapshot;
    const runs = (snap && snap.runs) || [];
    const orphanSessions = (snap && snap.orphan_sessions) || [];
    const fmtProgress = (p) => `${p.done}/${p.total} done` + (p.failed ? ` · ${p.failed} failed` : '') + (p.parked ? ` · ${p.parked} parked` : '');
    const runRow = (run) => {
      const id = run.identity.id;
      const workers = run.active_workers || [];
      const sessions = run.active_sessions || [];
      return html`
        <div class="card mt-8" data-testid=${`tracking-run-${id}`} key=${id}>
          <div class="card-header">
            <div class="card-title">
              ${run.project.name} <span class="inline-note">run #${id}</span>
              ${run.identity.external_run_id ? html`<span class="chip chip-blue" style="margin-left:6px">${run.identity.external_run_id}${run.identity.generation ? `/gen${run.identity.generation}` : ''}</span>` : null}
            </div>
            <span class="chip" data-testid=${`tracking-run-source-${id}`}>${run.identity.source}</span>
          </div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text-sec)">
            <span data-testid=${`tracking-run-phase-${id}`}>phase: <strong style="color:var(--text)">${run.phase}</strong></span>
            <span data-testid=${`tracking-run-status-${id}`}>status: <strong style="color:var(--text)">${run.status}</strong></span>
            <span data-testid=${`tracking-run-state-${id}`}>state: <strong style="color:var(--text)">${run.state}</strong></span>
            <span data-testid=${`tracking-run-progress-${id}`}>${fmtProgress(run.progress)}</span>
            <span>batch: ${run.identity.batch_id || '—'}</span>
            <span>last progress: ${run.last_progress_at ? formatRelativeTime(run.last_progress_at) : '—'}</span>
          </div>
          <div class="mt-8">
            <div class="as-roster-section-label">ACTIVE WORKERS (${workers.length})</div>
            ${workers.length ? workers.map(w => html`
              <div class="list-item" data-testid=${`tracking-worker-${w.id}`} key=${w.id} style="cursor:default">
                <span>${w.role}</span> <span class="chip chip-blue" style="margin-left:6px">${w.provider}/${w.model}</span> <span style="margin-left:6px">${w.state}</span>
              </div>`) : html`<div class="inline-note" data-testid=${`tracking-workers-empty-${id}`}>No active workers</div>`}
          </div>
          <div class="mt-8">
            <div class="as-roster-section-label">ACTIVE SESSIONS (${sessions.length})</div>
            ${sessions.length ? sessions.map(s => html`
              <div class="list-item" data-testid=${`tracking-session-${s.id}`} key=${s.id} style="cursor:default">
                <span>${s.name}</span> <span class="chip" style="margin-left:6px">${s.kind || '—'}</span> <span style="margin-left:6px">${s.status}</span>
              </div>`) : html`<div class="inline-note" data-testid=${`tracking-sessions-empty-${id}`}>No active sessions</div>`}
          </div>
        </div>`;
    };
    mainContent = html`<div>
      <div class="top-toolbar">
        <div class="section-note" style="margin-bottom:0;flex:1">Read-only native run substrate — runs, child workers/sessions, progress, source. No mutation controls; manual refresh only.</div>
        <button data-testid="tracking-refresh-btn" class="btn btn-sm" style="margin-left:12px" onclick=${refreshTracking} disabled=${trackingLoading}>${trackingLoading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      ${trackingErr ? html`<div data-testid="tracking-error" style="color:#f85149;font-size:12px;margin-top:8px">${trackingErr}</div>` : null}
      ${!trackingErr && snap && runs.length === 0 ? html`<div class="card mt-8" data-testid="tracking-empty"><div class="inline-note">No runs.</div></div>` : null}
      ${runs.map(runRow)}
      ${orphanSessions.length ? html`<div class="card mt-16" data-testid="tracking-orphans">
        <div class="card-header"><div class="card-title">Orphaned sessions (${orphanSessions.length})</div></div>
        ${orphanSessions.map(s => html`<div class="list-item" data-testid=${`tracking-orphan-${s.id}`} key=${s.id} style="cursor:default">${s.name} · ${s.status}</div>`)}
      </div>` : null}
    </div>`;
  } else if (currentSlug === '13-sessions') {
    // S14b: Sessions panel — owner/status visible; Close only for human-owned non-reaped rows.
    const ownerLabel = (o) => (o == null || o === '' ? '—' : String(o));
    const canClose = (s) => s && s.owner === 'human' && s.status !== 'reaped';
    const ownerChip = (o) => {
      if (o === 'human') return 'chip-green';
      if (o === 'helm') return 'chip-blue';
      return 'chip-gray';
    };
    const sessionRows = (sessionsList || []).map((s) => {
      const name = s.name || '';
      const rowKey = name || String(s.created_at || Math.random());
      return html`
        <div class="list-item" data-testid=${`sessions-row-${name}`} key=${rowKey} style="cursor:default;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <code style="font-size:11px;min-width:12em">${name}</code>
          <span class="chip chip-gray" style="font-size:9px">${s.kind || '—'}</span>
          <span data-testid=${`sessions-owner-${name}`} class=${`chip ${ownerChip(s.owner)}`} style="font-size:9px" title="owner">${ownerLabel(s.owner)}</span>
          <span data-testid=${`sessions-status-${name}`} class="chip" style="font-size:9px" title="status">${s.status || '—'}</span>
          ${canClose(s) ? html`<button
            type="button"
            class="btn btn-sm"
            data-testid=${`sessions-close-${name}`}
            style="margin-left:auto;color:#f85149;border-color:#f85149;font-size:10px;padding:2px 8px"
            disabled=${sessionsClosingName === name || !!sessionsClosingName}
            title="Close this human-owned session"
            onclick=${() => closeRegistrySession(s)}
          >${sessionsClosingName === name ? 'Closing…' : 'Close'}</button>` : html`<span style="margin-left:auto;font-size:10px;color:var(--text-sec)">${s.owner === 'human' && s.status === 'reaped' ? 'already closed' : 'no manual close'}</span>`}
        </div>`;
    });
    mainContent = html`<div data-testid="sessions-panel">
      <div class="top-toolbar">
        <div class="section-note" style="margin-bottom:0;flex:1">Registry sessions with owner and status. Manual close is available only for human-owned sessions (explicit confirmation required).</div>
        <button data-testid="sessions-refresh-btn" class="btn btn-sm" style="margin-left:12px" onclick=${refreshSessions} disabled=${sessionsLoading}>${sessionsLoading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      ${sessionsErr ? html`<div data-testid="sessions-error" style="color:#f85149;font-size:12px;margin-top:8px">${sessionsErr}</div>` : null}
      ${sessionsMsg ? html`<div data-testid="sessions-success" style="color:#3fb950;font-size:12px;margin-top:8px">${sessionsMsg}</div>` : null}
      <div class="card mt-8">
        <div class="card-header"><div class="card-title">Sessions (${(sessionsList || []).length})</div></div>
        ${(sessionsList || []).length
          ? sessionRows
          : html`<div class="inline-note" data-testid="sessions-empty" style="padding:10px">${sessionsLoading ? 'Loading…' : 'No sessions in registry.'}</div>`}
      </div>
    </div>`;
  }

  if (isStudio) {
    if (!studioAgentsCol) studioAgentsCol = buildStudioAgentsRoster();
    if (!studioCenterCol) {
      studioCenterCol = html`<div data-testid="as-col-center" class="as-col-center" style="overflow-y:auto;padding:16px 20px">${mainContent}</div>`;
    }
  }

  const studioContextHeaderName = studioSelectedAgent?.name || (selectedAgentId ? agentName : null);
  const studioChatHeaderName = selectedTeamId
    ? ((teamsList || []).find(t => t.id === selectedTeamId)?.name || 'Team')
    : (studioSelectedAgent?.name || agentName || 'Select an agent');
  const studioChatHeaderMeta = selectedTeamId
    ? 'team editor'
    : (studioSelectedAgent ? `${studioSelectedAgent.provider} · ${studioSelectedAgent.model}` : '');
  const studioColAgentsPx = agentsColCollapsed ? '34px' : `${colAgentsWidth}px`;
  const studioColContextPx = contextColCollapsed ? '34px' : `${colContextWidth}px`;
  const studioGridVars = { '--col-agents': studioColAgentsPx, '--col-context': studioColContextPx };

  const studioTopbar = isStudio ? html`
    <div data-testid="as-topbar" class=${`as-topbar ${agentsColCollapsed ? 'agents-collapsed' : ''} ${contextColCollapsed ? 'context-collapsed' : ''}`.trim()} style=${studioGridVars}>
      <div class="as-topbar-slot as-topbar-agents" data-testid="as-topbar-agents" style="display:flex;align-items:center;justify-content:${agentsColCollapsed ? 'center' : 'flex-end'}">
        <button class="as-col-collapse-btn" data-testid="as-agents-collapse" type="button" onclick=${toggleAgentsCol} title=${agentsColCollapsed ? 'Expand agents list' : 'Collapse agents list (full view)'}>${agentsColCollapsed ? '⟩' : '⟨'}</button>
      </div>
      <div class="as-topbar-slot as-topbar-chat" data-testid="as-topbar-chat">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <span style="font-size:13px;font-weight:600;color:var(--text)">${studioChatHeaderName}</span>
          ${isJkageL0Learner(studioSelectedAgent, agentDefMd) ? jkageL0LearnerBadge('as-jkage-l0-badge-topbar') : null}
          ${studioChatHeaderMeta ? html`<span class="text-sec" style="font-size:11px">${studioChatHeaderMeta}</span>` : null}
        </div>
        <div class="tab-strip" style="display:flex;gap:0;margin-left:auto">
          ${tabs.map(t => html`<div class=${`tab ${currentSlug===t.slug?'active':''}`} data-testid=${`tab-${t.key}`} onclick=${() => onTab(t.slug)}>${t.label}</div>`)}
        </div>
      </div>
      <div class="as-topbar-slot as-topbar-context" data-testid="as-topbar-context" style="display:flex;align-items:center;gap:6px">
        <button class="as-col-collapse-btn" data-testid="as-context-collapse" type="button" onclick=${toggleContextCol} title=${contextColCollapsed ? 'Expand agent context' : 'Collapse agent context (full view)'}>${contextColCollapsed ? '⟨' : '⟩'}</button>
        ${contextColCollapsed ? '' : html`<span>Agent Context${studioContextHeaderName ? html`<span style="margin-left:6px;font-weight:500;color:var(--accent)">${studioContextHeaderName}</span>` : ''}</span>`}
      </div>
    </div>` : null;

  const contextBoundModel = studioSelectedAgent ? resolveAgentBoundModel(studioSelectedAgent, modelsList) : null;
  const contextRole = studioSelectedAgent
    ? (deriveAgentFrontmatterField(agentDefMd, 'role') || studioSelectedAgent.agent_type || studioSelectedAgent.name)
    : '';
  const contextVersion = studioSelectedAgent ? deriveAgentFrontmatterField(agentDefMd, 'version') : '';
  const contextRoleLine = [contextRole, contextVersion ? `v${contextVersion}` : ''].filter(Boolean).join(' · ');
  const contextDescription = studioSelectedAgent ? (deriveAgentDescription(agentDefMd) || 'No description available') : '';
  const contextSkillsCount = attachedToolkits.length;
  const contextModelLabel = contextBoundModel?.name
    || (studioSelectedAgent ? `${studioSelectedAgent.provider} · ${studioSelectedAgent.model}` : '—');
  const contextValidationStatus = contextBoundModel?.validation_status || 'untested';
  const contextPermissionsLabel = contextBoundModel?.approval || bindings.spawn_pref || '—';
  const validationChipClass = contextValidationStatus === 'valid' ? 'chip-green'
    : contextValidationStatus === 'invalid' ? 'chip-red' : 'chip-gray';

  const studioContextCol = isStudio ? html`
    <div data-testid="as-col-context" class="as-col-context">
      <div class="as-context-body" data-testid="as-context-body">
        ${!studioSelectedAgent ? html`
          <div class="as-context-empty" data-testid="as-context-empty">Select an agent to see its context</div>
        ` : html`
          <div class="as-context-identity-card" data-testid="as-context-identity">
            <button
              type="button"
              class="as-context-card-header"
              data-testid="as-context-identity-toggle"
              aria-expanded=${contextIdentityExpanded}
              onclick=${() => setContextIdentityExpanded(!contextIdentityExpanded)}
            >
              <span class="as-context-card-title">Identity</span>
              <span class="as-context-chevron" aria-hidden="true">${contextIdentityExpanded ? '∨' : '›'}</span>
            </button>
            <div class="as-context-identity-summary">
              <div class="as-context-identity-role" data-testid="as-context-identity-role" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span>${contextRoleLine || studioSelectedAgent.name}</span>
                ${isJkageL0Learner(studioSelectedAgent, agentDefMd) ? jkageL0LearnerBadge('as-jkage-l0-badge-context') : null}
              </div>
              ${!contextIdentityExpanded ? html`
                <div class="as-context-identity-preview">${contextDescription}</div>
              ` : null}
            </div>
            ${contextIdentityExpanded ? html`
              <div class="as-context-identity-detail" data-testid="as-context-identity-detail">${contextDescription}</div>
            ` : null}
          </div>
          <div class="as-context-section" data-testid="as-context-skills">
            <div class="as-context-section-header as-context-section-header-labeled">
              <span class="as-roster-section-label as-context-section-label-inline">SKILLS</span>
              <span class="chip chip-purple as-context-skills-pill" data-testid="as-context-skills-count">${contextSkillsCount} skills</span>
            </div>
          </div>
          <div class="as-context-section" data-testid="as-context-memory">
            <div class="as-context-section-header as-context-section-header-labeled">
              <span class="as-roster-section-label as-context-section-label-inline">MEMORY</span>
              <span class="chip chip-gray as-context-memory-loaded" data-testid="as-context-memory-loaded">${studioContextMemories.length} loaded</span>
            </div>
            <div class="as-context-memory-body">
              ${studioContextMemories.length === 0 ? html`
                <div class="as-context-memory-empty" data-testid="as-context-memory-empty">No memories loaded for this agent</div>
              ` : studioContextMemories.map(m => html`
                <div class="as-context-memory-card" data-testid=${`as-context-memory-card-${m.id}`} key=${m.id}>
                  <div class="as-context-memory-card-top">
                    <span class=${`chip ${memoryScopeChipClass(m.scope)} as-context-memory-scope-tag`} data-testid=${`as-context-memory-scope-${m.scope}`}>${memoryScopeLabel(m.scope)}</span>
                    <span class="as-context-memory-time" data-testid=${`as-context-memory-time-${m.id}`}>${formatRelativeTime(m.updated_at || m.created_at)}</span>
                  </div>
                  <div class="as-context-memory-title" data-testid=${`as-context-memory-title-${m.id}`}>${m.title}</div>
                  <div class="as-context-memory-summary" data-testid=${`as-context-memory-summary-${m.id}`}>${memoryOneLineSummary(m)}</div>
                </div>
              `)}
            </div>
            <div class="as-context-memory-controls" data-testid="as-context-memory-controls">
              <button type="button" class="as-context-memory-control" data-testid="as-context-memory-add" onclick=${goStudioAddMemory}>+ Add memory</button>
              <button type="button" class="as-context-memory-control" data-testid="as-context-memory-search" onclick=${goStudioSearchMemories}>Search all memories</button>
            </div>
          </div>
          <div class="as-context-section" data-testid="as-context-settings">
            <div class="as-roster-section-label as-context-section-label">SETTINGS</div>
            <div class="as-context-settings-rows">
              <div class="as-context-settings-row" data-testid="as-context-settings-model">
                <span class="as-context-settings-key">Model</span>
                <span class="as-context-settings-val">${contextModelLabel}</span>
              </div>
              <div class="as-context-settings-row" data-testid="as-context-settings-validation">
                <span class="as-context-settings-key">Validation</span>
                <span class=${`chip ${validationChipClass} as-context-settings-val`}>${contextValidationStatus}</span>
              </div>
              <div class="as-context-settings-row as-context-settings-inert" data-testid="as-context-settings-permissions">
                <span class="as-context-settings-key">Permissions</span>
                <span class="as-context-settings-val text-sec">${contextPermissionsLabel}</span>
              </div>
            </div>
          </div>
          <div class="as-context-section as-context-section-activity" data-testid="as-context-activity">
            <div class="as-context-section-header as-context-section-header-labeled">
              <span class="as-roster-section-label as-context-section-label-inline">RECENT ACTIVITY</span>
              <button
                type="button"
                class="as-context-activity-sort"
                data-testid="as-context-activity-sort"
                aria-label="Toggle activity sort order"
                title=${studioActivitySortAsc ? 'Oldest first' : 'Newest first'}
                onclick=${() => setStudioActivitySortAsc(!studioActivitySortAsc)}
              >⇅</button>
            </div>
            <div class="as-context-activity-body" data-testid="as-context-activity-body" data-loaded=${studioContextActivityLoaded}>
              ${!studioContextActivityLoaded ? html`
                <div class="as-context-activity-empty" data-testid="as-context-activity-loading">Loading activity…</div>
              ` : studioContextActivity.length === 0 ? html`
                <div class="as-context-activity-empty" data-testid="as-context-activity-empty">No recent activity</div>
              ` : (studioActivitySortAsc ? [...studioContextActivity].reverse() : studioContextActivity).map((ev, i) => html`
                <div class="as-context-activity-row" data-testid=${`as-context-activity-row-${ev.id || i}`} key=${ev.id || i}>
                  <span class=${`as-activity-dot ${activityDotClass(ev)}`} data-testid=${`as-context-activity-dot-${ev.id || i}`} aria-hidden="true"></span>
                  <span class="as-context-activity-text" data-testid=${`as-context-activity-text-${ev.id || i}`}>${activityEventText(ev)}</span>
                  <span class="as-context-activity-time" data-testid=${`as-context-activity-time-${ev.id || i}`}>${activityEventTime(ev)}</span>
                </div>
              `)}
            </div>
          </div>
        `}
      </div>
    </div>` : null;

  const collapsedColsCls = `${agentsColCollapsed ? 'agents-collapsed' : ''} ${contextColCollapsed ? 'context-collapsed' : ''}`.trim();
  const studioCols = isStudio ? html`
    <div class="as-studio-cols-wrap" style=${studioGridVars}>
      <div class=${`as-studio-cols ${collapsedColsCls}`} data-testid=${currentSlug === '02-studio-agents' ? 'content-studio-agents' : `content-${activeSection}`}>
        ${agentsColCollapsed
          ? html`<div class="as-col-collapsed" data-testid="as-col-agents-collapsed" onclick=${toggleAgentsCol} title="Expand agents list"><span class="as-col-collapsed-chev">⟩</span><span class="as-col-collapsed-label">AGENTS</span></div>`
          : studioAgentsCol}
        ${studioCenterCol}
        ${contextColCollapsed
          ? html`<div class="as-col-collapsed" data-testid="as-col-context-collapsed" onclick=${toggleContextCol} title="Expand agent context"><span class="as-col-collapsed-chev">⟨</span><span class="as-col-collapsed-label">CONTEXT</span></div>`
          : studioContextCol}
      </div>
      ${!agentsColCollapsed && !studioLayoutMobile ? html`<div class="as-col-splitter as-col-splitter-agents" data-testid="as-col-splitter-agents" onpointerdown=${e => startColRailDrag('agents', e)}></div>` : null}
      ${!contextColCollapsed && !studioLayoutMobile ? html`<div class="as-col-splitter as-col-splitter-context" data-testid="as-col-splitter-context" onpointerdown=${e => startColRailDrag('context', e)}></div>` : null}
    </div>` : null;

  return html`
    ${!token ? html`
      <div class="login-center" style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;background:var(--bg)">
        <div class="login-card" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:32px 28px;width:320px;text-align:center">
          <div class="login-logo" style="font-size:28px;font-weight:700;color:var(--text);margin-bottom:4px">Helm</div>
          <div class="login-sub" style="font-size:12px;color:var(--text-sec);margin-bottom:24px">agent orchestration</div>
          <div class="form-row" style="margin-bottom:12px">
            <label style="font-size:11px;color:var(--text-sec);display:block;margin-bottom:3px">Owner credential</label>
            <input type="password" placeholder="owner credential" value=${loginCred} oninput=${e => setLoginCred(e.target.value)} style="background:var(--surface-2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:6px 10px;font-size:12px;width:100%" />
          </div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;padding:8px" onclick=${doLogin}>Login</button>
          <button
            class="btn"
            data-testid="tg-login-start"
            style="width:100%;justify-content:center;padding:8px;margin-top:8px"
            disabled=${tgLogin.phase === 'starting' || tgLogin.phase === 'pending'}
            onclick=${startTelegramLogin}
          >${tgLogin.phase === 'starting' ? 'Starting Telegram...' : 'Login via Telegram'}</button>
          ${tgLogin.phase === 'pending' ? html`
            <div data-testid="tg-login-panel" style="margin-top:16px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);padding:14px">
              <div style="font-size:11px;color:var(--text-sec);margin-bottom:6px">Open your Telegram and tap this number</div>
              <div data-testid="tg-login-number" style="font-size:44px;line-height:1;font-weight:800;color:var(--accent);letter-spacing:0;margin-bottom:10px">${tgLogin.displayNumber}</div>
              <button class="btn btn-sm" style="justify-content:center" onclick=${cancelTelegramLogin}>Cancel</button>
            </div>
          ` : null}
          ${(tgLogin.phase === 'fail' || tgLogin.phase === 'expired') ? html`
            <div data-testid="tg-login-message" style="margin-top:10px;color:var(--danger);font-size:12px">${tgLogin.message}</div>
            <button class="btn btn-sm" style="margin-top:8px;justify-content:center" onclick=${startTelegramLogin}>Retry</button>
          ` : null}
          <div class="login-footer" style="font-size:10px;color:var(--text-sec);margin-top:16px">single owner · loopback-guarded</div>
          ${error && html`<div data-testid="login-error" style="color:#f85149;margin-top:8px;font-size:12px;cursor:pointer" onclick=${() => setError('')}>${error} ✕</div>`}
        </div>
      </div>
    ` : html`
      <div style="display:flex;flex:1;width:100%;min-width:0;height:100vh;overflow:hidden">
        ${drawerOpen && html`<div class="drawer-scrim" onclick=${() => setDrawerOpen(false)} style="position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:90;"></div>`}
        <div id="sidebar" data-testid=${isStudio ? 'as-col-nav' : undefined} class=${`${drawerOpen ? 'open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`.trim()}>
          <div class="sidebar-logo" data-testid="nav-brand">
            <span class="nav-brand-mark" aria-hidden="true">H</span>
            <div class="sidebar-logo-text">
              <div class="wordmark">Helm</div>
              <div class="tagline" data-testid="nav-brand-sub">Agent Platform</div>
            </div>
            <button type="button" class="sidebar-collapse-toggle" data-testid="sidebar-collapse-toggle"
              title=${sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-pressed=${sidebarCollapsed ? 'true' : 'false'}
              onclick=${toggleSidebar}>${sidebarCollapsed ? '»' : '«'}</button>
          </div>
          <div class="sidebar-nav">
            <div class=${`nav-item ${activeSection==='studio'?'active':''}`} data-testid="nav-agent-studio" title="Agent Studio" onclick=${() => onNav('studio')}>
              <span class="nav-item-icon">${navIconSvg('studio')}</span>
              <span class="nav-item-label">Agent Studio</span>
            </div>
            <div class=${`nav-item ${activeSection==='setup'?'active':''}`} data-testid="nav-project-setup" title="Project Setup" onclick=${() => onNav('setup')}>
              <span class="nav-item-icon">${navIconSvg('setup')}</span>
              <span class="nav-item-label">Project Setup</span>
            </div>
            <div class=${`nav-item ${activeSection==='cmd'?'active':''}`} data-testid="nav-command-center" title="Command Center" onclick=${() => onNav('cmd')}>
              <span class="nav-item-icon">${navIconSvg('cmd')}</span>
              <span class="nav-item-label">Command Center</span>
            </div>
            <div class=${`nav-item ${activeSection==='memory'?'active':''}`} data-testid="nav-memory" title="Memory" onclick=${() => onNav('memory')}>
              <span class="nav-item-icon">${navIconSvg('memory')}</span>
              <span class="nav-item-label">Memory</span>
            </div>
            <div class=${`nav-item ${activeSection==='tracking'?'active':''}`} data-testid="nav-tracking" title="Tracking" onclick=${() => onNav('tracking')}>
              <span class="nav-item-icon">${navIconSvg('tracking')}</span>
              <span class="nav-item-label">Tracking</span>
            </div>
            <div class=${`nav-item ${activeSection==='sessions'?'active':''}`} data-testid="nav-sessions" title="Sessions" onclick=${() => onNav('sessions')}>
              <span class="nav-item-icon">${navIconSvg('sessions')}</span>
              <span class="nav-item-label">Sessions</span>
            </div>
          </div>
          ${agentsColCollapsed && (activeSessions || []).length ? html`
            <div class="sidebar-active-section" data-testid="nav-sidebar-active-section">
              <div class="sidebar-active-label as-roster-section-label">ACTIVE</div>
              ${(activeSessions || []).map(s => {
                const agent = (agentsList || []).find(a => a.id === s.agent_id);
                return html`
                  <div class="sidebar-active-row" key=${s.session_id} data-testid="nav-sidebar-active-row">
                    <button type="button" class="sidebar-active-open" data-testid="nav-sidebar-active-open"
                      onclick=${() => { if (agent) attachToActiveSession(agent, s); }}
                    >${s.agent_name}</button>
                    <button type="button" class="sidebar-active-close" data-testid="nav-sidebar-active-close"
                      title="End session"
                      onclick=${(e) => { e.stopPropagation(); closeActiveSession(s); }}
                    >×</button>
                  </div>`;
              })}
            </div>` : null}
          ${(teamsList || []).length ? html`
            <div class="sidebar-teams" data-testid="nav-teams-section">
              <div class="sidebar-teams-label as-roster-section-label" data-testid="nav-teams-label">TEAMS</div>
              ${(teamsList || []).map(t => {
                const dotState = teamNavDotState(t.id, teamMembersByTeamId, agentsList, modelsList, agentChatCacheRef.current, selectedAgentId, chatSid);
                return html`
                  <div
                    key=${t.id}
                    class=${`nav-team-row ${selectedTeamId === t.id ? 'selected' : ''}`}
                    data-testid="nav-team-row"
                    data-team-id=${t.id}
                    onclick=${() => onNavTeam(t)}
                  >
                    <span data-testid="nav-team-status-dot" class=${`nav-team-dot as-nav-team-dot-${dotState}`} title=${dotState}></span>
                    <span class="nav-team-name">${t.name}</span>
                  </div>`;
              })}
            </div>` : null}
          <div class="sidebar-footer sidebar-account">
            <div class="sidebar-account-row">
              <span class="sidebar-account-avatar" aria-hidden="true">S</span>
              <div class="sidebar-account-text">
                <div class="sidebar-account-name" data-testid="nav-account-name">silverjrom</div>
                <div class="sidebar-account-role" data-testid="nav-account-role">admin</div>
              </div>
              <span class="sidebar-account-dot live-dot" data-testid="nav-account-status" aria-label="online"></span>
              <button data-testid="theme-toggle" class="sidebar-theme-toggle" type="button" onclick=${toggleTheme} title="Toggle theme">${theme === 'light' ? 'Dark' : 'Light'}</button>
            </div>
          </div>
        </div>
        ${isStudio ? html`
          <div id="main" class="as-studio-main" style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;${Object.entries(studioGridVars).map(([k,v]) => `${k}:${v}`).join(';')}">
            <div style="display:flex;align-items:center;padding:8px 12px 0;border-bottom:1px solid var(--border);background:var(--surface)">
              <button class="mobile-hamburger" data-testid="mobile-hamburger" onclick=${() => setDrawerOpen(true)}>☰</button>
              <div class="section-title" style="font-size:14px;font-weight:600;color:var(--text);padding:4px 0 8px 6px">${secDef.title}</div>
            </div>
            ${studioTopbar}
            ${html`<div key=${currentSlug} style="display:contents">${studioCols}</div>`}
          </div>
        ` : html`
          <div id="main" style="flex:1;display:flex;flex-direction:column;overflow:hidden">
            <div class="section-header" style="display:flex;align-items:center;justify-content:space-between;padding:12px 20px 0;border-bottom:1px solid var(--border)">
              <div style="display:flex;align-items:center;gap:6px">
                <button class="mobile-hamburger" data-testid="mobile-hamburger" onclick=${() => setDrawerOpen(true)}>☰</button>
                <div class="section-title" style="font-size:14px;font-weight:600;color:var(--text);padding-bottom:12px">${secDef.title}</div>
              </div>
              <div class="tab-strip" style="display:flex;gap:0;padding-bottom:0">
                ${tabs.map(t => html`<div class=${`tab ${currentSlug===t.slug?'active':''}`} data-testid=${`tab-${t.key}`} onclick=${() => onTab(t.slug)}>${t.label}</div>`)}
              </div>
            </div>
            <div class=${`main-content-scroll${ccWsCycleId ? ' main-content-scroll--workspace' : ''}`}
              data-testid=${`content-${activeSection}`}>
              ${html`<div key=${currentSlug} style="display:contents">${mainContent}</div>`}
            </div>
          </div>
        `}
      </div>
    `}
    ${fsViewer && html`
      <div class="fs-scrim" data-testid="fs-viewer-scrim" onclick=${closeFullScreen}>
        <div class="fs-panel" onclick=${(e) => e.stopPropagation()}>
          <div class="fs-titlebar">
            <div class="fs-title" data-testid="fs-viewer-title">${fsViewer.title}</div>
            <button class="fs-close-btn" data-testid="fs-viewer-close" onclick=${closeFullScreen} title="Close (Esc)" aria-label="Close full screen">✕</button>
          </div>
          <div class="fs-body">
            ${fsViewer.kind === 'doc'
              ? html`<${MdViewer} content=${fsViewer.payload} testId="fs-viewer-doc" maxHeight="none" className="fs-md" />`
              : html`<img class="fs-image" data-testid="fs-viewer-image" src=${fsViewer.payload} alt=${fsViewer.title} />`}
          </div>
        </div>
      </div>
    `}
    ${error && token && html`<div data-testid="error-banner" style="color:#f85149;margin-top:8px;font-size:12px;cursor:pointer" onclick=${() => setError('')}>Last error: ${error} ✕</div>`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
