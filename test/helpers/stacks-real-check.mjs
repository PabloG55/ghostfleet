// The committed phone client, with its real sidebar, skin and bundled fonts.
// Fixtures have no tmux: only the terminal capability/transport is stubbed, on the
// mounted adapter. Every other call still uses the phone's fixture backend.
import fs from 'node:fs';
import path from 'node:path';
import { launch, serveDir, sleep } from '../../lib/browser.mjs';
const WEB = new URL('../../web/', import.meta.url).pathname;
export async function realStackChecks(shots = '') {
  const rows = [], errors = [];
  const is = (name, want, got) => rows.push([name, JSON.stringify(want), JSON.stringify(got)].join('\x1f'));
  const server = await serveDir(WEB);
  let b;
  try {
    b = await launch({ width:1280, height:900, scale:2 });
    b.onEvent((m,p)=>{if(m==='Runtime.exceptionThrown') errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);});
    const until = async (fn,...args) => {
      for(let i=0;i<150;i++) { const r=await b.evaluate(fn,...args); if(r) return r; await sleep(100); }
      throw new Error('Real stack client did not settle');
    };
    const go = async hash => { await b.evaluate(h=>{location.hash=h;},hash); await sleep(200); };
    const shot = async name => {
      if(!shots) return;
      fs.mkdirSync(shots,{recursive:true});
      const {data}=await b.call('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(shots,name+'.png'),Buffer.from(data,'base64'));
    };
    await b.call('Page.navigate',{url:server.base+'/#/stack-picker'});
    await until(()=>[...document.querySelectorAll('.auth-card button')].some(n=>/without a passkey/i.test(n.textContent)));
    await b.evaluate(()=>[...document.querySelectorAll('.auth-card button')].find(n=>/without a passkey/i.test(n.textContent)).click());
    await until(()=>document.querySelectorAll('.stack-group').length>0);
    await b.evaluate(()=>document.fonts.ready.then(()=>0));
    await b.evaluate(()=>document.querySelector('.stack-group summary').click());
    await sleep(150);
    const compact=await b.evaluate(()=>{
      const row=document.querySelector('.stack-choice'), name=row.querySelector('.stack-name'), pill=row.querySelector('.pill'), branch=row.querySelector('.stack-branch');
      const n=name.getBoundingClientRect(),p=pill.getBoundingClientRect(),r=branch.getBoundingClientRect();
      return n.width<280 && p.left-n.right<=16 && r.left-p.right<=16 && getComputedStyle(branch).textAlign==='left';
    });
    is('real 1280 picker: name, pill and branch stay together',true,compact);
    await shot('1280-picker-open');
    await b.viewport(390,844);
    await b.evaluate(()=>document.querySelectorAll('.stack-group').forEach(g=>g.open=true));
    await sleep(100);
    await b.evaluate(()=>{const l=document.querySelector('.stack-list');l.scrollTop=l.scrollHeight;});
    await sleep(100);
    const pinned=await b.evaluate(()=>{
      const list=document.querySelector('.stack-list'), top=list.getBoundingClientRect().top;
      const summary=[...list.querySelectorAll('summary')].find(s=>Math.abs(s.getBoundingClientRect().top-top)<2);
      return !!summary && getComputedStyle(summary).position==='sticky' && getComputedStyle(summary).backgroundColor!=='rgba(0, 0, 0, 0)' && document.elementFromPoint(list.getBoundingClientRect().left+80,top+2)?.closest('summary')===summary;
    });
    is('real 390 picker: the project covers clipped rows at the list top',true,pinned);
    // Which text was clipped into a stray mark before the sticky summary covered it.
    const clipped=await b.evaluate(()=>{
      const l=document.querySelector('.stack-list').getBoundingClientRect(),out=[];
      for(const el of document.querySelectorAll('.stack-choice span')) {
        const r=el.getBoundingClientRect(); if(r.top<l.top && r.bottom>l.top) out.push({text:el.textContent,cls:el.className,visible:Math.round(r.bottom-l.top)});
      }
      return out;
    });
    if(shots) fs.writeFileSync(path.join(shots,'clipped-text.json'),JSON.stringify(clipped,null,2));
    await shot('390-picker-end');
    // Find the actual FleetProvider adapter without replacing any app markup or styles.
    await b.evaluate(()=>{
      const find=v=>{if(v?.props?.adapter?.grid)return v.props.adapter;for(const child of v?.__k || []){const r=find(child);if(r)return r;}return null;};
      const fleet=find(document.getElementById('app').__k);if(!fleet)throw new Error('No mounted phone adapter');
      fleet.canTerm=()=>true;
      fleet.termOpen=async(project,kind)=>({ticket:'fixture',session:'_'+kind+'-'+project});
      fleet.termSocket=()=>{const ws={readyState:0,send(){},close(){this.readyState=3;}};setTimeout(()=>{if(ws.readyState===3)return;ws.readyState=1;ws.onopen?.();for(const t of ['hello','ready'])ws.onmessage?.({data:JSON.stringify({t,session:'_term-acme-api'})});ws.onmessage?.({data:new TextEncoder().encode('Fixture terminal ready').buffer});},20);return ws;};
    });
    await b.viewport(1280,900);
    const members=[{project:'acme-api',session:'master'},{project:'acme-api',session:'types'},{project:'acme-api',session:'docs-pass'}];
    await go('#/stack/'+encodeURIComponent(JSON.stringify(members)));
    await until(()=>document.querySelectorAll('.stack-column .composer textarea').length===3);
    await b.evaluate(()=>document.querySelector('.stack-column .tool-tab').click());
    await until(()=>document.querySelector('.tool-host .xterm'));
    await sleep(200);
    const short=await b.evaluate(()=>[...document.querySelectorAll('.stack-column .composer textarea')].every(ta=>{
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d'),s=getComputedStyle(ta);ctx.font=s.font;
      return /^Write to [^\n]+…$/.test(ta.placeholder) && !/attach|drag/.test(ta.placeholder) && ctx.measureText(ta.placeholder).width<=ta.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight) && ta.rows===1;
    }));
    is('real 1280 stack: each composer has a short placeholder fitting one line',true,short);
    await shot('1280-stack-terminal');
    if(errors.length) throw new Error(errors.join('\n'));
  } finally {await b?.close();server.close();}
  return rows;
}
if(process.argv[1]===new URL(import.meta.url).pathname) console.log((await realStackChecks(process.argv[2])).join('\n'));
