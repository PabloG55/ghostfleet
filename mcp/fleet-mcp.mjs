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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');

function run(cmd, args) {
  try {
    return execFileSync(path.join(BIN, cmd), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '(no output)';
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`.trim() || `error: ${e.message}`;
  }
}

const TOOLS = [
  { name: 'fleet_list', description: 'List the Claude sessions in this fleet (parallel worktrees) with their status. Call this first to see which siblings exist and whether they are free.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'fleet_send', description: 'Send a prompt to a sibling fleet session and submit it (it runs there). The prompt must be self-contained — the sibling does not share your context.',
    inputSchema: { type: 'object', properties: { session: { type: 'string', description: 'target session name (see fleet_list)' }, prompt: { type: 'string', description: 'the full, self-contained prompt to run there' } }, required: ['session', 'prompt'], additionalProperties: false } },
  { name: 'fleet_read', description: 'Read the last N assistant messages from a sibling session, to check its progress/output.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, n: { type: 'number', description: 'how many recent assistant messages (default 1)' } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_spawn', description: 'Create a new git worktree off the current repo and start a fresh parallel session in it (in the background), optionally with an initial task prompt. Call fleet_worktrees FIRST: if free worktrees exist, spawn refuses unless you reuse one (reuse) or force a new one (force_new).',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'session + worktree name' }, branch: { type: 'string', description: 'branch to use/create (default: name)' }, from: { type: 'string', description: 'base ref for a new branch; bases on your LOCAL ref (use "HEAD" for current), falls back to the remote tip only if local is behind' }, prompt: { type: 'string', description: 'initial task to send once it boots' }, model: { type: 'string', description: 'model for the worker (e.g. opus); default = account default' }, reuse: { type: 'string', description: 'start in this EXISTING free worktree (name or path); combine with branch+from to clean & rebranch it in one step' }, force_new: { type: 'boolean', description: 'create a new worktree even if free ones exist' } }, required: ['name'], additionalProperties: false } },
  { name: 'fleet_worktrees', description: 'Inventory every git worktree of this repo — branch, whether a session is live on it, git state, and which are FREE to reuse. Call this BEFORE fleet_spawn so you reuse an idle worktree instead of proliferating new ones.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'fleet_inbox', description: "Drain the lead's attention feed: worker 'need-you' events (permission / usage-limit / real questions) plus governor park/resume, collected passively. One call replaces polling every sibling — shows only what is new since last call.",
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'show the whole inbox instead of only new entries' } }, additionalProperties: false } },
  { name: 'fleet_answer', description: 'Send raw keystrokes to a worker BLOCKED on a prompt — a permission dialog, a "reached usage limit — retry?", a trust prompt (e.g. text "2"). Use this to unblock a worker; use fleet_send for normal task prompts.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, text: { type: 'string', description: 'literal keys to send (e.g. "2" or "yes"); Enter is pressed after unless no_enter is true' }, no_enter: { type: 'boolean' } }, required: ['session', 'text'], additionalProperties: false } },
  { name: 'fleet_pause', description: 'Park a worker: reliably interrupt it and mark it OFF (zero budget). Use to shed idle or expensive workers on the shared account. Un-park with fleet_resume or by sending it work.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_resume', description: 'Un-park a worker paused with fleet_pause; optionally dispatch a prompt to wake it immediately.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, prompt: { type: 'string' } }, required: ['session'], additionalProperties: false } },
];

function callTool(name, a = {}) {
  switch (name) {
    case 'fleet_list': return run('fleet-list', []);
    case 'fleet_send': return run('fleet-send', [String(a.session), String(a.prompt)]);
    case 'fleet_read': return run('fleet-read', [String(a.session), String(a.n || 1)]);
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
    case 'fleet_inbox': return run('fleet-inbox', a.all ? ['--all'] : []);
    case 'fleet_answer': {
      const args = [String(a.session), String(a.text)];
      if (a.no_enter) args.push('--no-enter');
      return run('fleet-answer', args);
    }
    case 'fleet_pause': return run('fleet-pause', [String(a.session)]);
    case 'fleet_resume': {
      const args = [String(a.session)];
      if (a.prompt) args.push(String(a.prompt));
      return run('fleet-resume', args);
    }
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
