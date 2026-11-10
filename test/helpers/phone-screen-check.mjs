// node --test test/helpers/phone-screen-check.mjs — each screen uses a stub useFleet adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './phone-screen-fixture.mjs';
import { launch, serveDir, sleep } from '../../lib/browser.mjs';
test('shared phone screens render and call their adapters', {timeout:120000}, async t => {
 const scratch = fs.mkdtempSync(path.join(os.tmpdir(),'phone-screen-test-'));
 t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
 const site = await fixture(scratch), server = await serveDir(site); t.after(()=>server.close());
 const b = await launch({width:390,height:844}); t.after(()=>b.close());
 const until = async fn => { for(let i=0;i<80;i++) {if(await b.evaluate(fn)) return;await sleep(50);} assert.fail('Screen did not settle'); };
 const go = async route => {await b.call('Page.navigate',{url:`${server.base}/?screen=${route}-${Date.now()}#${route}`}); await until(()=>document.querySelector('.page') && !document.body.textContent.includes('Loading…'));await sleep(180);};
 const shows = async text => assert.ok((await b.evaluate(()=>document.body.textContent)).includes(text),text);
 const called = async (member,args=[]) => assert.ok(await b.evaluate((name,args)=>window.calls.some(c=>c[0] === name && JSON.stringify(c.slice(1,args.length+1)) === JSON.stringify(args)),member,args),`${member} ${JSON.stringify(args)}`);
 const clickText = async text => {const clicked = await b.evaluate(text=>{const el=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===text);if(!el)return false;el.click();return true;},text);assert.ok(clicked,`button ${text}`);await sleep(150);};
 for(const [route,label,member] of [['automations','Daily check','automations'],['editor','Triggers','automations'],['reviews','docs-pass','reviews'],['review','Open project','review'],['picker','onboarding','grid'],['stack','onboarding','session'],['queue','Choose the next task','waiting'],['held','unsent text','waiting'],['search','onboarding','grid'],['signins','MCP provider','pendingSignIns']]) {
  await t.test(route,async()=>{
   await go(route); await shows(label); await called(member,route === 'stack' ? ['acme-web','onboarding'] : []);
   assert.equal(await b.evaluate(()=>document.querySelectorAll('select').length),0);
   assert.ok(await b.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),`${route} overflow`);
   if(route==='automations') {await clickText('Try now');await called('runAutomation',['daily']);}
   if(route==='editor') {await clickText('Send a prompt');assert.ok(await b.evaluate(()=>!!document.querySelector('.node.step textarea')));}
   if(route==='reviews') {await b.evaluate(()=>document.querySelector('.extra-card').click());await called('go',['/reviews/scratch/work/run']);}
   if(route==='review') {await clickText('OK');await called('saveReview');const body=await b.evaluate(()=>window.calls.find(c=>c[0]==='saveReview')[1]);assert.equal(body.host,'scratch');assert.equal(body.state[1].v,'ok');}
   if(route==='picker') {await b.evaluate(()=>document.querySelector('input[type=checkbox]').click());await clickText('Open stack · 1');const routes=await b.evaluate(()=>window.calls.filter(c=>c[0]==='go').map(c=>c[1]));assert.ok(routes.some(r=>r.startsWith('/stack/')&&decodeURIComponent(r).includes('onboarding')));}
   if(route==='stack') {await clickText('Open session');await called('go',['/p/acme-web/s/onboarding']);}
   if(route==='queue') {await clickText('Reply');await b.evaluate(()=>{const e=document.querySelector('textarea');e.value='Please continue';e.dispatchEvent(new Event('input',{bubbles:true}));});await sleep(80);await clickText('Send');await called('act');const call=await b.evaluate(()=>window.calls.find(c=>c[0]==='act'));assert.equal(call[1],'fleet_send');assert.equal(call[2].session,'master');assert.match(call[2].prompt,/Re your ledger item 1: "Choose the next task"\n\nPlease continue/);}
   if(route==='held') {await clickText('Open the input box');await called('go',['/p/acme-web/s/master']);}
   if(route==='search') {await b.evaluate(()=>document.querySelector('.extra-card').click());await called('go',['/p/acme-web/s/onboarding']);}
  });
 }
 await t.test('recorded review verdict and chapter',async()=>{await go('video');await clickText('Approve');await called('saveReview');assert.equal(await b.evaluate(()=>window.calls.find(c=>c[0]==='saveReview')[1].flow.v),'approve');await shows('Go to chapter');});
 await t.test('both sign-in secrets stay out of hooks, storage, console, toasts and error messages',async()=>{
  for(const [id,method] of [['mcp','finishLogin'],['account','finishAccountLogin']]) for(const failure of [false,true]) {
   await go('signins');
   const secret=`synthetic-secret-${id}-${failure}`;
   await b.evaluate((id,secret,failure)=>{window.failLogin=failure;const input=document.querySelector(`[data-login="${id}"] input`);input.value=secret;const card=input.closest('article');[...card.querySelectorAll('button')].find(b=>b.textContent.startsWith('Finish')).click();window.inputClearedBeforeAwait=input.value === '';},id,secret,failure);
   await sleep(180);await called(method);
   const result=await b.evaluate(()=>({cleared:window.inputClearedBeforeAwait,text:document.body.textContent,logs:window.consoleOutput,local:{...localStorage},session:{...sessionStorage},history:history.state,calls:window.calls,hooks:(()=>{const out=[],seen=new Set();const visit=v=>{if(!v||seen.has(v))return;seen.add(v);for(const h of v.__c?.__H?.__ || []) {const val=h.__?.[0];if(val!==undefined && typeof val!=='function')out.push(val);}for(const child of v.__k || [])visit(child);};visit(document.getElementById('app').__k);return out;})()}));
   // Preact's tree is cyclic; inspect its hook values separately, without serializing DOM.
   assert.equal(result.cleared,true);
   assert.ok(result.hooks.length > 0, 'inspected the mounted hook state');
   assert.ok(!JSON.stringify(result).includes(secret));
  }
 });
});
