// Shared stack screens, fixture adapter and real browser. Emits phone-check's US rows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './phone-screen-fixture.mjs';
import { launch, serveDir, sleep } from '../../lib/browser.mjs';
export async function stackChecks(shots = '') {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stacks-check-')), rows = [];
  const is = (name, want, got) => rows.push([name, JSON.stringify(want), JSON.stringify(got)].join('\x1f'));
  let server, b;
  try {
    server = await serveDir(await fixture(scratch));
    b = await launch({ width: 1280, height: 844 });
    const until = async (fn, ...args) => {
      for (let i=0;i<100;i++) { if (await b.evaluate(fn, ...args)) return true; await sleep(50); }
      return false;
    };
    const go = async route => {
      await b.call('Page.navigate', { url: server.base + '/?stacks=1&screen=' + Date.now() + '#' + route });
      await until(() => !!document.querySelector('.page,.session'));
      await sleep(300);
    };
    const shot = async name => { if (shots) { fs.mkdirSync(shots,{recursive:true}); const r=await b.call('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(shots,name+'.png'),Buffer.from(r.data,'base64')); } };
    for (const width of [390,1280]) {
      await b.viewport(width,844);
      await go('picker');
      is(width+' picker: groups start closed', true, await b.evaluate(() => {
        const groups=[...document.querySelectorAll('.stack-group')]; return groups.length===5 && groups.every(g=>!g.open);
      }));
      await shot(width+'-picker-closed');
      await b.evaluate(() => document.querySelector('.stack-group summary')?.click());
      await sleep(100);
      await shot(width+'-picker-open');
      // The legacy picker has no disclosure, so these selectors still inspect its actual rows.
      is(width+' picker: no last message in any row',false,await b.evaluate(()=>[...document.querySelectorAll('.stack-choice')].some(n=>n.textContent.includes('Ready for review'))));
      await b.evaluate(()=>document.querySelector('.stack-choice input')?.click()); await sleep(100);
      await b.evaluate(()=>document.querySelectorAll('.stack-group').forEach(g=>g.open=true));
      const rect=await b.evaluate(()=>document.querySelector('.page-head .btn').getBoundingClientRect().toJSON());
      await b.evaluate(()=>{
        const list=document.querySelector('.stack-list') || document.querySelector('.main');
        list.scrollTop=list.scrollHeight;
      }); await sleep(100);
      const end=await b.evaluate(()=>{
        const list=document.querySelector('.stack-list'), r=document.querySelector('.page-head .btn').getBoundingClientRect();
        return {top:r.top,bottom:r.bottom,page:document.scrollingElement.scrollTop,main:document.querySelector('.main').scrollTop,scrolled:!!list && list.scrollTop>0};
      });
      is(width+' picker: only list scrolls and Open stack stays pinned',true,end.scrolled && end.top===rect.top && end.bottom<=844 && end.top>=0 && end.page===0 && end.main===0);
      await shot(width+'-picker-end');
      await b.evaluate(()=>{const q=document.querySelector('input[type=search]');q.value='long last message';q.dispatchEvent(new Event('input',{bubbles:true}));}); await sleep(100);
      const noMessageMatch=await b.evaluate(()=>document.querySelectorAll('.stack-choice').length===0);
      await b.evaluate(()=>{const q=document.querySelector('input[type=search]');q.value='session-17';q.dispatchEvent(new Event('input',{bubbles:true}));}); await sleep(100);
      is(width+' picker: search opens matching groups and ignores messages',true,noMessageMatch && await b.evaluate(()=>{
        const groups=[...document.querySelectorAll('.stack-group')];
        return groups.length===5 && groups.every(g=>g.open && g.querySelectorAll('.stack-choice').length===1 && g.querySelector('summary').textContent.includes('18 sessions'));
      }));
    }
    await b.viewport(1280,844);
    await go('session');
    const status=await b.evaluate(()=>document.querySelector('.sess-title .pill').textContent.trim());
    await go('stack');
    is('desktop stack: no member tab bar',0,await b.evaluate(()=>document.querySelectorAll('.fleet-extra > .seg[role=tablist]').length));
    is('stack: status equals the session page',status,await b.evaluate(()=>document.querySelector('.stack-column .sess-title .pill').textContent.trim()));
    const hash=await b.evaluate(()=>location.hash);
    await b.evaluate(()=>document.querySelector('.stack-column .tool-tab')?.click());
    await until(()=>window.calls.some(c=>c[0]==='termSocket') && !!document.querySelector('.stack-column .tool-host .xterm'));
    await sleep(100);
    is('stack: Terminal stays in its column and keeps the hash',true,await b.evaluate(h=>location.hash===h && !!document.querySelector('.stack-column .tool.k-term'),hash));
    await shot('1280-stack-terminal');
    // Focus another column: the old socket must close; returning opens a fresh one.
    const before=await b.evaluate(()=>window.calls.filter(c=>c[0]==='termOpen').length);
    await b.evaluate(()=>document.querySelectorAll('.stack-column')[1]?.querySelector('.sess-tools button')?.focus()); await sleep(150);
    const paused=await b.evaluate(()=>window.calls.filter(c=>c[0]==='termClose').length);
    await b.evaluate(()=>document.querySelector('.stack-column > header button')?.focus());
    await until(n=>window.calls.filter(c=>c[0]==='termOpen').length>n,before);
    is('stack: quiet terminal pauses and resumes on focus',true,paused>0 && await b.evaluate(n=>window.calls.filter(c=>c[0]==='termOpen').length>n,before));
    await b.viewport(390,844); await sleep(200);
    await shot('390-stack-terminal');
    // Editor must follow the same local path as Terminal.
    await b.evaluate(()=>document.querySelectorAll('.stack-column.stack-active .tool-tab')[1]?.click()); await sleep(300);
    is('stack: Editor stays in its column and keeps the hash',true,await b.evaluate(h=>location.hash===h && !!document.querySelector('.stack-column .tool.k-edit'),hash));
  } finally { await b?.close(); server?.close(); fs.rmSync(scratch,{recursive:true,force:true}); }
  return rows;
}
if (process.argv[1] === new URL(import.meta.url).pathname) console.log((await stackChecks(process.argv[2])).join('\n'));
