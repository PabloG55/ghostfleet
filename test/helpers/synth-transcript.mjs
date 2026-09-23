#!/usr/bin/env node
// test/helpers/synth-transcript.mjs — a conversation of a known size, for timing a wake.
//
//     node test/helpers/synth-transcript.mjs <session-id> <cwd> <config-dir> <records>
//
// WHY SYNTHETIC. The number this feeds is "how long does a slept session take to come back",
// and it has to be measured against a transcript whose SIZE is chosen rather than whatever
// happened to be lying around. The first measurement of that number used a 46-record
// throwaway and came back 0.84s, which reads like free; the same path against 5,000 records
// took 26.3s. A benchmark that cannot set the size cannot tell those two apart.
//
// AND IT IS WRITTEN UNDER A SCRATCH CONFIG DIR, never the caller's own. An agent resumes by
// looking in $CLAUDE_CONFIG_DIR/projects/<mangled-cwd>/<id>.jsonl, so pointing that at a
// temporary directory keeps a fabricated conversation out of the real corpus — which other
// tools in this repo read and count.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [sid, cwd, cfg, nRaw] = process.argv.slice(2);
if (!sid || !cwd || !cfg || !nRaw) {
  console.error('usage: synth-transcript.mjs <session-id> <cwd> <config-dir> <records>');
  process.exit(2);
}
const n = Number(nRaw);
if (!Number.isFinite(n) || n < 1) { console.error('records must be a positive number'); process.exit(2); }

// ── THE REAL PATH, NOT THE ONE THAT WAS TYPED ────────────────────────────────
// CLAUDE.md's own entry: /tmp is a symlink to /private/tmp, and a config key written from
// the unresolved path is never found. Observed here — trust was recorded for the typed path,
// the agent looked up the resolved one, and the resume stopped on the trust dialog with a
// config file that plainly said the folder was trusted. Both the project-directory mangling
// and the trust key are derived from the resolved path for that reason.
const realCwd = (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })();

// The project directory name is the cwd with every non-alphanumeric byte replaced — the same
// mangling the real corpus uses, which is why a transcript written here is found by --resume.
const proj = String(realCwd).replace(/[^A-Za-z0-9]/g, '-');
const dir = path.join(cfg, 'projects', proj);
fs.mkdirSync(dir, { recursive: true });

const lines = [];
let prev = null;
for (let i = 0; i < n; i++) {
  const uuid = crypto.randomUUID();
  const role = i % 2 ? 'assistant' : 'user';
  // Padded so the file has a realistic size per record rather than a realistic count with a
  // trivial body: what a resume pays for is bytes parsed, not lines.
  const message = role === 'user'
    ? { role: 'user', content: `turn ${i}` }
    : { role: 'assistant', content: [{ type: 'text', text: `reply ${i} ${'x'.repeat(200)}` }] };
  lines.push(JSON.stringify({
    parentUuid: prev, isSidechain: false, userType: 'external', cwd: realCwd, sessionId: sid,
    version: '2.1.0', gitBranch: 'main', type: role, message, uuid,
    timestamp: new Date(Date.now() - (n - i) * 1000).toISOString(),
  }));
  prev = uuid;
}
fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
// ── THE CONFIG HAS TO LOOK USED, OR THE AGENT ONBOARDS INSTEAD OF RESUMING ───
// Observed: against a brand-new CLAUDE_CONFIG_DIR the resume never reached a prompt at all,
// because a fresh config means first-run onboarding — the pane sat on a theme picker for
// two minutes while the benchmark polled for a prompt that was never coming. The folder
// trust is the same class of thing one dialog later: untrusted, and the agent asks instead
// of starting. Both are pre-answered here so the number being measured is the RESUME and not
// a dialog somebody has to click.
fs.writeFileSync(path.join(cfg, '.claude.json'), JSON.stringify({
  hasCompletedOnboarding: true,
  lastOnboardingVersion: '2.1.222',
  theme: 'dark',
  firstStartTime: new Date(Date.now() - 86400000).toISOString(),
  numStartups: 5,
  projects: { [realCwd]: { hasTrustDialogAccepted: true } },
}, null, 1));
console.log(`${n} records -> ${path.join(dir, `${sid}.jsonl`)}`);
