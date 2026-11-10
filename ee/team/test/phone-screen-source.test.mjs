import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createScreenSource } from '../server/screen-source.mjs';
function setup(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(),'screen-source-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const p = {name:'acme-web',path:path.join(root,'acme-web'),cfg:root,profile:'work',sock:'cf-acme-web'};
 const dir = path.join(root,'fleet'), runDir=path.join(dir,'shots','run');fs.mkdirSync(runDir,{recursive:true});fs.mkdirSync(p.path);
 const manifest={provenance:{repo:p.path,branch:'docs-pass',at:new Date().toISOString()},steps:[{n:1,name:'Open',file:'page.png',notes:[]}]};
 fs.writeFileSync(path.join(runDir,'manifest.json'),JSON.stringify(manifest));fs.writeFileSync(path.join(runDir,'page.png'),'fixture');
 return {root,p,dir,runDir,source:createScreenSource({configs:()=>[p]})};
}
test('real review source resolves a registered project and writes a core-compatible verdict',async t=>{
 const r=setup(t), j=await r.source.reviews();assert.equal(j.groups[0].project,'acme-web');
 const v=await r.source.saveReview({profile:'work',run:'run',state:{1:{v:'ok'}}});assert.equal(v.state.cls,'ok');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.runDir,'verdict.json'))),{'1':{v:'ok',note:''}});
 assert.equal((await r.source.review('work','run')).run.project,'acme-web');
 await assert.rejects(r.source.review('work','../run'),e=>e.status===404);
 fs.writeFileSync(path.join(r.runDir,'manifest.json'),JSON.stringify({provenance:{repo:path.join(r.root,'unregistered','acme-web')},steps:[]}));
 await assert.rejects(r.source.review('work','run'),e=>e.status===404);
 assert.deepEqual((await r.source.reviews()).groups,[],'an unregistered repo with a granted project basename is hidden');
});
test('held wakes target the lead or sublead and ignore stale markers',async t=>{
 const r=setup(t), since=Math.floor(Date.now()/1000)-20;
 fs.writeFileSync(path.join(r.dir,`${r.p.sock}.notify.blocked`),`${since}\x1f1\x1fmaster\n`);
 fs.writeFileSync(path.join(r.dir,`${r.p.sock}.onboarding.needyou.blocked`),`${since}\x1f0\x1fonboarding\n`);
 fs.writeFileSync(path.join(r.dir,`${r.p.sock}.unknown.blocked`),`${since}\x1f1\n`);
 const j=await r.source.waiting();assert.deepEqual(j.items.map(i=>i.session).sort(),['master','onboarding']);
 for(const n of fs.readdirSync(r.dir).filter(n=>n.endsWith('.blocked')))fs.utimesSync(path.join(r.dir,n),1,1);
 assert.deepEqual((await r.source.waiting()).items,[]);
});
test('MCP callback reaches only its recorded loopback listener and never its stored record',async t=>{
 const r=setup(t), secret='synthetic-private-code';let received='';
 const server=http.createServer((req,res)=>{received=req.url;res.end('ok');});await new Promise(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>server.close());
 const loginDir=path.join(r.dir,'logins');fs.mkdirSync(loginDir);const id='a'.repeat(32), file=path.join(loginDir,`${id}.json`);
 fs.writeFileSync(file,JSON.stringify({id,project:'acme-web',sock:r.p.sock,kind:'loopback',state:'fixture-state',port:server.address().port,path:'/callback',expires:Date.now()+60000}));
 const args={project:'acme-web',id,callback:`http://localhost:${server.address().port}/callback?state=fixture-state&code=${secret}`};
 assert.equal((await r.source.login('mcp',args,{id:'admin'})).ok,true);assert.ok(received.includes(secret));assert.equal(args.callback,'');
 assert.ok(!fs.readFileSync(file,'utf8').includes(secret));assert.ok(!(await r.source.pendingSignIns({id:'admin'})).items.some(row=>JSON.stringify(row).includes(secret)));
});
test('paired-host login forwards its bare project only in the request and clears its secret',async t=>{
 const r=setup(t);let request;
 const source=createScreenSource({configs:()=>[r.p],peerList:()=>[{key:'scratch',label:'scratch'}],requestPeer:async(peer,opts)=>{request={peer:peer.key,body:JSON.parse(JSON.stringify(opts.body)),onBehalf:opts.onBehalf};return {status:200,json:{ok:true,text:'ignored'}};}});
 const args={project:'acme-web@scratch',id:'pending',code:'synthetic-code'};
 assert.deepEqual(await source.login('account',args,{id:'admin'}),{ok:true});assert.equal(request.peer,'scratch');assert.equal(request.body.args.project,'acme-web');assert.equal(request.body.tool,'fleet_account_login_finish');assert.equal(request.body.args.code,'synthetic-code');assert.equal(args.code,'');
});
