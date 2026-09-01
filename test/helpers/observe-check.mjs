#!/usr/bin/env node
// test/helpers/observe-check.mjs — hooks/fleet-observe.sh, driven by a scripted model in real
// sessions, in every direction that matters.
//
//     node test/helpers/observe-check.mjs        # "name <US> want <US> got" rows
//
// The hook is WARN ONLY: it records whether a lead's turn changed a surface and never looked
// at it, and it never blocks. That makes it silent by construction, and a silent check that
// has stopped working is indistinguishable from one that carefully had nothing to say — no
// error, no row, nothing to grep. So every row below is a direction, and the quiet ones carry
// as much weight as the loud one:
//
//   1. UNOBSERVED LEAD   writes a surface, runs a test, reports done -> `warn`
//   2. OBSERVED LEAD     the same turn with fleet-look in it         -> `ok`
//   3. UNOBSERVED WORKER the same script, slot is not master          -> no line at all
//
// AND THE THING A WARN-ONLY HOOK MOST HAS TO PROVE: that it did not change the run. Row 1
// asserts the session took exactly as many model turns as row 2 did. That is not decoration —
// the channel this hook does NOT use, stdout additionalContext, silently re-opens the turn,
// and a session went round TEN times instead of two with nothing in the payload to say why.
// A regression to that channel would look like a working warning.
//
// THE MARKER IS CHECKED AT ITS POSITION, NOT AS A STRING. #5's evaluator classified a session
// as treated because the marker word appeared in it, and the session it appeared in was the one
// writing the marker. So this asserts the line arrives inside an `attachment` record whose
// `attachment.hookEvent` is `Stop`, at the head of `attachment.stderr` — somewhere no agent
// prose can reach. A row that merely grepped the transcript would pass for this file too.
//
// IT ALSO PINS THE PLATFORM FACTS THE DESIGN RESTS ON, each measured rather than assumed, and
// each a thing Claude Code could change under us where the hook would just go quiet:
//
//   Q1 a Stop hook CAN block (exit 2 continues the session, stderr becomes turn feedback, and
//      the second Stop carries stop_hook_active) — measured with a TEST-ONLY hook, because the
//      shipped one must not depend on it. It is recorded so that if #5 ever says "promote this
//      to a refusal", the mechanism is known to work rather than hoped to.
//   Q2 last_assistant_message carries only the LAST TEXT BLOCK of a multi-block message, which
//      is why this hook reads the transcript instead of the report.
//
// SKIPPED where there is no claude / git / jq — see fixture-session.mjs for why the last two
// are not fussiness.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { US, missingPrerequisite, makeWorld, hookEntry, runSession, text, tool }
  from './fixture-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };

const why = missingPrerequisite();
if (why) {
  rows.push('#SKIP' + US + 'the Stop-hook observation check, in a real session' + US + why);
  done(0);
}

const HOOK = path.join(ROOT, 'hooks', 'fleet-observe.sh');
const FIRST = 'FIRST-BLOCK-of-the-final-message';
const LAST = 'LAST-BLOCK-of-the-final-message';
// `command -v` rather than a real render: the hook keys on the COMMAND NAMING fleet-look, which
// is bin/fleet-meter.mjs's BROWSER_BASH rule, and launching a headless Chrome here would make
// this group depend on a browser it does not need to test.
const LOOK = 'command -v fleet-look.mjs';

// Every .jsonl under the throwaway config dir's projects/ tree, after the process exited.
function transcripts(cfg) {
  const out = [];
  const walk = (d) => {
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (p.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(path.join(cfg, 'projects'));
  return out;
}

// THE POSITION CHECK. An attachment record written by a Stop hook, with the marker at the head
// of its stderr — and the verdict read out of that line rather than out of the file at large.
function markerAtPosition(cfg) {
  const found = [];
  for (const f of transcripts(cfg)) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const a = j.attachment;
      if (j.type !== 'attachment' || !a || a.hookEvent !== 'Stop') continue;
      const m = /^[^\S\n]*observe-check:[ \t]*(ok|warn)\b/.exec(String(a.stderr || ''));
      if (m) found.push(m[1]);
    }
  }
  return found;
}

function scriptFor({ observe, surface }) {
  return ({ agentTurn }) => {
    if (agentTurn === 1) {
      return { blocks: [tool('toolu_write', 'Write',
        { file_path: surface, content: 'export const send = () => {};\n' })], stop: 'tool_use' };
    }
    if (agentTurn === 2) {
      return { blocks: [tool('toolu_check', 'Bash',
        { command: observe ? LOOK : 'echo ran the tests',
          description: 'the only non-write tool in this turn' })], stop: 'tool_use' };
    }
    // A MULTI-BLOCK final message, which is how Q2 gets measured rather than assumed.
    if (agentTurn === 3) return { blocks: [text(FIRST), text(LAST)], stop: 'end_turn' };
    // Reached only if something re-opened the turn, which is the thing row 1 asserts against.
    return { blocks: [text('kept going, which a warning must not cause.')], stop: 'end_turn' };
  };
}

async function scenario({ observe, slot, hooks, launcher = true, env = {} }) {
  const world = makeWorld();
  try {
    const surface = path.join(world.cwd, 'web', 'app.js');
    fs.mkdirSync(path.dirname(surface), { recursive: true });
    const stops = path.join(world.cwd, 'stops.jsonl');
    // The recorder is this file's instrument and ships nothing — the same standing as
    // viewport-check serving its own deliberately-overflowing page from inside itself.
    const recorder = path.join(world.cwd, 'record.sh');
    fs.writeFileSync(recorder,
      '#!/bin/bash\ncat >> ' + JSON.stringify(stops) + '\nprintf "\\n" >> ' + JSON.stringify(stops) + '\nexit 0\n',
      { mode: 0o755 });
    const r = await runSession({
      root: ROOT, world, prompt: 'make the send button fit and report', slot, launcher,
      hooks: hooks ? hooks({ world, recorder }) : { Stop: hookEntry(recorder, HOOK) },
      env: { CLAUDE_FLEET_SOCK: 'cf-acme-api', ...env },
      script: scriptFor({ observe, surface }),
    });
    let payloads = [];
    try {
      payloads = fs.readFileSync(stops, 'utf8').split('\n').filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
    return { ...r, payloads, verdicts: markerAtPosition(world.cfg),
             convo: JSON.stringify(r.requests.map((q) => q.messages)) };
  } finally { world.dispose(); }
}

// ── 1. an unobserved lead turn is WARNED about, and nothing else changes ──
const bad = await scenario({ observe: false, slot: 'master' });
is('an unobserved lead turn is warned about', 'warn',
   bad.verdicts.length ? bad.verdicts.join(',') : 'no observe-check line at all');
// THE POINT OF WARN-ONLY. Three scripted turns and three taken: the hook did not re-open one.
is('...without changing the run', '3 agent turns',
   bad.timedOut ? `timed out at turn ${bad.agentTurns}` : `${bad.agentTurns} agent turns`);
is('...and the session exited clean', '0', bad.timedOut ? 'timed out' : String(bad.rc));
// The agent must NOT be told. stderr is the one channel that reaches the record and not the
// model; the channel that reaches the model re-opens the turn, which is why it is not used.
is('...and the agent was never told', 'not in the conversation',
   bad.convo.includes('observe-check:') ? 'reached the model' : 'not in the conversation');
// ONE LINE PER TURN, or anything averaging over the records double-counts.
is('...exactly once', '1 observe-check line', `${bad.verdicts.length} observe-check line`);

// ── 2. the same turn, with a look in it, records ok ──────────────────────
const good = await scenario({ observe: true, slot: 'master' });
is('the same turn WITH an observation in it records ok', 'ok',
   good.verdicts.length ? good.verdicts.join(',') : 'no observe-check line at all');
is('...and took the same number of turns as the warned one', `${bad.agentTurns} agent turns`,
   `${good.agentTurns} agent turns`);

// ── 3. a worker is not instrumented at all ───────────────────────────────
const worker = await scenario({ observe: false, slot: 'api-2' });
is('a WORKER doing exactly the same thing gets no line', 'no observe-check line',
   worker.verdicts.length ? `${worker.verdicts.join(',')}` : 'no observe-check line');

// ── the engine is not fooled by a request that is not a turn ─────────────
// Claude Code asks the MODEL for a session title, with no tools array, before the conversation
// starts. fixture-session.mjs indexes its script on requests that DO carry tools for that
// reason, and this row proves it rather than asserting it.
//   GETTING THE TITLE CALL TO HAPPEN TOOK TWO CHANGES, and each is a reason the trap stays
// dormant: it is suppressed by CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, which the engine sets
// (3 of 3 runs made one with it unset, 0 of 6 with it set), and independently by
// bin/claude-here passing `--name`, because a session that already has a name needs no title
// generated (1 of 1 through bare `claude`, 0 of 1 through the launcher). Doubly dormant is the
// worst kind of trap: a fixture keyed on request order passes every test today and mis-scripts
// the day somebody needs either of those different, by writing the surface from the wrong step.
const withTitleCall = await scenario({ observe: false, slot: 'master', launcher: false,
  env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined, CLAUDE_FLEET_SLOT: 'master' } });
is('a non-turn request does not consume a scripted turn', 'a title call arrived, and the turn still warned',
   `${withTitleCall.auxCalls > 0 ? 'a title call arrived' : 'no title call arrived'}, and the turn ${
     withTitleCall.verdicts.includes('warn') ? 'still warned' : 'did not warn'}`);

// ── Q1: a Stop hook CAN block — measured, and deliberately unused ────────
// A TEST-ONLY hook, not the shipped one. The shipped behaviour must not depend on this answer;
// the answer is worth having recorded so that promoting to a refusal later is a decision about
// evidence rather than about whether the platform allows it.
const blocked = await scenario({ observe: false, slot: 'master', hooks: ({ world, recorder }) => {
  const count = path.join(world.cwd, 'n');
  const blocker = path.join(world.cwd, 'block.sh');
  // Refuse the FIRST Stop only. A hook that refuses every Stop of the same turn is an infinite
  // loop wearing the costume of a working guard, and stop_hook_active is what prevents it.
  fs.writeFileSync(blocker, '#!/bin/bash\ncat >/dev/null\n'
    + 'n="$(cat ' + JSON.stringify(count) + ' 2>/dev/null || echo 0)"; n=$((n+1))\n'
    + 'printf %s "$n" > ' + JSON.stringify(count) + '\n'
    + 'if [ "$n" = 1 ]; then echo "TEST-ONLY-BLOCK: keep going" >&2; exit 2; fi\nexit 0\n',
    { mode: 0o755 });
  return { Stop: hookEntry(recorder, blocker) };
} });
is('a Stop hook CAN block, so a refusal is available if #5 ever asks for one', 'blocked, and the turn continued',
   blocked.agentTurns > 3 && blocked.convo.includes('TEST-ONLY-BLOCK')
     ? 'blocked, and the turn continued'
     : `${blocked.agentTurns} agent turns, feedback reached the model: ${blocked.convo.includes('TEST-ONLY-BLOCK')}`);
is('...and the second Stop of the turn is marked, so it cannot loop', 'stop_hook_active on the 2nd',
   blocked.payloads.length > 1 && blocked.payloads[1].stop_hook_active === true
     ? 'stop_hook_active on the 2nd'
     : `${blocked.payloads.length} stops, flags ${blocked.payloads.map((p) => p.stop_hook_active).join(',')}`);

// ── Q2, pinned rather than relied on ────────────────────────────────────
// The scripted final message had two text blocks. What a Stop hook is handed is the LAST one.
is('last_assistant_message carries only the final text block', LAST,
   String(good.payloads[0]?.last_assistant_message ?? '(no Stop payload)'));

if (bad.timedOut || bad.rc !== 0) {
  is('...without complaining', '',
     bad.err.split('\n').filter((l) => l && !l.startsWith('claude-here:')).slice(0, 2).join(' '));
}
done(0);
