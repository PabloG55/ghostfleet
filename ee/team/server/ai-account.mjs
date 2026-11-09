// server/ai-account.mjs — Administration → AI account (contract §3): which Claude account
// the fleet works on, the API key when it is the company's, and Codex as a tool inside Claude.
//
// ── WHERE THE KEY LIVES, AND HOW IT REACHES A SESSION ──────────────────────────────────
// The key is one 0600 file in GFW_DATA/secrets/, beside a 0700 helper that prints it. Each
// profile the fleet runs on gets `apiKeyHelper` in its own settings.json pointing at that
// helper, so every Claude the fleet launches — a new worker, a restart, a wake — reads the
// key itself, through the same config dir ghostfleet already gives it (CLAUDE_CONFIG_DIR).
// The two other roads were measured and refused:
//   ANTHROPIC_API_KEY in the tmux server's environment is inherited by every pane AND every
//     command an agent runs there, so one `env` in a Bash tool call puts the key in a
//     transcript; a fleet server already running keeps the environment it started with, so
//     the change lands nowhere until each one is killed; and Claude Code asks "do you want
//     to use this API key?" the first time it meets a key in the environment
//     (`customApiKeyResponses` in .claude.json), a dialog no one is watching in a worker.
//   ANTHROPIC_API_KEY on each launch would need ghostfleet's spawn to take an environment,
//     which it does not: the session starts from the fleet server's.
// apiKeyHelper is read per process, outranks the profile's claude.ai login (the binary's own
// hint: "Unset the apiKeyHelper setting and run /login to sign in with your claude.ai
// account"), and only ever runs after the folder is trusted. Leaving api-key mode removes the
// entry again — but only when it is still OURS, so a helper the owner set by hand survives.
//
// Nothing here returns, logs or audits the key: the browser sees `sk-…last4`, the activity
// log sees "set" or "cleared".
//
// ── DEMO ──────────────────────────────────────────────────────────────────────────────
// No real profile is read or written. What a real install would do is computed the same way
// and reported as `simulated`.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { t, msg, render } from '../shared/i18n/index.js';

export const MODES = ['shared-subscription', 'api-key', 'per-user'];
const KEY_OK = /^sk-ant-[A-Za-z0-9_-]{20,200}$/;
const PROFILE_OK = /^[A-Za-z0-9_-]{1,40}$/;
const KEY_FILE = 'anthropic-api-key';
const HELPER_FILE = 'anthropic-api-key-helper';
export const hint = (key) => `sk-…${String(key).slice(-4)}`;

// Codex: `codex mcp-server` exists in some releases and not in others (0.151.0 lists it,
// 0.155.1 onwards does not, and an unknown subcommand is taken as a PROMPT for the
// interactive CLI) — so it is offered only when the installed codex lists it.
// Gemini: no MCP server from Google that exposes Gemini to another agent as a local
// command. Gemini CLI is an MCP client; the servers that wrap it are third-party.
export const MCP = {
  codex: { label: 'Codex (OpenAI)', command: 'codex', args: ['mcp-server'] },
  gemini: { label: 'Gemini (Google)', command: null, args: [],
            get why() { return t('mcp.gemini.why'); } },
};

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function httpErr(status, text) { return Object.assign(new Error(text), { status }); }
const run = (cmd, args, opts) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', timeout: 20000, ...opts }, (err, stdout, stderr) =>
    resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.trim() }));
});

// The profiles the fleet's projects run on, each with its config dir — resolved by
// ghostfleet's own rule (lib/projects.mjs cfgFor), so a profile here is the dir its sessions use.
export function profilesOf(fleet, cfgFor) {
  return async () => {
    let list = [];
    try { list = await fleet.projects(); } catch {}
    const names = [...new Set(list.map(p => p.profile || 'work'))].sort();
    return names.map(profile => ({ profile, cfg: cfgFor ? cfgFor(profile) : null }));
  };
}

export function createAiAccount({ dir, demo = false, profiles, readJson, writeJson, audit = () => {}, exec = run }) {
  const secrets = path.join(dir, 'secrets');
  const keyFile = path.join(secrets, KEY_FILE);
  const helper = path.join(secrets, HELPER_FILE);
  // A shell command, as Claude Code runs it: quoted, because GFW_DATA may hold a space.
  const helperCmd = sq(helper);
  const blank = () => ({ mode: null, shared: null, key: null, perUser: {}, mcp: { codex: false, gemini: false }, applied: null });
  const load = () => ({ ...blank(), ...(readJson('settings.json', {}).ai || {}) });
  const save = (ai) => { const all = readJson('settings.json', {}); all.ai = ai; writeJson('settings.json', all); };

  function writeKey(key) {
    fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
    fs.chmodSync(secrets, 0o700);
    const tmp = `${keyFile}.tmp`;
    fs.writeFileSync(tmp, key, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, keyFile);
    fs.writeFileSync(helper, `#!/bin/sh\nexec cat ${sq(keyFile)}\n`, { mode: 0o700 });
    fs.chmodSync(helper, 0o700);
  }
  const removeKey = () => { for (const f of [keyFile, helper]) { try { fs.unlinkSync(f); } catch {} } };

  // ── the login a profile holds: who and which plan, never a token ──────────────────────
  // .claude.json's oauthAccount is the account's description (email, plan name, org);
  // .credentials.json is read for its subscriptionType only, and only on Linux, where it is
  // a file — on macOS it is a Keychain item, and asking for one pops a dialog.
  function loginOf(cfg) {
    if (demo) return { loggedIn: true, email: 'equipo@acme.example', plan: 'Max', simulated: true };
    let acc = null, sub = null, cred = null;
    for (const f of ['.config.json', '.claude.json']) {
      try { acc = JSON.parse(fs.readFileSync(path.join(cfg, f), 'utf8')).oauthAccount || null; if (acc) break; } catch {}
    }
    try {
      const o = JSON.parse(fs.readFileSync(path.join(cfg, '.credentials.json'), 'utf8')).claudeAiOauth || {};
      sub = o.subscriptionType || null;
      cred = !!o.refreshToken;
    } catch {}
    const plan = acc?.planDisplayName || (sub ? sub[0].toUpperCase() + sub.slice(1) : null);
    return { loggedIn: !!acc && cred !== false, email: acc?.emailAddress || null, plan, org: acc?.organizationName || null };
  }
  async function codexOffers() {
    if (demo) return { ok: true, version: 'demo' };
    const v = await exec('codex', ['--version']);
    if (!v.ok) return { ok: false, why: t('mcp.codex.missing') };
    const h = await exec('codex', ['--help']);
    return /^\s*mcp-server\b/m.test(h.out)
      ? { ok: true, version: v.out }
      : { ok: false, version: v.out, why: t('mcp.codex.old', { version: v.out }) };
  }

  // ── applying to the profiles ───────────────────────────────────────────────────────────
  function setHelper(cfg, on) {
    const f = path.join(cfg, 'settings.json');
    let s = {};
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, text: msg('ai.step.cantRead', { file: f, why: e.message }) }; }
    if (on && s.apiKeyHelper && s.apiKeyHelper !== helperCmd) return { ok: false, text: msg('ai.step.ownHelper', { file: f }) };
    if (on === (s.apiKeyHelper === helperCmd)) return { ok: true, text: msg('ai.step.unchanged') };
    if (on) s.apiKeyHelper = helperCmd; else delete s.apiKeyHelper;
    fs.mkdirSync(cfg, { recursive: true });
    const tmp = `${f}.gfw-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
    fs.renameSync(tmp, f);
    return { ok: true, text: msg(on ? 'ai.step.on' : 'ai.step.off', { what: 'apiKeyHelper' }) };
  }
  async function setMcpIn(cfg, name, on) {
    const m = MCP[name];
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
    if (!on) {
      const r = await exec('claude', ['mcp', 'remove', '-s', 'user', name], { env });
      return { ok: true, text: msg(r.ok ? 'ai.step.removed' : 'ai.step.wasNot', { what: name }) };
    }
    await exec('claude', ['mcp', 'remove', '-s', 'user', name], { env });    // add refuses a name that exists
    const r = await exec('claude', ['mcp', 'add', '-s', 'user', name, '--', m.command, ...m.args], { env });
    return { ok: r.ok, text: r.ok ? msg('ai.step.added', { what: name }) : msg('ai.step.addFailed', { why: r.out.split('\n')[0] }) };
  }
  // Every profile the fleet's projects run on. One pass decides the whole state, so a mode
  // switched twice lands where the last switch says and not where the steps happened to stop.
  async function apply(ai) {
    const list = await profiles();
    const steps = [];
    const wantKey = ai.mode === 'api-key' && !!ai.key;
    for (const p of list) {
      const what = [msg(wantKey ? 'ai.step.on' : 'ai.step.off', { what: 'apiKeyHelper' }), ...Object.keys(MCP).map(n => msg(ai.mcp[n] ? 'ai.step.added' : 'ai.step.removed', { what: n }))];
      if (demo) { steps.push({ profile: p.profile, ok: true, parts: what, simulated: true }); continue; }
      const out = [setHelper(p.cfg, wantKey)];
      for (const n of Object.keys(MCP)) if (MCP[n].command) out.push(await setMcpIn(p.cfg, n, !!ai.mcp[n]));
      steps.push({ profile: p.profile, ok: out.every(o => o.ok), parts: out.map(o => o.text) });
    }
    ai.applied = { at: Math.floor(Date.now() / 1000), steps };
    save(ai);
    return ai.applied;
  }

  async function view() {
    const ai = load();
    const list = await profiles();
    const codex = await codexOffers();
    let keyOnDisk = false;
    try { keyOnDisk = fs.statSync(keyFile).isFile(); } catch {}
    return {
      demo, modes: MODES, mode: ai.mode, shared: ai.shared,
      key: ai.key && keyOnDisk ? { set: true, hint: ai.key.hint, by: ai.key.by, at: ai.key.at } : { set: false },
      perUser: ai.perUser,
      profiles: list.map(p => ({ profile: p.profile, login: loginOf(p.cfg) })),
      mcp: {
        codex: { on: !!ai.mcp.codex, label: MCP.codex.label, available: codex.ok, why: codex.why || null, command: 'codex mcp-server' },
        gemini: { on: false, label: MCP.gemini.label, available: false, why: MCP.gemini.why, command: null },
      },
      // Each step in the words of whoever is reading; rows from before carry a `text`.
      applied: ai.applied && { ...ai.applied, steps: ai.applied.steps.map(({ parts, ...s }) => (parts ? { ...s, text: parts.map(x => render(x)).join(' · ') } : s)) },
    };
  }

  // One POST, one action. Returns the new view; never echoes what was sent.
  async function act(me, b = {}) {
    const ai = load();
    const at = Math.floor(Date.now() / 1000);
    if (b.action === 'mode') {
      if (!MODES.includes(b.mode)) throw httpErr(400, t('err.badMode', { mode: String(b.mode).slice(0, 40) }));
      if (b.mode === 'shared-subscription') {
        if (b.accept !== true) throw httpErr(428, t('err.acceptShared'));
        ai.shared = { by: me.id, at };
      }
      if (b.mode === 'api-key' && !ai.key) throw httpErr(400, t('err.keyFirst'));
      ai.mode = b.mode;
      audit({ user: me.id, verb: 'ai_mode', subject: b.mode, result: 'ran', ...(b.mode === 'shared-subscription' ? { output: msg('act.warningAccepted') } : {}) });
    } else if (b.action === 'key') {
      const key = String(b.key || '').trim();
      if (!KEY_OK.test(key)) throw httpErr(400, t('err.badKey'));
      writeKey(key);
      ai.key = { hint: hint(key), by: me.id, at };
      audit({ user: me.id, verb: 'ai_key', subject: 'set', result: 'ran' });
    } else if (b.action === 'clear-key') {
      removeKey();
      ai.key = null;
      if (ai.mode === 'api-key') ai.mode = null;
      audit({ user: me.id, verb: 'ai_key', subject: 'cleared', result: 'ran' });
    } else if (b.action === 'per-user') {
      const user = String(b.user || ''), profile = b.profile ? String(b.profile) : '';
      if (!user) throw httpErr(400, t('err.noPersonArg'));
      if (profile && !PROFILE_OK.test(profile)) throw httpErr(400, t('err.badProfile', { profile: profile.slice(0, 40) }));
      if (profile) ai.perUser[user] = profile; else delete ai.perUser[user];
      audit({ user: me.id, verb: 'ai_profile', subject: user, args: { profile: profile || null }, result: 'ran' });
    } else if (b.action === 'mcp') {
      const name = String(b.name || '');
      if (!MCP[name]) throw httpErr(400, t('err.badMcp', { name: name.slice(0, 40) }));
      if (b.on === true) {
        if (!MCP[name].command) throw httpErr(400, MCP[name].why);
        const c = await codexOffers();
        if (!c.ok) throw httpErr(400, c.why);
      }
      ai.mcp[name] = b.on === true;
      audit({ user: me.id, verb: 'ai_mcp', subject: name, args: { on: b.on === true }, result: 'ran' });
    } else throw httpErr(400, t('err.badAction', { action: String(b.action).slice(0, 40) }));
    save(ai);
    if (b.action !== 'per-user') await apply(ai);
    return view();
  }

  return { view, act, apply, paths: { keyFile, helper, helperCmd } };
}
