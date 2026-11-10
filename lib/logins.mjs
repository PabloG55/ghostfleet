import fs from 'node:fs';
import path from 'node:path';

// Derive scope from the registered socket AND profile directory, as other fleet reads do.
// The record's project label is descriptive; it is never authority to expose a project.
export function loginRecords(projects) {
  const out = [];
  for (const t of projects) {
    const dir = path.join(t.cfg, 'fleet', 'logins');
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
      try {
        const file = path.join(dir, name), r = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (r.sock === t.sock && name === `${r.id}.json`) out.push({ ...r, project: t.name, file });
      } catch {}
    }
  }
  return out;
}

export function loginList(projects, now = Date.now()) {
  const records = loginRecords(projects);
  return records.map(({ file, state, port, path: callbackPath, ...r }) => ({ ...r,
    status: r.used ? (r.result || 'used') : r.expires <= now ? 'expired' : 'pending',
    // Prior authorizations, including consumed ones, remember a site across devices.
    first_site: !records.some(x => x.provider === r.provider && x.created < r.created),
  }));
}

