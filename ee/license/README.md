# Offline Team subscriptions

This standalone module is under the [ghostfleet Team License](../LICENSE).
It uses Node builtins and makes no network calls. A later change will wire it into
the team app. Count active accounts before calling it; account storage belongs to
the app.

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

The owner runs the following from a case-sensitive checkout (the `ee/LICENSE`
file and `ee/license/` directory require distinct paths). Choose a persistent,
private directory outside both the repository and the home directory:

```sh
KEY_DIR=/secure/ghostfleet-signing
node ee/license/mint.mjs keygen --out "$KEY_DIR"
```

The directory must be writable by the owner. This creates `private.pem` with mode
0600 and `public.pem`, refuses existing keys, and prints an `export const
PUBLIC_KEY = ...;` line. Paste that line over the placeholder in `public-key.mjs`.
Keep the private PEM offline; never commit it or put it in a home directory.

```sh
node ee/license/mint.mjs mint --private "$KEY_DIR/private.pem" \
  --org acme-api --seats 5 --expires 2031-01-01
node ee/license/mint.mjs check '<key>' --public "$KEY_DIR/public.pem"
node ee/license/mint.mjs check '<key>'
```

Minting requires an explicit Ed25519 private PEM and a future expiration date.
`check` exits 0 for a valid key and 1 otherwise. Key generation refuses output
inside the repository or home directory, including through symlinked ancestors.

Run `node --test ee/license/test/*.test.mjs` or
`./test/run.sh "offline Team license and seats"`. Tests generate only disposable
pairs inside an OS temporary directory outside the checkout and home directory,
then remove them. The shipped placeholder remains empty.
