// fleet-tab owns creation/naming, just as it does for fleet-serve and the desk.
import path from 'node:path';
import { execFile } from 'node:child_process';

const missing = () => Object.assign(new Error('No such project or terminal tab.'), { status: 404 });
// Internal hyphens are necessary for acme-web and _term-acme-web. No caller can
// supply tmux target syntax; a derived tab must also match the freshly read list.
export const literalProject = name => typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(name);
const run = (cmd, args, env) => new Promise((resolve, reject) => {
  execFile(cmd, args, { encoding: 'utf8', timeout: 15000, env: { ...env, TMUX: '' } },
    (err, stdout) => err ? reject(err) : resolve(String(stdout || '').trimEnd()));
});

export function createTerminalTabs({ projects, home, env = () => process.env }) {
  const target = project => {
    if (!literalProject(project)) throw missing();
    const t = projects().find(t => t.name === project);
    if (!t) throw missing();
    return t;
  };
  const listed = async (t, session, kind) => {
    if (!['term', 'edit'].includes(kind) || session !== `_${kind}-${t.name}`) throw missing();
    const names = (await run('tmux', ['-u', '-L', t.sock, 'list-sessions', '-F', '#{session_name}'], env())).split('\n');
    if (!names.includes(session)) throw missing();
  };
  return {
    async openTerminal(project, kind) {
      const t = target(project);
      if (kind !== 'term' && kind !== 'edit') throw Object.assign(new Error('Invalid terminal kind.'), { status: 400 });
      let session;
      try {
        session = (await run(path.join(home, 'bin', 'fleet-tab'),
          [kind, t.sock, t.path, t.name, '-f', path.join(home, 'tmux', 'cf.tmux.conf'), '-d'], env())).split('\n').pop();
      } catch {
        throw Object.assign(new Error(kind === 'edit'
          ? 'no editor on this machine — the installer adds Neovim, or set CLAUDE_FLEET_EDITOR'
          : 'Could not open the terminal tab.'), { status: 502 });
      }
      await listed(t, session, kind);
      await run('tmux', ['-u', '-L', t.sock, 'set-option', '-w', '-t', session, 'window-size', 'latest'], env());
      return { sock: t.sock, session };
    },
    async checkTerminal(ticket) {
      const t = target(ticket.project);
      if (t.sock !== ticket.sock) throw missing();
      await listed(t, ticket.session, ticket.kind);
    },
  };
}
