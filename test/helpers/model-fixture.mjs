#!/usr/bin/env node
// test/helpers/model-fixture.mjs — a loopback HTTP server standing in for the model, so
// what the contract and the hooks DO can be asserted, not just what was passed to them.
//
//     node test/helpers/model-fixture.mjs        # "name <US> want <US> got" rows
//
// WHY THIS EXISTS. This repo's contract is its most heavily-evidenced artifact and its least
// protected one. Twenty-two assertions carry measured justifications in their comments, and
// every one of them answers the same question: was the string PASSED? None asks whether it
// arrived, and none asks what happened next. That gap is not theoretical — an apostrophe
// truncated the contract from 3589 characters to 673, submitted the word "the" as a turn in
// every new session, and stayed green for a day, because the tests grepped the whole argv
// rather than one argument.
//
// THE MECHANISM. An agent's model call is an HTTP POST carrying messages and tool
// definitions; the response names the next tool to call. That protocol is standardised, so
// anything that speaks it is, to the agent, a model. The transport lives in
// fixture-session.mjs; what stays real is the point:
//
//   real: the claude binary, bin/claude-here and the contract IT ships, hooks/fleet-guard.sh
//         and hooks/fleet-event.sh as installed hooks, a git checkout, the filesystem
//   fake: only what the model decides to do
//
// MEASURED, and it is why the launcher is invoked rather than `claude` directly: the request
// that arrives carries a 3-element system array whose last block holds the contract read out
// of bin/claude-here at run time. There is no test-only copy to drift — the assertion
// extracts the string from the shipped launcher and looks for THAT.
//
// WHAT IT PROVES, AND IN BOTH DIRECTIONS. One session, three scripted turns:
//
//   turn 1  Write   -> a real file appears with the scripted bytes, and the guard is silent
//   turn 2  Agent   -> hooks/fleet-guard.sh exits 2 and its refusal comes BACK to the
//                      fixture as a tool_result, which is the one assertion class this suite
//                      could not previously write at all
//   turn 3  text    -> the turn ends, and the Stop hook fires for real
//
// Turn 1 is not filler. A guard that refused everything would pass turn 2 and fail turn 1,
// and a guard that fired never would pass turn 1 and fail turn 2 — the same reason every
// pane assertion in this suite runs against a busy capture AND an idle one. A detector that
// cannot fire is indistinguishable from one that works.
//
// THE THIRD FINDING, which decided an item in docs/improvement-plan.md rather than guarding
// a behaviour: the Stop hook's payload carries `last_assistant_message`, and under a scripted
// model its value is a string chosen HERE. A real model's reply would have been an
// uncontrolled string, so "the hook can see turn-scoped output" could be believed but not
// measured. That is what a fixture buys that a live session cannot — and what it bought is
// hooks/fleet-observe.sh, tested by observe-check.mjs beside this file.
//
// SKIPPED, not failed, where there is no `claude` binary — the same precedent as
// viewport-check.mjs skipping where there is no Chrome. It needs no npm dependency
// (node:http only) but it does need the agent it is driving, and CI runners have no reason to
// carry one. A skipped group that says why beats a green one that proved nothing.
//
// WHY lib/browser.mjs IS NOT REUSED HERE, having been read first. It carries the two things
// that look like the transport this needed — a hand-rolled WebSocket and a port-0 server —
// and neither fits. The model wire is plain HTTP with an SSE response, so there is no upgrade
// to hand-roll; and `serveDir` answers with FILES, where a fixture has to answer with a reply
// computed from the request it just received. The node >= 18 floor that module was written
// for is respected all the same: nothing here uses anything newer.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { US, missingPrerequisite, shippedContract, makeWorld, hookEntry, runSession, text, tool }
  from './fixture-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };

const why = missingPrerequisite();
if (why) {
  rows.push('#SKIP' + US + 'a real session can be driven by a fixture model' + US + why);
  done(0);
}

// The contract, read from the launcher that SHIPS it — see shippedContract() for why the
// regex is anchored on the array's closing paren, which is the half that catches the
// apostrophe bug instead of reproducing it.
const CONTRACT = shippedContract(ROOT);

const world = makeWorld();
const WRITTEN = path.join(world.cwd, 'observed.txt');
const BYTES = 'acme-api: written by the scripted model\n';
const FINAL = 'the guard stopped the dispatch.';
const REFUSAL = 'dispatch through the fleet';   // hooks/fleet-guard.sh, on its stderr
const STOP_PAYLOAD = path.join(world.cwd, 'stop-payload.json');

let r;
try {
  r = await runSession({
    root: ROOT, world, prompt: 'dispatch the acme-api change',
    hooks: {
      PreToolUse: hookEntry(path.join(ROOT, 'hooks', 'fleet-guard.sh')),
      UserPromptSubmit: hookEntry(path.join(ROOT, 'hooks', 'fleet-event.sh')),
      // Two commands on one event, which is the array install.sh's wire_hooks already
      // produces. The second is this file's instrument and ships nothing: it copies the
      // payload out so the assertion can read what a Stop hook is actually handed, the same
      // way viewport-check serves its own deliberately-overflowing page from inside itself.
      Stop: hookEntry(path.join(ROOT, 'hooks', 'fleet-event.sh'),
                      'cat > ' + JSON.stringify(STOP_PAYLOAD)),
    },
    // The guard declines outside a fleet. `master` is not only because a lead is who it
    // refuses: the worker->lead push block in fleet-event.sh is gated on `SLOT != master`,
    // so this also cannot reach a real fleet's inbox or fire fleet-send at a live session.
    env: { CLAUDE_FLEET_SOCK: 'cf-acme-api' },
    script: ({ agentTurn }) => {
      if (agentTurn === 1) {
        // A tool the guard does NOT intercept: proves the session really executes what is
        // scripted, and gives the refusal check its silent direction.
        return { blocks: [tool('toolu_fixture_write', 'Write', { file_path: WRITTEN, content: BYTES })],
                 stop: 'tool_use' };
      }
      if (agentTurn === 2) {
        // Dispatch-by-subagent from a lead — the exact thing hooks/fleet-guard.sh exists to
        // refuse. subagent_type must not be Explore or Plan: the guard lets read-only
        // research through on purpose.
        return { blocks: [tool('toolu_fixture_agent', 'Agent',
                   { description: 'hand off the work', prompt: 'build the acme-api change',
                     subagent_type: 'general-purpose' })], stop: 'tool_use' };
      }
      return { blocks: [text(FINAL)], stop: 'end_turn' };
    },
  });

  const ran = r.timedOut ? `timed out after 120s at turn ${r.agentTurns}` : `${r.agentTurns} turns`;
  is('a real claude session reached the fixture', '3 turns', ran);
  is('...and exited clean', '0', String(r.rc));

  // The whole point: the shipped launcher's string, in the model request. `got` carries the
  // extracted length so a regex that matched nothing cannot pass on `"".includes("")`.
  is('the contract from bin/claude-here reaches the model request', 'present',
     CONTRACT.length < 1000 ? `only ${CONTRACT.length} chars extracted from bin/claude-here`
     : r.sysText.includes(CONTRACT) ? 'present' : `absent (${CONTRACT.length} chars looked for)`);

  // A scripted reply, an effect on disk. The bytes are compared, not the existence of the
  // file — a Write that ran with an empty input would still create one.
  is('a scripted reply produced a real file', BYTES,
     (() => { try { return fs.readFileSync(WRITTEN, 'utf8'); } catch { return '(no file)'; } })());

  // THE ASSERTION THIS FILE EXISTS FOR. A real PreToolUse hook refused a scripted tool call
  // and its reason travelled back into the conversation, where the fixture read it.
  const refusals = r.toolResults.filter((t) => t.includes(REFUSAL));
  is('the real guard refused the scripted dispatch, and the refusal came back',
     'yes', refusals.length > 0 ? 'yes'
     : `no (${r.toolResults.length} tool_results, none carrying the refusal)`);
  // The other direction, on the same measurement: the guard has to be silent on the tool it
  // does not guard, or "it refused" is a sentence a guard that refuses everything also says.
  is('...and stayed silent on the Write it does not guard', '1 of 2 tool_results refused',
     `${refusals.length} of ${r.toolResults.length} tool_results refused`);

  // Turn-scoped model output, delivered to a Stop hook, with the value chosen here — the
  // finding a live session cannot produce. It is what hooks/fleet-observe.sh rests on.
  let lastMsg = '(no Stop payload)';
  try { lastMsg = String(JSON.parse(fs.readFileSync(STOP_PAYLOAD, 'utf8')).last_assistant_message ?? '(absent)'); } catch {}
  is("the real Stop hook saw this turn's own output", FINAL, lastMsg);

  if (r.timedOut || r.rc !== 0) {
    // Keep the reason: the one thing worse than a session that will not run is one that will
    // not run and will not say why. viewport-check keeps Chrome's stderr for the same reason,
    // after going red on both CI legs with nothing to go on.
    is('...without complaining', '',
       r.err.split('\n').filter((l) => l && !l.startsWith('claude-here:')).slice(0, 2).join(' '));
  }
} finally { world.dispose(); }
done(0);
