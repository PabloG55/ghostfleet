// web/src/lead.js — a project's lead, started if it is not running: the team server's /api/lead,
// done from the phone. Its own module, with every read and the verb handed in, so the suite can run
// THIS function against a daemon that answers each way (test/run.sh, "the phone opens a woken
// session only when it woke") instead of a copy of it.
//
// OPENING IS THE CALLER'S, AND ONLY ON A RESOLVE. A wake the daemon refused must open nothing: the
// old client tested `r && r.ok === false`, which is false for the null its verb path returned on a
// refusal, so every failed wake went on to open a session that was not there — the reason, then an
// empty pane. Here a refusal is a throw (api.js verb() throws on `ok: false`), it is not caught, and
// every caller (search, the assistant, the project page) opens its session only once this resolves.
//
//   deps: grid(project) → { cards }, projects() → { projects }, act(tool, args), remote(project),
//         wait(ms), noLead(project) → Error
export function makeLead({ grid, projects, act, remote, wait, noLead, tries = 20, every = 1500 }) {
  return async function lead(project) {
    const find = async () => ((await grid(project)).cards || []).find(c => c.lead);
    const m = await find();
    let did = null;
    if (!m) {
      const p = ((await projects()).projects || []).find(x => x.name === project);
      if (!p || remote(project)) throw noLead(project);
      did = 'start';
      await act('fleet_project_add', { path: p.path, name: p.name, profile: p.profile, start: true });
    } else if (m.lost || m.exited) { did = 'reopen'; await act('fleet_reopen', { project, session: m.name }); }
    else if (m.asleep) { did = 'wake'; await act('fleet_wake', { project, session: m.name }); }
    else if (m.status === 'parked') { did = 'resume'; await act('fleet_resume', { project, session: m.name }); }
    if (!did) return { ok: true, started: null, lead: m.name };
    for (let i = 0; i < tries; i++) {
      await wait(every);
      const n = await find().catch(() => null);
      if (n && !n.lost && !n.asleep && !['starting', 'unknown'].includes(n.status)) return { ok: true, started: did, lead: n.name };
    }
    return { ok: true, started: did, lead: m ? m.name : 'master' };
  };
}
