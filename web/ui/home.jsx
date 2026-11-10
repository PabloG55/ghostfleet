// web/ui/home.jsx — the first page: the fleet as a board of what each session is doing.
// `children` go above the board: the team app puts its console there, the box a person types
// a question to the fleet in.
//
// It is the desk's Projects screen, so it answers Projects' keys (keyboard.jsx):
//   1-9            the master (lead) of the project at that position, counted in the fleet's
//                  own order, the desk's proj_nth, not the board's order of urgency
//   ← → ↑ ↓ hjkl   move between the projects on the board; ⏎ opens the one in focus
//   Ctrl-s         the focused project's sessions, skipping its master
import { Board } from './board.jsx';
import { useKeys, moveFocus, dirOf, projectTo } from './keyboard.jsx';

const TILES = '.main .fleet-name, .main .qchip';
const projectOf = (el) => {
  const a = el?.closest?.('.fleet')?.querySelector('.fleet-name') || el?.closest?.('.qchip');
  const m = /^#\/p\/([^/]+)/.exec(a?.getAttribute('href') || '');
  return m ? decodeURIComponent(m[1]) : null;
};

export function Home({ projects, children }) {
  useKeys((key, e, layer) => {
    const { k, lk, ctrl } = key;
    if (ctrl) {
      if (lk !== 's') return false;
      const p = projectOf(document.activeElement);
      if (p) layer.go(projectTo(p));
      return true;
    }
    const d = dirOf(key);
    if (d) { moveFocus(TILES, d); return true; }
    if (!key.alt && /^[1-9]$/.test(k)) {
      const p = (projects || [])[Number(k) - 1];
      if (p) layer.toLead(p.name);
      return true;
    }
    return false;
  });
  return (
    <div class="page home">
      {children}
      <Board projects={projects} />
    </div>
  );
}
