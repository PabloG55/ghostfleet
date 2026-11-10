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
 const go = async (route, query = '') => {await b.call('Page.navigate',{url:`${server.base}/?screen=${route}-${Date.now()}&${query}#${route}`}); await until(()=>document.querySelector('.page') && !document.body.textContent.includes('Loading…'));await sleep(180);};
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
 await t.test('cards name their own state, including the connector with an empty server',async()=>{
  for (const route of ['signins','queue']) {
   await go(route);
   const cards = await b.evaluate(()=>[...document.querySelectorAll('.login-card')].map(card=>({id:card.dataset.login,pill:card.querySelector('.pill').textContent.trim(),meta:card.querySelector('p').textContent.trim()})));
   assert.ok(cards.length >= 4);
   assert.ok(cards.every(c=>c.pill === 'Needs you'), 'each pending authorization needs the owner');
   assert.equal(cards.find(c=>c.id==='connector').meta,'master · This host · toolbox');
   assert.ok(cards.every(c=>!/^·|·$|·\s*·/.test(c.meta)));
  }
  for (const route of ['held','queue']) {
   await go(route);
   assert.ok(await b.evaluate(()=>[...document.querySelectorAll('.extra-card .pill')].some(p=>p.textContent.trim()==='Held')));
   assert.equal(await b.evaluate(()=>[...document.querySelectorAll('.extra-card .pill')].filter(p=>p.textContent.trim()==='Held items').length),0);
  }
 });
 await t.test('expired and completed sign-ins show their real state',async()=>{
  await go('signins','expired=1');
  assert.equal(await b.evaluate(()=>document.querySelector('[data-login="expired"] .pill').textContent.trim()),'Expired');
  assert.equal(await b.evaluate(()=>document.querySelector('[data-login="expired"] input')),null);
  await b.evaluate(()=>{const card=document.querySelector('[data-login="mcp"]');card.querySelector('input').value='synthetic-callback';[...card.querySelectorAll('button')].find(b=>b.textContent.startsWith('Finish')).click();});
  await sleep(180);
  assert.equal(await b.evaluate(()=>document.querySelector('[data-login="mcp"] .pill').textContent.trim()),'Ready');
 });
 await t.test('team automations retain ownership UI only with the people flag',async()=>{
  await go('automations','people=1');await shows('Mine');await shows('Company');await shows("Others' personal");
  assert.ok(await b.evaluate(()=>document.querySelector('.autos-tabs') && document.querySelector('.auto-top .tag')?.textContent==='Personal'));
  await go('editor','people=1');assert.ok(await b.evaluate(()=>!!document.querySelector('.scope-pick')));
 });
 await t.test('singular review counts',async()=>{
  await go('reviews'); await shows('1 earlier run');
  assert.ok(!(await b.evaluate(()=>document.body.textContent)).includes('1 earlier runs'));
 });
 await t.test('shared review-note spacing',async()=>{
  await go('review');
  const gap=await b.evaluate(()=>{const step=document.querySelector('.review-step');return step.querySelector('.field').getBoundingClientRect().top-step.querySelector('.row').getBoundingClientRect().bottom;});
  assert.ok(gap >= 12, 'the verdict row and note use the shared 12px spacing');
 });
 await t.test('back links name the place rather than a route id',async()=>{
  for (const [route,name] of [['stack','Stacks'],['held','Queue'],['review','Reviews'],['editor','Automations']]) {
   await go(route); assert.equal(await b.evaluate(()=>document.querySelector('a.back-link').textContent.trim()),`← ${name}`);
  }
 });
 await t.test('automations without people have a back link and no ownership UI',async()=>{
  for (const route of ['automations','editor']) for (const language of ['en','es']) {
   await go(route,`lang=${language}`);
   const view=await b.evaluate(()=>({text:document.body.textContent,tabs:!!document.querySelector('.autos-tabs'),scope:!!document.querySelector('.scope-pick'),tags:document.querySelectorAll('.autos .tag,.autos-edit .tag').length,back:!!document.querySelector('a.back-link')}));
   assert.equal(view.tabs,false);assert.equal(view.scope,false);assert.equal(view.tags,0);assert.equal(view.back,true);
   assert.ok(!/\b(?:Mine|Company|Others|Personal|Company's|Mías|Empresa|Personales|Personal)\b/i.test(view.text),view.text);
  }
 });
 await t.test('search hides each empty section consistently',async()=>{
  await go('search');assert.deepEqual(await b.evaluate(()=>[...document.querySelectorAll('h2')].map(e=>e.textContent)),['Sessions']);
  await go('search','query=acme-web');assert.deepEqual(await b.evaluate(()=>[...document.querySelectorAll('h2')].map(e=>e.textContent)),['Projects']);
  await go('search','query=missing');assert.deepEqual(await b.evaluate(()=>[...document.querySelectorAll('h2')].map(e=>e.textContent)),[]);await shows('No matches');
 });
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
