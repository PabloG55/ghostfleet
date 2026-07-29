#!/usr/bin/env node
// claude-fleet MCP server — exposes the fleet orchestration commands as native
// tools so a lead Claude session can call them as structured tool-calls instead
// of shelling out. Thin wrapper over bin/fleet-{list,send,read,spawn,worktrees,
// inbox,answer,pause,resume}; those
// read the session's env (CLAUDE_FLEET_SOCK, CLAUDE_CONFIG_DIR) which this
// server inherits from the Claude session that launched it.
//
// Dependency-free stdio JSON-RPC (newline-delimited), the MCP stdio transport.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const HOME = os.homedir();

// CROSS-FLEET: every fleet is its own tmux server (cf-<project>), and `tmux -L`
// reaches any of them — the bin/ commands all take `-s <socket>`. Without a way to
// name another fleet, a lead could only ever see its own, so work spanning repos
// (e.g. replying to a session fleet-open put on another project's fleet) was
// impossible from a tool call. Resolve a project name -> its socket + config dir,
// from the same ~/.config/claude-fleet/projects[.<profile>] files claude-fleet reads.
function projects() {
  const dir = path.join(HOME, '.config', 'claude-fleet');
  const files = [path.join(dir, 'projects')];
  try { for (const f of fs.readdirSync(dir)) if (f.startsWith('projects.')) files.push(path.join(dir, f)); } catch {}
  const out = [];
  for (const f of files) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      const t = line.replace(/\r$/, '');
      if (!t.trim() || t.startsWith('#')) continue;
      const [name, p, prof0] = t.split('\t');
      if (!name || !p) continue;
      const prof = prof0 || 'work';
      const isWork = prof === 'work' || prof === 'default';
      out.push({ name, path: p.replace(/^~/, HOME), profile: prof,
                 sock: isWork ? `cf-${name}` : `cf-${prof}-${name}`,
                 cfg: isWork ? path.join(HOME, '.claude') : path.join(HOME, '.claude-' + prof) });
    }
  }
  return out;
}
function target(proj) {
  if (!proj) return null;                       // omitted -> the caller's own fleet
  const s = String(proj), all = projects();
  const hit = all.find(p => p.name === s) || all.find(p => p.sock === s);
  if (!hit) throw new Error(`unknown project '${s}' — call fleet_projects to list them`);
  return hit;
}

function run(cmd, args, t) {
  // When targeting another fleet, pass -s AND point the env at that profile, so
  // status/markers land in the right fleet dir. TMUX is cleared because the commands
  // prefer the live server it names (drift-proof for normal use, wrong here).
  const argv = t ? ['-s', t.sock, ...args] : args;
  const env = t ? { ...process.env, TMUX: '', CLAUDE_FLEET_SOCK: t.sock,
                    CLAUDE_CONFIG_DIR: t.cfg, CLAUDE_FLEET_DIR: path.join(t.cfg, 'fleet') }
                : process.env;
  try {
    return execFileSync(path.join(BIN, cmd), argv, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }) || '(no output)';
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`.trim() || `error: ${e.message}`;
  }
}

const TOOLS = [
  { name: 'fleet_list', description: "List the Claude sessions in a fleet (parallel worktrees) with their status. Call this first to see which siblings exist and whether they are free. Pass `project` to list ANOTHER project's fleet.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" } }, additionalProperties: false } },
  { name: 'fleet_send', description: 'Send a prompt to a sibling fleet session and submit it (it runs there). The prompt must be self-contained — the sibling does not share your context.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string', description: 'target session name (see fleet_list)' }, prompt: { type: 'string', description: 'the full, self-contained prompt to run there' } }, required: ['session', 'prompt'], additionalProperties: false } },
  { name: 'fleet_read', description: 'Read the last N assistant messages from a sibling session, to check its progress/output.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' }, n: { type: 'number', description: 'how many recent assistant messages (default 1)' } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_spawn', description: 'Create a new git worktree off the current repo and start a fresh parallel session in it (in the background), optionally with an initial task prompt. Call fleet_worktrees FIRST: if free worktrees exist, spawn refuses unless you reuse one (reuse) or force a new one (force_new).',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'session + worktree name' }, branch: { type: 'string', description: 'branch to use/create (default: name)' }, from: { type: 'string', description: 'base ref for a new branch; bases on your LOCAL ref (use "HEAD" for current), falls back to the remote tip only if local is behind' }, prompt: { type: 'string', description: 'initial task to send once it boots' }, model: { type: 'string', description: 'model for the worker (e.g. opus); default = account default' }, reuse: { type: 'string', description: 'start in this EXISTING free worktree (name or path); combine with branch+from to clean & rebranch it in one step' }, force_new: { type: 'boolean', description: 'create a new worktree even if free ones exist' } }, required: ['name'], additionalProperties: false } },
  { name: 'fleet_worktrees', description: 'Inventory every git worktree of this repo — branch, whether a session is live on it, git state, and which are FREE to reuse. Call this BEFORE fleet_spawn so you reuse an idle worktree instead of proliferating new ones.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'fleet_inbox', description: "Drain the lead's attention feed: worker 'need-you' events (permission / usage-limit / real questions) plus governor park/resume, collected passively. One call replaces polling every sibling — shows only what is new since last call.",
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'show the whole inbox instead of only new entries' } }, additionalProperties: false } },
  { name: 'fleet_answer', description: 'Send raw keystrokes to a worker BLOCKED on a prompt — a permission dialog, a "reached usage limit — retry?", a trust prompt (e.g. text "2"). Use this to unblock a worker; use fleet_send for normal task prompts.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' }, text: { type: 'string', description: 'literal keys to send (e.g. "2" or "yes"); Enter is pressed after unless no_enter is true' }, no_enter: { type: 'boolean' } }, required: ['session', 'text'], additionalProperties: false } },
  { name: 'fleet_pause', description: 'Park a worker: reliably interrupt it and mark it OFF (zero budget). Use to shed idle or expensive workers on the shared account. Un-park with fleet_resume or by sending it work.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_resume', description: 'Un-park a worker paused with fleet_pause; optionally dispatch a prompt to wake it immediately.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' }, prompt: { type: 'string' } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_stop', description: "Cleanly STOP a worker for good: kill its session and clear its fleet state (status file, park/schedule markers + the schedule waiter, manifest entry). Use for a finished worker, or an ORPHAN whose git worktree was removed (its session lingers in fleet_list otherwise). Unlike fleet_pause (which only parks), this removes it. Does not touch git — run 'git worktree prune' if the dir is stale.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_projects', description: "List every claude-fleet project: name, profile, path, fleet socket and how many sessions are live. These names are what the `project` argument accepts, so a lead in one repo can list/send/read/answer/pause/stop a session in ANOTHER project's fleet.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

function callTool(name, a = {}) {
  let t;
  try { t = target(a.project); } catch (e) { return `error: ${e.message}`; }
  switch (name) {
    case 'fleet_projects': {
      const rows = projects().map(p => {
        let n = '0';
        try { n = String(execFileSync('tmux', ['-L', p.sock, 'list-sessions', '-F', '#{session_name}'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).length); } catch {}
        return `${p.name.padEnd(18)} ${p.profile.padEnd(9)} ${p.sock.padEnd(26)} ${n.padEnd(8)} ${p.path}`;
      });
      return rows.length
        ? `${'PROJECT'.padEnd(18)} ${'PROFILE'.padEnd(9)} ${'FLEET'.padEnd(26)} ${'SESSIONS'.padEnd(8)} PATH\n${rows.join('\n')}`
        : '(no projects configured)';
    }
    case 'fleet_list': return run('fleet-list', [], t);
    case 'fleet_send': return run('fleet-send', [String(a.session), String(a.prompt)], t);
    case 'fleet_read': return run('fleet-read', [String(a.session), String(a.n || 1)], t);
    case 'fleet_spawn': {
      const args = [String(a.name)];
      if (a.branch) args.push('--branch', String(a.branch));
      if (a.from) args.push('--from', String(a.from));
      if (a.model) args.push('--model', String(a.model));
      if (a.reuse) args.push('--reuse', String(a.reuse));
      if (a.force_new) args.push('--new');
      if (a.prompt) args.push('--prompt', String(a.prompt));
      return run('fleet-spawn', args);
    }
    case 'fleet_worktrees': return run('fleet-worktrees', []);
    case 'fleet_inbox': return run('fleet-inbox', a.all ? ['--all'] : [], t);
    case 'fleet_answer': {
      const args = [String(a.session), String(a.text)];
      if (a.no_enter) args.push('--no-enter');
      return run('fleet-answer', args, t);
    }
    case 'fleet_pause': return run('fleet-pause', [String(a.session)], t);
    case 'fleet_resume': {
      const args = [String(a.session)];
      if (a.prompt) args.push(String(a.prompt));
      return run('fleet-resume', args, t);
    }
    case 'fleet_stop': return run('fleet-stop', [String(a.session)], t);
    default: return `unknown tool: ${name}`;
  }
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'claude-fleet', version: '1.0.0' },
    }});
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const text = callTool(params?.name, params?.arguments || {});
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text).slice(0, 8000) }] } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method && method.startsWith('notifications/')) return;   // no response for notifications
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
