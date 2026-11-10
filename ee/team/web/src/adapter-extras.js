// Additional useFleet members, over the team server's cookie and project permissions.
import { lang } from './i18n.js';
const qs = value => new URLSearchParams(Object.entries(value).filter(([,v]) => v != null && v !== '')).toString();
async function call(method,path,body) {
  const r = await fetch(path,{method,credentials:'same-origin',headers:{'X-GFW':'1','X-GFW-Lang':lang(),...(body ? {'Content-Type':'application/json'} : {})},body:body ? JSON.stringify(body) : undefined});
  const j = await r.json();
  if(!r.ok || j.ok === false) throw Object.assign(new Error(j.text || `HTTP ${r.status}`),{status:r.status});
  return j;
}
// Login errors deliberately discard network and server text. They may echo input.
async function login(kind,args) {
  try { const r = await call('POST',`/api/logins/${kind}`,args); return {ok:r.ok === true}; }
  catch { return {ok:false}; }
  finally { args.code = ''; args.callback = ''; }
}
export function teamScreenExtras(ctx) {
  return {
    screenProjects:async () => { const j = await call('GET','/api/projects'); return {...j,projects:j.projects.map(p => ({...p,canPrompt:ctx.me?.role === 'admin' || ['member','admin'].includes(ctx.me?.projects?.[p.name])}))}; },
    waiting:() => call('GET','/api/waiting'),
    reviews:() => call('GET','/api/shots'),
    async review(profile,run,host = '') {
      const j = await call('GET',`/api/shots/run?${qs({profile,run,host})}`);
      const src = file => file ? `/api/shots/media?${qs({profile,run,host,file})}` : null;
      return {...j,run:{...j.run,videoSrc:src(j.run.video),steps:j.run.steps.map(s => ({...s,src:src(s.file)}))}};
    },
    saveReview:body => call('POST','/api/shots/verdict',body),
    pendingSignIns:() => ctx.me?.role === 'admin' ? call('GET','/api/logins') : Promise.resolve({items:[]}),
    startAccountLogin:(project,session,sock) => login('start',{project,session,sock}),
    finishLogin:(project,id,callback) => login('finish',{project,id,callback}),
    finishAccountLogin:(project,id,code) => login('account',{project,id,code}),
  };
}
