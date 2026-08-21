#!/usr/bin/env node
// ghostfleet MCP server — exposes the fleet orchestration commands as native
// tools so a lead Claude session can call them as structured tool-calls instead
// of shelling out. Thin wrapper over bin/fleet-{list,send,read,spawn,worktrees,
// inbox,answer,pause,resume}; those
// read the session's env (CLAUDE_FLEET_SOCK, CLAUDE_CONFIG_DIR) which this
// server inherits from the Claude session that launched it.
//
// Dependency-free stdio JSON-RPC (newline-delimited), the MCP stdio transport.
//
// THE VERBS THEMSELVES LIVE IN ./fleet-dispatch.mjs — the tool list, the argument
// validation and the argv each call turns into. They moved there when bin/fleet-serve
// (the phone's HTTP endpoint) needed the same verbs: two callers shelling out to
// bin/fleet-* separately would mean two copies of the validation that stops a missing
// argument reaching a worker as the word "undefined". This file is now only the
// transport.
import { TOOLS, callTool } from './fleet-dispatch.mjs';

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ghostfleet', version: '1.0.0' },
    }});
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    // callTool returns text for a call that RAN, or fail()'s {isError, text} for one we
    // refused to run. Only the second sets isError; a command that ran and printed a
    // failure is its own output, and flagging that would misreport the several commands
    // here which write to stderr on success (fleet-answer echoes the pane).
    const r = callTool(params?.name, params?.arguments || {});
    const out = typeof r === 'string' ? { text: r } : r;
    return send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: String(out.text).slice(0, 8000) }],
      ...(out.isError ? { isError: true } : {}),
    }});
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
