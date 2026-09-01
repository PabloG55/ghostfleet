// test/helpers/fixture-session.mjs — the engine behind the scripted-model fixture: drive a
// REAL claude session whose model is a loopback HTTP server, and hand back what happened.
//
// Exports only. Nothing here runs on import, so `node --check` in the suite's syntax group
// covers it and importing it from two helpers costs nothing.
//
// Lifted out of test/helpers/model-fixture.mjs when a SECOND helper needed the same
// scaffolding, on the precedent lib/browser.mjs sets in its own header: converge when there
// is a second caller, not before, and do not converge a file in the same change that
// introduces the thing calling it.
//
// THE MECHANISM, which is what this file is. An agent's model call is an HTTP POST carrying
// messages and tool definitions; the response names the next tool to call. That protocol is
// standardised, so anything that speaks it is, to the agent, a model. Point the real `claude`
// binary at a `node:http` server on loopback with `ANTHROPIC_BASE_URL`, hand it the literal
// API key "fixture" — nothing on the other end is a vendor API, so nothing validates it — and
// the whole stack runs for real except the model's reasoning.
//
// THE ONE THING THAT IS EASY TO GET WRONG, and it cost a whole probe run to find:
// NOT EVERY REQUEST IS A CONVERSATION TURN. Claude Code also asks the model to write a
// session title, and that call arrives FIRST, carrying one user message, NO `tools` array,
// and the text "Write the title in the predominant language of the session". A fixture that
// scripts by request order feeds its first scripted reply to the title generator, so the
// tool call it meant to make never happens — and the session then looks like it simply
// ignored the script, which is a confusing failure rather than an obvious one.
//
// MEASURED, and the trigger is exact rather than a race. TWO independent things suppress the
// title call, which is why the trap is dormant here and still worth guarding:
//
//   * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, which this module sets — 0 of 6 runs made a
//     title call with it set, 3 of 3 with it unset
//   * bin/claude-here passing `--name`, because a session that already has a name needs no
//     title generated — 0 of 1 through the launcher, 1 of 1 through bare `claude`, same
//     environment otherwise
//
// Doubly dormant is the worst kind of trap, not a reason to skip the guard: a fixture keyed
// on request order passes every test today and mis-scripts the day somebody needs either of
// those different — and it fails by feeding step 1 to the title generator, so the tool call
// it meant to make never happens and nothing says why.
//
// So an AGENT TURN is a request that carries tools, and the script is indexed by those.
// Anything without tools gets a short, harmless reply and is counted separately as auxCalls.
// The suite proves this in both directions: with the title call ALLOWED, the script still
// lands on the same turns.

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export const US = '\x1f';

// ── which of the things we need are actually here ─────────────────────────
export function which(cmd) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, cmd);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

// A missing agent is a skip. So are `git` and `jq`, and neither is fussiness: every hook in
// this repo opens with `command -v jq >/dev/null || exit 0`, so without jq a hook declines
// in SILENCE and any assertion about what it did goes red for a reason that has nothing to
// do with the hook.
export function missingPrerequisite() {
  for (const [cmd, why] of [
    ['claude', 'no claude binary to drive'],
    ['git', 'no git, and the hooks read the checkout to tell a lead from a leaf'],
    ['jq', 'no jq, and every hook here declines silently without it'],
  ]) if (!which(cmd)) return why;
  return null;
}

// ── the contract, read from the launcher that SHIPS it ────────────────────
// The point of the whole exercise, in one line: this is the same file a user's session reads,
// so there is no second copy to fall out of step. The contract is a single-quoted bash string
// and CLAUDE.md forbids an apostrophe inside it, so [^']* is not a guess about the grammar —
// it is that invariant, used.
//
// THE `\)` IS LOAD-BEARING. Bash ends a single-quoted string at the FIRST apostrophe, so an
// apostrophe inside the contract truncates what the session receives — 3589 characters to
// 673, measured, green for a day. Anchored only on the quotes, this regex truncates in
// exactly the same place, so it would look for the short string, find the short string, and
// report success while two thirds of the contract had stopped being in force. Requiring the
// closing quote to be followed by the bash array's `)` makes a stray apostrophe match
// NOTHING instead, which is a red row.
export function shippedContract(root) {
  const launcher = fs.readFileSync(path.join(root, 'bin', 'claude-here'), 'utf8');
  return (launcher.match(/--append-system-prompt '([^']*)'\)/) || [, ''])[1];
}

// ── the wire ─────────────────────────────────────────────────────────────
// `stream: true` on every request, so a JSON body is not an option: this has to be SSE in
// the Messages API's event order: message_start, then per block a start / an input_json_delta
// or text_delta / a stop, then message_delta carrying stop_reason, then message_stop. Tool
// input arrives as a JSON STRING in `partial_json`, not as an object — send the object and the
// block parses as empty and the tool is called with no arguments at all.
const sse = (res, ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
export function respond(res, blocks, stop_reason) {
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

// text/tool_use block helpers, so a script reads as a script
export const text = (t) => ({ type: 'text', text: t });
export const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });

// ── a throwaway world ────────────────────────────────────────────────────
// Its own CLAUDE_CONFIG_DIR, its own fleet dir, its own checkout: nothing may touch the
// live fleet's settings.json, its projects/, or its sockets. Two runs of the suite may
// overlap (CLAUDE.md), so every path is mkdtemp and the port is 0 — a fixed port is the
// same trap as a fixed tmux socket, where the second run does not fail, it measures the
// first one's server.
//
// A REAL MAIN CHECKOUT, because the guard's lead/leaf test is git-dir against
// git-common-dir and a leaf is deliberately let through. A bare mkdtemp would be "not a
// repo", where a hook exits 0 and an assertion about a refusal goes red having tested
// nothing.
export function makeWorld() {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-fixture-cfg-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-fixture-cwd-'));
  execFileSync('git', ['init', '-q', cwd], { stdio: 'ignore' });
  fs.writeFileSync(path.join(cwd, 'README.md'), '# acme-api\n');
  execFileSync('git', ['-C', cwd, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', cwd, '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=fixture', 'commit', '-qm', 'init'], { stdio: 'ignore' });
  return { cfg, cwd, dispose: () => {
    try { fs.rmSync(cfg, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
  } };
}

// The same {matcher, hooks:[{type:"command", command}]} shape install.sh's wire_hooks
// writes, pointing at the REPO's scripts rather than the staged runtime copy — the repo is
// what a PR changes, and a fixture reading ~/.local/libexec would test the last cf-sync.
export const hookEntry = (...cmds) => [{ matcher: '', hooks: cmds.map((command) => ({ type: 'command', command })) }];

// ── drive it ─────────────────────────────────────────────────────────────
// `script` is called with ({ agentTurn, body, requests }) and returns { blocks, stop } —
// agentTurn counts only requests that carry tools, for the reason in the header.
export async function runSession({ root, world, hooks, prompt, env: extraEnv = {},
                                   launcher = true, slot = 'master', timeoutMs = 120000, script }) {
  fs.writeFileSync(path.join(world.cfg, 'settings.json'), JSON.stringify({ hooks }, null, 2));

  const requests = [];
  let agentTurns = 0;
  let auxCalls = 0;
  const toolResults = new Map();   // keyed by tool_use_id: every request carries the WHOLE
                                   // conversation, so appending counts a result once per
                                   // later turn and "1 of 2" reads as "1 of 3"
  let sysText = '';

  const server = http.createServer((req, res) => {
    // The binary probes the base URL with `HEAD /api/hello` before its first call. Answer
    // it, or the first turn is spent on a retry.
    if (req.method === 'HEAD') { res.statusCode = 200; res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { res.statusCode = 400; res.end('{}'); return; }
      requests.push(b);
      // The system prompt arrives as an array of cache-scoped blocks, not a string.
      sysText = (Array.isArray(b.system) ? b.system : [{ text: String(b.system || '') }])
        .map((s) => s.text || '').join('\n');
      // A BLOCKED TOOL COMES BACK AS AN ORDINARY tool_result whose content is the hook's
      // stderr — which is why a refusal is observable from out here at all, and the reason a
      // PreToolUse guard can be asserted on rather than merely trusted.
      for (const m of b.messages || []) {
        if (!Array.isArray(m.content)) continue;
        for (const c of m.content) {
          if (c.type === 'tool_result') {
            toolResults.set(c.tool_use_id, typeof c.content === 'string' ? c.content : JSON.stringify(c.content));
          }
        }
      }
      // NOT A TURN: the session-title call carries no tools. Answer it with a word and do
      // not let it consume a scripted step.
      if (!(b.tools || []).length) { auxCalls++; respond(res, [text('acme-api')], 'end_turn'); return; }
      agentTurns++;
      const { blocks, stop } = script({ agentTurn: agentTurns, body: b, requests });
      respond(res, blocks, stop);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;

  const env = { ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
    ANTHROPIC_API_KEY: 'fixture',        // nothing on the other end is a vendor API
    CLAUDE_CONFIG_DIR: world.cfg,
    CLAUDE_FLEET_DIR: path.join(world.cfg, 'fleet'),
    CLAUDE_FLEET_FRESH: '1',             // never resume; discovery would read the real projects dir
    CLAUDE_FLEET_NOTIFIER: 'off',        // a desktop popup per event, from a machine nobody watches
    PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`,
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    DISABLE_BUG_COMMAND: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extraEnv,
  };
  // The parent's own session must not leak in. CLAUDE_CODE_* would register this child
  // against the session running the suite; TMUX is what the hooks route by, and a live cf-*
  // server there would point them at a REAL fleet; a provider override would send the call
  // to Bedrock or Vertex, where it would look like the fixture was never reached.
  for (const k of ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
                   'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
                   'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_ENTRYPOINT', 'TMUX',
                   'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
                   'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) delete env[k];
  for (const [k, v] of Object.entries(extraEnv)) if (v === undefined) delete env[k];

  // -p, because CLAUDE.md forbids driving the interactive TUI headlessly — it blocks on the
  // tty. claude-here passes everything after `--` straight through.
  const cmd = launcher ? path.join(root, 'bin', 'claude-here') : 'claude';
  // The slot is the launcher's first positional and claude-here exports it as
  // CLAUDE_FLEET_SLOT, which is how every hook here tells a lead from a worker. Passing it
  // rather than hard-coding `master` is what lets a test drive the worker case.
  const args = launcher
    ? [slot, '--', '-p', prompt, '--output-format', 'json']
    : ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions'];
  const child = spawn(cmd, args, { cwd: world.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += String(d); });
  child.stdout.resume();
  // A HANG IS A FAILURE, NOT AN ABSENCE. If the wire format moves under us the session waits
  // on a reply that never satisfies it; reporting that as a skip would retire the assertion
  // silently, so the caller gets timedOut and puts it in a red row.
  let timedOut = false;
  const rc = await new Promise((r) => {
    const t = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (c) => { clearTimeout(t); r(c); });
    child.on('error', () => { clearTimeout(t); r(-1); });
  });
  server.close();
  return { rc, timedOut, agentTurns, auxCalls, requests, sysText, err,
           toolResults: [...toolResults.values()] };
}
