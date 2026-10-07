#!/usr/bin/env node
// test/helpers/speech-check.mjs — which voice reads which sentence (lib/speech.mjs).
//
//     node test/helpers/speech-check.mjs     # one "name <US> want <US> got" row per check
//
// The Mac's voice is chosen PER SENTENCE because the owner writes English and Spanish in
// one message. So the table is in both directions: Spanish is detected AND English stays
// English — a detector that answered 'es' for everything would pass every Spanish row —
// and the ambiguous fragment keeps the language it was already in rather than flipping.
// Nothing here needs Kokoro: status() is checked against a directory that is missing and
// one whose files are sparse at the pinned sizes, and the plan is pure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const US = '\x1f';
const rows = [];
const is = (name, want, got) => rows.push(name + US + JSON.stringify(want) + US + JSON.stringify(got));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-check-'));
process.env.CLAUDE_FLEET_KOKORO_DIR = path.join(tmp, 'nowhere');
process.env.CLAUDE_FLEET_SPEECH_CACHE = path.join(tmp, 'cache');
delete process.env.CLAUDE_FLEET_KOKORO;
const S = await import(new URL('../../lib/speech.mjs', import.meta.url).href);

// ── 1. language, sentence by sentence ─────────────────────────────────────
for (const [what, text, want] of [
  ['plain English',            'The suite is green on both legs.',           'en'],
  ['plain Spanish',            'Listo, ya está desplegado en el servidor.',  'es'],
  ['Spanish with no accents',  'Tengo que revisar el PR antes de la demo',   'es'],
  ['a Spanish question',       '¿Quieres que lo mergee?',                    'es'],
  ['English with a code word', 'I pushed feat/retry-backoff and opened #42.', 'en'],
  ['English naming a Spanish word', 'The branch is called listo-final and it is merged.', 'en'],
]) is(`${what} reads as ${want}`, want, S.langOf(text));
is('a fragment with no vote keeps the language before it', 'es', S.langOf('OK.', 'es'));
is('...in either direction', 'en', S.langOf('acme-api #42.', 'en'));

// ── 2. the plan: sentences, and the voice each gets ───────────────────────
const mixed = 'The deploy finished. Ya está en staging. Next I will open the PR.';
const plan = S.plan(mixed);
is('a mixed message splits into its sentences', 3, plan.length);
is('...and each sentence gets its own voice', 'af_heart,ef_dora,af_heart', plan.map(p => p.voice).join(','));
is('...with the matching espeak language', 'en-us,es,en-us', plan.map(p => p.code).join(','));
is('an all-Spanish message is all ef_dora', 'ef_dora,ef_dora', S.plan('Listo. Ya está hecho y desplegado.').map(p => p.voice).join(','));
is('an all-English message is all af_heart', 'af_heart,af_heart', S.plan('Done. It is merged now.').map(p => p.voice).join(','));
is('a line break ends a sentence', 2, S.sentences('first item\nsecond item').length);
is('an abbreviation does not', 1, S.sentences('Use a flag, e.g. --dry-run, first.').length);
is('a decimal does not', 1, S.sentences('Version 1.2 shipped today.').length);
is('punctuation alone is not a sentence', 0, S.sentences(' … . ').length);
const long = S.sentences('word, '.repeat(120) + 'end.');
is('a very long sentence is cut at a comma', true, long.length > 1 && long.every(x => x.length <= 260));
is('...and nothing is lost in the cut', 'word, '.repeat(120) + 'end.', long.join(' '));
// The cache key is everything that changes the audio, and only that.
is('same words, same voice: same id', S.idFor('Hola.', S.VOICES.es), S.idFor('Hola.', S.VOICES.es));
is('same words, other voice: other id', false, S.idFor('Hola.', S.VOICES.es) === S.idFor('Hola.', { voice: 'em_alex', lang: 'es' }));
is('same words, other language: other id', false, S.idFor('Hola.', S.VOICES.es) === S.idFor('Hola.', { voice: 'ef_dora', lang: 'en-us' }));
is('an id is what the route accepts', true, S.validId(plan[0].id));
is('...and a path is not', false, S.validId('../../etc/passwd'));

// ── 3. optional: installed, missing, broken, or switched off ──────────────
// The model files are made at their PINNED sizes, sparse (truncate allocates nothing), so
// "installed" here is the real size rule and not an empty-file shortcut. Each state says
// the one command that fixes it — the phone shows `why` in a toast, and a toast that only
// says "no" is how nobody found out Kokoro existed.
const FIX = 'fleet-jarvis voice --kokoro --install';
is('no Kokoro dir: not ready', false, S.status().ready);
is('...and is "missing", not "broken"', 'missing', S.status().state);
is('...and it says where it looked, and the fix', true, /nowhere/.test(S.status().why) && S.status().why.includes(FIX));
const full = path.join(tmp, 'kokoro');
const P = S.pins();
const make = () => {
  fs.mkdirSync(path.join(full, 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(full, 'kokoro-v1.0.onnx'), ''); fs.truncateSync(path.join(full, 'kokoro-v1.0.onnx'), P.model.size);
  fs.writeFileSync(path.join(full, 'voices-v1.0.bin'), ''); fs.truncateSync(path.join(full, 'voices-v1.0.bin'), P.voices.size);
  fs.writeFileSync(path.join(full, 'venv', 'bin', 'python'), '');
};
make();
process.env.CLAUDE_FLEET_KOKORO_DIR = full;
is('all three present at the pinned sizes: ready', true, S.status().ready);
is('...and "installed"', 'installed', S.status().state);
fs.rmSync(path.join(full, 'voices-v1.0.bin'));
is('one missing: not ready', false, S.status().ready);
is('...and "broken", since the rest is there', 'broken', S.status().state);
is('...and it names the one', true, /voices-v1\.0\.bin/.test(S.status().why) && !/kokoro-v1\.0\.onnx/.test(S.status().why));
// A download cut short under the final name is the failure a size catches, and the one a
// bare existence test (what this file checked before) called ready.
make(); fs.truncateSync(path.join(full, 'kokoro-v1.0.onnx'), 4096);
is('a short model: not ready', false, S.status().ready);
is('...broken, naming the model and the fix', true, S.status().state === 'broken' && /kokoro-v1\.0\.onnx/.test(S.status().why) && S.status().why.includes(FIX));
make();
process.env.CLAUDE_FLEET_KOKORO = 'off';
is('CLAUDE_FLEET_KOKORO=off wins over a complete install', false, S.status().ready);
is('...and is "off"', 'off', S.status().state);
delete process.env.CLAUDE_FLEET_KOKORO;
// An id nobody planned cannot make the daemon synthesise anything.
is('audio for an unplanned id is refused', null, S.audio('0'.repeat(32)));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(rows.join('\n'));
