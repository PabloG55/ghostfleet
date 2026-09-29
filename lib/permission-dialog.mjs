// lib/permission-dialog.mjs — is this pane asking a human to APPROVE A TOOL CALL, and
// would these keys approve it?
//
// fleet-answer presses raw keys in a worker's pane, and the fleet_answer MCP tool hands
// that verb to an agent. Nothing ever asked what the pane was showing, so a lead could
// answer "1" to a worker's "Do you want to proceed?" and approve a command no human had
// seen — one agent approving another agent's tool call, which is the one thing a
// permission dialog exists to prevent. The tool's own description said "a permission
// dialog" in so many words.
//
// This is the ONE detector for that question. fleet-answer runs it before it sends
// anything; the MCP dispatch runs it to put the dialog in front of Jarvis's owner when
// Jarvis asks to answer one. Two copies would disagree the first time an agent redraws
// its dialog, and the disagreement would be a hole on whichever side went blind.
//
// WHAT IS A PERMISSION DIALOG, and what is not. Every agent draws several numbered
// menus that a blocked worker legitimately needs answered by its lead, and those must
// stay answerable: a usage-limit notice, a folder-trust prompt, codex's update prompt.
// Each parser below keys on the QUESTION the agent asks about a tool call, not on the
// menu shape, because the menu shape is shared by all of them. Captured, not guessed —
// test/fixtures/*-permission-*.txt, *-trust*.txt, codex-update.txt, claude-limit-hit.txt:
//
//   claude    "Do you want to proceed?" / "Do you want to create hello.txt?", then
//             "❯ 1. Yes … 3. No", then "Esc to cancel · Tab to amend". The trust prompt
//             asks "Is this a project you created or one you trust?" and the limit menu
//             "What do you want to do?" — neither starts a line with "Do you want to".
//   codex     "Would you like to run the following command?" (and "…make the following
//             edits?"), "› 1. Yes, proceed (y)", "Press enter to confirm or esc to
//             cancel". Its trust prompt is "Trust this folder?"; its update prompt is
//             "Update available".
//   opencode  "△ Permission required", "# Shell command", "$ touch notes.txt", then
//             "Allow once   Allow always   Reject" — a horizontal menu driven by ⇆ and
//             enter, so there is no number to press at all.
//
// ANCHORED TO THE BOTTOM OF THE SCREEN. A live dialog is the last thing an agent draws;
// the same text QUOTED — a lead that ran fleet-read on a blocked worker, a doc about
// dialogs — sits above a composer box. So the dialog's last line must be near the end of
// the pane, with no input box after it. Bias, deliberately: when in doubt this says
// "dialog". A false dialog costs a refused "2" that a human then re-sends; a missed one
// is the hole this file exists to close.
//
// WHICH KEYS DECLINE. Only two things, both measured on the captures: Escape (every agent
// binds it to cancel/reject), and typing the number of an option whose label is a "No"
// (claude's "3. No", codex's "3. No, and tell Codex what to do differently"). Everything
// else is treated as approving — Enter, a "Yes" number, codex's letter shortcuts (y, p,
// a), arrow keys that move the highlight, Tab ("Tab to amend"), free text. That list is
// short on purpose: a key sequence that walks the highlight to "Reject" and presses Enter
// would decline too, and it is refused anyway, because telling it apart from one that
// walks to "Allow" means modelling every agent's cursor. The refusal says which key to
// use instead.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// CSI (colours, cursor), OSC (hyperlinks — the permission fixture's file path is one),
// and the lone two-byte escapes. The pane view keeps them; a detector wants the words.
export function stripAnsi(s) {
  return String(s ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

// How close to the bottom a dialog's last line must be, in NON-BLANK lines. Measured on
// the captures: claude and codex end ON their footer (0 lines after), opencode draws one
// or two hint lines and an empty gutter line beneath its menu. 4 leaves room for a
// status line some setups draw under a dialog, and not for a composer plus a transcript.
const NEAR_BOTTOM = 4;

// An input box after the dialog means the dialog is history, not a question. claude's
// composer is a bare "❯" line between rules (a dialog's own "❯ 1. Yes" has text after
// it); codex's is a "›" line that is not a numbered option.
const COMPOSER = /^\s*(?:❯|›)\s*(?!\d+\.)(?:\S.*)?$/;

function prep(pane) {
  // opencode draws its conversation inside a "┃" gutter; drop it so every parser reads the
  // same indentation of plain text.
  return stripAnsi(pane).split('\n').map(l => l.replace(/\s+$/, '').replace(/^\s*[┃│]\s?/, ''));
}
function lastNonBlank(lines) { for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) return i; return -1; }
function nonBlankBetween(lines, a, b) { let n = 0; for (let i = a + 1; i <= b; i++) if (lines[i].trim()) n++; return n; }
function composerAfter(lines, i) { for (let k = i + 1; k < lines.length; k++) if (COMPOSER.test(lines[k]) && !/^\s*(?:❯|›)\s*\d+\./.test(lines[k])) return true; return false; }
function nearBottom(lines, end) {
  const last = lastNonBlank(lines);
  return last >= 0 && nonBlankBetween(lines, end, last) <= NEAR_BOTTOM && !composerAfter(lines, end);
}
function block(lines, a, b) {
  const out = lines.slice(a, b + 1);
  // Re-indent to the block's own margin so it reads as one quotation when printed.
  const m = Math.min(...out.filter(l => l.trim()).map(l => l.match(/^\s*/)[0].length));
  return out.map(l => l.slice(Number.isFinite(m) ? m : 0)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// "❯ 1. Yes" / "  3. No, and tell Codex …" -> {n:'3', label:'No, and tell…'}. A wrapped
// option's continuation line has no number and is not a new option.
function options(lines, a, b) {
  const out = [];
  for (let i = a; i <= b; i++) {
    const m = lines[i].match(/^\s*(?:❯|›|>)?\s*(\d+)\.\s+(.*)$/);
    if (m) out.push({ n: m[1], label: m[2].trim() });
  }
  return out;
}
const isNo = (label) => /^(?:No|Reject|Deny)\b/i.test(label);

function claude(lines) {
  // The LAST question on the screen, so an earlier quoted one cannot shadow a live one.
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*Do you want to .+\?\s*$/.test(lines[i])) { q = i; break; }
  if (q < 0) return null;
  let foot = -1;
  for (let i = q + 1; i < Math.min(lines.length, q + 16); i++) if (/Esc to cancel/.test(lines[i])) { foot = i; break; }
  const opts = options(lines, q + 1, foot < 0 ? Math.min(lines.length - 1, q + 12) : foot);
  if (!opts.length || !/^Yes\b/.test(opts[0].label)) return null;
  const end = foot < 0 ? q + 1 + opts.length : foot;
  if (!nearBottom(lines, end)) return null;
  // The dialog opens at the full-width rule above it; the first line after the rule names
  // the tool ("Bash command", "Create file").
  let top = q;
  for (let i = q - 1; i >= Math.max(0, q - 60); i--) if (/^\s*─{10,}\s*$/.test(lines[i])) { top = i + 1; break; }
  const tool = (lines.slice(top, q).find(l => l.trim()) || '').trim();
  return { agent: 'claude', tool, question: lines[q].trim(), options: opts, text: block(lines, top, end) };
}

function codex(lines) {
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*Would you like to .+\?\s*$/.test(lines[i])) { q = i; break; }
  if (q < 0) return null;
  let foot = -1;
  for (let i = q + 1; i < Math.min(lines.length, q + 30); i++) if (/esc to cancel/i.test(lines[i])) { foot = i; break; }
  const opts = options(lines, q + 1, foot < 0 ? Math.min(lines.length - 1, q + 24) : foot);
  if (!opts.length || !/^Yes\b/.test(opts[0].label)) return null;
  const end = foot < 0 ? q + 1 : foot;
  if (!nearBottom(lines, end)) return null;
  // "• Running touch …" above the question names the call; keep it in the quotation.
  const top = q > 0 && /^\s*•\s/.test(lines[q - 1]) ? q - 1 : q;
  const cmd = lines.slice(q, end + 1).find(l => /^\s*\$\s/.test(l));
  return { agent: 'codex', tool: cmd ? 'shell command' : lines[q].trim().replace(/^Would you like to /, '').replace(/\?$/, ''),
           question: lines[q].trim(), options: opts, text: block(lines, top, end) };
}

function opencode(lines) {
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/Permission required\s*$/.test(lines[i])) { q = i; break; }
  if (q < 0) return null;
  let menu = -1;
  for (let i = q + 1; i < Math.min(lines.length, q + 30); i++) if (/Allow once/.test(lines[i])) { menu = i; break; }
  if (menu < 0) return null;
  if (!nearBottom(lines, menu)) return null;
  const tool = (lines.slice(q + 1, menu).find(l => l.trim()) || '').trim().replace(/^#\s*/, '');
  // Strip the key hints opencode prints on the menu line at full width.
  const body = block(lines, q, menu).replace(/(Reject)\s{2,}.*$/m, '$1');
  // A horizontal menu: no numbers, so no option is reachable by typing one.
  return { agent: 'opencode', tool, question: 'Permission required', options: [], text: body };
}

// The dialog on this pane, or null. Every parser runs whatever the session's agent marker
// says: the marker defaults to claude when absent, and a wrong marker must not be what
// makes a dialog invisible.
export function permissionDialog(pane) {
  const lines = prep(pane);
  return claude(lines) || codex(lines) || opencode(lines);
}

// Would sending this to that dialog approve it? {text, keys:[...]} as fleet-answer takes
// them. true = approving (or unknown, which is treated the same); false = a decline.
export function approves(dialog, { text = '', keys = [] } = {}) {
  if (!dialog) return false;
  if (keys.length) return !keys.every(k => /^(?:Escape|Esc|C-\[)$/i.test(k));
  const t = String(text).trim();
  if (/^\d+$/.test(t)) { const o = dialog.options.find(x => x.n === t); return !(o && isNo(o.label)); }
  return true;
}

// The keys that would decline it, for a refusal to hand over instead of a lecture.
export function declineHint(dialog) {
  const no = (dialog?.options || []).find(o => isNo(o.label));
  return no ? `"${no.n}" (${no.label.split(/[,(]/)[0].trim()}) or --key Escape` : '--key Escape';
}

// ── CLI, for bin/fleet-answer ─────────────────────────────────────────────
//   node lib/permission-dialog.mjs [--text T] [--key K]... < pane
// Exit 0: no permission dialog on the pane. 10: a dialog, and these keys decline it.
// 11: a dialog, and these keys would approve it (or cannot be shown not to). The dialog
// is printed on stdout in both dialog cases, and the decline hint as its last line.
const isMain = (() => { try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2); let text = ''; const keys = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--text') text = argv[++i] ?? '';
    else if (argv[i] === '--key') keys.push(argv[++i] ?? '');
  }
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const d = permissionDialog(Buffer.concat(chunks).toString('utf8'));
    if (!d) process.exit(0);
    process.stdout.write(`${d.agent} · ${d.tool || 'tool call'}\n${d.text}\nto decline: ${declineHint(d)}\n`);
    process.exit(approves(d, { text, keys }) ? 11 : 10);
  });
}
