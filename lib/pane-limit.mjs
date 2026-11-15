// "This account is spent", read off a session's pane — ONE reader for the grid, fleet-list,
// fleet-send and the inbox row, so none of them can disagree about whether a session is out.
//
// Every pattern comes from bin/fleet-agent (limit_re_js, limit_fig_js, limit_fig_kind,
// limit_at_js), so this file knows nothing about any one agent. See the field notes there for
// why it takes TWO signals: the sentence alone is also what a session that merely QUOTES it
// carries, and only the agent's own figure, painted by the agent, separates the two.
//
// Fails CLOSED: no pattern, no figure in the pane (a narrow footer drops it), or a pattern that
// does not compile all read as "not limited" — a missed limit, never a fabricated one.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIBLING_AGENT = path.join(HERE, '..', 'bin', 'fleet-agent');

const rx = (src, flags = '') => { try { return src ? new RegExp(src, flags) : null; } catch { return null; } };

// "Nov 11th, 2026 12:04 AM" -> "Nov 11 12:04am"; "10:20pm" stays. The short form the card, the
// phone and the inbox already print for Claude's "resets 10:20pm": no year, no ordinal, no space
// before the meridiem.
export function shortReset(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim()
    .replace(/(\d)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/,?\s*\b20\d\d\b,?/g, '')
    .replace(/(\d{1,2}:\d{2})\s*([ap])\.?m\.?/i, (_, t, m) => t + m.toLowerCase() + 'm')
    .replace(/\s+/g, ' ').trim();
}

// fields: { re, fig, kind, at } — JS regex sources. Returns the reset time ('soon' when the
// sentence names none), or null when the session is not limited.
export function readLimit(txt, fields) {
  const re = rx(fields && fields.re), fig = rx(fields && fields.fig, 'g');
  if (!re || !fig) return null;                           // an agent with no pair of signals has no limit
  const lines = String(txt || '').split('\n');
  const at = lines.findIndex(l => re.test(l));
  if (at < 0) return null;
  const nums = [...String(txt).matchAll(fig)].map(m => Number(m[1]));
  if (!nums.length || !Number.isFinite(nums[nums.length - 1])) return null;
  const last = nums[nums.length - 1];
  if (fields.kind === 'left' ? last > 0 : last < 100) return null;
  const when = rx(fields.at, 'i');
  const m = when && when.exec(lines.slice(at, at + 4).join(' '));
  return m ? shortReset(m[1]) || 'soon' : 'soon';
}

export function limitFields(agent, get) {
  const g = get || ((f) => {
    for (const bin of [SIBLING_AGENT, 'fleet-agent']) {
      try { return execFileSync(bin, ['field', agent, f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
      catch { /* next */ }
    }
    return '';
  });
  return { re: g('limit_re_js'), fig: g('limit_fig_js'), kind: g('limit_fig_kind'), at: g('limit_at_js') };
}

// ONE inbox row per limit episode. Claude's Notification hook files its own; codex has no such
// hook, so the first reader that sees the pane files it. A marker holds the episode open and the
// next reader that finds the session NOT limited drops it, so a second limit later is news again.
export function noteLimit({ dir, sock, name, at, now = Math.floor(Date.now() / 1000) }) {
  if (!dir || !sock || !name || /[^A-Za-z0-9._~-]/.test(sock + name)) return false;
  const mark = path.join(dir, `${sock}.${name}.limit.noted`);
  try { if (fs.existsSync(mark)) return false; } catch { return false; }
  let to = 'master';
  try { const p = fs.readFileSync(path.join(dir, `${sock}.${name}.parent`), 'utf8').trim(); if (p && !/[^A-Za-z0-9._~-]/.test(p)) to = p; } catch {}
  const inbox = path.join(dir, to === 'master' ? `${sock}.inbox` : `${sock}.${to}.inbox`);
  try {
    fs.writeFileSync(mark, String(now) + '\n');
    fs.appendFileSync(inbox, `${now}\t${name}\tneed-you\tusage limit reached · resets ${at}\n`);
    return true;
  } catch { return false; }
}
export function clearLimitNote({ dir, sock, name }) {
  if (!dir || !sock || !name || /[^A-Za-z0-9._~-]/.test(sock + name)) return;
  try { fs.unlinkSync(path.join(dir, `${sock}.${name}.limit.noted`)); } catch {}
}

// CLI: pane on stdin, agent as argv[2]; prints the reset time and exits 0 when limited, 1 not.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const agent = process.argv[2] || 'claude';
  let txt = ''; try { txt = fs.readFileSync(0, 'utf8'); } catch {}
  const r = readLimit(txt, limitFields(agent));
  if (r) { process.stdout.write(r + '\n'); process.exit(0); }
  process.exit(1);
}
