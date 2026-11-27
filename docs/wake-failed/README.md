# Waking an asleep session

A tap on an asleep session wakes it before it opens: a card on a project's page, a row of its tree, or a boat on the board. While the wake is out the card reads **Starting**. The session's page opens only once `fleet-hibernate --wake` has answered yes, and the card it leaves behind is no longer **Asleep**. This is what the pill's hint ("one click wakes it") and the desk's ⏎ already did. The phone's shared screens had lost it: a tap opened the asleep session's page and stopped there.

A wake that fails says why. On a phone that is a bottom sheet; at a desk it is a centred dialog. It is never a toast and never a card in the page. The sheet carries what the wake printed: how the agent died, its last lines, and that it is still asleep, so trying again is safe. **Try again** wakes it again and opens the session if it comes up. The session header's **Wake**, and a send that could not wake its session, open the same sheet.

## Screenshots read

Every image was opened and read. They come from the fixture `web/fixtures/grid-asleep.json` (acme-api with two sessions asleep). docs-pass wakes. csv-export does not, because its folder was cleaned up. Only demo data is shown: the demo banner, the fixture projects and sessions, and `/Users/you/gf-demo` as the only home. Digests are recorded in `test/helpers/name-sweep.mjs`.

Every page puts the project's lead first (`web/ui/order.js`): `master` stands above every group heading, whatever it is doing. The two whole-page shots are drawn 390 wide and 1560 tall, so the lead and the asleep cards fit in one image. The sheet is shot at the phone's real 390×844.

- `390-asleep.png`: acme-api at 390, the whole page. `master` comes first, and docs-pass and csv-export are both **Asleep**, under "Paused or idle 2".
- `390-woken.png`: the same page after a tap on docs-pass woke it and opened it. Back on the page, docs-pass is **Ready**, under "Ready to review 3"; only csv-export is left asleep.
- `390-failed-sheet.png`: a tap on csv-export. The wake failed, so the session did not open, and a bottom sheet says why: "exited 1s after it started, before it showed a prompt … cannot cd to /Users/you/gf-demo/csv-export". It offers **Close** and **Try again**. `master` is the first card behind it.
- `1280-failed-dialog.png`: the same failure at a desk's width, as a centred dialog over the page. Behind it, `master` comes first, docs-pass is Ready, and csv-export's card still says **Asleep**.
