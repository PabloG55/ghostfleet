// web/ui/order.js — the order a project's sessions are listed in, on every screen that lists them.
//
// THE LEAD IS THE FIRST CARD, WHATEVER IT IS DOING. A project's lead (`master`, the card the wire
// marks `lead`) is the session work is sent to, so it is the one a person looks for first. The
// project page used to file it under its state like any other card, so a lead that was ready sat
// under every working session, below the fold on a busy fleet: the owner's words were that master
// must always appear first, even when another session is working. The sidebar and the swipe took
// the wire's order as it came, which leads with the lead only because fleet-grid.mjs chooses to
// (gather({ lead: true })) — a promise of the server's that no screen checked.
//   So the order is decided here, once, and every list of one project's sessions draws from it:
// the project page (a phone's list of a project is the same page), the session page's sidebar,
// the swipe between sessions, and the stack picker's group for each project. Everything that is
// not the lead keeps the order it had. A project with no lead is drawn exactly as before.
//   Framework-free, like keys.js and history.js, so it can be read and tested without a build.

// The cards in the order a list draws them: the lead, then the rest in the order they came.
export function leadFirst(cards) {
  const list = cards || [];
  const i = list.findIndex(c => c && c.lead);
  return i <= 0 ? list : [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
}

// The project page's sections: the lead on its own, above every heading, and each group with the
// cards that are not the lead and not already in an earlier group. `groups` are the page's own
// ({ id, has(status) }, most urgent first) and `statusOf` is ui.jsx's, so this file decides only
// where the lead goes and nothing about what a state means.
export function sections(cards, groups, statusOf) {
  const all = cards || [];
  const lead = all.find(c => c && c.lead) || null;
  const taken = new Set(lead ? [lead.name] : []);
  return {
    lead,
    groups: groups.map(gr => {
      const list = all.filter(c => !taken.has(c.name) && gr.has(statusOf(c)));
      for (const c of list) taken.add(c.name);
      return { gr, list };
    }),
  };
}
