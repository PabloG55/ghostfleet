// Drives the REAL fleet-mcp.mjs over its real stdio JSON-RPC and prints one record per
// case: <case>\x1f<isError 1|0>\x1f<response text, whitespace-flattened>.
//
// One long-lived server process rather than one pipe-and-sleep per case: the server only
// exits when stdin ends, so a case per invocation costs a flush wait each (the older MCP
// group's `sleep 3`), and there are twenty of them here.
//
// \x1f between fields, never a tab — a tab is IFS-whitespace, so an empty field
// collapses and shifts every later one left, which is a bug this repo has shipped twice.
import { spawn } from 'node:child_process';

const server = process.argv[2];
const p = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'ignore'] });
const w = (o) => p.stdin.write(JSON.stringify(o) + '\n');

const names = new Map();                        // request id -> case name
const got = new Map();
let next = 10, want = -1;

const call = (label, tool, args) => {
  const id = next++;
  names.set(id, label);
  w({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } });
};

function plan(tools) {
  // The reported bug, verbatim: the key the client dropped.
  call('send.no-prompt',   'fleet_send',   { session: 'w1' });
  // ...and the same call with it, which must still RUN and carry it through untouched.
  // Without this direction a guard that refused everything would look identical.
  call('send.ok',          'fleet_send',   { session: 'w1', prompt: 'the real work' });
  call('send.empty',       'fleet_send',   { session: 'w1', prompt: '' });
  call('send.no-session',  'fleet_send',   { prompt: 'x' });
  call('send.obj-prompt',  'fleet_send',   { session: 'w1', prompt: { a: 1 } });
  call('pause.null',       'fleet_pause',  { session: null });
  // fleet_answer types raw keys at a BLOCKED worker, so a missing text is the worst of
  // the set (u-n-d-e-f-i-n-e-d into a permission dialog) while an empty one is a
  // legible request for the bare Enter its description promises: refuse the first, let
  // the second through to fleet-answer, which owns that call.
  call('answer.no-text',   'fleet_answer', { session: 'w1' });
  call('answer.empty',     'fleet_answer', { session: 'w1', text: '' });
  // Optional arguments must not start erroring — the guard reads `required` only.
  call('read.no-n',        'fleet_read',   { session: 'w1' });
  call('stop.no-reclaim',  'fleet_stop',   { session: 'w1' });
  call('list.no-args',     'fleet_list',   {});
  call('inbox.all',        'fleet_inbox',  { all: true });
  call('resume.prompt',    'fleet_resume', { session: 'w1', prompt: 'go' });

  // DRIFT: every required argument the server itself declares, omitted in turn. Written
  // against tools/list rather than a hand-kept list, so a tool added later is covered
  // here without anyone remembering to come back.
  for (const t of tools) {
    const req = t.inputSchema?.required || [];
    for (const k of req) {
      const args = {};
      for (const other of req) if (other !== k) args[other] = 'placeholder';
      call(`req:${t.name}.${k}`, t.name, args);
    }
  }
  want = names.size;
}

function finish() {
  for (const id of [...names.keys()].sort((a, b) => a - b)) {
    const m = got.get(id), r = m?.result || {};
    const text = String(r.content?.[0]?.text ?? '').replace(/\s+/g, ' ').trim();
    process.stdout.write(`${names.get(id)}\x1f${r.isError ? 1 : 0}\x1f${text}\n`);
  }
  p.stdin.end();                                 // the server exits on end; no exit() race
}

let buf = '';
p.stdout.setEncoding('utf8');
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === 2) { plan(m.result?.tools || []); continue; }
    if (names.has(m.id)) { got.set(m.id, m); if (got.size === want) finish(); }
  }
});

w({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
w({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
// A response that never arrives must fail the run, not hang it. unref'd so it never
// keeps the loop alive on its own.
setTimeout(() => { process.stdout.write('TIMEOUT\x1f1\x1f no response\n'); p.kill(); process.exit(1); }, 30000).unref();
