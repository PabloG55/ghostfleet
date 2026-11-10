import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse } from './helpers/browse.mjs';
import { requestArrivals } from '../../../test/helpers/request-arrival.mjs';

for (const user of ['admin', 'viewer']) {
  test(`request arrival in the team app: ${user}`, { timeout: 180000 }, async t => {
    const { b, r, go } = await browse(t, { user });
    const admin = await r.login('admin');
    const failures = [];
    await requestArrivals({ b, app: 'team', readonly: user === 'viewer', shots: process.env.REQUEST_SHOTS || '',
      is: (name, want, got) => { if (JSON.stringify(want) !== JSON.stringify(got)) failures.push({ name, want, got }); },
      go: async () => {
        await r.call('POST', '/api/demo/reset', {}, admin);
        await go('/p/acme-web/s/stripe-billing', '.composer');
      },
    });
    assert.deepEqual(failures, []);
  });
}
