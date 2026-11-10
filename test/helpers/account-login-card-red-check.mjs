import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(new URL('../..', import.meta.url).pathname);
const mutations = [
  ['profile', "card.append(el('div', { class: 'c-name account-profile', text: row.profile }));", '', '390 pending: profile in large type'],
  ['finish', 'await api.finishAccountLogin(row.project, row.id, callback, assertion)', 'await api.finishLogin(row.project, row.id, callback, assertion)', '390 finish uses dedicated verb'],
  ['history', "let callback = input.value; input.value = '';", "let callback = input.value; localStorage.setItem('bad-draft', callback); input.value = '';", '390 callback absent from page and storage'],
  ['target', 'api.startAccountLogin(row.project, row.session, row.sock)', "api.startAccountLogin(row.project, 'master', row.sock)", '390 Sign in sends one session to its own host'],
  ['fleet', 'api.startAccountLogin(row.project, row.session, row.sock)', 'api.startAccountLogin(row.project, row.session)', '390 Sign in sends one session to its own host'],
];
for (const [name, from, to, assertion] of mutations) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'account-card-red.'));
  try {
    const web = path.join(tmp, 'web'); fs.cpSync(path.join(root, 'web'), web, { recursive: true });
    const file = path.join(web, 'app.js'), text = fs.readFileSync(file, 'utf8');
    if (!text.includes(from)) throw new Error('mutation target missing');
    fs.writeFileSync(file, text.replace(from, to));
    const r = spawnSync(process.execPath, [path.join(root, 'test/helpers/login-card-check.mjs'), web, '', 'account'],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    const failed = r.stdout.split('\n').map(line => line.split('\x1f')).filter(a => a.length === 3 && a[1] !== a[2]).map(a => a[0]);
    const hit = failed.includes(assertion);
    console.log(`${name}: ${hit ? 'RED observed' : 'FAILED mutation proof'} (${failed.length} red assertions)`);
    if (!hit) process.exitCode = 1;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
