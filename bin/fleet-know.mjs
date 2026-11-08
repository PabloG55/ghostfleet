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
//   fleet-know rule list [<project>]   the standing rules that apply, most specific first
//   fleet-know fact <project> <key>    one keyed fact; "not recorded" when nothing holds now
//   fleet-know reads [--since <time>]  what was asked of the memory, zero-hit questions first
//
//   --at <time>        as it stood then (ISO, epoch, or "3d ago"); default now
//   --known-at <time>  as it was KNOWN then (what had been recorded by that time)
//   --json             data, not text (the fleet_know MCP tool reads this)
//   --no-sync          do not ask paired machines; read their last fetched state
//   --trusted          on a project's page: only what the owner or a lead said
//
//   fleet-know describe <project> "<one line>"            what the project is
//   fleet-know decide <project> "<decision>" [--why "…"] [--supersedes <id>]
//                                      a decision, stated; --supersedes closes the old one (the
//                                      page prints each id), which stays readable with --at
//   fleet-know fact <project> <key> <value>               a keyed fact; a new value closes the old
//   fleet-know fact <project> <key> --off                 no current value any more
//   fleet-know rule add "<text>" [--why "…"] [--scope project:<name>|profile|all]
//                                [--quote "…"] [--supersedes <id>]
//                                      a standing rule. Default scope: the project you are in,
//                                      else the profile. An owner's or a lead's is live at once;
//                                      a worker's is proposed, and not a rule until accepted
//   fleet-know rule accept <id>        a proposal becomes a rule (owner or lead)
//   fleet-know rule close <id> [--reason "…"]             stops applying; stays readable with --at
//   fleet-know rule share-from <profile> [--off]          this profile reads that one's `all`
//                                      rules too; recorded here, and nothing crosses without it
//   fleet-know relate <project> depends-on <other> [--off]
//   fleet-know privacy [<project> [include|private|exclude|default]]
//   fleet-know privacy --profile <p> [include|private|exclude|default]
//   fleet-know forget <id> [--purge]   an event out of the graph, find and what a paired machine
//                                      fetches (find prints each id); --purge also rewrites its
//                                      line in the log, in place and with no backup, for a real
//                                      leak. A paired machine that already fetched it keeps its
//                                      copy until it fetches the tombstone
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
  if (x === '--json' || x === '--check' || x === '--off' || x === '--no-sync' || x === '--trusted' || x === '--purge') flags[x.slice(2)] = true;
  else if (x === '-h' || x === '--help') flags.help = true;
  else if (['--at', '--known-at', '--why', '--profile', '--scope', '--quote', '--supersedes', '--reason', '--since', '--via'].includes(x)) { flags[x.slice(2)] = args[++i]; if (flags[x.slice(2)] === undefined) die(`${x} needs a value`); }
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
// A write from the owner's own terminal: no fleet slot, no agent's shell, and a person's tty on
// both ends. An agent's tool call has no tty, and a fleet pane has a slot. Anything that cannot
// show all of it is recorded without the claim, and reads as a worker's (authorityOf).
const atOwnTerminal = () => !process.env.CLAUDE_FLEET_SLOT && !process.env.CLAUDECODE && process.stdin.isTTY && process.stdout.isTTY;
const writerSrc = () => ({ via: 'fleet-know', ...(process.env.CLAUDE_FLEET_SLOT ? { slot: process.env.CLAUDE_FLEET_SLOT } : {}), ...(atOwnTerminal() ? { by: 'terminal' } : {}) });
const writeTo = (p, kind, f) => {
  const ev = K.record(kind, f, { fleetDir: p.fleetDir, create: true, sock: p.sock, project: p.name, cwd: p.path, src: writerSrc() });
  if (!ev) die(`nothing recorded: the memory is '${K.privacyFor(p.fleetDir, p.sock).mode}' for ${p.name}`, 1);
  return ev;
};
// What this write would be recorded as, by the same reading the fold will give it. The fold
// refuses a close from below in silence, because it has nobody to tell; here there is somebody.
const myAuthority = () => K.writerAuthority({ src: writerSrc() });
const logOf = (profile) => (profile ? path.join(cfgFor(profile), 'fleet') : K.fleetDirOf());
const realOr = (d) => { try { return fs.realpathSync(d); } catch { return d; } };
// A rule, and the log it lives in: each log folds on its own, so a close written to any other
// file would name a target that file has never heard of, and change nothing.
function findRule(id) {
  for (const d of K.allFleetDirs()) {
    const g = K.snapshot(d, { save: false }).graph;
    if (g.nodes[`rule:${id}`]) return { dir: d, g, n: g.nodes[`rule:${id}`] };
  }
  return null;
}
// A lead speaks for its own profile. A rule read here through share-from is still the other
// profile's to close, and the fold cannot tell: the line lands in that profile's log, as a lead's.
const refuseAcross = (f, id, me) => { if (me !== 'owner' && f.dir !== realOr(K.fleetDirOf())) die(`nothing recorded: rule ${id} belongs to another profile, and a ${me} acts in its own`, 1); };
const ruleWrite = (kind, f, { dir, sock = '', project = K.NO_PROJECT }) => {
  const ev = K.record(kind, f, { fleetDir: dir, create: true, sock, project, src: writerSrc() });
  if (!ev) die(`nothing recorded: the memory is '${K.privacyFor(dir, sock).mode}' here`, 1);
  return ev;
};
// Where a new rule goes: its scope names the log. With none given, the project you are standing
// in, else the profile, and the answer says which it chose.
function ruleScope() {
  const s = flags.scope;
  if (s === 'profile' || s === 'all') return { scope: s, dir: logOf(flags.profile) };
  if (s && !s.startsWith('project:')) die(`--scope is project:<name>, profile or all, not '${s}'`);
  const here = s ? null : K.resolveProject({ sock: process.env.CLAUDE_FLEET_SOCK || '', cwd: process.cwd() });
  if (here && !here.known) return { scope: 'profile', dir: logOf(flags.profile) };
  const p = target(s ? s.slice('project:'.length) : `${here.name}/${here.profile}`);
  return { scope: `project:${p.name}`, dir: p.fleetDir, sock: p.sock, project: p.name };
}
// Every read leaves a line, with what it found: a question the memory could not answer is how
// anybody learns what it is missing. fleet_know says --via mcp, so the two can be told apart.
const noted = (verb, query, hits) => K.noteRead(verb, query, hits, { via: flags.via === 'mcp' ? 'mcp' : 'cli' });

const verb = pos[0];
switch (verb) {
  case undefined: {
    const v = await getView();
    noted('overview', '', K.projectsIn(v).length);
    out(K.overview(v, { now }), { projects: K.projectsIn(v), peers: v.peers });
    break;
  }
  case 'waiting': {
    const v = await getView();
    const w = K.waiting(v, { at, known, now });
    noted('waiting', '', w.rows.length);
    out(K.renderWaiting(w, now), { ...w, ...(w.rows.some(r => r.mode === 'private') ? { note: PRIV_JSON } : {}) });
    break;
  }
  case 'touched': {
    if (!pos[1]) die('touched <path>');
    const v = await getView();
    const r = K.touched(v, pos[1], { at, known });
    noted('touched', pos[1], r.rows.length);
    out(K.renderTouched(r, now), { ...r, ...(r.rows.some(x => x.mode === 'private') ? { note: PRIV_JSON } : {}) });
    break;
  }
  case 'find': {
    const q = pos.slice(1).join(' ');
    if (!q.trim()) die('find <text>');
    const v = await getView();
    const r = K.find(v, q, { at });
    noted('find', q, r.total);
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
        const same = K.sameGraph(K.canonical(inc.graph), fresh.graph);
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
  case 'forget': {
    if (!pos[1] || pos.length > 2) die('forget <event-id> [--purge] (fleet-know find <text> prints each event\'s id)');
    const r = K.forget(pos[1], { purge: !!flags.purge });
    if (!r.ok) die(r.why, 1);
    const copies = r.files.filter(x => x.peer).map(x => x.peer);
    const purged = r.files.reduce((n, x) => n + (x.purged || 0), 0);
    const when = new Date(r.t).toISOString().slice(0, 10);
    const lines = [`forgotten: ${r.id} (${r.kind}, ${r.project}, ${when}). It is out of the graph, of find, and of what a paired machine fetches.`];
    if (purged) lines.push(`purged: ${purged} line${purged === 1 ? '' : 's'} rewritten in place, with no backup.`);
    else if (flags.purge) lines.push('purge: the line was already rewritten.');
    if (copies.length) lines.push(`this machine's copy of ${copies.join(', ')}'s event: the machine it came from still holds it. Forget it there too.`);
    if (r.files.some(x => !x.peer)) lines.push('a paired machine that already fetched it keeps its copy until its next fetch brings the tombstone.');
    out(lines.join('\n'), r);
    break;
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
    if (!pos[1] || !pos[2]) die('decide <project> "<decision>" [--why "<why>"] [--supersedes <id>]');
    const p = target(pos[1]), old = flags.supersedes;
    // Said here rather than left to the fold, which can only ignore it: the writer would then
    // believe the old decision had closed while the page went on showing it.
    if (old) {
      const v = K.localView(p.fleetDir);
      const hit = K.findProject(v, `${p.name}/${p.profile}`).hit;
      const n = v.g.nodes[`decision:${old}`];
      if (!n || !hit || K.attr(n, 'project') !== hit.id) die(`nothing recorded: ${p.name} has no decision '${old}' (its page prints each id)`, 1);
      if (!K.decisionsHolding(v.g, hit.id).some(d => d.id === old)) die(`nothing recorded: decision ${old} is already closed`, 1);
      if (!K.outranks(myAuthority(), K.attr(n, 'authority'))) die(`nothing recorded: decision ${old} is the ${K.attr(n, 'authority')}'s word, and this is a ${myAuthority()}'s`, 1);
    }
    const ev = writeTo(p, 'decision', { text: pos.slice(2).join(' '), why: flags.why, source: 'stated', supersedes: old });
    out(`recorded the decision for ${pos[1]} (${ev.id})${old ? `; ${old} no longer holds, and --at still reads it` : ''}`, { id: ev.id, supersedes: old });
    break;
  }
  case 'fact': {
    const [, q, key] = pos;
    const value = pos.slice(3).join(' ');
    if (!q || !key) die('fact <project> <key> [<value> | --off]');
    if (!K.FACT_KEY.test(key)) die(`a fact's key is letters, digits and . _ : -, not '${key}'`);
    if (!value && !flags.off) {
      const r = K.factFor(await K.view({ sync: false }), q, key, { at, known });
      noted('fact', `${q} ${key}`, r.recorded ? 1 : 0);
      out(K.renderFact(r, q, now), r);
      break;
    }
    if (value && flags.off) die('a value or --off, not both');
    const p = target(q);
    const cur = K.factFor(K.localView(p.fleetDir), `${p.name}/${p.profile}`, key);
    const mine = cur.recorded && !cur.machine ? cur : null;
    if (mine && !K.outranks(myAuthority(), mine.authority)) die(`nothing recorded: ${key} on ${p.name} is the ${mine.authority}'s word, and this is a ${myAuthority()}'s`, 1);
    if (flags.off && !mine) { out(`not recorded: ${p.name} has no current fact '${key}', so there is nothing to close`, { recorded: false, key }); break; }
    const ev = writeTo(p, 'fact', { key, value: value || undefined, off: flags.off || undefined });
    out(flags.off ? `${key} on ${p.name} no longer holds (${ev.id}); --at still reads it` : `${key} on ${p.name} = ${value}${mine ? ` (replaces ${mine.value})` : ''} (${ev.id})`, { id: ev.id, key, value: value || undefined, off: !!flags.off });
    break;
  }
  case 'rule': {
    const sub = pos[1];
    const usage = 'rule add "<text>" | rule list [<project>] | rule accept <id> | rule close <id> [--reason "…"] | rule share-from <profile> [--off]';
    switch (sub) {
      case 'add': {
        const text = pos.slice(2).join(' ');
        if (!text.trim()) die('rule add "<text>" [--why "…"] [--scope project:<name>|profile|all] [--quote "…"] [--supersedes <id>]');
        const where = ruleScope(), me = myAuthority(), live = K.TRUSTED.includes(me);
        if (flags.supersedes) {
          const old = findRule(flags.supersedes);
          if (!old || old.dir !== realOr(where.dir)) die(`nothing recorded: this profile has no rule '${flags.supersedes}' (fleet-know rule list prints each id)`, 1);
          if (K.attr(old.n, 'closed')) die(`nothing recorded: rule ${flags.supersedes} is already closed`, 1);
          // A worker may propose replacing anybody's rule: it replaces nothing until it is
          // accepted, and whoever accepts it is who has to outrank what it replaces.
          if (live && !K.outranks(me, K.attr(old.n, 'authority'))) die(`nothing recorded: rule ${flags.supersedes} is the ${K.attr(old.n, 'authority')}'s, and this is a ${me}'s`, 1);
        }
        const ev = ruleWrite('rule', { text, why: flags.why, scope: where.scope, quote: flags.quote, supersedes: flags.supersedes }, where);
        out(live
          ? `rule ${ev.id} is live, scope ${where.scope}${flags.supersedes ? `; ${flags.supersedes} no longer applies` : ''}\n${K.RULE_PRECEDENCE}`
          : `rule ${ev.id} is PROPOSED, scope ${where.scope}: not a rule until an owner or lead runs fleet-know rule accept ${ev.id}`, { id: ev.id, scope: where.scope, state: live ? 'live' : 'proposed', authority: me });
        break;
      }
      case 'list': {
        const q = pos[2] || '';
        const { name, profile: pf } = q ? K.splitName(q) : { name: '', profile: '' };
        const reg = name ? projects().filter(p => p.name === name && (!pf || p.profile === pf)) : [];
        const mine = K.profileOf(K.fleetDirOf());
        const profile = flags.profile || pf || (reg.find(p => p.profile === mine) || reg[0] || {}).profile || mine;
        // Rules do not cross a pairing, so a list of them has no reason to wait on one.
        const v = await K.view({ sync: false });
        const r = K.rulesFor(v, { profile, project: name, at, known });
        noted('rule.list', q, r.live.length);
        const stranger = name && !reg.length && !K.findProject(v, q).hit;
        out(`${stranger ? `no project '${name}' on record; these are the rules for any project in ${profile}\n` : ''}${K.renderRules(r)}`, { ...r, ...(stranger ? { known: false } : {}) });
        break;
      }
      case 'accept': {
        const id = pos[2];
        if (!id) die('rule accept <id>');
        const me = myAuthority(), f = findRule(id);
        if (!K.TRUSTED.includes(me)) die(`nothing recorded: only an owner or a lead accepts a rule, and this is a ${me}`, 1);
        if (!f) die(`nothing recorded: no rule '${id}'`, 1);
        refuseAcross(f, id, me);
        if (K.attr(f.n, 'closed')) die(`nothing recorded: rule ${id} is closed`, 1);
        if (K.attr(f.n, 'proposed') !== 'yes' || K.attr(f.n, 'accepted')) die(`nothing recorded: rule ${id} is already live`, 1);
        const sup = K.attr(f.n, 'supersedes'), old = sup && f.g.nodes[`rule:${sup}`];
        if (old && !K.attr(old, 'closed') && !K.outranks(me, K.attr(old, 'authority'))) die(`nothing recorded: rule ${id} replaces ${sup}, which is the ${K.attr(old, 'authority')}'s, and this is a ${me}`, 1);
        const ev = ruleWrite('rule.accept', { target: id }, { dir: f.dir });
        out(`rule ${id} is live, scope ${K.attr(f.n, 'scope')}${sup ? `; ${sup} no longer applies` : ''} (${ev.id})`, { id: ev.id, target: id });
        break;
      }
      case 'close': {
        const id = pos[2];
        if (!id) die('rule close <id> [--reason "<why>"]');
        const me = myAuthority(), f = findRule(id);
        if (!f) die(`nothing recorded: no rule '${id}'`, 1);
        refuseAcross(f, id, me);
        if (K.attr(f.n, 'closed')) die(`nothing recorded: rule ${id} is already closed`, 1);
        if (!K.outranks(me, K.attr(f.n, 'authority'))) die(`nothing recorded: rule ${id} is the ${K.attr(f.n, 'authority')}'s, and this is a ${me}`, 1);
        const ev = ruleWrite('rule.close', { target: id, reason: flags.reason }, { dir: f.dir });
        out(`rule ${id} no longer applies (${ev.id}); it stays in the log and --at still reads it`, { id: ev.id, target: id });
        break;
      }
      case 'share-from': {
        const from = pos[2];
        if (!from) die('rule share-from <profile> [--off]');
        const dir = logOf(flags.profile), me = K.profileOf(dir), who = myAuthority();
        if (!K.TRUSTED.includes(who)) die(`nothing recorded: only an owner or a lead opts a profile in, and this is a ${who}`, 1);
        if (from === me) die(`${me} already reads its own rules`);
        if (!fs.existsSync(path.join(cfgFor(from), 'fleet'))) die(`no profile '${from}' on this machine`, 1);
        const ev = ruleWrite('rule.share', { from, off: flags.off || undefined }, { dir });
        out(flags.off ? `${me} no longer reads ${from}'s rules (${ev.id})` : `${me} now reads the \`all\` rules of ${from}; its \`profile\` and \`project:\` rules stay there (${ev.id}). Undo: fleet-know rule share-from ${from} --off`, { id: ev.id, profile: me, from, off: !!flags.off });
        break;
      }
      default: die(usage);
    }
    break;
  }
  case 'reads': {
    let since = 0;
    if (flags.since !== undefined) { try { since = K.parseAt(flags.since, now0); } catch (e) { die(e.message.replace('--at', '--since')); } }
    const r = K.readsReport({ since: Number.isFinite(since) ? since : 0 });
    out(K.renderReads(r, now0), r);
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
    const b = K.brief(v, q, { at, known, now, ...(flags.trusted ? { authority: K.TRUSTED } : {}) });
    noted('about', q, b ? 1 : 0);
    if (!b) {
      const names = [...new Set(K.projectsIn(v).map(p => p.name))];
      die(`not recorded: nothing for '${q}'${names.length ? ` (known: ${names.slice(0, 12).join(', ')})` : ' — events land as sessions run'}`, 1);
    }
    out(K.renderBrief(b, now), { ...b, ...(b.mode === 'private' || b.decisions.some(d => d.priv) || b.openRequests.some(r => r.priv) ? { note: PRIV_JSON } : {}) });
  }
}
