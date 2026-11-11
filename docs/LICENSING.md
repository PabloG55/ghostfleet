# Licensing: what is free, what is not

ghostfleet has two licenses. The core is MIT. The `ee/` folder, the Team edition, has its own
license.

**`ee/` now holds the Team edition: ghostfleet team (`ee/team`), the fleet in a browser for
several people.** It is free for up to 2 accounts, and it checks a subscription key before it
adds a third. Everything outside `ee/` is MIT and needs no key.

This page explains it in plain words. If anything here differs from the license files, the
files win: [`LICENSE`](../LICENSE), [`ee/LICENSE`](../ee/LICENSE) and [`CLA.md`](../CLA.md).

## The core: MIT

Everything outside `ee/` is MIT. Use it at work, fork it, ship it, sell it. You do not need to
ask me, and you do not need to pay.

## The Team edition: `ee/`

Code in `ee/` is under the ghostfleet Team License. You can read it, run it and change it.
The rules:

- **Free in production for up to 2 users.**
- **Free with any number of users to develop, test or evaluate it.** Trying it out with your
  whole team is fine. Doing your real work with it is not "testing".
- **3 or more users in production need a subscription.**
- **You may modify it for your own use.**
- **You may not** offer it to others as a hosted service, redistribute it, or work around the
  user count.

A "user" is a person with an account in the Team edition's multi-person mode, or who has used
it in the last 30 days.

## How ghostfleet team applies it

This is what the software does. The license text above is still what you agreed to.

- **What it counts.** Every account that is not disabled. Disabling an account frees its seat.
- **Up to 2 accounts need nothing.** No key, no sign-up, no network.
- **A subscription is a key.** A subscription (monthly or annual) gives you a license key: a
  line of text that starts with `gft1.` and carries your organization, a number of seats and
  an expiry date, signed so it cannot be edited. An admin pastes it in **Administration →
  License**. That page shows the organization, the seats, the expiry, whether the key is
  valid, and how many accounts count against it. The key is checked on your own server; it is
  stored in the server's data folder (`GFW_DATA`, mode 0600) and nowhere else.
- **Only adding an account is checked.** Creating an account (from the admin panel or with
  `server/admin-cli.mjs create-admin`) and re-enabling a disabled one are refused when they
  would go past your seats, with a message that says how many seats you have and where to
  paste a key.
- **Nobody is locked out.** If a key expires, is removed, or you already have more accounts
  than seats, everyone keeps signing in and working. Only new accounts are refused, and admins
  see a banner that says why. Other people see nothing.
- **The demo is not limited.** `pnpm demo` shows a sample license and stores nothing.

A key verifies against a public key that ships in `ee/seats/public-key.mjs`. A build where
that constant is empty cannot verify any key: it stays at the 2 free accounts and the License
page says so.

### The daily check, and how to turn it off

A subscription renews, and each renewal is a new key with a later expiry. So that nobody has
to paste a key every month, the server can ask the license service for the newest one.

- **What is sent.** One HTTPS `POST` with your current license key as JSON, `{"key":"gft1.…"}`.
  Nothing else: no account names, no account count, no project names, no usage.
- **When.** Once a day, and when an admin presses **Check now**.
- **What comes back is not trusted blindly.** A returned key replaces yours only if its
  signature verifies, it is for the same license and organization, and it expires later than
  the one you have. Anything else is ignored and the reason is shown on the License page. A
  failed check never changes what you are allowed to do.
- **How to turn it off.** Untick **Ask for the renewed key once a day** in **Administration →
  License**. From then on the server sends nothing, **Check now** included, and you paste each
  renewed key by hand. It is on by default.
- **When there is nothing to turn off.** The address of the license service is the constant
  `RENEW_URL`, next to the public key. A build where it is empty makes no request at all, and
  the License page says automatic renewal is not available yet.

No request is made while there is no key stored, and none in the demo.

## The npm package

The npm package does not ship `ee/`. `package.json` leaves it out of `files`, and it stays that
way. If you install ghostfleet from npm, you get the MIT core only.

## Contributing

Every contribution needs the [Contributor License Agreement](../CLA.md), once. That covers
changes to the core and to `ee/`.

- **Why.** It lets the project keep offering the core as MIT and `ee/` under the Team License.
- **What you keep.** Your copyright. The CLA is a license, not an assignment. You can use your
  own work anywhere else.
- **How you sign.** On your first PR, the CLA bot ([CLA Assistant](https://cla-assistant.io))
  comments with a link to the CLA, and the PR shows a `license/cla` check as pending. Follow the
  link, sign in with GitHub and accept. The check turns green, and the acceptance is recorded
  against your GitHub account, so it covers all your later PRs.

If you contribute for a company, ask in an issue first. A company needs a corporate version.

## Questions

**Can I use the core at my company?**
Yes. It is MIT.

**We are 2 people. Can we use Team?**
Yes, in production, for free.

**We are 5 people. Can we use Team?**
Not for real work without a subscription. For development, testing or evaluation, yes.

**Our subscription lapsed. Is the team locked out?**
No. Everyone keeps their access. You cannot add accounts beyond the free 2 until a renewed key
is in place.

**Does ghostfleet team phone home?**
Only the daily license check described above, only when a key is stored, and you can switch
it off. With up to 2 accounts and no key, it contacts nobody.

**Can I fork `ee/`?**
For your own use, yes, and you can change it. You cannot give your fork to others or run it
as a service for them.

**Can I fork the core and sell it?**
Yes. That is what MIT means. Keep the license notice, and note that the "ghostfleet" name is
not part of the license.

**Does the CLA take my code?**
No. You keep the copyright. You give the project a license to use your contribution, including
under the Team License.

**Do I need to do anything today?**
With the MIT core, or with ghostfleet team and up to 2 accounts: no. For a third account in
production you need a subscription key.
