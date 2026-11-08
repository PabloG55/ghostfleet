// lib/know-brief.mjs — the lead's briefing: what a project's master is told at SessionStart so it
// does not ask the owner what the owner already decided (docs/MEMORY.md). Experimental, behind
// `know-brief` (lib/experimental.mjs): hooks/fleet-event.sh is the gate, and with the switch off
// nothing here runs.
//
// IT IS A READ OF THIS PROFILE'S SNAPSHOT AND NOTHING ELSE. A session start waits on it, so it asks
// no paired machine and saves no file: localView() in lib/know.mjs. The hook holds it to a budget
// from the outside, because a synchronous read that hangs also blocks any timer set inside it.
//
// THE CAP IS WHAT THE OUTPUT IS BUILT AROUND, not a check at the end. Claude Code turns a hook's
// output over 10,000 characters into a file the model is not asked to read, so a log that grew past
// that would silently brief nobody. Cut by whole lines, one section at a time, so 500 rules cannot
// starve the three things waiting on the owner.
import * as K from './know.mjs';

export const BRIEF_CAP = 2000;
const LINE_TEXT = 130;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const stamp = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const more = (n) => `+${n} more: fleet_know`;

// Round robin, each section's next line in turn while it fits. What a section does not use goes to
// the others. A section's tail is reserved up front, at the longest it could read.
export function fit(head, sections, cap = BRIEF_CAP) {
  const live = sections.filter(s => s.rows.length).map(s => ({ ...s, take: 0 }));
  let used = head.length;
  for (const s of live) used += 1 + s.title.length + 1 + more(s.rows.length).length;
  for (let moved = true; moved;) {
    moved = false;
    for (const s of live) {
      if (s.take >= s.rows.length) continue;
      const cost = 1 + s.rows[s.take].text.length;
      if (used + cost > cap) continue;
      used += cost;
      s.take++;
      moved = true;
    }
  }
  const lines = [head], ids = [];
  for (const s of live) {
    lines.push(s.title);
    for (const r of s.rows.slice(0, s.take)) { lines.push(r.text); if (r.id) ids.push(r.id); }
    if (s.take < s.rows.length) lines.push(more(s.rows.length - s.take));
  }
  // Only a head longer than the cap can land here, and then the whole lines come off the end.
  while (lines.length > 1 && lines.join('\n').length > cap) lines.pop();
  const text = lines.join('\n');
  return text.length > cap ? { text: '', ids: [] } : { text, ids };
}

const AUTH_ORDER = { owner: 0, lead: 1 };
const privTag = (x, mode) => (x.priv && mode !== 'private' ? ' [private]' : '');

// `source` is the SessionStart source. `fleetDir` and `sock` name the session's fleet.
export function compose({ fleetDir, sock = '', source = 'startup', now = Date.now(), env = process.env }) {
  const { mode } = K.privacyFor(fleetDir, sock);
  if (mode === 'exclude') return { text: '', ids: [], why: 'excluded' };
  const v = K.localView(fleetDir, env);
  if (!v.events) return { text: '', ids: [], why: 'nothing in the log' };
  const profile = K.profileOf(fleetDir, env);
  const reg = sock ? K.resolveProject({ sock }) : null;
  const project = reg && reg.known ? reg.name : '';
  const rules = K.rulesFor(v, { profile, project });
  const rows = { rules: [], decisions: [], waits: [] };
  // Owner first, then in the order they win. Each line names its scope, and the title says what
  // the order means, so a project rule under an owner's `all` rule is not read as losing to it.
  // A fleet with no project of its own cannot tell whether a `project:` rule is about it, and the
  // reading that lists them all is for a person asking what the profile holds, not for a lead who
  // would take another project's rule as its own.
  const applying = rules.live.filter(r => project || K.scopeKind(r.scope) !== 'project');
  for (const r of [...applying].sort((a, b) => AUTH_ORDER[a.authority] - AUTH_ORDER[b.authority] || K.SCOPE_RANK[K.scopeKind(a.scope)] - K.SCOPE_RANK[K.scopeKind(b.scope)] || b.t - a.t)) {
    rows.rules.push({ id: r.id, text: `- ${r.id} [${r.authority} ${r.scope}${r.shared ? `, from ${r.from}` : ''}] ${clip(r.text, LINE_TEXT)}${privTag(r, mode)}` });
  }
  const hit = project ? K.findProject(v, `${project}/${profile}`).hit : null;
  if (hit) {
    for (const d of K.decisionsHolding(v.g, hit.id).filter(x => K.TRUSTED.includes(x.authority))) {
      rows.decisions.push({ id: d.id, text: `- ${d.id} [${d.authority}] ${clip(d.text, LINE_TEXT)}${privTag(d, mode)}` });
    }
    for (const x of K.factsHolding(v.g, hit.id, { machine: hit.machine }).filter(x => K.TRUSTED.includes(x.authority))) {
      rows.decisions.push({ id: x.id, text: `- ${x.id} [${x.authority}] ${clip(x.key, 40)} = ${clip(x.value, LINE_TEXT - 40)}${privTag(x, mode)}` });
    }
    // Not a session's state this minute: that is what fleet_know is for, and it would be stale
    // before the first prompt.
    const b = K.brief(v, `${project}@${hit.machine}/${profile}`, { now });
    for (const w of (b ? b.waiting : []).filter(w => !w.live)) {
      // A PR's line already names its number; anything else leads with what to ask fleet_know for.
      const named = w.ref && !String(w.ref).startsWith('pr#') ? `${w.ref} ` : '';
      rows.waits.push({ id: w.ref, text: `- ${named}${clip(w.what, LINE_TEXT + 20)}${privTag(w, mode)}` });
    }
  }
  const empty = !rows.rules.length && !rows.decisions.length && !rows.waits.length;
  const anyPrivate = mode === 'private' || [...rows.rules, ...rows.decisions, ...rows.waits].some(r => r.text.endsWith(' [private]'));
  // A fresh session has nothing to replace. One that resumes or compacts may be holding an earlier
  // briefing whose rules have since closed, and saying nothing would leave those standing: unless
  // nothing here was ever on record, when there is no such briefing, and an empty log stays silent.
  if (empty && (source === 'startup' || !K.anythingEverHeld(v.g, profile, hit ? hit.id : ''))) return { text: '', ids: [], why: 'nothing to brief' };
  const head = [
    `[fleet] Briefing for ${project || `the ${profile} profile`}, as of ${stamp(now)}. It REPLACES any earlier briefing in this conversation. Live state comes from fleet_know.`,
    ...(anyPrivate ? [K.PRIV_NOTE] : []),
    ...(empty ? ['No rules, decisions or waits on record now; anything an earlier briefing named has closed.'] : []),
  ].join('\n');
  return { ...fit(head, [
    { title: `RULES (${K.RULE_PRECEDENCE})`, rows: rows.rules },
    { title: 'DECISIONS THAT HOLD (owner and lead only)', rows: rows.decisions },
    { title: 'WAITING ON THE OWNER', rows: rows.waits },
  ]), project };
}
