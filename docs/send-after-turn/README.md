# Send after this turn

A message sent to a session that is working goes into its running turn: the agent reads it at its next step, labelled as queued work to do after the task in hand (a message that says stop, instead or first do still switches). Waiting for the turn to end is the sender's choice. In the composer, holding the Send button, or right-clicking it on a desk, opens **Send to {session}** with two choices:

- **Send now**: into the running turn if there is one, the same as a tap.
- **Send after this turn**: held until the turn ends, then run as a turn of its own (`fleet_send` with `after_turn`; it shows in the session's queue and can be taken back).

It opens as a bottom sheet on a phone and a centred dialog on a desk. Nothing is added to the composer, so the layout around the thumb does not move. A tap still sends at once. A long press neither sends nor picks a choice when the finger lifts.

## Screenshots read

Every image was opened and read. Only demo data is shown: the demo banner, acme-api's master and its fixture conversation. Digests are recorded in `test/helpers/name-sweep.mjs`.

- `phone-390-composer.png`: the composer at rest at 390 with a draft typed. It is the same composer as before, with no new control in it.
- `phone-390-send-sheet.png`: Send held at 390: the bottom sheet with both choices, each saying what it does. The Send button stays at 328,758 46×46 underneath.
- `desk-1280-send-menu.png`: Send right-clicked at 1280: the same choices as a centred dialog over the session.
