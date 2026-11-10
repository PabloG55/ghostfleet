// Under the ghostfleet Team License; see ../LICENSE.
// renew.mjs: ask the license service for the newest key of the license this install already
// holds, and decide whether what came back may replace it. Pure: the caller hands in fetch,
// the clock and the current key, and stores the result. Nothing here schedules or persists.
//
// The contract with the service, all of it:
//   POST RENEW_URL   {"key":"<the current gft1 key>"}     nothing else is sent
//   200 {"key":"<gft1 key>"}   the newest key of that license
//   404                        the service does not know this license
//   anything else              a transient error
// A renewal keeps the license id and the organisation and has a later `expires`.
//
// The answer is never trusted for being an answer. It replaces the current key only when it
// verifies against the same public key, is in date, names the same id and org, and expires
// LATER. Without the last three a service that answered with some other customer's valid key,
// or replayed an older key of this one, would be obeyed.
import { verifyKey, describeKey, isoTime } from './index.mjs';
import { RENEW_URL } from './public-key.mjs';

const no = (reason, extra = {}) => ({ ok: false, reason, ...extra });

// Reasons, for the caller to word:
//   unavailable     no RENEW_URL in this build; no request was made
//   no-key          there is no key to renew; no request was made
//   current-invalid the stored key is not an authentic one (`detail` says why); no request
//   unknown-license the service answered 404
//   transient       network failure, timeout, another status, or a body that is not {"key"}
//   rejected        the returned key does not verify (`detail` is verifyKey's reason)
//   other-license   it verifies but names another id or org
//   not-newer       it is this license, and does not expire later than the key already held
export async function renewKey({ key, url = RENEW_URL, publicKey, now = new Date(), fetch = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (typeof url !== 'string' || !url.trim()) return no('unavailable');
  if (key == null || key === '') return no('no-key');
  const current = describeKey(key, { publicKey, now });
  if (!current.ok) return no('current-invalid', { detail: current.reason });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) { return no('transient', { detail: String(error?.name || 'error') }); }
  if (response.status === 404) return no('unknown-license');
  if (response.status !== 200) return no('transient', { detail: `status ${response.status}` });
  let next;
  try { next = (await response.json())?.key; } catch { return no('transient', { detail: 'body' }); }
  if (typeof next !== 'string') return no('transient', { detail: 'body' });

  const license = verifyKey(next, { publicKey, now });
  if (!license.ok) return no('rejected', { detail: license.reason });
  if (license.id !== current.id || license.org !== current.org) return no('other-license');
  if (!(isoTime(license.expires) > isoTime(current.expires))) return no('not-newer');
  return { ok: true, key: next, license };
}
