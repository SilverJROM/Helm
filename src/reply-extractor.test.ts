// reply-extractor.test.ts
// G1 required unit tests for the reply extractor (covers ALL cases verbatim from brief).
// Runs against the real implementation in src/web/public/reply-extractor.js (ESM).
// These + submit-verify + terminal-source + full vitest baseline ensure no regressions.

// @ts-nocheck
// .js ESM module (no .d.ts). @ts-nocheck at top makes tsc skip for this test file.
// Runtime import works under vitest. Tests the exact 4 cases required by brief.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  extractHelmReply,
  extractAgentPaneSegment,
  paneLooksGenerating,
  looksLikeChrome,
  stripChrome
} from './web/public/reply-extractor.js';

const PANE_FIXTURES = [
  {
    file: 'discovery-finished-turn-20260727.txt',
    pending: 'please continue discovery',
    reply: 'Diwa v1 from cycle 11 is complete and clean on main'
  },
  {
    file: 'discovery-sent-echoed-in-composer-20260728.txt',
    pending: '(a) — recall output is unreadable, keep text mode frozen',
    reply: 'Status: INTERVIEWING'
  }
];

// E8: discovery-live-20260728-2251.txt (SOL diagnosis fixture — three completed HELM_REPLY turns,
// the second reply's own content contains a box-drawing markdown table) is deliberately NOT added to
// PANE_FIXTURES above. It exercises FIX1 (src/cc-disc-stream-reconcile.test.ts) and FIX3 (the
// last-reply-strip suite), neither of which uses this suite's single-current-turn pending/reply
// convention. It still carries a provenance header and is covered by the directory-wide check below.

function readPaneFixture(file) {
  const raw = readFileSync(new URL(`./test-fixtures/panes/${file}`, import.meta.url), 'utf8');
  return raw.replace(/^# HELM_PROVENANCE: source_session=[^\n]+ capture_date=\d{4}-\d{2}-\d{2}\n/, '');
}

function appDisplayText(pane, pending) {
  const r = extractHelmReply(pane, pending);
  const thinking = r.state === 'thinking';
  let text = r.text || '';
  if (!thinking && !text) text = extractAgentPaneSegment('', pane, pending) || '';
  return { state: r.state, thinking, text };
}

function appJsSource() {
  return readFileSync(new URL('./web/public/app.js', import.meta.url), 'utf8');
}

function splitArgs(argsSource) {
  const args = [];
  let current = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < argsSource.length; i += 1) {
    const ch = argsSource[i];
    const prev = argsSource[i - 1];
    if (quote) {
      current += ch;
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function argShape(arg) {
  const clean = arg.trim();
  if (clean === "''" || clean === '""' || clean === '``') return 'empty-literal';
  return 'non-empty-expression';
}

function discoveredExtractorCallShapes() {
  const source = appJsSource();
  const calls = [];
  const callRe = /\b(extractHelmReply|extractAgentPaneSegment)\s*\(([^)]*)\)/g;
  let match;
  while ((match = callRe.exec(source)) !== null) {
    const args = splitArgs(match[2]);
    calls.push({
      name: match[1],
      arity: args.length,
      argShapes: args.map(argShape),
      signature: `${match[1]}/${args.length}/${args.map(argShape).join(',')}`
    });
  }
  return calls;
}

const exercisedDisplayCallShapes = new Set([
  'extractHelmReply/2/non-empty-expression,non-empty-expression',
  'extractAgentPaneSegment/3/empty-literal,non-empty-expression,non-empty-expression'
]);

describe('G1 reply-extractor (Studio + CC parity)', () => {
  it('marked ⟦HELM_REPLY⟧ reply yields state=reply with inner text (priority)', () => {
    const pane = 'some prior\n⟦HELM_REPLY⟧\nHello from agent in markers.\n⟦/HELM_REPLY⟧\n❯ ';
    const r = extractHelmReply(pane, 'last user');
    expect(r.state).toBe('reply');
    expect(r.text).toBe('Hello from agent in markers.');
  });

  it('plain-prose reply (no markers) yields fallback with extracted text', () => {
    const pane = 'JROM: do the thing\n\nThe agent did the thing successfully.\nIt also wrote a test.\n\n❯ ';
    const r = extractHelmReply(pane, 'do the thing');
    expect(r.state).toBe('fallback');
    expect(r.text).toContain('The agent did the thing successfully.');
    expect(r.text).not.toContain('❯');
  });

  it('pane containing ONLY chrome/footer must yield NO bubble (state thinking or empty, text="")', () => {
    const chromePane = 'bypass permissions on (shift+tab to cycle)\n❯ \nResponding…\n';
    expect(paneLooksGenerating(chromePane)).toBe(true);
    const r = extractHelmReply(chromePane, 'some user');
    // No real content → thinking (prevents chrome-as-reply)
    expect(['thinking', 'empty'].includes(r.state)).toBe(true);
    expect(r.text || '').toBe('');
    // Also direct segmenter
    const fb = extractAgentPaneSegment('', chromePane, 'some user');
    expect(fb).toBe('');
  });

  it('reply interleaved with tool-output noise extracts cleanly (plain or marked)', () => {
    const noisyPlain = `
[tool] ls src
file1.ts
file2.ts
The final answer is the fix works.
More prose here.
❯ 
`;
    const r = extractHelmReply(noisyPlain, 'investigate');
    expect(r.state).toBe('fallback');
    expect(r.text).toContain('The final answer is the fix works.');
    expect(r.text).not.toContain('[tool]');
    expect(r.text).not.toContain('❯');

    const noisyMarked = 'tool noise\n⟦HELM_REPLY⟧\nClean reply despite tools.\n⟦/HELM_REPLY⟧\nmore noise';
    const r2 = extractHelmReply(noisyMarked, '');
    expect(r2.state).toBe('reply');
    expect(r2.text).toBe('Clean reply despite tools.');
  });

  it('stripChrome and looksLikeChrome helpers reject chrome-only input', () => {
    const chrome = 'esc to interrupt\nbypass permissions on (shift+tab to cycle)\n❯ ';
    expect(looksLikeChrome(chrome)).toBe(true);
    expect(stripChrome(chrome)).toBe('');
    const real = 'This is actual agent output after tools.\nDone.';
    expect(looksLikeChrome(real)).toBe(false);
    expect(stripChrome(real)).toContain('actual agent output');
  });

  it('multi-turn pane (GAP1): extracts NEW plain-prose after LATEST user (not stale earlier marked reply); must be RED before fix, GREEN after', () => {
    const oldUser = 'old question';
    const oldMarked = `⟦HELM_REPLY⟧
I'm online as projcore...
⟦/HELM_REPLY⟧`;
    const newUser = 'In one short paragraph, what does the Helm repo do?';
    const newPlain = 'Helm is the command center for managing project agents, kloo, and runs with live tmux sessions.';
    const pane = `❯ ${oldUser}

${oldMarked}

❯ ${newUser}

${newPlain}

❯ `;
    // Simulate cleared pending (common after prior reply) or explicit last user: must pick NEW, not old
    const r1 = extractHelmReply(pane, '');  // cleared pending case
    expect(r1.state).toBe('fallback');
    expect(r1.text).toContain('Helm is the command center');
    expect(r1.text).not.toContain('online as projcore');

    const r2 = extractHelmReply(pane, newUser);
    expect(r2.text).toContain('Helm is the command center');
    expect(r2.text).not.toContain('online as projcore');
  });

  it('real-pane from evidence (iter2 Rung-2): multiple complete marker blocks + ❯/box noise; with afterUserText="", extracts LAST (NONCE7714XYZ) not stale old rmr35wdod reply; RED before fix, GREEN after', () => {
    // Reconstructed from real-pane-nonce.txt (the exact SSE stream that caused rendered failure)
    const oldBlock = `⟦HELM_REPLY⟧
Run rmr35wdod is genuinely complete — independently re-verified, not just taking the completion-summary at its word.

- lib/lucky9Table.js, server registration, client UI branch, and test/lucky9.test.js are all in place and match the north-star spec (mod-10 hand value, idle→betting→roundover lifecycle, minBet 10).
- test/lucky9.test.js (19/19) and test/client-lucky9-ui.test.js (11/11) both pass standalone.
- server.js loads cleanly (only failure was port 8080 already held by the live pm2 "cards" process — expected, not a code issue).
- One note: npm test doesn't include the two new lucky9 test files in its script list — worth adding them there so CI/regression runs catch them automatically.

Nothing to fix. Ready for you to review/merge the branch or have me wire the new tests into npm test.
⟦/HELM_REPLY⟧`;

    const nonceUser = 'Reply with exactly this token and nothing else: NONCE7714XYZ';

    const nonceBlock = `⟦HELM_REPLY⟧
NONCE7714XYZ
⟦/HELM_REPLY⟧`;

    const pane = `You are running inside Helm test-chat...

${oldBlock}

❯ ${nonceUser}

● ${nonceBlock}

✻ Sautéed for 2s

────────────────────────────────────────────────────────────────────────────────
❯ wire the two lucky9 test files into npm test
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

    // Critical: afterUserText='' (cleared pending case) must still pick the LAST complete marker block
    const r = extractHelmReply(pane, '');
    expect(r.state).toBe('reply');
    expect(r.text).toContain('NONCE7714XYZ');
    expect(r.text).not.toContain('rmr35wdod');
    expect(r.text).not.toContain('Nothing to fix');
  });

  it('real-pane-iter2-FAIL (iter3): whitespace-wrapped prompt + queued noise; extracts CURRENT plain reply (This repo ... G1VAL3) not stale marked startup; with sent text and with ""', () => {
    // verbatim from batch-G1/evidence/real-pane-iter2-FAIL.txt (the exact failing stream)
    const realPane = `     *observably* closed — read the diff, exercise the behavior, don't trust
  the worker's word.
     Apply the Evidence Quality Gate (side skill) — especially Q6: outcome, not
  attempt.
  4. **Advisory red-team / deliberation** when the change warrants it (risky
  surface, ambiguous
     spec, irreversible action). Convene the team; a CLEAN streak over distinct
  lenses clears it.
     A real BUGS verdict sends the task back (max 3 iterations, then BLOCK).
  5. **Update the requirements matrix and progress**, then move to the next
  batch.

  ## Role-boundary HARD RULE
  When you send a correction brief naming N gaps, the implementer fixes ONLY
  those N gaps — not
  "while I'm here" extras. Scope drift is a defect.

  ## Dynamic queue
  The operator may inject new work mid-run. Drain injected items at **batch
  boundaries**, never
  mid-batch: append to the end by default, jump only if marked URGENT. Loop
  while the queue is
  non-empty.

  ## Context hygiene
  Between batches, write the handoff (what's done, what's next, open decisions)
  so the next batch
  starts from file-backed context, not a bloated working memory.

  ## Topology & model routing (you adapt to what the project gives you)
  - Default **2-agent** (you + implementer, deterministic gate as validator).
  Escalate to
    **3-agent** (independent validator ≠ implementer ≠ you) per-task when
  quality demands it.
  - Prefer the cheap/primary token pool for implementer work; reserve the
  expensive/auditor tier
    for validation and genuinely hard calls.
  - **Per-task model + effort live in the plan.** When you author the plan,
  each task may carry its
    own implementer **model** and **effort** (heavier for complex tasks,
  lighter for routine) —
    Helm uses that as the task's base worker, swapping the main worker per task
  as the plan
    specifies. The per-agent **escalation ladder still applies on top**
  (on-fail / low-budget bumps
    from that base). Set the per-task policy from the operator's interview
  answer; absent a per-task
    override, the project's default binding is used.

  ## Issue tasks (bugs) — reproduce-first, defer-don't-block
  For issue/bug tasks, the validator reproduces the issue BEFORE any
  implementer work — the repro
  is the fix contract. No reproduction → the implementer is never dispatched.
  If the issue cannot
  be reproduced after the engine's bounded retries, it is marked **DEFERRED —
  NOT REPRODUCIBLE**,
  the queue moves on to the next issue, and you collect it. You do NOT halt the
  run or ping the
  operator mid-stream for a non-repro. **All deferred / not-reproducible issues
  are surfaced to the
  operator in one batch at the END of the task list** — never as a mid-run
  interruption.

  ## Escalation & budget (you set the policy; the engine enforces it)
  Two escalation axes, both deterministic once you set them:
  - **On failure** — a task that fails its gate N times at a rung bumps to the
  next, stronger model
    rung (implementer and validator each have a rung ladder). At the top rung's
  cap you decide:
    re-plan, hand off, or raise to the operator.
  - **On budget** — if a bound model's remaining token budget falls below
  what's needed to finish
    the task, the engine swaps it to the next rung / a model with headroom (for
  you as master, a
    hot-swap to the backup brain). You don't watch budgets; you set the
  threshold and the ladder,
    the engine acts.
  You are consulted only at the genuine edge — which rung, re-plan vs thrash,
  when to stop — not
  for the mechanical bump.

  ## What you do NOT do
  You do not run dispatch plumbing, watchers, wakeup timers, notifications, or
  overmind calls by
  hand — the Helm engine does all of that. You do not babysit per-task progress
  or budgets. You
  decide; the engine executes, monitors, and reports back to you through
  callbacks. You are the
  brain; Helm is the body.

  You are running inside Helm test-chat (test and discuss only — not production
  orchestration).

  Memory: Do not use native CLI memory. Use Helm app and project memory
  supplied via the Helm UI.

  Tools: Follow the Helm tool and callback protocol when tools are available.

  Helm shared memory:
  - Helm orchestration conventions: Platform-wide rules for projcore batches,
  callbacks, and evidence gates.

  Chat reply protocol (IMPORTANT — follow every turn):
  - Think, reason, and use tools normally. All of that stays in your terminal
  (the user sees it in the "Session Logs" tab).
  - Then write your user-facing answer wrapped EXACTLY in these markers, on
  their own lines:
  ⟦HELM_REPLY⟧
  <your concise reply to the user here>
  ⟦/HELM_REPLY⟧
  - The Chat tab shows ONLY the text between those markers. Put nothing else
  inside them. Emit the markers literally (do not put them in a code block).

  <!-- HELM_BOOTSTRAP_END:7218645c3d5d674e -->

● ⟦HELM_REPLY⟧
  projcore ready. I have the Helm run context for the cards repo (branch
  exp/lucky9-projcore-test) and see recent work on lib/lucky9Table.js, server
  registration, client UI, and tests, plus draft artifacts under
  helm_tasks/rmr35wdod/lucy9-tests/. What would you like me to do — review the
  current batch, continue the north-star interview, or pick up the next item in
  the queue?
  ⟦/HELM_REPLY⟧

✻ Crunched for 8s

❯ In one short paragraph, what does this repo do? Reply as plain text and
  include G1VAL3_1783014289665.

  Listed 1 directory (ctrl+o to expand)

● This repo is a Node.js/Express + Socket.IO web app implementing a single-table
  Texas Hold'em (No-Limit) poker game with real-time WebSocket play, and this
  branch is extending it with additional casino-style table games (e.g.,
  Blackjack and a Lucky 9 variant being added under lib/, public/client.js, and
  test/). G1VAL3_1783014289665

✻ Cooked for 23s

────────────────────────────────────────────────────────────────────────────────
❯ run the lucky9 tests
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

    const sent = 'In one short paragraph, what does this repo do? Reply as plain text and include G1VAL3_1783014289665.';

    const r = extractHelmReply(realPane, sent);
    expect(r.state === 'reply' || r.state === 'fallback').toBe(true);
    expect(r.text).toContain('This repo is a Node');
    expect(r.text).toContain('G1VAL3_1783014289665');
    expect(r.text).not.toContain('projcore ready');
    expect(r.text).not.toContain('Helm run context');

    // also with '' (cleared case) must not return stale
    const rEmpty = extractHelmReply(realPane, '');
    expect(rEmpty.text || '').not.toContain('projcore ready');
    expect(rEmpty.text || '').not.toContain('Helm run context');
  });

  // DC-R1: reliable "done" — an open ⟦HELM_REPLY⟧ with NO matching close must not be stuck
  // "thinking" forever once the pane goes idle (close marker scrolled off the capture window).
  it('DC-R1: open marker, no close, pane IDLE (no spinner/esc-to-interrupt) → returns reply text, NOT thinking', () => {
    const pane = `❯ tell me the status
⟦HELM_REPLY⟧
The batch is done and all tests pass. Ready to merge.
❯ `;
    const r = extractHelmReply(pane, 'tell me the status');
    expect(r.state).not.toBe('thinking');
    expect(r.state === 'reply' || r.state === 'fallback').toBe(true);
    expect(r.text).toContain('The batch is done and all tests pass.');
    expect(r.text).not.toContain('❯');
    expect(r.text).not.toContain('⟦HELM_REPLY⟧');
  });

  it('DC-R1: open marker, no close, pane STILL GENERATING (esc to interrupt present) → thinking', () => {
    const pane = `❯ tell me the status
⟦HELM_REPLY⟧
Working on it, gathering the test resul
  esc to interrupt`;
    expect(paneLooksGenerating(pane)).toBe(true);
    const r = extractHelmReply(pane, 'tell me the status');
    expect(r.state).toBe('thinking');
    expect(r.text || '').toBe('');
  });

  it('E4: real finished Discovery pane is idle, not generating', () => {
    const realFinishedPane = readPaneFixture('discovery-finished-turn-20260727.txt');
    expect(paneLooksGenerating(realFinishedPane)).toBe(false);
  });

  it('E4: real finished Discovery pane extracts the completed reply', () => {
    const realFinishedPane = readPaneFixture('discovery-finished-turn-20260727.txt');
    expect(extractHelmReply(realFinishedPane, '').state).toBe('reply');
  });

  it('E4: truncated finished pane with close marker but no open marker extracts reply', () => {
    const realFinishedPane = readPaneFixture('discovery-finished-turn-20260727.txt');
    const last80Lines = realFinishedPane.trimEnd().split('\n').slice(-80).join('\n');
    expect(extractHelmReply(last80Lines, '').state).toBe('reply');
  });

  it('E4: genuinely generating pane still returns thinking', () => {
    const pane = `❯ tell me the status
⟦HELM_REPLY⟧
Working on it, gathering the test resul
  esc to interrupt`;
    expect(paneLooksGenerating(pane)).toBe(true);
    const r = extractHelmReply(pane, 'tell me the status');
    expect(r.state).toBe('thinking');
    expect(r.text || '').toBe('');
  });

  it('E6: real Discovery pane with composer echo extracts reply when pending is passed', () => {
    const pane = readPaneFixture('discovery-sent-echoed-in-composer-20260728.txt');
    const sent = '(a) — recall output is unreadable, keep text mode frozen';
    const r = extractHelmReply(pane, sent);
    expect(r.state).toBe('reply');
    expect(r.text).toContain('Status: INTERVIEWING');
    expect(r.text).not.toContain('bypass permissions');
    expect(r.text).not.toContain('─────');
  });

  it('E6: real Discovery pane still extracts reply when pending is cleared', () => {
    const pane = readPaneFixture('discovery-sent-echoed-in-composer-20260728.txt');
    const r = extractHelmReply(pane, '');
    expect(r.state).toBe('reply');
    expect(r.text).toContain('Status: INTERVIEWING');
  });

  it('E6: single sent-text occurrence still returns the reply with pending passed', () => {
    const sent = 'summarize the repo status';
    const pane = `❯ ${sent}

⟦HELM_REPLY⟧
Status: READY - all requested checks passed.
⟦/HELM_REPLY⟧

❯ `;
    const r = extractHelmReply(pane, sent);
    expect(r.state).toBe('reply');
    expect(r.text).toContain('Status: READY');
  });

  it('E6: genuinely generating pane still returns thinking with pending passed', () => {
    const sent = 'summarize the repo status';
    const pane = `❯ ${sent}
⟦HELM_REPLY⟧
Gathering the current status
  esc to interrupt`;
    const r = extractHelmReply(pane, sent);
    expect(r.state).toBe('thinking');
    expect(r.text || '').toBe('');
  });

  it('E6: E4 real Discovery fixture passes with cleared and plausible pending values', () => {
    const pane = readPaneFixture('discovery-finished-turn-20260727.txt');
    expect(extractHelmReply(pane, '').state).toBe('reply');
    expect(extractHelmReply(pane, 'please continue discovery').state).toBe('reply');
  });

  it('E6b structural: app.js extractor call-site shapes are covered by this suite', () => {
    const discovered = discoveredExtractorCallShapes();
    expect(discovered).toEqual([
      expect.objectContaining({ signature: 'extractHelmReply/2/non-empty-expression,non-empty-expression' }),
      expect.objectContaining({ signature: 'extractAgentPaneSegment/3/empty-literal,non-empty-expression,non-empty-expression' }),
      expect.objectContaining({ signature: 'extractHelmReply/2/non-empty-expression,non-empty-expression' }),
      expect.objectContaining({ signature: 'extractAgentPaneSegment/3/empty-literal,non-empty-expression,non-empty-expression' })
    ]);
    expect(new Set(discovered.map(call => call.signature))).toEqual(exercisedDisplayCallShapes);

    const pane = readPaneFixture('discovery-sent-echoed-in-composer-20260728.txt');
    const { text } = appDisplayText(pane, '(a) — recall output is unreadable, keep text mode frozen');
    expect(text).toContain('Status: INTERVIEWING');
    expect(text).not.toContain('bypass permissions');
  });

  it('E6b structural: display-level bubble text is clean for every captured pane fixture', () => {
    const boxDrawing = /[─│┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/;
    for (const fixture of PANE_FIXTURES) {
      const pane = readPaneFixture(fixture.file);
      const { text } = appDisplayText(pane, fixture.pending);
      expect(text, fixture.file).not.toContain('bypass permissions');
      expect(text, fixture.file).not.toMatch(boxDrawing);
      expect(text, fixture.file).not.toBe(fixture.pending);
      expect(text.startsWith(fixture.pending), fixture.file).toBe(false);
      expect(text, fixture.file).toContain(fixture.reply);
    }
  });

  it('E6b structural: pane fixtures carry provenance headers and still replay to real replies', () => {
    const paneFiles = readdirSync(new URL('./test-fixtures/panes/', import.meta.url))
      .filter(file => file.endsWith('.txt'))
      .sort();
    // E8: every REAL captured pane in this directory must carry provenance — widened from an exact-
    // equality list (PANE_FIXTURES) so a fixture captured for a DIFFERENT purpose than this suite's
    // single-current-turn pending/reply convention (e.g. discovery-live-20260728-2251.txt, used by
    // FIX1/FIX3's own suites for its three-reply, multi-turn content) can live here too without being
    // forced through it. PANE_FIXTURES itself must still be a subset — nothing here was removed.
    expect(paneFiles).toEqual(expect.arrayContaining(PANE_FIXTURES.map(fixture => fixture.file)));

    for (const file of paneFiles) {
      const raw = readFileSync(new URL(`./test-fixtures/panes/${file}`, import.meta.url), 'utf8');
      expect(raw, file).toMatch(
        /^# HELM_PROVENANCE: source_session=[^\n]+ capture_date=\d{4}-\d{2}-\d{2}\n/
      );
    }

    for (const fixture of PANE_FIXTURES) {
      const { text } = appDisplayText(readPaneFixture(fixture.file), fixture.pending);
      expect(text, fixture.file).toContain(fixture.reply);
      expect(text, fixture.file).not.toBe(fixture.pending);
    }
  });
});
