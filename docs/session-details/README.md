# A session's Details

What a session left listening, running or booted, read from the last scan (`lib/ports.mjs`, refreshed by the governor every 5 minutes) and never polled. It opens from **Details…** in the session's More, right under the branch, PR, label and schedule that a phone's one-row header moves there. It is a centred dialog on a desk and a bottom sheet below 901px. Every row says how it was tied to the session: its parent chain reaches the session's pane, it runs in the session's folder, or a compose label, a bind mount or a process naming a simulator says so. The line at the top is the flag, shown here and in `fleet-ports` and nowhere on a card. It calls the session what its header chip does ("Ready — still listening on :5173"). A phone and a paired host read it; only the owner's browser on this machine is offered a scan.

## Stopping one row

On the desktop at localhost, each row of a personal project's session gets a **Stop**. It opens a modal naming that one row, and a confirmed stop sends TERM to the pid the sheet showed. The daemon first re-reads that pid's start time and command, and refuses if either changed. A container gets `docker stop`, a simulator `simctl shutdown`. If TERM leaves the process running, the row says so and offers **Force stop…**, behind a second modal, which sends KILL. A work-profile project never offers a stop, and neither does the phone: the daemon offers one only to a direct localhost request and refuses everything else with a 400. `fleet-ports stop` is the same from a terminal.

## Screenshots read

Every image was opened and read. Only demo data is shown: the demo banner, the fixture projects and sessions, and `/Users/you/gf-demo` as the only home. Digests are recorded in `test/helpers/name-sweep.mjs`.

- `phone-390-more.png`: More on a phone, Details beside the branch and PR.
- `phone-390-open.png`: Details as a bottom sheet at 390, a done session still holding two ports and a container, flagged "Ready — …" as its chip says. A work-profile project: no stop, wherever it is opened.
- `phone-1280-open.png`: the same at 1280, as a centred dialog. Its flag reads "Ready — …", the header chip's word.
- `desk-1280-stop-confirm.png`: the desktop at localhost, the demo's personal project. Each row has a Stop, and the modal over the sheet names the one row it would stop, `:5173 node (pid 51240)`.
- `phone-390-no-stop.png`: the same session on the phone: the same rows, and no stop control at all.
