#!/usr/bin/env node
// lib/session-model.mjs — the parts of moving a Claude session's model that read JSON.
// lib/session-model.sh has the precedence and the files; bin/fleet-model is the command.
//
//   restore <settings.json> <snapshot|-> <model we set> <backup>
//       put the profile's `model` key back after a `/model`. One line out:
//         exit 0  `unchanged: …`  nothing to put back
//         exit 0  `restored: …`   the file is the snapshot again, byte for byte
//         exit 3  `left: …`       changed in a way this will not touch; the reason follows
//       <snapshot> is the file as it was just before the `/model` was sent; `-` = no file then.
//   outcome <transcript> <byte offset> <model>
//       what the `/model <model>` sent after <offset> did: `ok <what it said>`,
//       `failed <what it said>`, or `none` (nothing yet). Exit 0 always.
//   current
//       stdin: one `<name><TAB><transcript|-><TAB><launch record|->` per line;
//       stdout: `<name><TAB><model|-><TAB><epoch|-><TAB><how>` per line, how one of
//       reply | switch | launch | none. The newest of: the model its last reply came from,
//       the last `/model` that took, and what agent-here started it on.
//
// ── WHY THE SETTINGS FILE IS PUT BACK ─────────────────────────────────────────
// Claude Code's `/model <m>` does two things: it switches the running conversation, and it
// writes `"model": "<m>"` into the PROFILE's settings.json — "Set model to Sonnet 5.5 and saved
// as your default for new sessions". The second is right for a person at a keyboard and wrong
// for a lead moving one session among many: every later session of that profile would start on
// whatever one list-keeping session was moved to, and nobody would know to look. Measured on
// 2.1.319: the write lands when the switch is confirmed (not when the command is typed), and a
// running session does NOT follow the key — a second session on the same profile stayed on its
// model through the write, and the moved one stayed on its new model when the key was put back.
// So putting the key back changes future sessions only, which is exactly what is wanted.
//
// WHAT "ONLY IF CLAUDE CODE CHANGED IT" MEANS. The file is read again after the switch and
// compared with the snapshot as DATA, every key but `model` — not as bytes, because Claude Code
// rewrites the whole file and re-orders its keys while it is at it (measured: theme, env became
// env, theme, model). Then:
//   * the rest is the same and `model` moved to exactly what we set: our write, so the
//     SNAPSHOT'S BYTES go back, and the person's own formatting and key order come back too;
//   * the rest changed as well: somebody edited the file in the same window (a person, another
//     session's own settings write). Left alone, and the caller warns, naming the keys;
//   * `model` moved to something else: another `/model`, very likely a person meaning it. Left;
//   * `model` did not move: nothing to do. A reformat alone is not worth a write.
// Written IN PLACE (truncate and write, as Claude Code does), never replaced by a rename: a
// rename gives the file the temp file's mode and inode, and turns a symlinked settings.json into
// a plain file. It is read once more right before the write, and a change since the decision is
// left alone too. The version being overwritten goes to <backup> first.
//
// ── WHY THE TRANSCRIPT IS THE READ-BACK ───────────────────────────────────────
// The pane says "Set model to …" too, but the pane scrolls, wraps and repaints; the transcript is
// an append-only record with the outcome as its own line. Two shapes, both measured on 2.1.319:
//   a switch that took   type:user, content `<command-name>/model</command-name> … <command-args>
//                        sonnet</command-args>`, then type:user `<local-command-stdout>Set model to
//                        \`Sonnet 5.5\` and saved as your default …</local-command-stdout>`
//   one that did not     type:system subtype:local_command, the same command line, then a stdout
//                        line carrying `commandRun:{command:"model", args:"opus"}` — "Kept model as
//                        `Haiku 5.5`" (the confirm dialog declined), "Unable to validate model: …"
// Every assistant reply carries `message.model`, the id it was actually answered by — the one
// fact about the running model nothing else states, and what `current` leans on.

import fs from 'node:fs';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Canonical: keys sorted at every depth, so two files that say the same thing compare equal
// however they are ordered.
const canon = (v) => isObj(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v);
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };

// decide(before, after, ours) -> {action: 'unchanged'|'restore'|'leave', why, write?}
// before/after are the file's TEXT, or null for no file. Pure, so the suite can drive every
// branch without a session.
export function decide(before, after, ours) {
  if (after === before) return { action: 'unchanged', why: 'settings.json was not touched' };
  if (after === null) return { action: 'leave', why: 'settings.json is gone since the switch' };
  let b = {}, a;
  if (before !== null) {
    try { b = JSON.parse(before); } catch { return { action: 'leave', why: 'the snapshot is not JSON' }; }
  }
  try { a = JSON.parse(after); } catch { return { action: 'leave', why: 'settings.json is not JSON now' }; }
  if (!isObj(b) || !isObj(a)) return { action: 'leave', why: 'settings.json is not a JSON object' };
  const changed = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => k !== 'model' && canon(b[k]) !== canon(a[k])).sort();
  if (changed.length)
    return { action: 'leave', why: `other keys changed in the same window (${changed.join(', ')}), so it is not only fleet-model's switch — check its "model" key by hand` };
  if (canon(a.model) === canon(b.model))
    return { action: 'unchanged', why: 'the model key did not move' };
  if (typeof a.model !== 'string' || a.model.toLowerCase() !== String(ours).toLowerCase())
    return { action: 'leave', why: `the model key is ${JSON.stringify(a.model)}, not the ${JSON.stringify(ours)} fleet-model set — somebody else changed it` };
  // Ours. The snapshot's own bytes when there was a file; with none, the file Claude Code made
  // minus the key it made it for.
  const write = before !== null ? before : `${JSON.stringify(without(a, 'model'), null, 2)}\n`;
  return { action: 'restore', why: `model key back to ${b.model === undefined ? 'unset' : JSON.stringify(b.model)}`, write };
}

export function restore(file, snapshot, ours, backup) {
  const before = snapshot === '-' ? null : read(snapshot);
  if (snapshot !== '-' && before === null) return { code: 3, line: `left: the snapshot ${snapshot} is unreadable` };
  const after = read(file);
  const d = decide(before, after, ours);
  if (d.action === 'unchanged') return { code: 0, line: `unchanged: ${d.why}` };
  if (d.action === 'leave') return { code: 3, line: `left: ${d.why}` };
  try { fs.writeFileSync(backup, after); } catch (e) { return { code: 3, line: `left: could not write the backup ${backup} (${e.code || e.message})` }; }
  if (read(file) !== after) return { code: 3, line: 'left: settings.json changed again while it was being put back' };
  try { fs.writeFileSync(file, d.write); } catch (e) { return { code: 3, line: `left: could not write settings.json (${e.code || e.message})` }; }
  if (read(file) !== d.write) return { code: 3, line: 'left: settings.json did not read back as written' };
  return { code: 0, line: `restored: ${d.why} (the version it replaced is in ${backup})` };
}

// ── the transcript ────────────────────────────────────────────────────────────
const text = (r) => {
  const c = r?.message?.content ?? r?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('');
  return '';
};
const records = (s) => s.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const said = (t) => (t.match(/<local-command-stdout>([\s\S]*?)(<\/local-command-stdout>|$)/) || [])[1]?.trim() || '';
const argsOf = (t) => (t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1]?.trim() ?? null;
const isModelCmd = (t) => /<command-name>\/model<\/command-name>/.test(t);
const conversational = (r) => r && (r.type === 'user' || r.type === 'system');

// The tail, not the whole file: a long conversation's transcript runs to megabytes, and the
// answer is near the end. The first line of a cut is dropped, since it is half a record.
function tail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const s = buf.toString('utf8');
    return start > 0 ? s.slice(s.indexOf('\n') + 1) : s;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function since(file, offset) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.min(Math.max(0, offset), size);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// The outcome of a `/model <ours>` written after <offset>. A command line naming another model
// is somebody else's switch and is skipped; the stdout that answers ours is the first one after
// its command line.
export function outcome(file, offset, ours) {
  const s = since(file, offset);
  if (s === null) return 'none';
  const rs = records(s).filter(conversational);
  const want = String(ours).toLowerCase();
  for (let i = 0; i < rs.length; i++) {
    const t = text(rs[i]);
    const run = rs[i].commandRun;
    // the declined/failed shape carries its own command on the stdout line
    if (run && run.command === 'model' && String(run.args || '').toLowerCase() === want && said(t))
      return `${/^Set model to/.test(said(t)) ? 'ok' : 'failed'} ${said(t)}`;
    if (!isModelCmd(t) || String(argsOf(t) || '').toLowerCase() !== want) continue;
    for (let j = i + 1; j < rs.length; j++) {
      const u = text(rs[j]);
      if (isModelCmd(u)) break;
      if (!/<local-command-stdout>/.test(u)) continue;
      return `${/^Set model to/.test(said(u)) ? 'ok' : 'failed'} ${said(u)}`;
    }
  }
  return 'none';
}

const epoch = (r) => { const t = Date.parse(r?.timestamp || ''); return Number.isFinite(t) ? Math.floor(t / 1000) : 0; };

// The newest model fact in a transcript: {model, at, how} or null.
export function lastModel(file) {
  for (const bytes of [1 << 21, Infinity]) {
    const s = bytes === Infinity ? read(file) : tail(file, bytes);
    if (s === null) return null;
    const rs = records(s);
    for (let i = rs.length - 1; i >= 0; i--) {
      const r = rs[i];
      const m = r?.type === 'assistant' ? r.message?.model : null;
      // `<synthetic>` is what an error turn or an interrupted one records: not a model.
      if (typeof m === 'string' && m && !m.startsWith('<')) return { model: m, at: epoch(r), how: 'reply' };
      if (conversational(r) && /^Set model to/.test(said(text(r)))) {
        // its command line is the record before it (or this one carries it)
        const args = r.commandRun?.command === 'model' ? r.commandRun.args : argsOf(text(rs[i - 1] || {}));
        if (args) return { model: String(args), at: epoch(r), how: 'switch' };
      }
    }
    if (bytes === Infinity || s.length < bytes) return null;   // the tail WAS the whole file
  }
  return null;
}

// current: a launch record is `<epoch> <source> <model|->` (bin/agent-here). It wins when it is
// newer than the transcript's last fact — a session restarted onto sonnet has a last reply from
// before the restart, and that reply's opus is not what it runs on now.
export function current(transcript, launch) {
  const l = String(launch || '').trim().split(/\s+/);
  const la = /^\d+$/.test(l[0] || '') ? Number(l[0]) : 0;
  const lm = la && l[2] && l[2] !== '-' ? l[2] : '';
  const t = transcript && transcript !== '-' ? lastModel(transcript) : null;
  if (t && t.at >= la) return t;
  if (la) return { model: lm, at: la, how: 'launch', source: l[1] || '' };
  return t || { model: '', at: 0, how: 'none' };
}

const main = async () => {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'restore') {
    const [file, snap, ours, backup] = a;
    if (!file || !snap || !ours || !backup) { process.stderr.write('usage: session-model.mjs restore <settings.json> <snapshot|-> <model> <backup>\n'); process.exit(2); }
    const r = restore(file, snap, ours, backup);
    process.stdout.write(`${r.line}\n`); process.exit(r.code);
  }
  if (cmd === 'outcome') {
    const [file, off, ours] = a;
    if (!file || !ours) { process.stderr.write('usage: session-model.mjs outcome <transcript> <offset> <model>\n'); process.exit(2); }
    process.stdout.write(`${outcome(file, Number(off) || 0, ours)}\n`); process.exit(0);
  }
  if (cmd === 'current') {
    const input = fs.readFileSync(0, 'utf8');
    const out = [];
    for (const line of input.split('\n')) {
      if (!line) continue;
      const [name, tr, launch] = line.split('\t');
      const c = current(tr, launch && launch !== '-' ? launch : '');
      out.push([name, c.model || '-', c.at || '-', c.how + (c.source ? `:${c.source}` : '')].join('\t'));
    }
    process.stdout.write(out.length ? `${out.join('\n')}\n` : ''); process.exit(0);
  }
  process.stderr.write('usage: session-model.mjs restore|outcome|current …\n'); process.exit(2);
};

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) main();
