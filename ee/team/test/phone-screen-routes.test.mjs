import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenRoutes } from '../server/screen-routes.mjs';
const users = {viewer:{id:'viewer',role:'member',projects:{'acme-web':'viewer'}},member:{id:'member',role:'member',projects:{'acme-web':'member'}},admin:{id:'admin',role:'admin',projects:{}}};
function rig() {
  const calls = [], audits = [];
  const source = {
    waiting:async () => ({items:[{project:'acme-web',id:1},{project:'billing-svc',id:2}]}),
    reviews:async () => ({groups:[{project:'acme-web',profile:'work'},{project:'billing-svc',profile:'work'}]}),
    review:async (profile,id) => ({run:{project:id === 'private' ? 'billing-svc' : 'acme-web',profile,id}}),
    saveReview:async b => { calls.push(['save',b]); return {ok:true}; },
    media:async () => { calls.push(['media']); },
    pendingSignIns:async () => ({items:[{id:'pending',project:'acme-web',provider:'MCP',state:'hidden',code:'hidden',callback:'hidden',file:'hidden'}]}),
    login:async (kind,args) => { calls.push(['login',kind,args.project]); return {ok:true,text:args.code || args.callback}; },
  };
  const route = createScreenRoutes({source,body:async req => JSON.parse(req.raw || '{}'),send:(res,status,body) => Object.assign(res,{status,body}),audit:r => audits.push(r)});
  const call = async (role,method,path,b) => {
    const res = {};
    try { await route({method,raw:JSON.stringify(b)},res,new URL(path,'http://localhost'),users[role]); }
    catch(e) { Object.assign(res,{status:e.status || 500,body:{text:e.message}}); }
    return res;
  };
  return {call,calls,audits,source};
}
for(const path of ['/api/waiting','/api/shots']) test(`${path}: viewers and members read only their projects; admin reads all`,async () => {
  const r = rig(), key = path.endsWith('waiting') ? 'items' : 'groups';
  for(const role of ['viewer','member','admin']) {
    const res = await r.call(role,'GET',path);
    assert.equal(res.status,200); assert.deepEqual(res.body[key].map(x => x.project),role === 'admin' ? ['acme-web','billing-svc'] : ['acme-web']);
  }
});
for(const endpoint of ['run','media']) test(`/api/shots/${endpoint}: project read permission also covers media`,async () => {
  const r = rig();
  for(const role of ['viewer','member','admin']) {
    const res = await r.call(role,'GET',`/api/shots/${endpoint}?profile=work&run=own&file=page.png`);
    assert.equal(endpoint === 'media' ? r.calls.at(-1)[0] : res.status,endpoint === 'media' ? 'media' : 200);
    const privateRun = await r.call(role,'GET',`/api/shots/${endpoint}?profile=work&run=private&file=page.png`);
    if(role !== 'admin') { assert.equal(privateRun.status,404); assert.ok(!JSON.stringify(privateRun).includes('billing-svc')); }
    else if(endpoint === 'run') assert.equal(privateRun.status,200);
  }
});
test('/api/shots/verdict: viewer refused; member acts on own project; admin acts everywhere',async () => {
  const r = rig(), b = {profile:'work',run:'own',state:{1:{v:'ok'}}};
  assert.equal((await r.call('viewer','POST','/api/shots/verdict',b)).status,403);
  assert.equal(r.calls.length,0);
  assert.equal((await r.call('member','POST','/api/shots/verdict',b)).status,200);
  assert.equal((await r.call('member','POST','/api/shots/verdict',{...b,run:'private'})).status,404);
  assert.equal((await r.call('admin','POST','/api/shots/verdict',{...b,run:'private'})).status,200);
  assert.equal(r.audits.length,2);
});
for(const endpoint of ['','/start','/finish','/account']) test(`/api/logins${endpoint}: admin only, including before parsing the secret`,async () => {
  const r = rig(), method = endpoint ? 'POST' : 'GET';
  for(const role of ['viewer','member']) assert.equal((await r.call(role,method,`/api/logins${endpoint}`,{project:'acme-web',code:'synthetic-code'})).status,404);
  assert.equal(r.calls.length,0);
  const res = await r.call('admin',method,`/api/logins${endpoint}`,{project:'acme-web',code:'synthetic-code',callback:'http://localhost/?code=synthetic-code'});
  assert.equal(res.status,200);
  assert.ok(!JSON.stringify(res).includes('synthetic-code'));
  assert.ok(!JSON.stringify(res).includes('hidden'));
  assert.deepEqual(r.audits,[]);
});
test('sign-in failures cannot echo secrets into logs, audit, responses or persistent state',async () => {
  const r = rig(), output = [], saved = [], secret = 'synthetic-private-callback';
  const prior = ['log','warn','error'].map(k => [k,console[k]]);
  for(const [k] of prior) console[k] = (...args) => output.push(args);
  r.source.login = async (kind,args) => { throw new Error(args.code || args.callback); };
  try {
    for(const endpoint of ['finish','account']) {
      const res = await r.call('admin','POST',`/api/logins/${endpoint}`,{project:'acme-web',callback:secret,code:secret});
      saved.push(res);
    }
  } finally { for(const [k,fn] of prior) console[k] = fn; }
  assert.ok(!JSON.stringify([output,r.audits,saved,r.calls]).includes(secret));
});
test('every read rejects writes and verdicts reject reads',async () => {
 const r = rig();
 for(const p of ['/api/waiting','/api/shots','/api/shots/run','/api/shots/media','/api/logins']) assert.equal((await r.call('admin','POST',p,{})).status,405);
 assert.equal((await r.call('admin','GET','/api/shots/verdict')).status,405);
});
