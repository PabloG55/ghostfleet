// test/helpers/context-corpus.mjs <dir> — a corpus whose context report is known by hand.
//
// Every number `fleet-meter --context` prints for it can be worked out from this file:
//   five calls, one per bucket — one exactly ON the 200k edge, which is the upper bucket's —
//   on claude-opus-5-5 with only cache reads, so each costs its context x $0.20/MTok and
//   the shares are the contexts' shares;
//   one call written as two records (Claude Code repeats `usage` per content block) and the
//   same call again in a forked copy — still one call;
//   one call in a subagent transcript, on a model the price table does not know;
//   one prompt of each trigger, each followed by exactly one call, and one prompt followed
//   by none (an interrupt marker), which is not a turn;
//   one auto compaction from 812345 tokens.
// Every prompt carries SENTINEL, which no output may contain.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const SENTINEL = 'acme-api-secret-plan';
const proj = path.join(dir, '-work-acme-api');
fs.mkdirSync(path.join(proj, 'sess-1', 'subagents'), { recursive: true });

let n = 0;
const ts = (i) => `2026-11-0${i < 5 ? 1 : 3}T10:${String(i).padStart(2, '0')}:00Z`;
const user = (text, i) => ({ type: 'user', timestamp: ts(i), sessionId: 'sess-1', message: { role: 'user', content: text } });
const call = (ctx, i, { model = 'claude-opus-5-5', id = `msg_${++n}` } = {}) => ({
  type: 'assistant', timestamp: ts(i), sessionId: 'sess-1', requestId: `req_${id}`,
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: SENTINEL }],
             usage: { input_tokens: 0, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0, output_tokens: 0 } },
});

const rows = [
  user(`please look at ${SENTINEL}`, 0),                                         call(100_000, 0),
  user(`[fleet] w1 is done: ${SENTINEL}`, 1),                                    call(200_000, 1),
  user(`<task-notification>${SENTINEL}</task-notification>`, 2),                 call(400_000, 2),
  user(`The ghostfleet plugin sent a message: [ghostfleet ledger] ${SENTINEL}`, 3), call(600_000, 3),
  user('[Request interrupted by user]', 4),
  user(`<system-reminder>${SENTINEL}</system-reminder>and now ${SENTINEL}`, 5),  call(800_000, 5, { id: 'msg_dup' }),
];
rows.push(call(800_000, 5, { id: 'msg_dup' }));            // the same call's second content block
rows.push({ type: 'system', subtype: 'compact_boundary', timestamp: ts(6), compactMetadata: { trigger: 'auto', preTokens: 812345 } });
const lines = (rs) => rs.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n';
fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), lines(rows));
// a fork: a new file holding a copy of the parent's history, ids and all
fs.writeFileSync(path.join(proj, 'sess-2.jsonl'), lines([user(`again ${SENTINEL}`, 5), call(800_000, 5, { id: 'msg_dup' })]));
fs.writeFileSync(path.join(proj, 'sess-1', 'subagents', 'agent-1.jsonl'),
  lines([{ ...user(`subagent brief ${SENTINEL}`, 7), isSidechain: true }, { ...call(50_000, 7, { model: 'claude-unknown-9' }), isSidechain: true }]));
