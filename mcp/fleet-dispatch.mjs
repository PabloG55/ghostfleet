// ghostfleet tool dispatch — the fleet verbs, their argument validation, and the argv
// each one turns into. Shared by mcp/fleet-mcp.mjs (stdio JSON-RPC, for a lead Claude
// session) and bin/fleet-serve.mjs (HTTP, for the phone).
//
// WHY THIS IS ITS OWN FILE. It all lived inside fleet-mcp.mjs until the phone needed
// the same verbs over HTTP. The tempting shape there is "fleet-serve shells out to
// bin/fleet-* itself" — and that would have quietly dropped the argument validation
// below, which exists because a client that omitted one key had `String(undefined)`
// pasted into a worker's input box and submitted as its prompt (see argError). A second
// caller must INHERIT that guard, not re-earn it.
//
// So the DECISION — validate, resolve the project, build the argv — happens here
// exactly once, in plan(). Only the EXECUTION differs: callTool() is synchronous and is
// byte-for-byte the behaviour the MCP server has always had, callToolAsync() runs the
// same plan without blocking, which an HTTP server must do since one fleet_spawn can
// take a minute and a blocked event loop cannot even answer /api/health.
//
// Node builtins only: ghostfleet is a zero-dependency package and this is on its
// import path.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin');
export const HOME = os.homedir();

// CROSS-FLEET: every fleet is its own tmux server (cf-<project>), and `tmux -L`
// reaches any of them — the bin/ commands all take `-s <socket>`. Without a way to
// name another fleet, a lead could only ever see its own, so work spanning repos
// (e.g. replying to a session fleet-open put on another project's fleet) was
// impossible from a tool call. Resolve a project name -> its socket + config dir,
// from the same ~/.config/ghostfleet/projects[.<profile>] files ghostfleet reads.
export function projects() {
  const dir = path.join(HOME, '.config', 'ghostfleet');
  const files = [path.join(dir, 'projects')];
  // only real profile lists: 'projects.bak.1785…' is a backup, not a profile
  try { for (const f of fs.readdirSync(dir)) if (/^projects\.[A-Za-z0-9_-]+$/.test(f)) files.push(path.join(dir, f)); } catch {}
  const out = [];
  for (const f of files) {
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      const t = line.replace(/\r$/, '');
      if (!t.trim() || t.startsWith('#')) continue;
      const [name, p, prof0, agent0] = t.split('\t');
      if (!name || !p) continue;
      const prof = prof0 || 'work';
      const isWork = prof === 'work' || prof === 'default';
      // 4th column = that project's default agent. Carried so a cross-fleet spawn uses
      // the TARGET's default rather than inheriting whatever the caller happens to run.
      const agent = /^[a-z0-9_-]+$/.test((agent0 || '').trim()) ? agent0.trim() : '';
      out.push({ name, path: p.replace(/^~/, HOME), profile: prof, agent,
                 sock: isWork ? `cf-${name}` : `cf-${prof}-${name}`,
                 cfg: isWork ? path.join(HOME, '.claude') : path.join(HOME, '.claude-' + prof) });
    }
  }
  return out;
}
export function target(proj) {
  if (!proj) return null;                       // omitted -> the caller's own fleet
  const s = String(proj), all = projects();
  const hit = all.find(p => p.name === s) || all.find(p => p.sock === s);
  if (!hit) throw new Error(`unknown project '${s}' — call fleet_projects to list them`);
  return hit;
}

// WHO WE ARE — needed for fleet_send's reply_to, and resolved HERE rather than in
// fleet-send, because exec() below deliberately clears TMUX and repoints
// CLAUDE_FLEET_SOCK at the TARGET's fleet. `--reply-to me` in that child would resolve
// OUR session name against the TARGET's socket: an address that validates perfectly and
// relays the answer to whichever session answers that name over there. Never cached —
// fleet_rename can change our own name while this server lives.
export function self() {
  const t = process.env.TMUX || '';                     // <socket-path>,<pid>,<session-id>
  const [sp, , sid] = t.split(',');
  const sock = (sp || '').split('/').pop() || '';
  if (!/^cf-/.test(sock)) return null;                  // not inside a fleet session
  let sess = '';
  if (/^\d+$/.test(sid || '')) {                        // that field is the ID, not the name
    try {
      const rows = execFileSync('tmux', ['-L', sock, 'list-sessions', '-F', '#{session_id} #{session_name}'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of rows.split('\n')) {
        const [id, name] = line.split(' ');
        if (id === `$${sid}`) { sess = name || ''; break; }
      }
    } catch {}
  }
  if (!sess) sess = process.env.CLAUDE_FLEET_SLOT || ''; // a --resume'd session can hold this stale
  if (!sess) return null;
  const dir = process.env.CLAUDE_FLEET_DIR
    || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'fleet');
  return { sock, sess, dir };
}

// fleet-spawn and fleet-worktrees find the repo from $PWD, not from -s — they are the
// only two commands here that do. So targeting another project means RUNNING THERE, and
// this resolves where "there" is: the same convention enter_master uses in
// bin/ghostfleet — <root>/<name>, else a child repo, else the root itself, because a
// project is registered either as a container of checkouts or as one repo
// (docs/OPERATIONS.md, "Two ways to register a project").
//
// PREFER A MAIN CHECKOUT among the children, and sort. A linked worktree has a .git of
// its own, so "the first child directory that is a repo" handed one back on a container
// root — whereupon fleet-spawn, run there, correctly refused to spawn a worker from
// inside a worktree, and a lead's fleet_spawn failed for a reason nothing in the request
// explained. git gives a real clone a .git DIRECTORY and a worktree a .git file, which
// is the whole distinction. fleet-grid.mjs mainRepo() is the third copy of these steps
// and has the same preference; the suite pins the two together, because a lead that
// targets a project and a grid that draws it must agree about which checkout it is.
export function checkoutOf(t) {
  const isRepo = p => { try { return fs.existsSync(path.join(p, '.git')); } catch { return false; } };
  const isMain = p => { try { return fs.statSync(path.join(p, '.git')).isDirectory(); } catch { return false; } };
  if (isRepo(t.path)) return t.path;
  const named = path.join(t.path, t.name);
  if (isRepo(named)) return named;
  try {
    const kids = fs.readdirSync(t.path, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => path.join(t.path, e.name))
      .filter(isRepo).sort();
    return kids.find(isMain) || kids[0] || t.path;
  } catch {}
  return t.path;
}

// ── the plan, and the two ways to run it ────────────────────────────────────
// run() used to execute here. It now DESCRIBES the execution, because the argv is the
// part that must not be written twice and the exec is the part that has to differ.
function run(cmd, args, t, opts = {}) { return { kind: 'run', cmd, args, t, opts }; }

// The argv and env a plan resolves to. Both executors call this, so a change to how a
// fleet is addressed cannot reach one caller and miss the other.
function invocation(p) {
  // When targeting another fleet, pass -s AND point the env at that profile, so
  // status/markers land in the right fleet dir. TMUX is cleared because the commands
  // prefer the live server it names (drift-proof for normal use, wrong here).
  // opts.noSock: fleet-spawn is deliberately NOT given -s. It accepts one now, but an
  // explicit socket PINS the fleet and skips route_to_owner — and route_to_owner is
  // precisely the mechanism that gets a cross-project spawn onto the target's fleet,
  // from the repo it is running in. Passing -s here would pin the worker to whatever
  // socket we resolved and defeat the thing that makes targeting work.
  const t = p.t;
  const argv = (t && !p.opts.noSock) ? ['-s', t.sock, ...p.args] : p.args;
  // ALL SIX, EXPLICITLY — the same set bin/ghostfleet:197-200 exports when it enters a
  // project. SCOPE and ROOT used to be left to inherit, which is invisible inside a
  // Claude session (its own values happen to be the fleet it is in) and wrong the moment
  // anything targets another project: fleet-grid.mjs derives `project` from
  // CLAUDE_FLEET_SCOPE and its free-worktree list from CLAUDE_FLEET_ROOT, so querying
  // another project's socket from a ghostfleet session answered `project: "ghostfleet"` and listed
  // GHOSTFLEET's worktrees as free. On a phone that is a "reuse this free worktree"
  // button naming a checkout in the wrong repo, with fleet_spawn behind it — wrong data
  // driving a destructive verb, not a cosmetic mislabel. A long-lived daemon is the
  // process that gets this worst, because it has its own plausible values and never
  // changes them.
  const env = t ? { ...process.env, TMUX: '', CLAUDE_FLEET_SOCK: t.sock,
                    CLAUDE_CONFIG_DIR: t.cfg, CLAUDE_FLEET_DIR: path.join(t.cfg, 'fleet'),
                    CLAUDE_FLEET_PROFILE: t.profile, CLAUDE_FLEET_SCOPE: t.name,
                    CLAUDE_FLEET_ROOT: t.path,
                    CLAUDE_FLEET_AGENT: t.agent || 'claude' }
                : process.env;
  return { file: path.join(BIN, p.cmd), argv, env, cwd: p.opts.cwd };
}
// A command that fails is not a refusal: several here write to stderr on success, and
// the caller wants what it said either way. Only plan() refuses, and it says so.
const combined = (e) => `${e.stdout || ''}${e.stderr || ''}`.trim() || `error: ${e.message}`;

function execPlan(p) {
  const { file, argv, env, cwd } = invocation(p);
  try {
    return execFileSync(file, argv, { encoding: 'utf8', env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }) || '(no output)';
  } catch (e) { return combined(e); }
}
// maxBuffer defaults to execFileSync's own so the two cannot differ on a chatty command;
// a caller that expects a big answer raises it. Timeout is the async half's own concern.
//
// EXCEEDING IT IS THE TRUNCATION BUG WEARING A THIRD HAT. node hands back the output it
// DID collect alongside the error, so a naive `stdout || stderr` returns a payload cut off
// mid-value — which for JSON fails loudly at the parse, and for text does not fail at all:
// it looks like a short answer. So it is named rather than merged into the generic path.
function execPlanAsync(p, { timeout = 0, maxBuffer = 1024 * 1024 } = {}) {
  const { file, argv, env, cwd } = invocation(p);
  return new Promise((resolve) => {
    execFile(file, argv, { encoding: 'utf8', env, cwd, timeout, maxBuffer },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout || '(no output)');
        // A killed-by-timeout child has usually printed nothing, so say what happened
        // rather than handing back an empty string that reads like success.
        if (err.killed && timeout && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return resolve(`error: ${p.cmd} timed out after ${timeout}ms`);
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
          return resolve(`error: ${p.cmd} produced more than ${maxBuffer} bytes — the answer was cut off, so it is refused rather than returned short`);
        resolve(`${stdout || ''}${stderr || ''}`.trim() || `error: ${err.message}`);
      });
  });
}

export const TOOLS = [
  { name: 'fleet_list', description: "List the Claude sessions in a fleet (parallel worktrees) with their status. Call this first to see which siblings exist and whether they are free. Pass `project` to list ANOTHER project's fleet.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" } }, additionalProperties: false } },
  { name: 'fleet_send', description: 'Send a prompt to a sibling fleet session and submit it (it runs there). The prompt must be self-contained — the sibling does not share your context. Set reply_to:true when you are ASKING something rather than dispatching work: without it a send is one-way and the answer never comes back to you.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string', description: 'target session name (see fleet_list)' }, prompt: { type: 'string', description: 'the full, self-contained prompt to run there' }, reply_to: { type: 'boolean', description: "ask for an answer back: that session is told to answer YOU directly, so its reply usually arrives in this conversation as a message from it (even while you are mid-turn) — no polling, and nothing to drain. If it can't reach you (not a Claude session, or its turn dies first) the answer falls back to an ANSWERED row in your fleet_inbox, so check there if nothing arrives" } }, required: ['session', 'prompt'], additionalProperties: false } },
  { name: 'fleet_read', description: 'Read the last N assistant messages from a sibling session, to check its progress/output.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' }, n: { type: 'number', description: 'how many recent assistant messages (default 1)' }, json: { type: 'boolean', description: "return the messages as DATA — {ts, role, text} per message plus a next_before cursor — instead of as text. For a machine consumer (bin/fleet-serve's /api/session); a reader wanting the output should leave it off and use n" }, limit: { type: 'number', description: 'with json: how many messages in this page (default 20)' }, before: { type: 'string', description: "with json: page backwards from this message's ts (the previous page's next_before)" } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_spawn', description: "Create a new git worktree and start a fresh parallel session in it (in the background), optionally with an initial task prompt. Defaults to YOUR OWN repo; pass `project` to spawn a worker into ANOTHER project's fleet (name from fleet_projects) — it runs in that project's checkout and the worker lands on that fleet, with that project's default agent. Call fleet_worktrees FIRST (same `project`): if free worktrees exist, spawn refuses unless you reuse one (reuse) or force a new one (force_new).",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, name: { type: 'string', description: 'session + worktree name' }, branch: { type: 'string', description: 'branch to use/create (default: name)' }, from: { type: 'string', description: 'base ref for a new branch; bases on your LOCAL ref (use "HEAD" for current), falls back to the remote tip only if local is behind' }, prompt: { type: 'string', description: 'initial task to send once it boots' }, model: { type: 'string', description: 'model for the worker (e.g. opus); default = account default' }, reuse: { type: 'string', description: 'start in this EXISTING free worktree (name or path); combine with branch+from to clean & rebranch it in one step' }, force_new: { type: 'boolean', description: 'create a new worktree even if free ones exist' } }, required: ['name'], additionalProperties: false } },
  // A SECOND SESSION IN THE SAME WORKTREE, which had a CLI and no tool. fleet-companion
  // is the answer to "give me another session here" and an agent restricted to MCP could
  // not reach it — an asymmetry that got worse when #89 gave codex and opencode the
  // tools, because neither has the orchestrate skill that would have mentioned the CLI.
  //   THE WARNING IS PART OF THE TOOL. bin/fleet-companion's own header says two Claudes
  // editing the same files can conflict and to keep the companion to questions and
  // reading; a tool that hands out that footgun without repeating it is worse than no
  // tool, because the caller has no header to have read.
  { name: 'fleet_companion', description: "Start a SECOND session in the SAME worktree as an existing one — same files, same branch, a separate and always-fresh conversation. Nothing is branched, copied or checked out. Use it for a second pair of eyes on work in progress: asking questions about a running task, or reading around the change while the first session keeps going. WARNING: the two sessions share one working tree and there is NO locking, so both editing it will conflict and can lose work — keep a companion to questions and reading unless you specifically mean otherwise. For an ISOLATED parallel worker with its own checkout and branch, use fleet_spawn instead.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string', description: "the session whose worktree to join (from fleet_list); omit to use the directory you are standing in" } }, additionalProperties: false } },
  { name: 'fleet_worktrees', description: "Inventory every git worktree of a repo — branch, whether a session is live on it, git state, and which are FREE to reuse. Call this BEFORE fleet_spawn so you reuse an idle worktree instead of proliferating new ones. Defaults to your own repo; pass `project` to inventory ANOTHER project's.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" } }, additionalProperties: false } },
  { name: 'fleet_inbox', description: "Drain the lead's attention feed: worker 'need-you' events (permission / usage-limit / real questions), governor park/resume, and answers relayed back from sessions you asked with fleet_send reply_to that could not message you directly (the usual case now is a direct message in the conversation, so a missing ANSWERED row is not a missing answer). One call replaces polling every sibling — shows only what is new since last call. Pass `project` to drain ANOTHER project's feed instead of your own.",
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'show the whole inbox instead of only new entries' }, project: { type: 'string', description: "another project's fleet to read (name from fleet_projects); omit for your own — your relayed answers arrive in YOUR OWN inbox, so omit it for those" } }, additionalProperties: false } },
  { name: 'fleet_answer', description: 'Send raw keystrokes to a worker BLOCKED on a prompt — a permission dialog, a "reached usage limit — retry?", a trust prompt (e.g. text "2"). Use this to unblock a worker; use fleet_send for normal task prompts.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' }, text: { type: 'string', description: 'literal keys to send (e.g. "2" or "yes"); Enter is pressed after unless no_enter is true' }, no_enter: { type: 'boolean' } }, required: ['session', 'text'], additionalProperties: false } },
  { name: 'fleet_pause', description: "Park a worker: reliably interrupt it and mark it OFF (zero budget). Use to shed idle or expensive workers on the shared account. Un-park with fleet_resume or by sending it work. Can't park 'master': it is the fleet's lead, and a fleet whose lead is off dispatches nothing (the governor excludes it for the same reason).",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_resume', description: 'Un-park a worker paused with fleet_pause; optionally dispatch a prompt to wake it immediately.',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' }, prompt: { type: 'string' } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_stop', description: "Cleanly STOP a worker for good: kill its session and clear its fleet state (status file, park/schedule markers + the schedule waiter, manifest entry). Use for a finished worker, or an ORPHAN whose git worktree was removed (its session lingers in fleet_list otherwise). Unlike fleet_pause (which only parks), this removes it. reclaim:true ALSO removes its git worktree — the one-call \"this one is done\", instead of stopping here and running `git worktree remove` somewhere else. Whether removal is safe is decided by fleet-clean's own gates (clean tree, no other session, PR merged or fully pushed); if it isn't, the session still stops and the worktree is kept with the reason. force:true (with reclaim) is the escalation for exactly that case — `git worktree remove --force`, which DELETES uncommitted work; ask for it only after a plain reclaim reported why it declined. Without reclaim it does not touch git. Can't stop 'master': it is the fleet's lead, and reclaim would aim at the repo's own main checkout.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string' }, reclaim: { type: 'boolean', description: "also remove its git worktree when it is safe to (PR merged or fully pushed, clean, no other session)" }, force: { type: 'boolean', description: "with reclaim: remove the worktree ANYWAY, past those gates. Destroys uncommitted work — the deliberate second step after a reclaim was declined" } }, required: ['session'], additionalProperties: false } },
  { name: 'fleet_rename', description: "Rename a worker's session AND move its worktree folder (git worktree move) in one step, so the two never drift apart. Migrates its pause marker, notify-lead override, pending scheduled send, fleet_worktrees manifest row, and its slot in the grid's card order to the new name. Refuses on a live-session/path collision or a dirty worktree git won't move. Can't rename 'master'.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "another project's fleet to act on (name from fleet_projects); omit for your own fleet" }, session: { type: 'string', description: 'current session name' }, new_name: { type: 'string', description: 'new name for both the session and its worktree folder' } }, required: ['session', 'new_name'], additionalProperties: false } },
  { name: 'fleet_project_add', description: "Register a NEW project (its own fleet) from a path — the CLI form of the Projects screen's '+ add project'. Use this when work belongs to a repo that is NOT part of any existing fleet: registering it and starting its master is correct, whereas spawning a worker inside your own fleet would put it on the wrong socket and under the wrong project. start:true boots its master immediately so you can fleet_send to it.",
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'project root: the repo, or a folder holding its checkouts' }, name: { type: 'string', description: 'project name (default: the folder name)' }, profile: { type: 'string', description: 'work (default) or another profile' }, agent: { type: 'string', description: "default coding CLI for this project's master and its workers (fleet-agent list; omit for claude)" }, start: { type: 'boolean', description: 'also start its master session' } }, required: ['path'], additionalProperties: false } },
  { name: 'fleet_project_agent', description: "Set or clear an EXISTING project's default agent — the 4th column of the projects list, inherited by the next master it starts and by workers spawned in it that do not name one. Omit `agent` (or pass an empty string) to clear it back to the default, claude. The RUNNING master is unaffected: CLAUDE_FLEET_AGENT is read once, when its tmux session is created, so this applies to the next one.",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'project name (from fleet_projects)' }, agent: { type: 'string', description: 'an agent from fleet-agent list; empty or omitted clears it back to claude' } }, required: ['name'], additionalProperties: false } },
  { name: 'fleet_worktree_remove', description: "Remove ONE git worktree that no session is using — the `x` on a grey FREE card in the grid. Whether removal is safe is decided by fleet-clean's own gates (clean tree, fully pushed or merged, no live session); if they decline, the worktree is kept and the reason is printed. force:true is the escalation for exactly that case — the grid's `f = remove anyway` — and it DELETES UNCOMMITTED WORK. It still refuses a main checkout, a worktree a live session is standing in, and Claude's own .claude/worktrees trees. Use fleet_stop reclaim for a worktree that still has a session on it.",
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: "the project whose worktree this is (name from fleet_projects); omit for your own fleet" }, path: { type: 'string', description: 'absolute path of the worktree to remove' }, force: { type: 'boolean', description: 'remove it past those gates — destroys uncommitted work; the deliberate second step after a plain removal was declined' } }, required: ['path'], additionalProperties: false } },
  { name: 'fleet_project_remove', description: "Unregister a project — drop its entry from the projects list. Its sessions, worktrees and history are untouched; this is the `x` on the Projects screen, not a delete.",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'project name (from fleet_projects)' } }, required: ['name'], additionalProperties: false } },
  { name: 'fleet_projects', description: "List every ghostfleet project: name, profile, path, fleet socket and how many sessions are live. These names are what the `project` argument accepts, so a lead in one repo can list/send/read/answer/pause/stop a session in ANOTHER project's fleet.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

// REFUSING A CALL, so the caller can see it was refused. MCP's error channel for a tool
// call is a result flagged isError — a client renders that as a failed call, where the
// same words in an ordinary result render as the tool's output. The bug this exists for
// returned the normal success line, so text alone would only be half a fix: the lead's
// transcript would still show a green call.
export const fail = (msg) => ({ isError: true, text: `error: ${msg}` });

// THE LEAD IS NOT A WORKER, and this is where saying so has to happen.
//
// Three commands already refuse it: bin/fleet-stop won't stop 'master', bin/fleet-rename
// won't rename it, and fleet-clean won't remove a main checkout. But they all refuse in
// the SHELL, and a nonzero exit from one of these is not a refusal here — combined()
// hands the child's output back as ordinary text on purpose (several of them write to
// stderr on success). So `fleet_stop --reclaim master` came back as a plain string, which
// runVerb reads as ok:true: the phone showed a SUCCESS toast carrying the words "refusing
// to stop 'master'", and fleet-serve's audit logged it as `result: 'ran'`. The guard held
// and the report lied about it.
//
// Refusing in plan() fixes both callers at once, because plan() is the only layer both
// go through: the MCP server returns {isError:true} to the agent, and the daemon returns
// a 400 with `result: 'refused'` in the audit. It is also the layer that CANNOT be
// bypassed by a client that simply doesn't draw the button — docs/mobile.md §7's rule,
// and the reason this landed with the lead's card: until now nothing could name master
// as a target from a phone, and now everything can.
const LEAD = 'master';
const notTheLead = (tool, session, why) => (String(session) === LEAD
  ? { kind: 'fail', ...fail(`${tool}: refusing to ${why} '${LEAD}' — it is the fleet's lead, not a worker (every project needs one, and its checkout is the repo itself)`) }
  : null);

// `required` in an inputSchema is a declaration to the CLIENT; the server never enforced
// it. So a client that dropped a key handed the tool `undefined`, and `String(undefined)`
// is the seven-character word "undefined" — pasted into a worker's input box and
// submitted as its prompt, while the call answered `fleet-send: → <session>` as usual.
// Four dispatches from one lead were lost that way, with nothing on either side to see.
// Validate here instead, and name the tool and the argument so the next one reads
// "fleet_send: missing required argument 'prompt'".
//
// Driven off the schema's own `required` rather than a check per tool: 13 tools and 12
// required arguments today, and a hand-written list drifts from the schema the first
// time one is added.
//
// EMPTY STRING is refused too — everywhere but one place. "" is not an addressable
// session, worktree name or path, and an empty prompt pastes nothing and submits it,
// which loses the caller's instruction exactly as the missing key did. fleet_answer's
// `text` is the exception: it is raw keystrokes whose own description promises a trailing
// Enter, so "" reads as a deliberate bare Enter, and whether that is honoured belongs to
// fleet-answer — which today refuses it by name ("nothing to send — give <text> or --key
// Name"). Nothing silent gets through either way; a *missing* text still cannot, because
// that is what would type u-n-d-e-f-i-n-e-d into a permission dialog.
const EMPTY_OK = new Set(['fleet_answer.text']);

export function argError(name, a) {
  const req = TOOLS.find(x => x.name === name)?.inputSchema?.required || [];
  for (const k of req) {
    const v = a[k];
    if (v === undefined || v === null) return `${name}: missing required argument '${k}'`;
    // Wrong TYPE is the same defect wearing another hat: String([]) is "", String({}) is
    // "[object Object]", and both reach a shell command as quietly as "undefined" did.
    if (typeof v !== 'string')
      return `${name}: required argument '${k}' must be a string, got ${Array.isArray(v) ? 'array' : typeof v}`;
    if (v === '' && !EMPTY_OK.has(`${name}.${k}`)) return `${name}: required argument '${k}' is empty`;
  }
  return null;
}

// Every project's live session count, for fleet_projects. Kept synchronous in both
// executors on purpose: it is one `tmux list-sessions` per project against a local
// socket, and the measured cost of all 14 is well under the 0.39s the grid itself takes.
function projectTable() {
  const rows = projects().map(p => {
    let n = '0';
    try { n = String(execFileSync('tmux', ['-L', p.sock, 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).length); } catch {}
    return `${p.name.padEnd(18)} ${p.profile.padEnd(9)} ${p.sock.padEnd(26)} ${n.padEnd(8)} ${p.path}`;
  });
  return rows.length
    ? `${'PROJECT'.padEnd(18)} ${'PROFILE'.padEnd(9)} ${'FLEET'.padEnd(26)} ${'SESSIONS'.padEnd(8)} PATH\n${rows.join('\n')}`
    : '(no projects configured)';
}

// The single decision point: validate, resolve the project, and say what should run.
// Returns {kind:'fail'|'text'|'run'} — never executes anything.
export function plan(name, a = {}) {
  const bad = argError(name, a);
  if (bad) return { kind: 'fail', ...fail(bad) };   // before anything runs, or resolves
  let t;
  try { t = target(a.project); } catch (e) { return { kind: 'fail', ...fail(e.message) }; }
  switch (name) {
    case 'fleet_project_add': {
      const args = ['add', String(a.path)];
      if (a.name) args.push('--name', String(a.name));
      if (a.profile) args.push('--profile', String(a.profile));
      if (a.agent) args.push('--agent', String(a.agent));
      if (a.start) args.push('--start');
      return run('fleet-project', args);
    }
    // Empty/absent CLEARS. `--none` rather than an empty argument, so the intent is in
    // the argv a user can read back out of a log — an empty string there is
    // indistinguishable from an argument that got lost on the way.
    case 'fleet_project_agent':
      return run('fleet-project', ['agent', String(a.name), String(a.agent || '').trim() || '--none']);
    case 'fleet_projects': return { kind: 'text', text: projectTable() };
    case 'fleet_list': return run('fleet-list', [], t);
    case 'fleet_send': {
      const args = [];
      if (a.reply_to) {
        const me = self();
        // Refuse rather than send it one-way: a caller that asked for an answer and
        // silently didn't get a return address would wait for a reply that can't come.
        if (!me) return { kind: 'fail', ...fail('reply_to needs this session to be inside a fleet ($TMUX names none). Send without reply_to, or from Bash: fleet-send --reply-to <socket>/<session> …') };
        args.push('--reply-to', `${me.sock}/${me.sess}`, '--reply-dir', me.dir);
      }
      args.push(String(a.session), String(a.prompt));
      return run('fleet-send', args, t);
    }
    case 'fleet_read': {
      // Two output modes, ONE transcript-locating implementation (see bin/fleet-read's
      // header for why a second one would eventually answer with the wrong session's
      // conversation on a recycled worktree).
      if (a.json) {
        const args = ['--json', String(a.session)];
        if (a.limit) args.push('--limit', String(Number(a.limit) || 20));
        if (a.before) args.push('--before', String(a.before));
        return run('fleet-read', args, t);
      }
      return run('fleet-read', [String(a.session), String(a.n || 1)], t);
    }
    case 'fleet_spawn': {
      const args = [String(a.name)];
      if (a.branch) args.push('--branch', String(a.branch));
      if (a.from) args.push('--from', String(a.from));
      if (a.model) args.push('--model', String(a.model));
      if (a.reuse) args.push('--reuse', String(a.reuse));
      if (a.force_new) args.push('--new');
      if (a.prompt) args.push('--prompt', String(a.prompt));
      // noSock + cwd: spawn finds the repo (and so the owning fleet) from where it runs,
      // and an explicit -s would pin the socket past that. Everything else here is
      // addressed by socket. See invocation()'s note.
      return run('fleet-spawn', args, t, { noSock: true, cwd: t ? checkoutOf(t) : undefined });
    }
    // Positional session|path, exactly as the CLI takes it, and -s comes from `t` the way
    // every other targeted command here gets it. With no session it falls through to the
    // command's own "companion for the worktree you're standing in" — so cwd is set for a
    // cross-project call, or standing-in-the-wrong-place would pick the caller's tree.
    case 'fleet_companion':
      return run('fleet-companion', a.session ? [String(a.session)] : [], t,
                 { cwd: t ? checkoutOf(t) : undefined });
    case 'fleet_worktrees': return run('fleet-worktrees', [], t, { cwd: t ? checkoutOf(t) : undefined });
    case 'fleet_inbox': return run('fleet-inbox', a.all ? ['--all'] : [], t);
    case 'fleet_answer': {
      const args = [String(a.session), String(a.text)];
      if (a.no_enter) args.push('--no-enter');
      return run('fleet-answer', args, t);
    }
    case 'fleet_pause': {
      // Pause is a WORKER verb — its own description says "park a worker" — and the
      // governor already keeps this rule for itself: bin/fleet-governor excludes master
      // from the sessions it parks ("master is never parked"), because a fleet whose lead
      // is off has nothing to drain fleet-inbox or dispatch the next task, and the way out
      // was flipping a marker by hand. It only became reachable from a phone when the lead
      // gained a card, and there it is one careless swipe on the FIRST one.
      //   RESUME IS DELIBERATELY NOT GUARDED. The recovery direction has to stay open, or
      // a lead parked by an older build — or by hand — could not be turned back on from
      // the one surface that can see it.
      const nl = notTheLead('fleet_pause', a.session, 'park');
      if (nl) return nl;
      return run('fleet-pause', [String(a.session)], t);
    }
    case 'fleet_resume': {
      const args = [String(a.session)];
      if (a.prompt) args.push(String(a.prompt));
      return run('fleet-resume', args, t);
    }
    case 'fleet_stop': {
      // The lead, first: `reclaim` on master would aim fleet-clean at the repo's own main
      // checkout, and this is the one verb on the phone that can delete work.
      const nl = notTheLead('fleet_stop', a.session, 'stop');
      if (nl) return nl;
      // --force is meaningless without --reclaim and fleet-stop says so itself; sending
      // it alone would look like a harder stop while doing nothing at all, so refuse
      // here where the caller can still see which argument was wrong.
      if (a.force && !a.reclaim) return { kind: 'fail', ...fail("fleet_stop: force needs reclaim — without it nothing touches git") };
      const args = [];
      if (a.reclaim) args.push('--reclaim');
      if (a.force) args.push('--force');
      args.push(String(a.session));
      return run('fleet-stop', args, t);
    }
    case 'fleet_rename': {
      // Same rule, same reason it has to be here: bin/fleet-rename's own refusal reached
      // the phone as a success toast.
      const nl = notTheLead('fleet_rename', a.session, 'rename');
      if (nl) return nl;
      return run('fleet-rename', [String(a.session), String(a.new_name)], t);
    }
    case 'fleet_project_remove': return run('fleet-project', ['rm', String(a.name)]);
    case 'fleet_worktree_remove': {
      // fleet-clean owns worktree removal AND the rule about which gates --force may
      // skip, so both forms go through it. It resolves its repo from $PWD, and the
      // directory it is about to delete is a poor place to be standing — hence cwd.
      const args = ['--only', String(a.path), '--go'];
      if (a.force) args.push('--force');
      return run('fleet-clean', args, t, { cwd: t ? checkoutOf(t) : undefined });
    }
    default: return { kind: 'fail', ...fail(`unknown tool: ${name}`) };
  }
}

// The MCP server's entry point. Same signature and same return shape it always had: a
// string for a call that RAN, fail()'s {isError,text} for one we refused to run.
export function callTool(name, a = {}) {
  const p = plan(name, a);
  if (p.kind === 'fail') return { isError: true, text: p.text };
  if (p.kind === 'text') return p.text;
  return execPlan(p);
}

// The HTTP server's entry point. Identical decisions, non-blocking execution, and a
// timeout — a phone on cellular has already given up long before a wedged child would.
export async function callToolAsync(name, a = {}, opts = {}) {
  const p = plan(name, a);
  if (p.kind === 'fail') return { isError: true, text: p.text };
  if (p.kind === 'text') return p.text;
  return execPlanAsync(p, opts);
}
