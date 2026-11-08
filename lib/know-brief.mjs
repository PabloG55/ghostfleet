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
// that would silently brief nobody. Cut by whole lines, so 500 rules cannot starve the three things
// waiting on the owner.
//
// RULES FIRST, because a rule the lead was not told about is one it breaks, and a waiting item it was
// not told about is one fleet_know still lists. Sharing the cap evenly did the wrong thing: 13 rules
// and 8 waiting items, each section taking a line in turn, cut the 3 oldest rules, which are the
// ones that have stood longest, while every waiting item showed.
import * as K from './know.mjs';

export const BRIEF_CAP = 2000;
const LINE_TEXT = 130;
// A long rule gives up its tail before any rule gives up its line, but not past where it stops
// saying anything: below this, the line is an id and a fragment.
const RULE_TEXT_MIN = 48;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const stamp = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const more = (n) => `+${n} more: fleet_know`;

// Every section's budget, in the order it is claimed. A section's tail is reserved up front, at the
// longest it could read. Then:
//   a `first` section gets all of it but a floor: one line for each of the others, so 500 rules leave
//     a heading and a first line for what waits, and nothing else. `shrink` hands it the room it has,
//     so its lines can give up text before any of them gives up its place. A section that fits
//     hands its tail back, and one that does not pays for `note`, the line that says so
//   and what is left is shared, each section's next line in turn while it fits. What one does not
//     use goes to the others.
// With no `first` section there is only the sharing.
export function fit(head, sections, cap = BRIEF_CAP) {
  const live = sections.filter(s => s.rows.length).map(s => ({ ...s, take: 0 }));
  let used = head.length;
  for (const s of live) used += 1 + s.title.length + 1 + more(s.rows.length).length;
  const first = live.find(s => s.first);
  if (first) {
    const floor = live.filter(s => s !== first).reduce((n, s) => n + 1 + s.rows[0].text.length, 0);
    const tail = 1 + more(first.rows.length).length;
    if (first.shrink) first.rows = first.shrink(cap - used - floor + tail);
    const whole = first.rows.reduce((n, r) => n + 1 + r.text.length, 0);
    if (used + whole - tail + floor <= cap) { used += whole - tail; first.take = first.rows.length; }
    else {
      first.over = true;
      used += 1 + first.note.length;
      for (; first.take < first.rows.length; first.take++) {
        const cost = 1 + first.rows[first.take].text.length;
        if (used + cost + floor > cap) break;
        used += cost;
      }
    }
  }
  // A `first` section cut short has had everything but the floor, and the floor is the others' first
  // lines: left to the round, its next line would take them, and a heading would sit over nothing.
  const others = first && first.over ? live.filter(s => s !== first) : live;
  for (let moved = true; moved;) {
    moved = false;
    for (const s of others) {
      if (s.take >= s.rows.length) continue;
      const cost = 1 + s.rows[s.take].text.length;
      if (used + cost > cap) continue;
      used += cost;
      s.take++;
      moved = true;
    }
    if (others !== live) break;
  }
  const lines = [head], ids = [];
  for (const s of live) {
    lines.push(s.title);
    if (s.over && s.take < s.rows.length) lines.push(s.note);
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
// What survives a cut: the owner's over a lead's, then what reaches every project before what names
// one, then the newest. It is the order the lines print in whether or not anything is cut, so a
// briefing does not rearrange itself on the day the thirteenth rule arrives.
const reach = (r) => (K.scopeKind(r.scope) === 'project' ? 1 : 0);
const RULES_OVER = 'RULES DO NOT ALL FIT: the end of this order is cut, owner first, then profile and all before project, then newest.';

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
  // Each line names its scope, and the title says which wins, so a project rule printed under an
  // owner's `all` rule is not read as losing to it.
  // A fleet with no project of its own cannot tell whether a `project:` rule is about it, and the
  // reading that lists them all is for a person asking what the profile holds, not for a lead who
  // would take another project's rule as its own.
  const applying = rules.live.filter(r => project || K.scopeKind(r.scope) !== 'project')
    .sort((a, b) => AUTH_ORDER[a.authority] - AUTH_ORDER[b.authority] || reach(a) - reach(b) || b.t - a.t);
  const ruleRows = (width) => applying.map(r => ({ id: r.id, text: `- ${r.id} [${r.authority} ${r.scope}${r.shared ? `, from ${r.from}` : ''}] ${clip(r.text, width)}${privTag(r, mode)}` }));
  rows.rules = ruleRows(LINE_TEXT);
  // The widest clip at which every rule fits in `room`, or the narrowest there is. Only a line
  // longer than the width pays, so a short rule never loses a word to a long one's length.
  const ruleBudget = (room) => {
    for (let w = LINE_TEXT; w > RULE_TEXT_MIN; w -= 2) {
      const r = ruleRows(w);
      if (r.reduce((n, x) => n + 1 + x.text.length, 0) <= room) return r;
    }
    return ruleRows(RULE_TEXT_MIN);
  };
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
    { title: `RULES (${K.RULE_PRECEDENCE})`, rows: rows.rules, first: true, shrink: ruleBudget, note: RULES_OVER },
    { title: 'DECISIONS THAT HOLD (owner and lead only)', rows: rows.decisions },
    { title: 'WAITING ON THE OWNER', rows: rows.waits },
  ]), project };
}
