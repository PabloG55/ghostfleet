// A disposable, adapter-backed page for shared-screen browser tests and photographs.
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function fixture(scratch) {
  const entry = path.join(scratch,'fixture.jsx'), site = path.join(scratch,'site');
  const imp = rel => JSON.stringify(path.join(ROOT,rel));
  fs.writeFileSync(entry, `
import {render} from 'preact';
import {useState,useEffect} from 'preact/hooks';
import ${imp('brand/tokens.css')};
import ${imp('web/ui/ui.css')};
import ${imp('web/ui/skin.css')};
import {FleetProvider} from ${imp('web/ui/adapter.jsx')};
import {go} from ${imp('web/ui/history.js')};
import {screenPlace} from ${imp('web/ui/phone-places.js')};
import {setLangSource} from ${imp('web/ui/i18n.js')};
const params = new URLSearchParams(location.search);
setLangSource(() => params.get('lang') || 'en');
import {Automations} from ${imp('web/ui/automations.jsx')};
import {ACTIONS as PHONE_ACTIONS, EVENTS as PHONE_EVENTS, STATES as PHONE_STATES} from ${imp('lib/automations-model.mjs')};
import {Reviews,Review} from ${imp('web/ui/reviews.jsx')};
import {SessionView} from ${imp('web/ui/session.jsx')};
import ${imp('web/ui/terminal.css')};
import {StackPicker,StackView} from ${imp('web/ui/stacks.jsx')};
import {Queue} from ${imp('web/ui/queue.jsx')};
import {Held} from ${imp('web/ui/held.jsx')};
import {Search} from ${imp('web/ui/search.jsx')};
import {SignIns} from ${imp('web/ui/sign-ins.jsx')};
window.calls=[]; window.consoleOutput=[];
for(const name of ['log','warn','error']) { const original=console[name]; console[name]=(...args)=>{window.consoleOutput.push(args.map(String)); original.apply(console,args);}; }
const log=(name,args=[])=>window.calls.push([name,...args]);
const card={name:'onboarding',status:'ready',branch:'docs-pass',msg:'Ready for review',lead:false};
const member={project:'acme-web',session:'onboarding'};
const stackProof=params.has('stacks');
const projects=['acme-web','acme-api','toolbox','billing-svc','scratch'];
const cards=()=>stackProof ? Array.from({length:18},(_,i)=>({...card,name:i ? 'session-'+i : 'onboarding',msg:'Ready for review: this long last message must never appear in the picker.'})) : [card];
const auto={id:'daily',name:'Daily check',scope:'personal',mine:true,editable:true,enabled:true,trigger:{type:'schedule',mode:'days',at:'10:00',days:[1,2,3,4,5]},steps:[{action:'send',project:'acme-web',session:'master',prompt:'Check the queue'}]};
const rows=[{id:1,project:'acme-web',session:'master',state:'waiting',text:'Choose the next task',reason:'Needs a decision'}, {id:'held',project:'acme-web',session:'master',state:'held',text:'The input box has unsent text',since:Date.now()/1000-600}];
const loginRows=[{id:'mcp',kind:'loopback',provider:'MCP provider',server:'toolbox',session:'onboarding',project:'acme-web@scratch',host:'scratch',authorize:'https://example.com/authorize',status:'pending',expires:Date.now()+600000,first_site:true}, {id:'account',kind:'account',provider:'Claude account',server:'Claude',session:'master',project:'acme-api',profile:'work',authorize:'https://example.com/authorize',status:'pending',expires:Date.now()+600000}, {id:'start',kind:'account',provider:'Claude account',server:'Claude',session:'master',project:'billing-svc',profile:'work',status:'needs-login'}, {id:'connector',kind:'connector',provider:'Connector',connector:'toolbox',session:'master',project:'toolbox',status:'pending',authorize:'https://example.com/settings'}];
if (params.has('expired')) loginRows.push({...loginRows[0],id:'expired',provider:'Expired MCP provider',expires:Date.now()-1000});
const pixel='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#11171f"/><text x="70" y="120" fill="#5fd7d7" font-size="42" font-family="monospace">acme-web</text><text x="70" y="200" fill="#b2becb" font-size="26" font-family="monospace">A recorded page ready for review</text></svg>');
const summary={id:'run',commit:'47147a4',at:new Date().toISOString(),state:{cls:'warn',label:'unreviewed'},steps:2,kind:'stills'};
const runs={run:{id:'run',project:'acme-web',branch:'docs-pass',kind:'stills',steps:[{n:1,name:'Open project',src:pixel,url:'https://acme-web.example',notes:[]},{n:2,name:'Open session',src:pixel,notes:['Check the heading']}],verdict:{},provenance:{commit:'47147a4'}}, video:{id:'video',project:'acme-web',branch:'docs-pass',kind:'recorded',videoSrc:'./flow.mp4',steps:[{n:1,name:'Open project',start:0,notes:[]}],verdict:{},provenance:{commit:'47147a4'}}};
const adapter={
 hasPeople:params.get('people') === '1',
 go(to){log('go',[to]);go(to);},slots:{},place:screenPlace,
 screenProjects:async()=>{log('screenProjects');return {projects:(stackProof ? projects : ['acme-web']).map(name=>({name,host:'This host',sessions:{total:stackProof ? 18 : 1}}))};},
 grid:async project=>{log('grid',[project]);return {cards:cards()};},
 session:async(project,name)=>{log('session',[project,name]);return {messages:[{role:'user',text:'Check the queue',ts:Date.now()/1000}],...(stackProof ? {} : {status:'ready'})};},
 pane:async(project,name)=>{log('pane',[project,name]);return {pane:'Ready for the next task'};},
 canTerm:()=>stackProof,
 termOpen:async(project,kind)=>{log('termOpen',[project,kind]);return {ticket:'fixture',session:'_'+kind+'-'+project};},
 termSocket:()=>{log('termSocket');const ws={readyState:0,send(){},close(){log('termClose');this.readyState=3;}};setTimeout(()=>{ws.readyState=1;ws.onopen?.();ws.onmessage?.({data:JSON.stringify({t:'hello',session:'_term-acme-web'})});ws.onmessage?.({data:JSON.stringify({t:'ready'})});ws.onmessage?.({data:new TextEncoder().encode('Fixture terminal ready').buffer});},30);return ws;},
 act:async(tool,args)=>{log('act',[tool,args]);return {text:'Sent'};},lead:async project=>{log('lead',[project]);return {session:'master'};},
 waiting:async()=>{log('waiting');return {items:rows};},pendingSignIns:async()=>{log('pendingSignIns');return {items:loginRows};},
 startAccountLogin:async(...args)=>{log('startAccountLogin',args);return {ok:true};},
 finishLogin:async(project,id,secret)=>{log('finishLogin',[project,id]);if(window.failLogin)throw new Error(secret);return {ok:true,text:secret};},
 finishAccountLogin:async(project,id,secret)=>{log('finishAccountLogin',[project,id]);if(window.failLogin)throw new Error(secret);return {ok:true,text:secret};},
 reviews:async()=>{log('reviews');return {groups:[{key:'branch',project:'acme-web',branch:'docs-pass',profile:'work',host:'scratch',host_key:'scratch',latest:summary,earlier:[{...summary,id:'earlier'}]}]};},
 review:async(profile,id,host)=>{log('review',[profile,id,host]);return {run:runs[id] || runs.run};},saveReview:async body=>{log('saveReview',[body]);return {ok:true};},
 automations:async()=>{log('automations');return {automations:[auto],me:{admin:true,projects:['acme-web']},capabilities:params.get('people') === '1' ? undefined : {actions:Object.keys(PHONE_ACTIONS),events:Object.keys(PHONE_EVENTS),states:PHONE_STATES,scopes:['personal']},runs:[],notices:[]};},
 saveAutomation:async a=>{log('saveAutomation',[a]);return {automation:a};},runAutomation:async id=>{log('runAutomation',[id]);return {ok:true};},
 deleteAutomation:async id=>{log('deleteAutomation',[id]);return {ok:true};},automationAI:async(...args)=>{log('automationAI',args);return {reply:'Draft ready',automation:auto};},
};
function App(){const [route,setRoute]=useState(location.hash.slice(1)||'queue');useEffect(()=>{const h=()=>setRoute(location.hash.slice(1));addEventListener('hashchange',h);return()=>removeEventListener('hashchange',h);},[]);
const screens={automations:<Automations projects={[{name:'acme-web',sessions:[{name:'master',lead:true}]}]}/>,editor:<Automations id="new" projects={[{name:'acme-web',sessions:[{name:'master',lead:true}]}]}/>,reviews:<Reviews/>,review:<Review host="scratch" profile="work" run="run"/>,video:<Review profile="work" run="video"/>,picker:<StackPicker/>,session:<SessionView project={member.project} name={member.session} card={card} onChanged={()=>{}} onGone={()=>{}}/>,stack:<StackView members={stackProof ? [member,{project:'acme-api',session:'onboarding'},{project:'toolbox',session:'onboarding'}] : [member,{project:'acme-api',session:'master'}]}/>,queue:<Queue/>,held:<Held/>,search:<Search query={params.get('query') || 'onboarding'}/>,signins:<SignIns/>};
const screen=screens[route]||<p id="destination">{route}</p>;return <FleetProvider adapter={adapter}>{stackProof ? <div class="app"><header class="topbar">ghostfleet</header><aside class="side"/><main class="main">{screen}</main></div> : screen}</FleetProvider>;}
render(<App/>,document.getElementById('app'));
`);
  await build({plugins:[{name:'fixture-terminal',enforce:'pre',resolveId(source){if(source==='../term.js')return {id:source,external:true};}}],configFile:false,root:ROOT,logLevel:'error',resolve:{dedupe:['preact']},esbuild:{jsx:'automatic',jsxImportSource:'preact'},build:{outDir:site,emptyOutDir:true,minify:false,lib:{entry,formats:['es'],fileName:()=> 'fixture.js'},rollupOptions:{output:{paths:{'../term.js':'./term.js'},assetFileNames:'[name][extname]'}}}});
  for(const name of ['term.js','xterm.js','xterm-fit.js','xterm.css']) fs.copyFileSync(path.join(ROOT,'web',name),path.join(site,name));
  fs.copyFileSync(path.join(ROOT,'web/fixtures/shots/flow.mp4'),path.join(site,'flow.mp4'));
  const js = fs.readdirSync(site).find(n => /^fixture\..*js$/.test(n));
  const css = fs.readdirSync(site).filter(n => n.endsWith('.css'));
  fs.writeFileSync(path.join(site,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shared fleet screens</title><link rel="stylesheet" href="./xterm.css">${css.map(n=>`<link rel="stylesheet" href="./${n}">`).join('')}<body><main id="app"></main><script type="module" src="./${js}"></script></body></html>`);
  return site;
}
