#!/usr/bin/env node
// lib/mod-gate.mjs — the questions the mod's guards ask, answered by the code that already
// answers them for every other door.
//
//   node lib/mod-gate.mjs jarvis-bash          < the Bash command
//   node lib/mod-gate.mjs jarvis-mcp <tool>    < the MCP call's arguments, as JSON
//   node lib/mod-gate.mjs answer-mcp           < fleet_answer's arguments, as JSON
//
// Exit 0: let it run. Exit 2: refused, the reason on stderr. Anything else is not a
// decision, and the mod refuses on it: its guards fail CLOSED (mods/ghostfleet/hooks/guards.js).
//
// WHY A PROCESS AND NOT A PORT. The mod runs with no Node and no filesystem of its own, and
// Jarvis's proposals are read and written under a lock shared by the MCP server, the Bash
// guard and fleet-serve (lib/jarvis.mjs withStateLock). A second implementation of the gate
// in the mod would be a second answer to "did he say yes", and a second writer outside the
// lock. So the mod asks here, at its own door ('mod'), and the gate leaves the relay that
// lets the older door behind it pass the same call without spending his yes twice.
import fs from 'node:fs';
import { readMarker, isJarvisSelf, bashSpec, gate } from './jarvis.mjs';
import { self, jarvisGateCall, answerCheck } from '../mcp/fleet-dispatch.mjs';

const [kind, tool] = process.argv.slice(2);
const stdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const refuse = (text) => { process.stderr.write(`${text}\n`); process.exit(2); };
const args = () => {
  const a = JSON.parse(stdin() || '{}');
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('arguments are not an object');
  return a;
};

switch (kind) {
  // hooks/jarvis-guard.sh's question, with the session judged as the MCP door judges it
  // (the live $TMUX), so the two cannot disagree about who is Jarvis.
  case 'jarvis-bash': {
    const c = stdin();
    const m = readMarker();
    if (!m || !isJarvisSelf(self(), m)) process.exit(0);
    const spec = bashSpec(c, m);
    if (spec.action === 'ok') process.exit(0);
    if (spec.action === 'refuse') refuse(`jarvis: ${spec.why}`);
    const g = gate(spec, Date.now(), 'mod');
    if (g.ok) process.exit(0);
    refuse(`jarvis: ${g.text}`);
    break;
  }
  case 'jarvis-mcp': {
    if (!tool) { process.stderr.write('mod-gate: jarvis-mcp needs a tool name\n'); process.exit(1); }
    const r = jarvisGateCall(tool, args());
    if (r.fail) refuse(r.fail.text);
    // His yes was spent on this call: the mod then skips asking fleet-answer, since the MCP
    // door turns this yes into --human-approved (mcp/fleet-dispatch.mjs withHuman).
    if (r.granted) process.stdout.write('granted\n');
    process.exit(0);
    break;
  }
  // bin/fleet-answer --check under the invocation the MCP call would get. 3 is its refusal
  // (an approving key on a permission dialog), 4 "the prompt changed"; 1 is a call it would
  // reject anyway (no such session), which the call itself reports, so it is let through.
  case 'answer-mcp': {
    const r = answerCheck(args());
    if (r.code === 0 || r.code === 1) process.exit(0);
    if (r.code === 3 || r.code === 4) refuse(r.text);
    process.stderr.write(`mod-gate: fleet-answer --check gave no decision (${r.code}): ${r.text}\n`);
    process.exit(1);
    break;
  }
  default:
    process.stderr.write(`mod-gate: unknown question '${kind || ''}'\n`);
    process.exit(1);
}
