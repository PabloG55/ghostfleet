// Permissions for the screens are checked here, independently of the source of their data.
import { can, denial, isAdmin } from './access.mjs';
const fail = (status,text) => { throw Object.assign(new Error(text),{status}); };
const publicLogin = r => Object.fromEntries(['id','kind','provider','server','session','project','host','host_key','status','profile','sock','connector','authorize','expires','first_site'].filter(k => r[k] !== undefined).map(k => [k,r[k]]));
export function createScreenRoutes({ source, body, send, audit }) {
  return async (req,res,url,me) => {
    const p = url.pathname, q = k => url.searchParams.get(k) || '';
    const known = ['/api/waiting','/api/shots','/api/shots/run','/api/shots/media','/api/shots/verdict','/api/logins','/api/logins/start','/api/logins/finish','/api/logins/account'];
    if(!known.includes(p)) return false;
    const guard = (project,action) => { const no = denial(me,project,action); if(no) fail(no.status,no.status === 404 ? 'No such run' : no.text); };
    // Sign-in arguments and exceptions never enter perform(), the activity log, or the
    // server's outer exception logger. Both authentication and admin checks precede parsing.
    if(p.startsWith('/api/logins')) {
      if(!isAdmin(me)) fail(404,'No such endpoint');
      if(p === '/api/logins' && req.method === 'GET') {
        try { const j = await source.pendingSignIns(me); send(res,200,{ok:true,items:(j.items || []).map(publicLogin),missing:j.missing || []}); }
        catch { send(res,503,{ok:false,text:'Could not read sign-ins'}); }
        return true;
      }
      if(req.method !== 'POST' || p === '/api/logins') fail(405,'POST only');
      let b;
      try {
        b = await body(req);
        const args = {project:b.project,id:b.id,session:b.session,sock:b.sock,...(p.endsWith('/account') ? {code:b.code} : p.endsWith('/finish') ? {callback:b.callback} : {})};
        const r = await source.login(p.endsWith('/start') ? 'start' : p.endsWith('/account') ? 'account' : 'mcp',args,me);
        send(res,200,{ok:r.ok === true,text:r.ok ? 'Sign-in complete' : 'Sign-in could not be completed'});
      } catch { send(res,400,{ok:false,text:'Sign-in could not be completed'}); }
      finally { if(b) { b.code = ''; b.callback = ''; } }
      return true;
    }
    if(p === '/api/waiting') {
      if(req.method !== 'GET') fail(405,'GET only');
      const j = await source.waiting(); send(res,200,{ok:true,items:(j.items || []).filter(r => can(me,r.project,'read'))}); return true;
    }
    if(p === '/api/shots') {
      if(req.method !== 'GET') fail(405,'GET only');
      const j = await source.reviews(), groups = (j.groups || []).filter(g => can(me,g.project,'read'));
      const profiles = [...new Set(groups.map(g => g.profile))];
      send(res,200,{ok:true,groups,profiles,multi:profiles.length > 1,waiting:groups.filter(g => g.waiting).length}); return true;
    }
    if(p === '/api/shots/verdict') {
      if(req.method !== 'POST') fail(405,'POST only');
      const b = await body(req);
      if(b.host) fail(400,'Remote review is not available');
      const j = await source.review(b.profile,b.run); guard(j.run.project,'prompt');
      const r = await source.saveReview(b);
      audit({user:me.id,verb:'shots_verdict',project:j.run.project,subject:String(b.run).slice(0,200),result:'ran'});
      send(res,200,r); return true;
    }
    if(req.method !== 'GET' && !(p === '/api/shots/media' && req.method === 'HEAD')) fail(405,'GET only');
    if(q('host')) fail(404,'No such run');
    const j = await source.review(q('profile'),q('run')); guard(j.run.project,'read');
    if(p === '/api/shots/media') { await source.media(req,res,q('profile'),q('run'),q('file')); return true; }
    send(res,200,{ok:true,...j}); return true;
  };
}
