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
//   agy       "Requesting permission for:", the command indented beneath it, "Run this
//             command?", then "> 1. Yes, run command … 4. No, cancel" and a "↑/↓ Navigate"
//             hint. Its trust prompt asks "Do you trust the contents of this project?".
//   cursor    a full-width rule, "$  touch notes.txt in .", "Run this command?", "Not in
//             allowlist: touch", then "→ Run (once) (y)" … "Skip & tell the agent what to do
//             instead (esc or n)" — LETTERS, not numbers. Its trust prompt is a box asking
//             "Do you trust the contents of this directory?" over "▶ [a] Trust this workspace".
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
import crypto from 'node:crypto';
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
const FOOTER = /\b(?:enter|esc)\b.*\b(?:confirm|continue|cancel|skip|quit|select)\b/i;

// The continuation lines of a wrapped option belong to its label: at 56 columns claude's
// "2. Yes, and always allow access to" carries its path on the next line, and a label that
// stopped at the wrap would make the same dialog a different one after a resize.
function options(lines, a, b) {
  const out = [];
  for (let i = a; i <= b; i++) {
    const m = lines[i].match(/^\s*(?:❯|›|>)?\s*(\d+)\.\s+(.*)$/);
    if (m) { out.push({ n: m[1], label: m[2].trim() }); continue; }
    const last = out[out.length - 1];
    if (last && lines[i].trim() && /^\s{3,}\S/.test(lines[i]) && !FOOTER.test(lines[i])) last.label += ' ' + lines[i].trim();
    else if (last) break;
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
  // The command is what sits between the tool's name and the question — for Bash the
  // command line and Claude's one-line description of it, for a file its path and diff.
  const command = lines.slice(top, q).map(l => l.trim()).filter(Boolean).slice(1).join(' ');
  return { agent: 'claude', tool, command, question: lines[q].trim(), options: opts, text: block(lines, top, end) };
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
           command: cmd ? cmd.trim().replace(/^\$\s*/, '') : '',
           question: lines[q].trim(), options: opts, text: block(lines, top, end), fpText: block(lines, q, end) };
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
  const cmd = lines.slice(q + 1, menu).find(l => /^\s*\$\s/.test(l));
  return { agent: 'opencode', tool, command: cmd ? cmd.trim().replace(/^\$\s*/, '') : '',
           question: 'Permission required', options: [], text: body };
}

// ── any prompt, for "is the thing the phone showed STILL there" ──────────────
// A key sent to a prompt that has gone — answered at the desk, timed out, replaced by the
// next one — lands in the composer as a MESSAGE: "1" and Enter becomes a turn. So a phone
// answer carries a fingerprint of the prompt it was showing, and the verb re-captures and
// compares immediately before the keys go. That needs every prompt a phone can answer, not
// only permission dialogs: folder trust, codex's update menu, any numbered menu.
//   A MENU is a list of options, one of them SELECTED (❯ or ›), ending at the bottom of the
// screen with no input box after it. The selection glyph is the discriminator: a numbered
// list in a transcript has none. An UNNUMBERED menu (claude's trust prompt: "❯ No, exit /
// Yes, I trust this folder") must also have a key-hint footer, because a bare "❯ text" line
// is also what a composer with a draft in it looks like.
const SELECTED = /^\s*[❯›]\s*(?:\d+\.\s+)?\S/;
function menu(lines) {
  const last = lastNonBlank(lines);
  if (last < 0) return null;
  // the footer, if there is one, is within the last few lines
  let foot = -1;
  for (let i = last, n = 0; i >= 0 && n <= NEAR_BOTTOM; i--) { if (!lines[i].trim()) continue; if (FOOTER.test(lines[i])) { foot = i; break; } n++; }
  const end = foot >= 0 ? foot : last;
  // walk up from the bottom through the options to the selected one
  let sel = -1, first = -1;
  for (let i = (foot >= 0 ? foot - 1 : last), n = 0; i >= 0 && n < 24; i--, n++) {
    if (!lines[i].trim()) continue;
    if (SELECTED.test(lines[i])) sel = i;
    if (/^\s*[❯›>]?\s*\d+\.\s+\S/.test(lines[i]) || SELECTED.test(lines[i])) first = i;
    else if (sel >= 0 && !/^\s{2,}\S/.test(lines[i])) break;   // the paragraph above the options
  }
  if (sel < 0 || first < 0) return null;
  const numbered = options(lines, first, end);
  if (!numbered.length && foot < 0) return null;
  if (numbered.length && numbered.length < 2) return null;
  if (!nearBottom(lines, end)) return null;
  const opts = numbered.length ? numbered
    : lines.slice(first, end).map(l => l.replace(/^\s*[❯›]?\s*/, '').trim()).filter(Boolean).map((label, i) => ({ n: String(i + 1), label }));
  // The question: the paragraph immediately above the options, up to a blank line or a rule.
  let top = first, k = first - 1;
  while (k >= 0 && !lines[k].trim()) k--;
  for (let n = 0; k >= 0 && n < 10 && lines[k].trim() && !/^\s*[─━]{10,}/.test(lines[k]); k--, n++) top = k;
  const question = lines.slice(top, first).map(l => l.trim()).filter(Boolean).join(' ');
  if (!question && !numbered.length) return null;
  const kind = /\btrust\b/i.test(question + ' ' + opts.map(o => o.label).join(' ')) ? 'trust' : 'menu';
  return { kind, tool: '', command: '', question, options: opts, text: block(lines, top, end) };
}

// The prompt on this pane — a permission dialog first, since it is the one that matters
// most — or null when the pane is not waiting on a key at all.
export function promptOn(pane) {
  const d = permissionDialog(pane);
  if (d) return { kind: 'permission', ...d };
  return menu(prep(pane));
}

// What makes two captures "the same prompt": its kind, tool, command and options, with
// ALL whitespace and the selection glyph dropped. Whitespace because the same dialog
// re-wraps at another width (codex breaks a path mid-word), and a resize is not a change;
// the glyph because moving the highlight is not a different question.
export function fingerprint(p) {
  if (!p) return '';
  const norm = (x) => String(x ?? '').replace(/[❯›]/g, '').replace(/\s+/g, '');
  const src = [p.kind, p.agent || '', p.tool, p.command, p.question, (p.options || []).map(o => `${o.n}.${o.label}`).join('|'),
               p.fpText ?? p.text].map(norm).join('\u0001');
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
}
// The part of a prompt a client needs, with its fingerprint — what /api/pane serves.
export function promptSummary(pane) {
  const p = promptOn(pane);
  if (!p) return null;
  return { kind: p.kind, agent: p.agent || '', tool: p.tool || '', command: p.command || '', question: p.question || '',
           options: (p.options || []).map(o => ({ n: o.n, label: o.label })), fingerprint: fingerprint(p) };
}

// agy's selection glyph is ">", which is ALSO its composer, and at a narrow width it wraps
// an option's continuation to COLUMN 0 ("commands that start with 'touch'" under "2. Yes,
// and always allow in this conversation for" at 56 columns) — so the shared options()
// walk, which ends the list at the first unindented line, stopped at option 2 and lost the
// "4. No" that makes a decline typeable. Here every line between the question and the hint
// line belongs to the options: a numbered one starts the next, anything else continues it.
function agy(lines) {
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*Requesting permission for:\s*$/.test(lines[i])) { q = i; break; }
  if (q < 0) return null;
  let ask = -1;
  for (let i = q + 1; i < Math.min(lines.length, q + 12); i++) if (/^\s*\S.*\?\s*$/.test(lines[i]) && !/^\s*>?\s*\d+\./.test(lines[i])) { ask = i; break; }
  if (ask < 0) return null;
  const opts = []; let end = -1;
  for (let i = ask + 1; i < Math.min(lines.length, ask + 20); i++) {
    if (!lines[i].trim()) continue;
    if (/Navigate|esc to cancel/i.test(lines[i])) { end = i; break; }
    const m = lines[i].match(/^\s*>?\s*(\d+)\.\s+(.*)$/);
    if (m) opts.push({ n: m[1], label: m[2].trim() });
    else if (opts.length) opts[opts.length - 1].label += ' ' + lines[i].trim();
    else return null;
  }
  if (!opts.length || !/^Yes\b/.test(opts[0].label)) return null;
  if (end < 0) end = ask + opts.length;
  if (!nearBottom(lines, end)) return null;
  // A dialog that has been answered is history above agy's composer: a bare ">" line, or
  // "> " and a draft, between two rules. The live dialog has nothing of the kind below it.
  for (let k = end + 1; k < lines.length; k++) if (/^>(?:\s|$)/.test(lines[k]) && !/^>\s*\d+\./.test(lines[k])) return null;
  // The rule above the question closes the transcript; the line above THAT names the tool.
  let k = q - 1; while (k >= 0 && !lines[k].trim()) k--;
  let tool = '';
  if (k >= 0 && /^\s*─{10,}\s*$/.test(lines[k])) { k--; while (k >= 0 && !lines[k].trim()) k--; if (k >= 0) tool = lines[k].trim(); }
  const command = lines.slice(q + 1, ask).map(l => l.trim()).filter(Boolean).join(' ');
  return { agent: 'agy', tool: tool ? tool.toLowerCase() : 'tool call', command,
           question: lines[ask].trim(), options: opts, text: block(lines, q, end) };
}

// cursor's options are keyed by LETTERS ("Run (once) (y)", "Skip & tell the agent what to do
// instead (esc or n)") and the selected one is drawn with "→" — the same arrow as cursor's
// composer, "→ Add a follow-up". So the options are not returned as typeable numbers, the way
// opencode's are not: a phone that sent "y" and then Enter would approve on the "y" and put
// the Enter into the composer. They stay in the quoted text.
//   ESCAPE IS ONLY HALF A DECLINE HERE. Measured on a live worker: it opens "→ Tell the agent
// what to do instead (Enter to send, empty to skip, Esc to cancel)", and a second Escape goes
// back to the dialog. Enter on that empty line is the skip ("The shell command was blocked"),
// and it is answerable by itself because that line is no longer a permission dialog — so the
// hint below names both steps.
//   At 30 columns every option wraps, its continuation drawn at the same two-column indent as
// the next option's arrow, so the menu ends at the ")" that closes the decline's key hint
// rather than at a change of indentation.
function cursor(lines) {
  let q = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s?Run this command\?\s*$/.test(lines[i])) { q = i; break; }
  if (q < 0) return null;
  let sel = -1;
  for (let i = q + 1; i < Math.min(lines.length, q + 10); i++) if (/^\s*→\s+\S/.test(lines[i])) { sel = i; break; }
  if (sel < 0) return null;
  let skip = -1;
  for (let i = sel + 1; i < Math.min(lines.length, sel + 16); i++) if (/^\s*Skip\b/.test(lines[i])) { skip = i; break; }
  if (skip < 0) return null;
  let end = -1;
  for (let i = skip; i < Math.min(lines.length, skip + 4); i++) if (/\)\s*$/.test(lines[i])) { end = i; break; }
  if (end < 0) return null;
  if (!nearBottom(lines, end)) return null;
  // An answered dialog is history above cursor's composer, a "→" line of its own.
  for (let k = end + 1; k < lines.length; k++) if (/^\s*→\s/.test(lines[k])) return null;
  // The rule above the call closes the transcript; what sits between it and the question is
  // the command, "$  <cmd> in <dir>", wrapped onto as many lines as the width needs.
  let top = q;
  for (let i = q - 1; i >= Math.max(0, q - 12); i--) if (/^\s*─{10,}\s*$/.test(lines[i])) { top = i + 1; break; }
  const command = lines.slice(top, q).map(l => l.trim()).filter(Boolean).join(' ')
    .replace(/^\$\s*/, '').replace(/\s+in \S+$/, '');
  return { agent: 'cursor', tool: 'shell command', command, question: lines[q].trim(), options: [],
           text: block(lines, top, end) };
}

// The dialog on this pane, or null. Every parser runs whatever the session's agent marker
// says: the marker defaults to claude when absent, and a wrong marker must not be what
// makes a dialog invisible.
export function permissionDialog(pane) {
  const lines = prep(pane);
  return claude(lines) || codex(lines) || opencode(lines) || agy(lines) || cursor(lines);
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
  if (dialog?.agent === 'cursor') return '--key Escape, then --key Enter at the empty "Tell the agent what to do instead" line';
  const no = (dialog?.options || []).find(o => isNo(o.label));
  return no ? `"${no.n}" (${no.label.split(/[,(]/)[0].trim()}) or --key Escape` : '--key Escape';
}

// ── CLI, for bin/fleet-answer ─────────────────────────────────────────────
//   node lib/permission-dialog.mjs [--text T] [--key K]... [--expect FP] < pane
//   node lib/permission-dialog.mjs --fingerprint < pane      (the prompt as JSON, or null)
// Exit 0: no permission dialog on the pane. 10: a dialog, and these keys decline it.
// 11: a dialog, and these keys would approve it (or cannot be shown not to). The dialog
// is printed on stdout in both dialog cases, and the decline hint as its last line.
// 12: --expect was given and the pane is not showing that prompt any more — or no prompt
// at all. Checked FIRST: a key meant for a prompt that has gone is refused before anything
// else is asked about it.
const isMain = (() => { try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2); let text = ''; const keys = []; let expect = null; let fp = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--text') text = argv[++i] ?? '';
    else if (argv[i] === '--key') keys.push(argv[++i] ?? '');
    else if (argv[i] === '--expect') expect = argv[++i] ?? '';
    else if (argv[i] === '--fingerprint') fp = true;
  }
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    const pane = Buffer.concat(chunks).toString('utf8');
    if (fp) { process.stdout.write(JSON.stringify(promptSummary(pane)) + '\n'); process.exit(0); }
    if (expect !== null) {
      const now = promptSummary(pane);
      if (!now || !expect || now.fingerprint !== expect) {
        process.stdout.write(now ? `the pane now shows a different prompt (${now.kind}${now.tool ? ' · ' + now.tool : ''}: ${now.question || now.command})\n`
                                 : 'the pane is not showing a prompt any more\n');
        process.exit(12);
      }
    }
    const d = permissionDialog(pane);
    if (!d) process.exit(0);
    process.stdout.write(`${d.agent} · ${d.tool || 'tool call'}\n${d.text}\nto decline: ${declineHint(d)}\n`);
    process.exit(approves(d, { text, keys }) ? 11 : 10);
  });
}
