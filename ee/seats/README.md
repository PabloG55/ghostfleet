# Offline Team subscriptions

This standalone module is under the [ghostfleet Team License](../LICENSE).
It uses Node builtins. Verifying a key and checking seats make no network calls; the
one function that does, `renewKey`, is handed its `fetch` by the caller and makes no
request while `RENEW_URL` is empty. The team app calls this module from
`ee/team/server/license.mjs`, which counts the accounts (those not disabled), stores
the key and schedules the renewal; account storage belongs to the app.

`verifyKey(key, { publicKey, now })` verifies an Ed25519 signature and returns
`{ ok: true, org, seats, expires, id }`, or `{ ok: false, reason }`. Reasons are
`malformed`, `bad-signature`, `unknown-version`, `expired`, and `no-public-key`.
Bad input never throws. The default public key is `PUBLIC_KEY` in
`public-key.mjs`, shipped as an empty placeholder: all keys fail `no-public-key`
until the owner installs the public key.

Keys have the form `gft1.<base64url(payload bytes)>.<base64url(signature)>`.
The signature covers the exact UTF-8 JSON payload bytes:

```json
{"v":1,"id":"acme-api-subscription","org":"acme-api","seats":5,"issued":"2030-01-01","expires":"2031-01-01"}
```

IDs and organizations are nonempty strings; seats are positive safe integers.
Dates accept `YYYY-MM-DD` or UTC timestamps with seconds and optional three-digit
milliseconds. Expiration is exclusive: `2031-01-01` expires at the start of that
UTC day. `now` defaults to the current time and can be a Date, epoch milliseconds,
or a date string for testing.

`seatCheck({ users, key, publicKey, now })` returns
`{ allowed, free: 2, seats, reason }`. Up to two active accounts are free.
A valid subscription allows its seat count (at least the free two); exceeding it
returns `seat-limit`. Success has `reason: null`. Invalid keys retain their
verification reason; absent keys within the free allowance have `reason: null`.

An authentic expired subscription keeps existing accounts allowed and reports
`reason: 'expired'` for an admin banner, with `seats: 2` for current capacity.
Use `canAdd` with the **current** account count before creating an account: it
checks one additional account and refuses additions beyond two on expiration.
A forged or malformed key cannot grant the existing-account exception. These
functions provide policy decisions; the app must enforce creation checks.

`describeKey(key, { publicKey, now })` reads an authentic key whether or not it is
in date: `{ ok: true, org, seats, expires, id, expired }`, or the same failures as
`verifyKey` except `expired`. It is for a screen that has to name a lapsed
subscription and for the renewal comparison below. It grants nothing; only
`verifyKey`, `seatCheck` and `canAdd` decide what is allowed.

## Renewal

A subscription renews, and each renewal is a new key: the same `id` and `org`, a
later `expires`. `RENEW_URL` in `public-key.mjs`, next to `PUBLIC_KEY`, is the
license service's address. It ships empty, and empty means renewal is unavailable:
no request is made.

`renewKey({ key, url, publicKey, now, fetch, timeoutMs })` in `renew.mjs` asks once
and decides. `url` defaults to `RENEW_URL` and `fetch` to the global one; nothing is
stored or scheduled here.

- Request: `POST url` with the JSON body `{"key":"<current gft1 key>"}` and nothing
  else. Redirects are refused.
- `200 {"key":"<gft1 key>"}` is the newest key of that license; `404` is an unknown
  license; anything else is a transient error.
- The returned key is accepted only if `verifyKey` passes, its `id` and `org` equal
  the current key's, and its `expires` is later. An expired current key can be
  renewed; a key that is not authentic cannot, and is never sent.

It returns `{ ok: true, key, license }`, or `{ ok: false, reason, detail? }` with the
current key left for the caller to keep:

| reason | meaning | request made |
|---|---|---|
| `unavailable` | `url` is empty | no |
| `no-key` | there is no key to renew | no |
| `current-invalid` | the current key is not authentic (`detail`: why) | no |
| `unknown-license` | the service answered 404 | yes |
| `transient` | network error, timeout, another status, or a body without a string `key` | yes |
| `rejected` | the returned key does not verify (`detail`: `verifyKey`'s reason) | yes |
| `other-license` | it verifies and names another `id` or `org` | yes |
| `not-newer` | same license, and it does not expire later than the current key | yes |

## Owner tooling

The owner runs the following from the repository root. Store the signing pair
in a private directory outside every Git worktree:

```sh
KEY_DIR="$HOME/.config/ghostfleet-license"
node ee/seats/mint.mjs keygen --out "$KEY_DIR"
```

The directory must be writable by the owner. Key generation creates or secures it
with mode 0700, creates `private.pem` with mode 0600 and `public.pem`, refuses
existing keys, and prints an `export const
PUBLIC_KEY = ...;` line. Paste that line over the placeholder in `public-key.mjs`.
Keep an offline backup of `private.pem` in a password manager. Losing the private
key means every existing customer key must be reissued. Never commit the PEM.

```sh
node ee/seats/mint.mjs mint --private "$KEY_DIR/private.pem" \
  --org acme-api --seats 5 --expires 2031-01-01
node ee/seats/mint.mjs check '<key>' --public "$KEY_DIR/public.pem"
node ee/seats/mint.mjs check '<key>'
```

Minting requires an explicit Ed25519 private PEM and a future expiration date.
`check` exits 0 for a valid key and 1 otherwise. Key generation refuses output
inside this repository or any other Git worktree, including through symlinked
ancestors. A home directory is allowed when it is outside a Git worktree.

Run `node --test ee/seats/test/*.test.mjs` or
`./test/run.sh "offline Team seats"`. Tests generate only disposable
pairs inside OS temporary directories, including a temporary HOME, then remove
them. The shipped placeholder remains empty.
