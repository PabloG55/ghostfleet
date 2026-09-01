#!/usr/bin/env node
// test/helpers/model-fixture.mjs — a loopback HTTP server standing in for the model, so
// what the contract and the hooks DO can be asserted, not just what was passed to them.
//
//     node test/helpers/model-fixture.mjs        # "name <US> want <US> got" rows
//
// WHY THIS EXISTS. This repo's contract is its most heavily-evidenced artifact and its
// least protected one. Twenty-two assertions carry measured justifications in their
// comments, and every one of them answers the same question: was the string PASSED? None
// asks whether it arrived, and none asks what happened next. That gap is not theoretical
// — an apostrophe truncated the contract from 3589 characters to 673, submitted the word
// "the" as a turn in every new session, and stayed green for a day, because the tests
// grepped the whole argv rather than one argument.
//
// THE MECHANISM. An agent's model call is an HTTP POST carrying messages and tool
// definitions; the response names the next tool to call. That protocol is standardised,
// so anything that speaks it is, to the agent, a model. Point the real `claude` binary at
// a `node:http` server on loopback with `ANTHROPIC_BASE_URL`, hand it the literal API key
// "fixture", and the whole stack runs for real except the model's reasoning:
//
//   real: the claude binary, bin/claude-here and the contract IT ships, hooks/fleet-guard.sh
//         and hooks/fleet-event.sh as installed hooks, a git checkout, the filesystem
//   fake: only what the model decides to do
//
// MEASURED, and it is why the launcher is invoked rather than `claude` directly: the
// request that arrives here carries a 3-element system array whose last block holds the
// contract read out of bin/claude-here at run time. There is no test-only copy to drift —
// the assertion extracts the string from the shipped launcher and looks for THAT.
//
// WHAT IT PROVES, AND IN BOTH DIRECTIONS. One session, three scripted turns:
//
//   turn 1  Write   -> a real file appears with the scripted bytes, and the guard is silent
//   turn 2  Agent   -> hooks/fleet-guard.sh exits 2 and its refusal comes BACK to the
//                      fixture as a tool_result, which is the one assertion class this
//                      suite could not previously write at all
//   turn 3  text    -> the turn ends, and the Stop hook fires for real
//
// Turn 1 is not filler. A guard that refused everything would pass turn 2 and fail turn 1,
// and a guard that fired never would pass turn 1 and fail turn 2 — the same reason every
// pane assertion in this suite runs against a busy capture AND an idle one. A detector
// that cannot fire is indistinguishable from one that works.
//
// THE THIRD FINDING, which decides an item in docs/improvement-plan.md rather than
// guarding a behaviour: the Stop hook's payload carries `last_assistant_message`, and
// under a scripted model its value is a string chosen HERE. A real model's reply would
// have been an uncontrolled string, so "the hook can see turn-scoped output" could be
// believed but not measured. That is what a fixture buys that a live session cannot.
//
// SKIPPED, not failed, where there is no `claude` binary — the same precedent as
// viewport-check.mjs skipping where there is no Chrome. It needs no npm dependency
// (node:http only) but it does need the agent it is driving, and CI runners have no
// reason to carry one. A skipped group that says why beats a green one that proved
// nothing.
//
// WHY lib/browser.mjs IS NOT REUSED HERE, having been read first. It carries the two
// things that look like the transport this needed — a hand-rolled WebSocket and a port-0
// server — and neither fits. The model wire is plain HTTP with an SSE response, so there
// is no upgrade to hand-roll; and `serveDir` answers with FILES, where a fixture has to
// answer with a reply computed from the request it just received. Reusing it would have
// meant a static server with a dynamic special case bolted on, which is how
// viewport-check's `/__overflowing` already reads. The node >= 18 floor that module was
// written for is respected all the same: nothing below uses anything newer.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));
const skipGroup = (what, why) => rows.push('#SKIP' + US + what + US + why);
const done = (code = 0) => { console.log(rows.join('\n')); process.exit(code); };

// ── is there anything to drive ────────────────────────────────────────────
// A missing agent is a skip. A missing `git` or `jq` is ALSO a skip and not a weakened
// assertion: both hooks open with `command -v jq >/dev/null || exit 0`, so without jq the
// guard would decline silently and "the guard refused" would go red for a reason that has
// nothing to do with the guard.
function which(cmd) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, cmd);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
for (const [cmd, why] of [['claude', 'no claude binary to drive'],
                          ['git', 'no git, and the guard reads the checkout to tell a lead from a leaf'],
                          ['jq', 'no jq, and both hooks decline silently without it']]) {
  if (!which(cmd)) { skipGroup('a real session can be driven by a fixture model', why); done(0); }
}

// ── the contract, read from the launcher that SHIPS it ────────────────────
// The point of the whole exercise, in one line: this is the same file a user's session
// reads, so there is no second copy to fall out of step. The contract is a single-quoted
// bash string and CLAUDE.md forbids an apostrophe inside it, so [^']* is not a guess about
// the grammar — it is that invariant, used.
//
// THE `\)` IS LOAD-BEARING, and without it this whole row is blind to the one bug it most
// needs to catch. Bash ends the string at the FIRST apostrophe, so an apostrophe inside
// the contract truncates what the session receives — 3589 characters to 673, measured.
// Anchored only on the quotes, this regex truncates in exactly the same place, so it would
// look for the short string, find the short string, and report success while two thirds of
// the contract had silently stopped being in force. Requiring the closing quote to be
// followed by the array's `)` means a stray apostrophe matches NOTHING instead.
//   AND A FAILED EXTRACTION MUST NOT PASS EITHER, which is the other half: `"".includes("")`
// is true, so a no-match would make the containment check below succeed on nothing. The
// length is carried into the `got` value for that reason.
const launcher = fs.readFileSync(path.join(ROOT, 'bin', 'claude-here'), 'utf8');
const CONTRACT = (launcher.match(/--append-system-prompt '([^']*)'\)/) || [, ''])[1];

// ── a throwaway world ────────────────────────────────────────────────────
// Its own CLAUDE_CONFIG_DIR, its own fleet dir, its own checkout: nothing here may touch
// the live fleet's settings.json, its projects/, or its sockets. Two runs of the suite are
// explicitly allowed to overlap (CLAUDE.md), so every path is mkdtemp and the port is 0 —
// a fixed port is the same trap as a fixed tmux socket, where the second run does not fail,
// it measures the first one's server.
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-fixture-cfg-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-fixture-cwd-'));
let child = null;
const cleanup = () => {
  try { if (child) child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(cfg, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

// A REAL MAIN CHECKOUT, because the guard's lead/leaf test is git-dir against
// git-common-dir and a leaf is deliberately let through. A bare mkdtemp would be "not a
// repo", where the guard exits 0 and the refusal row would go red having tested nothing.
const git = (...a) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });
execFileSync('git', ['init', '-q', cwd], { stdio: 'ignore' });
fs.writeFileSync(path.join(cwd, 'README.md'), '# acme-api\n');
git('add', '.');
git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'init');

// ── the hooks, wired the way install.sh wires them ───────────────────────
// The same {matcher, hooks:[{type:"command", command}]} shape wire_hooks writes, pointing
// at the repo's own scripts rather than the staged runtime copy — the repo is what a PR
// changes, and a fixture that read ~/.local/libexec would test the last cf-sync instead.
const STOP_PAYLOAD = path.join(cwd, 'stop-payload.json');
const entry = (cmd) => [{ matcher: '', hooks: [{ type: 'command', command: cmd }] }];
fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({
  hooks: {
    PreToolUse: entry(path.join(ROOT, 'hooks', 'fleet-guard.sh')),
    UserPromptSubmit: entry(path.join(ROOT, 'hooks', 'fleet-event.sh')),
    // Two commands on one event, which is the array wire_hooks already produces. The
    // second is this file's instrument and ships nothing: it copies the payload out so
    // the assertion can read what a Stop hook is actually handed, the same way
    // viewport-check serves its own deliberately-overflowing page from inside itself.
    Stop: [{ matcher: '', hooks: [
      { type: 'command', command: path.join(ROOT, 'hooks', 'fleet-event.sh') },
      { type: 'command', command: `cat > ${JSON.stringify(STOP_PAYLOAD)}` },
    ] }],
  },
}, null, 2));

// ── the wire ─────────────────────────────────────────────────────────────
// `stream: true` on every request, so a JSON body is not an option: this has to be SSE in
// the Messages API's event order. message_start, then per block a start / an
// input_json_delta or text_delta / a stop, then message_delta carrying stop_reason, then
// message_stop. Tool input arrives as a JSON STRING in partial_json, not as an object —
// send the object and the block parses as empty and the tool is called with no arguments.
const sse = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
function respond(res, blocks, stop_reason) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  sse(res, 'message_start', { type: 'message_start', message: {
    id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-fixture',
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text } });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index: i,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index: i });
  });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ── the script, and what each turn is for ────────────────────────────────
const WRITTEN = path.join(cwd, 'observed.txt');
const BYTES = 'acme-api: written by the scripted model\n';
const FINAL = 'the guard stopped the dispatch.';
const REFUSAL = 'dispatch through the fleet';   // hooks/fleet-guard.sh, on its stderr

let turns = 0;
let sysText = '';
// KEYED BY tool_use_id, NOT APPENDED. Every request carries the WHOLE conversation, so a
// result from turn 1 arrives again in turn 3 — appending counted the Write twice and made
// "1 of 2" read as "1 of 3", which is a row that fails while the code under it is right.
const toolResults = new Map();

const server = http.createServer((req, res) => {
  // The binary probes the base URL with `HEAD /api/hello` before its first call. Answer it
  // or the first turn is spent on a retry.
  if (req.method === 'HEAD') { res.statusCode = 200; res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let b; try { b = JSON.parse(body); } catch { res.statusCode = 400; res.end('{}'); return; }
    turns++;
    // The system prompt arrives as an array of cache-scoped blocks, not a string.
    sysText = (Array.isArray(b.system) ? b.system : [{ text: String(b.system || '') }])
      .map((s) => s.text || '').join('\n');
    // A blocked tool comes back as an ordinary tool_result whose content is the hook's
    // stderr — which is why a refusal is observable from out here at all.
    for (const m of b.messages || []) {
      if (!Array.isArray(m.content)) continue;
      for (const c of m.content) {
        if (c.type === 'tool_result') {
          toolResults.set(c.tool_use_id, typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
        }
      }
    }
    if (turns === 1) {
      // A tool the guard does NOT intercept: proves the session really executes what is
      // scripted, and gives the refusal check its silent direction.
      respond(res, [{ type: 'tool_use', id: 'toolu_fixture_write', name: 'Write',
        input: { file_path: WRITTEN, content: BYTES } }], 'tool_use');
    } else if (turns === 2) {
      // Dispatch-by-subagent from a lead — the exact thing hooks/fleet-guard.sh exists to
      // refuse. subagent_type must not be Explore or Plan: the guard lets read-only
      // research through on purpose.
      respond(res, [{ type: 'tool_use', id: 'toolu_fixture_agent', name: 'Agent',
        input: { description: 'hand off the work', prompt: 'build the acme-api change',
                 subagent_type: 'general-purpose' } }], 'tool_use');
    } else {
      respond(res, [{ type: 'text', text: FINAL }], 'end_turn');
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// ── drive it ─────────────────────────────────────────────────────────────
const env = { ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  ANTHROPIC_API_KEY: 'fixture',      // nothing on the other end is a vendor API
  CLAUDE_CONFIG_DIR: cfg,
  CLAUDE_FLEET_DIR: path.join(cfg, 'fleet'),
  CLAUDE_FLEET_FRESH: '1',           // never resume; discovery would read the real projects dir
  CLAUDE_FLEET_SOCK: 'cf-acme-api',  // the guard declines outside a fleet
  // master, and not only because a lead is who the guard refuses: the worker->lead push
  // block in fleet-event.sh is gated on `SLOT != master`, so this also cannot reach a real
  // fleet's inbox or fire fleet-send at a live session.
  CLAUDE_FLEET_SLOT: 'master',
  CLAUDE_FLEET_NOTIFIER: 'off',      // a desktop popup per event, from a machine nobody is watching
  PATH: `${path.join(ROOT, 'bin')}${path.delimiter}${process.env.PATH}`,
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
  DISABLE_BUG_COMMAND: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};
// The parent's own session must not leak in. CLAUDE_CODE_* would register this child
// against the session running the suite; TMUX is what both hooks route by, and a live
// cf-* server there would point them at a real fleet; and a provider override would send
// the call to Bedrock or Vertex instead of to the fixture, where it would look like the
// fixture was simply never reached.
for (const k of ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
                 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
                 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_ENTRYPOINT', 'TMUX',
                 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
                 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) delete env[k];

// -p, because CLAUDE.md forbids driving the interactive TUI headlessly — it blocks on the
// tty. claude-here passes everything after `--` straight through.
child = spawn(path.join(ROOT, 'bin', 'claude-here'),
  ['master', '--', '-p', 'dispatch the acme-api change', '--output-format', 'json'],
  { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
let err = '';
child.stderr.on('data', (d) => { err += String(d); });
child.stdout.resume();
// A HANG IS A FAILURE, NOT AN ABSENCE. If the wire format moves under us the session
// waits on a reply that never satisfies it, and reporting that as a skip would retire the
// assertion silently. The rows below go red with "timed out" in them instead.
let timedOut = false;
const rc = await new Promise((r) => {
  const t = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, 120000);
  child.on('close', (c) => { clearTimeout(t); r(c); });
  child.on('error', () => { clearTimeout(t); r(-1); });
});
server.close();

// ── what was observed ────────────────────────────────────────────────────
const ran = timedOut ? `timed out after 120s at turn ${turns}` : `${turns} turns`;
is('a real claude session reached the fixture', '3 turns', ran);
is('...and exited clean', '0', String(rc));

// The whole point: the shipped launcher's string, in the model request. `got` carries the
// extracted length so a regex that matched nothing cannot pass on `"".includes("")`.
is('the contract from bin/claude-here reaches the model request', 'present',
   CONTRACT.length < 1000 ? `only ${CONTRACT.length} chars extracted from bin/claude-here`
   : sysText.includes(CONTRACT) ? 'present' : `absent (${CONTRACT.length} chars looked for)`);

// A scripted reply, an effect on disk. The bytes are compared, not the existence of the
// file — a Write that ran with an empty input would still create one.
is('a scripted reply produced a real file', BYTES,
   (() => { try { return fs.readFileSync(WRITTEN, 'utf8'); } catch { return '(no file)'; } })());

// THE ASSERTION THIS FILE EXISTS FOR. A real PreToolUse hook refused a scripted tool call
// and its reason travelled back into the conversation, where the fixture read it.
const results = [...toolResults.values()];
const refusals = results.filter((t) => t.includes(REFUSAL));
is('the real guard refused the scripted dispatch, and the refusal came back',
   'yes', refusals.length > 0 ? 'yes' : `no (${results.length} tool_results, none carrying the refusal)`);
// The other direction, on the same measurement: the guard has to be silent on the tool it
// does not guard, or "it refused" is a sentence a guard that refuses everything also says.
is('...and stayed silent on the Write it does not guard', '1 of 2 tool_results refused',
   `${refusals.length} of ${results.length} tool_results refused`);

// Turn-scoped model output, delivered to a Stop hook, with the value chosen here — which
// is the finding a live session cannot produce. docs/improvement-plan.md #6 is
// conditional on this being possible.
let lastMsg = '(no Stop payload)';
try { lastMsg = String(JSON.parse(fs.readFileSync(STOP_PAYLOAD, 'utf8')).last_assistant_message ?? '(absent)'); } catch {}
is("the real Stop hook saw this turn's own output", FINAL, lastMsg);

if (timedOut || rc !== 0) {
  // Keep the reason: the one thing worse than a session that will not run is one that
  // will not run and will not say why. viewport-check keeps Chrome's stderr for the same
  // reason, after going red on both CI legs with nothing to go on.
  is('...without complaining', '', err.split('\n').filter((l) => l && !l.startsWith('claude-here:')).slice(0, 2).join(' '));
}
done(0);
