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
// EVERY STATE A LEAD CAN BE DOWN IN, ON EVERY MACHINE. The phone reaches one machine through
// another (a paired fleet-serve forwards the verb), so each of these is a verb that crosses:
// asleep → fleet_wake, parked → fleet_resume, lost → fleet_reopen, and no lead at all →
// fleet_lead_start, by the project's NAME. That last used to be fleet_project_add with the
// project's path, which a paired machine rightly refuses — it can register a folder — so a
// project on the other machine with no lead was a dead end: "has no lead to start from this
// phone". The name is all a start needs; the machine that has the project looks it up.
//
// IT ACTS ON WHAT IT READS, SO IT READS FRESH. The daemon keeps a grid for 2.5 s for everyone
// polling it; through that keep a lead lost a second ago read as up, and the button said the lead
// was ready and did nothing. So every read here asks for `{ fresh: true }`, which the daemon
// answers with a run of its own (fleet-serve gridJson), on whichever machine has the project.
//
//   deps: grid(project, { fresh }) → { cards }, projects() → { projects }, act(tool, args),
//         wait(ms), noLead(project) → Error
export function makeLead({ grid, projects, act, wait, noLead, tries = 20, every = 1500 }) {
  return async function lead(project) {
    const find = async () => ((await grid(project, { fresh: true })).cards || []).find(c => c.lead);
    const m = await find();
    let did = null;
    if (!m) {
      const p = ((await projects()).projects || []).find(x => x.name === project);
      if (!p) throw noLead(project);
      did = 'start';
      await act('fleet_lead_start', { project });
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
