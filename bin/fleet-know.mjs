#!/usr/bin/env node
// fleet-know — the fleet's memory, read (docs/MEMORY.md). Answers "where does X stand" from
// what ghostfleet already saw happen, across every profile and every paired machine, instead
// of from whatever happens to be in a lead's context.
//
//   fleet-know                         every project it knows, newest first
//   fleet-know <project>               one page: what it is, where it stands (sessions,
//                                      branches, PRs, last deploy), what is open, decisions
//                                      <project> may be name, name@machine or name/profile
//   fleet-know waiting                 everything waiting on the owner, every project
//   fleet-know touched <path>          which sessions touched a file, and the PRs it went into
//   fleet-know find <text…>            the RAW events, not only the graph (see lib/know.mjs)
//
//   --at <time>        as it stood then (ISO, epoch, or "3d ago"); default now
//   --known-at <time>  as it was KNOWN then (what had been recorded by that time)
//   --json             data, not text (the fleet_know MCP tool reads this)
//   --no-sync          do not ask paired machines; read their last fetched state
//
//   fleet-know describe <project> "<one line>"            what the project is
//   fleet-know decide <project> "<decision>" [--why "…"]  a decision, stated
//   fleet-know relate <project> depends-on <other> [--off]
//   fleet-know privacy [<project> [include|private|exclude|default]]
//   fleet-know privacy --profile <p> [include|private|exclude|default]
//   fleet-know rebuild [--check]       the graph again from the log; --check only compares
//   fleet-know sync                    fetch every paired machine's events now
//
// Every write here goes through record() in lib/know.mjs, the one writer fleet-know-event is
// the command-line face of.
import fs from 'node:fs';
import path from 'node:path';
import * as K from '../lib/know.mjs';
import { projects, cfgFor } from '../lib/projects.mjs';

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  const x = args[i];
  if (x === '--json' || x === '--check' || x === '--off' || x === '--no-sync') flags[x.slice(2)] = true;
  else if (x === '-h' || x === '--help') flags.help = true;
  else if (['--at', '--known-at', '--why', '--profile'].includes(x)) { flags[x.slice(2)] = args[++i]; if (flags[x.slice(2)] === undefined) die(`${x} needs a value`); }
  else if (x === '--') { pos.push(...args.slice(i + 1)); break; }
  else if (x.startsWith('--')) die(`unknown option ${x} (fleet-know --help)`);
  else pos.push(x);
}
function die(msg, code = 2) { process.stderr.write(`fleet-know: ${msg}\n`); process.exit(code); }
function out(text, data) {
  if (flags.json) process.stdout.write(JSON.stringify(data, (k, v) => (v === Infinity ? null : v)) + '\n');
  else process.stdout.write(text.replace(/\n?$/, '\n'));
}
if (flags.help) {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  process.stdout.write(src.slice(1, src.findIndex(l => l.startsWith('// Every write'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
  process.exit(0);
}

let at, known;
try { at = K.parseAt(flags.at); known = K.parseAt(flags['known-at']); } catch (e) { die(e.message); }
// CLAUDE_FLEET_NOW_MS pins the clock (as fleet-ledger's does), and an answer --at a time
// counts its "3h ago" from that time: the page reads as it would have then.
const now0 = Number(process.env.CLAUDE_FLEET_NOW_MS) || Date.now();
const now = Number.isFinite(at) ? at : now0;
const getView = () => K.view({ sync: !flags['no-sync'] });
const PRIV_JSON = 'items marked private are for this machine\'s leads: do not paste them into a prompt for another model vendor';

// A registered project, by name (name/profile when two profiles share one), for the writes.
function target(q) {
  let name = String(q || ''), prof = '';
  const sl = name.indexOf('/'); if (sl > 0) { prof = name.slice(sl + 1); name = name.slice(0, sl); }
  const hits = projects().filter(p => p.name === name && (!prof || p.profile === prof));
  if (hits.length > 1) die(`two profiles have a project '${name}' — say which: ${hits.map(h => `${name}/${h.profile}`).join(', ')}`);
  if (!hits.length) die(`no project '${q}' in the project list (fleet-project list)`, 1);
  const p = hits[0];
  return { ...p, fleetDir: path.join(p.cfg, 'fleet') };
}
const writeTo = (p, kind, f) => {
  const ev = K.record(kind, f, { fleetDir: p.fleetDir, create: true, sock: p.sock, project: p.name, cwd: p.path, src: { via: 'fleet-know', ...(process.env.CLAUDE_FLEET_SLOT ? { slot: process.env.CLAUDE_FLEET_SLOT } : {}) } });
  if (!ev) die(`nothing recorded: the memory is '${K.privacyFor(p.fleetDir, p.sock).mode}' for ${p.name}`, 1);
  return ev;
};

const verb = pos[0];
switch (verb) {
  case undefined: {
    const v = await getView();
    out(K.overview(v, { now }), { projects: K.projectsIn(v), peers: v.peers });
    break;
  }
  case 'waiting': {
    const v = await getView();
    const w = K.waiting(v, { at, known, now });
    out(K.renderWaiting(w, now), { ...w, ...(w.rows.some(r => r.mode === 'private') ? { note: PRIV_JSON } : {}) });
    break;
  }
  case 'touched': {
    if (!pos[1]) die('touched <path>');
    const v = await getView();
    const r = K.touched(v, pos[1], { at, known });
    out(K.renderTouched(r, now), { ...r, ...(r.rows.some(x => x.mode === 'private') ? { note: PRIV_JSON } : {}) });
    break;
  }
  case 'find': {
    const q = pos.slice(1).join(' ');
    if (!q.trim()) die('find <text>');
    const v = await getView();
    const r = K.find(v, q, { at });
    out(K.renderFind(r, now), { ...r, ...(r.rows.some(x => x.mode === 'private') ? { note: PRIV_JSON } : {}) });
    break;
  }
  case 'rebuild': {
    const rows = [];
    let differs = 0;
    for (const d of K.allFleetDirs()) {
      if (!fs.existsSync(path.join(d, K.LOG))) continue;
      if (flags.check) {
        const inc = K.snapshot(d);
        const fresh = K.rebuild(d, { save: false });
        const same = JSON.stringify(K.canonical(inc.graph)) === JSON.stringify(fresh.graph);
        if (!same) differs++;
        rows.push({ profile: K.profileOf(d), dir: d, events: fresh.events, same });
      } else {
        const s = K.rebuild(d);
        rows.push({ profile: K.profileOf(d), dir: d, events: s.events, nodes: Object.keys(s.graph.nodes).length, edges: Object.keys(s.graph.edges).length });
      }
    }
    out(rows.length ? rows.map(r => flags.check
      ? `${r.profile.padEnd(12)} ${r.events} events — ${r.same ? 'the snapshot matches a rebuild from the log' : 'DIFFERS from a rebuild: run fleet-know rebuild'}`
      : `${r.profile.padEnd(12)} rebuilt from ${r.events} events: ${r.nodes} nodes, ${r.edges} edges`).join('\n') : 'no memory log on this machine yet', { rows });
    process.exit(differs ? 1 : 0);
  }
  case 'sync': {
    const r = await K.syncPeers({ timeout: 6000 });
    out(r.length ? r.map(m => `${(m.label || m.key).padEnd(16)} ${m.ok ? `fetched, ${m.added} new event${m.added === 1 ? '' : 's'}` : `not reached (${m.why}) — its last fetched state stands, marked stale`}`).join('\n') : 'no paired machines', { peers: r });
    break;
  }
  case 'privacy': {
    const mode = pos.length > 1 && K.MODES.concat('default').includes(pos[pos.length - 1]) ? pos[pos.length - 1] : '';
    if (flags.profile !== undefined) {
      const f = K.profileModeFile(path.join(cfgFor(flags.profile), 'fleet'));
      if (mode) K.setPrivacy(f, mode);
      const v = (() => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } })();
      out(`profile ${flags.profile}: ${v || 'include'}${v ? '' : ' (default)'}`, { profile: flags.profile, mode: v || 'include' });
      break;
    }
    const name = mode ? pos.slice(1, -1)[0] : pos[1];
    if (mode && !name) die('privacy <project> <include|private|exclude|default>');
    const list = name ? [target(name)] : projects().map(p => ({ ...p, fleetDir: path.join(p.cfg, 'fleet') }));
    if (mode) K.setPrivacy(K.projectModeFile(list[0].fleetDir, list[0].sock), mode);
    const rows = list.map(p => ({ project: p.name, profile: p.profile, ...K.privacyFor(p.fleetDir, p.sock) }));
    out(rows.length ? rows.map(r => `${r.project.padEnd(16)} ${r.profile.padEnd(10)} ${r.mode.padEnd(8)} (${r.from})`).join('\n') : 'no projects', { rows });
    break;
  }
  case 'describe': {
    if (!pos[1] || !pos[2]) die('describe <project> "<one line>"');
    const ev = writeTo(target(pos[1]), 'project.about', { text: pos.slice(2).join(' ') });
    out(`recorded what ${pos[1]} is (${ev.id})`, { id: ev.id });
    break;
  }
  case 'decide': {
    if (!pos[1] || !pos[2]) die('decide <project> "<decision>" [--why "<why>"]');
    const ev = writeTo(target(pos[1]), 'decision', { text: pos.slice(2).join(' '), why: flags.why, source: 'stated' });
    out(`recorded the decision for ${pos[1]} (${ev.id})`, { id: ev.id });
    break;
  }
  case 'relate': {
    if (!pos[1] || !pos[2] || !pos[3]) die('relate <project> depends-on <other> [--off]');
    if (pos[2] !== 'depends-on') die(`the one relation is depends-on, not '${pos[2]}'`);
    const ev = writeTo(target(pos[1]), 'relate', { rel: 'depends-on', to: pos[3], off: flags.off || undefined });
    out(`${pos[1]} ${flags.off ? 'no longer depends' : 'depends'} on ${pos[3]} (${ev.id})`, { id: ev.id });
    break;
  }
  default: {
    const q = verb === 'brief' ? pos[1] : verb;
    if (!q) die('brief <project>');
    const v = await getView();
    const b = K.brief(v, q, { at, known, now });
    if (!b) {
      const names = [...new Set(K.projectsIn(v).map(p => p.name))];
      die(`nothing recorded for '${q}'${names.length ? ` (known: ${names.slice(0, 12).join(', ')})` : ' — events land as sessions run'}`, 1);
    }
    out(K.renderBrief(b, now), { ...b, ...(b.mode === 'private' || b.decisions.some(d => d.priv) || b.openRequests.some(r => r.priv) ? { note: PRIV_JSON } : {}) });
  }
}
