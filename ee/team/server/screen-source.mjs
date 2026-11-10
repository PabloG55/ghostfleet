// The shared screens read the core's own formats. No live fleet is contacted at import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as shots from '../../../lib/shots.mjs';
import { fleetDirs, masterRecords } from '../../../lib/fleet-scan.mjs';
import { ledgerFile, parseLedger, heldItems } from '../../../mods/ghostfleet/hooks/ledger.js';
import { loginList, loginRecords, finishLogin } from '../../../lib/logins.mjs';
import { startAccountLogin, finishAccountLogin } from '../../../lib/account-logins.mjs';
import * as peers from '../../../lib/peers.mjs';
import { GF_HOME } from './paths.mjs';
const absent = () => { throw Object.assign(new Error('No such run'), { status:404 }); };
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
function registeredProject(repo,list) {
  if(!repo) return null;
  const names = new Map(list.map(t => [path.resolve(t.path),t.name]));
  const direct = names.get(path.resolve(repo)); if(direct) return direct;
  const git = /^gitdir:\s*(.+)$/m.exec(read(path.join(repo,'.git')));
  const main = git && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(git[1].trim());
  return main ? names.get(path.resolve(main[1])) || null : null;
}

export function createScreenSource({ configs, peerList = () => [], requestPeer = peers.peerRequest }) {
  const roots = list => [...new Map(list.map(t => [t.profile || 'work', {profile:t.profile || 'work',root:path.join(t.cfg,'fleet','shots')}])).values()];
  const locate = (profile, id) => {
    const list = configs(), rs = roots(list), loc = shots.runDir(rs, profile, id), m = loc && shots.readManifest(loc.dir);
    if(!m) return absent();
    const project = registeredProject(m.provenance?.repo,list);
    if(!project) return absent();
    return { ...loc, m, project };
  };
  let chain = Promise.resolve();
  return {
    async waiting() {
      const list = configs(), bySock = new Map(list.map(t => [t.sock,t])), dirs = fleetDirs(list), items = [];
      for(const m of masterRecords(dirs)) {
        const t = bySock.get(m.sock); if(!t) continue;
        for(const i of heldItems(parseLedger(read(ledgerFile(m.dir,m.sessionId))),Date.now())) items.push({project:t.name,profile:t.profile,session:'master',...i,at:Math.floor(i.at/1000),since:Math.floor(i.since/1000)});
      }
      const held = new Map();
      for(const t of list) {
        const dir = path.join(t.cfg,'fleet'); let names = []; try { names = fs.readdirSync(dir); } catch {}
        for(const n of names) {
          if(!n.startsWith(`${t.sock}.`) || !n.endsWith('.blocked')) continue;
          const f = path.join(dir,n); let stat; try { stat = fs.statSync(f); } catch { continue; }
          if(Date.now()-stat.mtimeMs > 120000) continue;
          const [since,why] = read(f).split('\n')[0].split('\x1f'); if(!Number(since)) continue;
          const socket = list.map(p => p.sock).filter(sock => n.startsWith(`${sock}.`)).sort((a,b) => b.length-a.length)[0];
          if(socket !== t.sock) continue;
          const kind = n.slice(t.sock.length+1,-8);
          const session = ['notify','jarvis','needyou'].includes(kind) ? 'master' : /\.(notify|needyou)$/.test(kind) ? kind.replace(/\.(notify|needyou)$/, '') : null;
          if(!session) continue;
          const key = `${t.sock}/${session}`;
          if(held.has(key) && held.get(key).since <= Number(since)) continue;
          held.set(key,{project:t.name,profile:t.profile,session,id:'held',state:'held',since:Number(since),text:why === '1' ? `${session}'s input box has unsent text` : `${session} shows no input box`,reason:'A fleet wake is waiting for the input box to be empty.'});
        }
      }
      return {items:[...held.values(),...items]};
    },
    async reviews() {
      const list = configs(), rs = roots(list);
      const groups = shots.groups(rs,list).flatMap(g => {
        const runs = [g.latest,...g.earlier].filter(r => {
          const loc = shots.runDir(rs,g.profile,r.id), m = loc && shots.readManifest(loc.dir);
          return registeredProject(m?.provenance?.repo,list) === g.project;
        });
        return runs.length ? [{...g,latest:runs[0],earlier:runs.slice(1),waiting:runs[0].state.cls !== 'ok'}] : [];
      });
      return {groups};
    },
    async review(profile,id) {
      const loc = locate(profile,id), m = loc.m, verdict = shots.readVerdict(loc.dir);
      return {run:{id,profile,project:loc.project,branch:m.provenance?.branch || '',provenance:m.provenance || {},kind:shots.isRecorded(m) ? 'recorded' : 'stills',video:m.video || null,steps:m.steps.map(s => ({...s,url:shots.stepUrl(s)})),verdict,state:shots.runState(m,verdict)}};
    },
    async saveReview(body) {
      const save = () => {
        const loc = locate(body.profile,body.run), clean = shots.cleanVerdict(loc.m,body);
        if(!clean.ok) throw Object.assign(new Error(clean.error),{status:400});
        fs.writeFileSync(path.join(loc.dir,shots.VERDICT),JSON.stringify(clean.out,null,2),{mode:0o600});
        return {ok:true,verdict:clean.out,state:shots.runState(loc.m,clean.out)};
      };
      chain = chain.then(save,save); return chain;
    },
    async media(req,res,profile,id,file) {
      const loc = locate(profile,id);
      const allowed = [loc.m.video,...loc.m.steps.map(s => s.file)].filter(Boolean);
      if(!allowed.includes(file) || path.basename(file) !== file || !/\.(png|jpg|jpeg|webp|mp4|webm)$/i.test(file)) return absent();
      // realpath defeats a media symlink as well as lexical traversal.
      const root = fs.realpathSync(loc.dir), full = fs.realpathSync(path.join(root,file));
      if(!full.startsWith(root+path.sep)) return absent();
      return shots.serveFile(req,res,full,/\.(mp4|webm)$/i.test(file) ? `video/${path.extname(file).slice(1)}` : `image/${path.extname(file).slice(1).replace('jpg','jpeg')}`);
    },
    async pendingSignIns(user) {
      const items = loginList(configs());
      const missing = [];
      for(const peer of peerList()) {
        let r; try { r = await requestPeer(peer,{pathq:'/api/logins',onBehalf:user.id,timeout:5000}); } catch { r = {}; }
        if(r.status !== 200) { missing.push({host:peer.label}); continue; }
        for(const row of r.json?.items || []) items.push({...row,project:peers.joinAddr(row.project,peer.key),host:peer.label,host_key:peer.key});
      }
      return {items,missing};
    },
    async login(kind,args,user) {
      const address = peers.splitAddr(args.project);
      if(address?.key) {
        const peer = peerList().find(p => p.key === address.key); if(!peer) return {ok:false};
        const tool = {start:'fleet_account_login_start',account:'fleet_account_login_finish',mcp:'fleet_login_finish'}[kind];
        try {
          const r = await requestPeer(peer,{method:'POST',pathq:'/api/verb',body:{tool,args:{...args,project:address.project}},onBehalf:user.id,timeout:15000});
          return {ok:r.status === 200 && r.json?.ok === true};
        } finally { args.code = ''; args.callback = ''; }
      }
      try {
        const list = configs();
        const r = kind === 'start' ? await startAccountLogin(list,args) : kind === 'account' ? await finishAccountLogin(list,args,loginRecords(list)) : await finishLogin(list,args);
        return {ok:r.json?.ok === true};
      } finally { args.code = ''; args.callback = ''; }
    },
  };
}
export async function realScreenSource() {
  const { projects } = await import(pathToFileURL(path.join(GF_HOME,'lib/projects.mjs')).href);
  const config = process.env.GHOSTFLEET_SERVE_CONFIG || path.join(os.homedir(),'.config','ghostfleet','serve.json');
  return createScreenSource({configs:projects,peerList:() => peers.loadPeers(peers.peersFile(config)).peers});
}
