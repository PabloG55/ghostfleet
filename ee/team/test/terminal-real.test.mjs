import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createTerminalTabs } from '../server/terminal-tab.mjs';
import { createTerminal } from '../server/terminal.mjs';
import { connect } from './helpers/terminal-ws.mjs';

const repo = new URL('../../../', import.meta.url).pathname;
const command = (args, env = process.env) => cp.execFileSync('tmux', args, { encoding: 'utf8', env: { ...env, TMUX: '' } }).trim();

test('real terminal refuses unlisted or target-syntax project names before any subprocess', async t => {
  const calls = [];
  t.mock.method(cp, 'execFile', (...args) => { calls.push(args); throw new Error('unexpected subprocess'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (const name of ['missing', '+scratch', '-scratch', 'scratch:x', 'scratch.x', 'scratch=x', 'scratch{x', 'scratch}x', 'scratch/x']) {
    const tabs = createTerminalTabs({ home: repo, projects: () => name === 'missing' ? [] : [{ name }] });
    await assert.rejects(tabs.openTerminal(name, 'term'), e => e.status === 404, name);
    assert.equal(calls.length, 0, name);
  }
});

test('real terminal verifies returned and listed tab names and UTF-8 on every read', async t => {
  const project = { name: 'acme-api', sock: 'scratch', path: '/tmp' }, calls = [];
  let tab = '_term-acme-api', names = '_term-acme-api\n';
  t.mock.method(cp, 'execFile', (cmd, args, opts, callback) => {
    calls.push({ cmd, args });
    callback(null, cmd === 'tmux' ? args.includes('list-sessions') ? names : '' : tab, '');
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let current = [project];
  const tabs = createTerminalTabs({ home: repo, projects: () => current });
  assert.deepEqual(await tabs.openTerminal('acme-api', 'term'), { sock: 'scratch', session: tab });
  assert.ok(calls.some(c => c.args.includes('list-sessions')));
  assert.ok(calls.filter(c => c.cmd === 'tmux').every(c => c.args.includes('-u')));
  for (tab of ['+scratch', '-scratch', 'scratch:x', 'scratch.x', 'scratch=x', 'scratch{x', 'scratch}x', '_edit-acme-api', '_term-toolbox']) {
    const count = calls.length;
    await assert.rejects(tabs.openTerminal('acme-api', 'term'), e => e.status === 404, tab);
    assert.equal(calls.length, count + 1, 'invalid returned name is refused before a tmux read or write');
  }
  tab = '_term-acme-api'; names = '_term-acme-api-other\n';
  await assert.rejects(tabs.openTerminal('acme-api', 'term'), e => e.status === 404, 'substring match must not authorize a tab');
  names = '_term-acme-api\n';
  await tabs.checkTerminal({ project: 'acme-api', kind: 'term', sock: 'scratch', session: tab });
  current = [];
  await assert.rejects(tabs.checkTerminal({ project: 'acme-api', kind: 'term', sock: 'scratch', session: tab }), e => e.status === 404);
});

test('real WebSocket opens the shared project tab, round-trips shell output, resizes and counts output as activity', async t => {
  // A short socket path works on macOS too; only this test's namespace is reachable.
  const root = fs.mkdtempSync('/tmp/gft-');
  const tmuxDir = path.join(root, 'tmux'); fs.mkdirSync(tmuxDir, { mode: 0o700 });
  const previous = process.env.TMUX_TMPDIR; process.env.TMUX_TMPDIR = tmuxDir;
  const shell = path.join(root, 'shell');
  fs.writeFileSync(shell, '#!/bin/sh\nPS1="$ "\nexport PS1\nexec /bin/sh -f\n', { mode: 0o700 });
  const sock = 'scratch', env = { ...process.env, SHELL: shell, LC_ALL: 'C', LANG: 'C' };
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tmux'));
  fs.symlinkSync(path.join(repo, 'bin', 'fleet-tab'), path.join(home, 'bin', 'fleet-tab'));
  fs.writeFileSync(path.join(home, 'tmux', 'cf.tmux.conf'), 'set -g status off\n');
  const project = { name: 'acme-api', sock, path: fs.realpathSync(root) };
  const tabs = createTerminalTabs({ home, projects: () => [project], env: () => env });
  const audit = [], peers = [];
  let time = 0;
  const user = { id: 'member', role: 'member', projects: { 'acme-api': 'member' } };
  const terminal = createTerminal({ fleet: tabs, audit: row => audit.push(row),
    clock: () => time, tickMs: 20, authenticate: req => req.headers.cookie === 'gfw=scratch' ? { user, key: 'scratch' } : null,
    allowedHost: host => host.startsWith('127.0.0.1:') });
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const result = await terminal.open(user, 'scratch', JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(e.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: e.message })); }
  });
  server.on('upgrade', (req, socket, head) => { void terminal.upgrade(req, socket, head); });
  t.after(async () => {
    terminal.close(); peers.forEach(p => p.socket?.destroy());
    await new Promise(resolve => server.close(resolve));
    // -L plus this test's TMUX_TMPDIR can never address the live fleet.
    try { command(['-L', sock, 'kill-server'], env); } catch {}
    if (previous === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/term/open`, { method: 'POST',
    body: JSON.stringify({ project: 'acme-api', kind: 'term', cols: 83, rows: 27 }) });
  assert.equal(response.status, 200);
  const tab = await response.json();
  const peer = await connect({ port, cookie: 'gfw=scratch', ticket: tab.ticket }); peers.push(peer);
  assert.equal(peer.status, 101);
  await peer.wait(({ messages }) => messages.some(m => m.t === 'ready'));
  assert.equal(command(['-u', '-L', sock, 'list-sessions', '-F', '#{session_name}'], env), '_term-acme-api');
  assert.equal(command(['-u', '-L', sock, 'display-message', '-p', '-t', '_term-acme-api', '#{pane_current_path}'], env), project.path);
  assert.equal(command(['-u', '-L', sock, 'show-options', '-wv', '-t', '_term-acme-api', 'window-size'], env), 'latest');
  // Suppress the shell's input echo: the assertion must observe command execution.
  peer.input("stty -echo; printf '\\n%s\\n' terminal-ready\r");
  await peer.wait(({ output }) => output.includes('\r\nterminal-ready\r\n'));
  peer.input("printf '\\n'; echo terminal-real-sentinel\r");
  await peer.wait(({ output }) => output.includes('\r\nterminal-real-sentinel\r\n'));
  peer.resize(101, 39);
  for (let i = 0; i < 100; i++) {
    if (command(['-u', '-L', sock, 'display-message', '-p', '-t', '_term-acme-api', '#{pane_width}x#{pane_height}'], env) === '101x39') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(command(['-u', '-L', sock, 'display-message', '-p', '-t', '_term-acme-api', '#{pane_width}x#{pane_height}'], env), '101x39');
  const tty = command(['-u', '-L', sock, 'display-message', '-p', '-t', '_term-acme-api', '#{pane_tty}'], env);
  time = 1799000;
  peer.pong();
  fs.writeFileSync(tty, 'terminal-output-activity\r\n');
  await peer.wait(({ output }) => output.includes('terminal-output-activity'));
  time = 1801000;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(peer.messages.some(m => m.t === 'closed'), false, 'output alone resets the idle timer');
  time = 3600000;
  await peer.wait(({ messages }) => messages.some(m => m.close === 4000));
  assert.equal(command(['-u', '-L', sock, 'list-sessions', '-F', '#{session_name}'], env), '_term-acme-api', 'idle detaches the client, preserving the desk tab');
  assert.deepEqual(audit.map(r => r.verb), ['terminal_open', 'terminal_close']);
  assert.equal(JSON.stringify(audit).includes('terminal-real-sentinel'), false);
  assert.equal(audit[1].duration, 3600);

  // fleet-tab supplies the actionable editor error without starting a fallback shell.
  env.CLAUDE_FLEET_EDITOR = 'scratch-editor-not-installed';
  await assert.rejects(tabs.openTerminal('acme-api', 'edit'), e => e.status === 502 && /no editor on this machine/.test(e.message));
});
