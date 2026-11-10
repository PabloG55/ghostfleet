#!/usr/bin/env node
// test/helpers/codex-mcp-client.mjs <config.toml> <server name> <tool> [<args json>]
//
// A STAND-IN FOR CODEX AS AN MCP CLIENT, and only for the one thing about it that ever
// broke: what environment the server starts with. codex does not hand its MCP children the
// session's environment. Measured on codex-cli 0.166.0 (2026-11-10) by having a stub server
// dump `env` from a real session in a scratch fleet, the child gets
//
//     HOME LANG LOGNAME PATH SHELL TERM TMPDIR USER      (plus macOS's own __CF_* and PWD)
//
// then the table's static `env = { … }`, then each name in `env_vars` that the SESSION has
// set — a listed name the session lacks is simply absent, not empty. Everything else the
// session exported is dropped, CLAUDE_FLEET_SOCK included, which is why a codex session's
// fleet_list() used to answer "no socket".
//
// So this reads the table install.sh wrote, builds exactly that environment out of its own
// (which plays the session's), starts the server, makes one tool call and prints the text.
// It does not parse TOML in general: the table codex writes for `codex mcp add` is a header
// and `key = value` lines whose values are a string, an array of strings, or an inline
// table of strings, and that is all this reads. A config it cannot read is an error, never
// an empty table, because an empty table would start the server with the base env and make
// the "no socket" direction pass for the wrong reason.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const [cfgPath, name, tool, argsJson = '{}'] = process.argv.slice(2);
if (!cfgPath || !name || !tool) {
  console.error('usage: codex-mcp-client.mjs <config.toml> <server> <tool> [<args json>]');
  process.exit(2);
}

// The measured base set. TERM is in it because a pane has one; nothing here reads it.
const BASE = ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'TMPDIR', 'USER'];

function table(text, header) {
  const out = {};
  let inside = false, found = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^\[/.test(line)) { inside = line === header; found = found || inside; continue; }
    if (!inside || !line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!m) throw new Error(`cannot read line in ${header}: ${raw}`);
    out[m[1]] = value(m[2]);
  }
  if (!found) throw new Error(`no ${header} table in ${cfgPath}`);
  return out;
}

function value(v) {
  v = v.trim();
  if (v.startsWith('"')) return JSON.parse(v);
  if (v.startsWith('[')) return JSON.parse(v);                     // ["a", "b"] is JSON already
  if (v.startsWith('{')) {                                         // { K = "v", L = "w" }
    const o = {};
    for (const pair of v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)) {
      const m = pair.match(/^([A-Za-z0-9_]+)\s*=\s*(".*")$/);
      if (!m) throw new Error(`cannot read inline table entry: ${pair}`);
      o[m[1]] = JSON.parse(m[2]);
    }
    return o;
  }
  throw new Error(`unsupported value: ${v}`);
}

const t = table(fs.readFileSync(cfgPath, 'utf8'), `[mcp_servers.${name}]`);
if (typeof t.command !== 'string') throw new Error(`[mcp_servers.${name}] has no command`);

const env = {};
for (const k of BASE) if (process.env[k] !== undefined) env[k] = process.env[k];
Object.assign(env, t.env || {});
for (const k of t.env_vars || []) {
  const key = typeof k === 'string' ? k : k.name;
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
if (process.env.CODEX_MCP_CLIENT_DUMP) {                           // for a row that asserts the env itself
  fs.writeFileSync(process.env.CODEX_MCP_CLIENT_DUMP, Object.keys(env).sort().join('\n') + '\n');
}

const child = spawn(t.command, t.args || [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '', done = false;
const finish = (text, code) => {
  if (done) return; done = true;
  process.stdout.write(text);
  try { child.kill(); } catch {}
  process.exit(code);
};
child.stdout.on('data', c => {
  buf += c;
  for (const line of buf.split('\n').slice(0, -1)) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.id !== 2) continue;
    if (o.error) finish(`error: ${o.error.message}\n`, 1);
    finish((o.result?.content || []).map(c => c.text || '').join(''), o.result?.isError ? 1 : 0);
  }
  buf = buf.slice(buf.lastIndexOf('\n') + 1);
});
child.on('exit', () => finish('', 1));
const send = o => child.stdin.write(JSON.stringify(o) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0' } } });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: JSON.parse(argsJson) } });
setTimeout(() => finish('timeout: no answer to the tool call\n', 1), 15000);
