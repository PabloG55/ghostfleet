// A DRAFT PER SESSION, kept until a send of it succeeds. Framework-free, so the rule lives in one
// place whichever screen holds the composer (a session's page, a column of a stack).
//
// Typing to an agent, leaving the chat and coming back used to find the box empty, and so did a
// reload or relaunching the installed app: the composer's text was the screen's own state, and a
// session's screen is mounted fresh every time it is opened. The phone client before this one kept
// a draft per session for exactly that report, and the shared screens lost it when they replaced it.
//
//   KEYED BY PROJECT AND SESSION. Every project has a session called `master`, so a session name
// alone is two projects' drafts in one box. The project is the app's own address for it (a paired
// machine's is `<name>@<key>`), which is what tells two machines' same-named projects apart.
//   NOT THE OUTBOX. A draft is what has not been sent. A refused or failed send leaves the words in
// the box, and so here; only a send that succeeded clears it.
//   localStorage, mirrored in memory and wrapped like every other read: in a private window, or
// with site data blocked, the draft still lives for the page's life.
//   FILES stay with their draft for as long as the page lives (they are uploaded the moment they
// are picked, and the tile is what says so). A reload cannot keep a picked file, so the draft
// remembers how many it had, and the composer says how many did not come back, instead of a send
// quietly carrying fewer than the person attached.

const LS = 'gfw.drafts';
const DAYS = 30;                       // a draft nobody has touched in a month is let go
let drafts = null;                     // key -> { text, files, at }
const lost = new Map();                // key -> files a reload dropped, until they are seen
const kept = new Map();                // key -> the composer's files, for the page's life

export const draftKey = (project, session) => `${project || ''}\x1f${session || ''}`;

function load() {
  if (drafts) return drafts;
  drafts = new Map();
  try {
    const o = JSON.parse(localStorage.getItem(LS) || '{}') || {};
    const old = Date.now() / 1000 - DAYS * 86400;
    for (const [k, v] of Object.entries(o)) {
      if (!v || typeof v.text !== 'string' || (v.at || 0) < old) continue;
      drafts.set(k, v);
      if (v.files > 0) lost.set(k, v.files);       // this page never had them
    }
  } catch {}
  return drafts;
}
function persist() {
  try { localStorage.setItem(LS, JSON.stringify(Object.fromEntries(drafts))); } catch {}
}

export function draftText(key) { const d = load().get(key); return d ? d.text : ''; }
export function draftFiles(key) { return kept.get(key) || []; }
export function lostFiles(key) { load(); return lost.get(key) || 0; }

// The box's text and its files, as they are now. Nothing typed and nothing attached is no draft.
export function keepDraft(key, text, files = draftFiles(key)) {
  const m = load();
  if (files.length) kept.set(key, files); else kept.delete(key);
  const n = files.filter(f => f.state !== 'err').length;
  if (!text && !n) m.delete(key);
  else m.set(key, { text: String(text || ''), files: n, at: Math.floor(Date.now() / 1000) });
  persist();
}

// The note about files a reload dropped has been read, or a send made it moot.
export function seenLost(key) { lost.delete(key); }

// A send of this draft succeeded.
export function sentDraft(key) { seenLost(key); keepDraft(key, '', []); }
