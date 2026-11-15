// Demonstration data for the same screens; this never starts or reads a live session.
import fs from 'node:fs';
import path from 'node:path';
import { runState, cleanVerdict, serveFile } from '../../../lib/shots.mjs';
const fixtures = new URL('../../../web/fixtures/',import.meta.url).pathname;
const load = n => JSON.parse(fs.readFileSync(path.join(fixtures,n),'utf8'));
// What a demo person did to the waiting list: an explanation asked (fleet_ledger explain in
// demo.mjs), arriving after a pause as a session's turn would, and the items they answered.
export const demoLedger = { explain: new Map(), answered: new Set(), busy: new Set() };
const DEMO_EXPLAIN_MS = 2500;
function demoWaiting() {
  const nowS = Math.floor(Date.now() / 1000);
  return load('waiting.json').items.filter(i => !demoLedger.answered.has(`${i.project}#${i.id}`)).map(({ since_ago, at_ago, explain_demo, busy_demo, ...i }) => {
    if (busy_demo) demoLedger.busy.add(`${i.project}#${i.id}`);
    const row = { ...i, since: nowS - (Number(since_ago) || 0), at: nowS - (Number(at_ago) || 0) };
    const ex = demoLedger.explain.get(`${i.project}#${i.id}`);
    if (ex) row.explain = explain_demo && Date.now() - ex.askedAt >= DEMO_EXPLAIN_MS ? { ...ex, at: ex.askedAt + DEMO_EXPLAIN_MS, text: explain_demo } : ex;
    return row;
  });
}
export function createScreenDemo() {
  const ids = load('shots.json').runs, runs = new Map(ids.map(id => { const j = load(`shots-run-${id}.json`); return [id,{...j.run,at:new Date(Date.now()-(j.run.at_ago || 0)*1000).toISOString()}]; }));
  const get = id => { const r = runs.get(id); if(!r) throw Object.assign(new Error('No such run'),{status:404}); return r; };
  return {
    async waiting() { return {items:[...demoWaiting(),{project:'acme-web',session:'master',id:'held',state:'held',text:'The input box has unsent text'}]}; },
    async reviews() { return {groups:[...runs.values()].map(r => ({key:r.id,project:r.project,profile:r.profile,branch:r.branch,latest:{...r,steps:r.steps.length,state:runState(r,r.verdict || {})},earlier:[]}))}; },
    async review(profile,id) { const run = get(id); if(run.profile !== profile) throw Object.assign(new Error('No such run'),{status:404}); return {run:{...run,state:runState(run,run.verdict || {})}}; },
    async saveReview(b) { const r = get(b.run), c = cleanVerdict(r,b); if(!c.ok) throw Object.assign(new Error(c.error),{status:400}); r.verdict = c.out; return {ok:true,state:runState(r,c.out)}; },
    async media(req,res,profile,id,file) { const r = get(id); if(![r.video,...r.steps.map(s => s.file)].includes(file) || path.basename(file) !== file) throw Object.assign(new Error('No such media'),{status:404}); return serveFile(req,res,path.join(fixtures,'shots',file),file.endsWith('.mp4') ? 'video/mp4' : 'image/png'); },
    async pendingSignIns() { return {items:[]}; },
    async login() { return {ok:true}; },
  };
}
