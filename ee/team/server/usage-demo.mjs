// server/usage-demo.mjs — five weeks of pretend usage for the demo, so the admin panel has
// something to show. Built from whoever was created at setup and the demo's own projects, and
// the same every time for the same people (a seeded generator, not Math.random): a panel that
// reshuffles on every poll reads as broken.
//
// The shape is what a real team looks like: weekdays busy and weekends near zero, a heavy
// user, a light one, and — so a cap can be seen doing its job — one person whose demo cap is
// already used up today and one at about two thirds of it.
import { capTokens, periodStarts } from './usage-ledger.mjs';

function rng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const MODELS = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
// Turns per weekday, by position in the team: the first is the admin and works a lot.
const PACE = [14, 22, 9, 5, 12, 7];

const DAILY_CAP = 1_500_000, MONTHLY_CAP = 30_000_000;

// Demo caps: only for a user who has never had one set (tokenCap undefined). The admin's null
// and anything typed in the panel win.
export function demoCap(users, u) {
  const i = users.findIndex(x => x.id === u?.id);
  if (i < 1) return null;
  return i === 1 || i === 2 ? { daily: DAILY_CAP, monthly: MONTHLY_CAP } : null;
}

export function demoRows(users, projects, nowSec) {
  const rows = [];
  const sessions = projects.flatMap(p => p.sessions.map(s => ({ project: p.name, session: s.name })));
  if (!sessions.length || !users.length) return rows;
  const { day } = periodStarts(nowSec);
  users.forEach((u, i) => {
    const r = rng(u.id);
    // Each person keeps to two or three projects, like people do.
    const mine = sessions.filter((_, k) => (k + i) % 3 !== 0);
    const pace = PACE[i % PACE.length];
    for (let d = 34; d >= 0; d--) {
      const start = day - d * 86400;
      const dow = new Date(start * 1000).getDay();
      const n = Math.round(pace * (dow === 0 || dow === 6 ? 0.15 + r() * 0.2 : 0.6 + r() * 0.8));
      for (let k = 0; k < n; k++) {
        const ts = Math.floor(start + 9 * 3600 + r() * 9 * 3600);
        if (ts > nowSec) continue;
        const s = mine[Math.floor(r() * mine.length)] || sessions[0];
        const calls = 3 + Math.floor(r() * 25);
        rows.push({ ts, user: u.id, project: s.project, session: s.session, model: MODELS[Math.floor(r() * MODELS.length)],
                    input: calls * (2 + Math.floor(r() * 40)), output: Math.floor(calls * (150 + r() * 900)),
                    cacheRead: Math.floor(calls * (30000 + r() * 70000)), cacheWrite: Math.floor(calls * (800 + r() * 4000)),
                    id: `demo:${u.id}:${d}:${k}` });
      }
    }
  });
  // The second person has used up today's cap; the third sits at about two thirds of it.
  const top = (i, frac) => {
    const u = users[i];
    if (!u) return;
    const today = rows.filter(x => x.user === u.id && x.ts >= day).reduce((n, x) => n + capTokens(x), 0);
    const want = Math.floor(DAILY_CAP * frac) - today;
    if (want <= 0) return;
    const s = sessions[i % sessions.length];
    rows.push({ ts: Math.max(day, nowSec - 1800), user: u.id, project: s.project, session: s.session, model: 'claude-opus-5-5',
                input: 1200, output: Math.floor(want * 0.2), cacheRead: want * 9, cacheWrite: want - 1200 - Math.floor(want * 0.2),
                id: `demo:${u.id}:push` });
  };
  top(1, 1.04);
  top(2, 0.66);
  return rows;
}
