// web/ui/adapter.jsx — how a shared screen reaches the fleet without knowing which app it is in.
//
// The screens in this folder never call an `/api` of their own. An app wraps them once in
// <FleetProvider adapter={…}> and every screen reads `useFleet()`. The team app's adapter is
// ee/team/web/src/adapter.js, over its multi-user server; the phone's is web/src/adapter.js, over
// fleet-serve. What a screen needs, and so what an adapter implements, is in README.md
// ("The adapter"). In short:
//
//   grid(project)                     → { cards, worktrees, … }        the project's sessions
//   session(project, name, before?)   → { messages, … }                a chat, older pages by `before`
//   pane(project, name)               → { text, status, here?, … }     the terminal and the live status
//   act(tool, args, opts?)            → { text, queued? }              every change, by fleet tool name
//   attach(project, session, file)    → { path }                       an upload, the path to cite
//   attachPerMessage                  number                           how many files one message takes
//   lead(project)                     → { session, … }                 open the lead (master) session
//   presence(project, session, typing)  optional: say who is looking
//   go(to, { replace? })              navigate to a hash route; history.js's go() is the one to pass
//   place(route)                      optional: what an app's own route is called on a back link
//   offers(view)                      optional: false hides a page this server does not have
//   activity()                        → { rows }                       what was done, newest first
//   settings, saveLang                optional: Settings' sections (views.jsx), and where a language is kept
//   route, tasks, taskSent, taskPlace, taskDone    the assistant's dispatcher and list (agent.js)
//   voice, hear, speak, speakAudio, voices, vad?, installVoice?, deleteVoice?   its voice (voice.js)
//   slots                             an app's own pieces (below)
//
// Slots are how an app puts something of its own into a shared screen without the screen
// knowing what it is: the team app's owners, avatars and who-is-here. Each is a plain function
// that returns markup or null — not a component, so it must not call hooks — and every one is
// optional: a screen with no slot draws nothing there, which is what the single-user client is.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

const Fleet = createContext(null);

export function FleetProvider({ adapter, children }) {
  return <Fleet.Provider value={adapter}>{children}</Fleet.Provider>;
}

// A screen outside a provider is a wiring mistake, not an empty fleet: say so where it happened,
// instead of letting the first `api.grid` read as "undefined is not a function" three calls in.
export function useFleet() {
  const a = useContext(Fleet);
  if (!a) throw new Error('web/ui: a shared screen was rendered outside <FleetProvider>');
  return a;
}

// The slot, or `fallback` — by default a function that draws nothing.
const none = () => null;
export function useSlot(name, fallback = none) {
  const s = useFleet().slots;
  return (s && s[name]) || fallback;
}
