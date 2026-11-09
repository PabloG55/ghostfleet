# Licensing: what is free, what is not

ghostfleet has two licenses. The core is MIT. The `ee/` folder, the Team edition, has its own
license.

**Today `ee/` holds only its license. There is no Team code yet, so nothing in ghostfleet
needs a subscription.** Everything you can run today is MIT.

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
No. There is no Team code yet.
