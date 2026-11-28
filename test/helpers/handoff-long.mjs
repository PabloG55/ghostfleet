// node test/helpers/handoff-long.mjs <claude fixture> <out.jsonl> <turns>
//
// A LONG conversation, built from the records of a SHORT real one. The captured fixture is
// a few turns, which a 16k-token budget carries whole — the case lib/handoff.mjs has to get
// right is the one that does not fit, and no capture of that size could be published. So the
// real records are the templates (an owner's typed prompt, an assistant Bash call, its tool
// result with the "Exit code N" head Claude Code writes, an assistant reply) and only their
// text, ids and clock change: every field the reader looks at keeps its real shape.
//
// The first request and the last reply carry words the suite asks for by name, and each
// command's exit code is its turn number mod 5, so "the commands went over" is checkable.
import fs from 'node:fs';

const [src, out, n = '120'] = process.argv.slice(2);
const recs = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const pick = (f, what) => { const r = recs.find(f); if (!r) { console.error(`handoff-long: no ${what} in ${src}`); process.exit(1); } return JSON.parse(JSON.stringify(r)); };
const req = pick(r => r.type === 'user' && typeof r.message?.content === 'string', 'typed prompt');
const call = pick(r => r.type === 'assistant' && (r.message?.content || []).some(b => b.type === 'tool_use' && b.name === 'Bash'), 'Bash call');
const res = pick(r => r.type === 'user' && Array.isArray(r.message?.content) && r.message.content.some(b => b.type === 'tool_result'), 'tool result');
const reply = pick(r => r.type === 'assistant' && (r.message?.content || []).length === 1 && r.message.content[0].type === 'text', 'text reply');

const fill = (k, len) => `${`acme-api step ${k} — `.repeat(Math.ceil(len / 20))}`.slice(0, len);
const t0 = Date.parse(req.timestamp);
const at = (k, j) => new Date(t0 + k * 10000 + j * 1000).toISOString();
const id = (p, k) => `${p}-0000-4000-8000-${String(k).padStart(12, '0')}`;
const lines = [];
const N = Number(n);
for (let k = 1; k <= N; k++) {
  const q = JSON.parse(JSON.stringify(req));
  q.uuid = id('aaaaaaaa', k); q.promptId = id('bbbbbbbb', k); q.timestamp = at(k, 0);
  q.message.content = k === 1 ? `FIRST REQUEST: build the acme-api invoice export, then keep it green. ${fill(k, 300)}`
                              : `turn ${k}: ${fill(k, 380)}`;
  const c = JSON.parse(JSON.stringify(call));
  c.uuid = id('cccccccc', k); c.timestamp = at(k, 1); c.message.id = `msg_long_call_${k}`;
  c.message.content = [{ type: 'tool_use', id: `toolu_long_${k}`, name: 'Bash', input: { command: `make -C acme-api test-${k}`, description: `Run the step-${k} tests` } }];
  delete c.wireToolInputs; delete c.wireIngestContext;
  const r = JSON.parse(JSON.stringify(res));
  const code = k % 5;
  r.uuid = id('dddddddd', k); r.timestamp = at(k, 2); r.sourceToolAssistantUUID = c.uuid;
  const body = Array.from({ length: 40 }, (_, i) => `step ${k} line ${i}: ${fill(i, 30)}`).join('\n');
  r.message.content = [{ type: 'tool_result', tool_use_id: `toolu_long_${k}`, is_error: code !== 0,
    content: code ? `Exit code ${code}\n${body}\nmake: *** [test-${k}] Error ${code}` : `${body}\nok step ${k}` }];
  r.toolUseResult = code ? `Error: Exit code ${code}\n${body}` : { stdout: body, stderr: '', interrupted: false, isImage: false, noOutputExpected: false };
  const a = JSON.parse(JSON.stringify(reply));
  a.uuid = id('eeeeeeee', k); a.timestamp = at(k, 3); a.message.id = `msg_long_reply_${k}`;
  a.message.content = [{ type: 'text', text: k === N ? `LAST REPLY: the invoice export is green at step ${k}.` : `turn ${k} done: ${fill(k, 380)}` }];
  lines.push(q, c, r, a);
}
fs.writeFileSync(out, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
