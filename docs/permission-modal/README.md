# Requests stay above the page

Permission requests, agent questions, assistant approvals and quota notices use the shared dialog: centred at desktop width and a bottom sheet below 901px. Closing leaves a button in the existing composer space (approvals use a reserved 36px slot). The session keeps a dismissed request closed across polls and navigation, and clears an open dialog when its request disappears. Team project viewers can inspect but cannot answer.

## Arrival proof

The arrival row was run against the old inline card first. At 390px the tabs moved from y=209.92 to y=596.73; at 320px from y=225.92 to y=677.17; at 1280px from y=136.63 to y=490.19. The old client opened no dialog. The same row was also run against a team build loading the old session component: at 390px the tabs moved from y=228.92 to y=598.48, and the 320px and 1280px arrival rows failed too. The replacement keeps the tabs, chat and composer rectangles identical before arrival, after arrival and after dismissal.

`node test/helpers/phone-check.mjs --arrival-only` runs the focused rows. The normal phone browser group includes them. `node --test ee/team/test/request-arrival.test.mjs` runs the same arrival sequence against the built team demo for an admin and a project viewer, with data under the system temp directory.

The rows also exercise X, outside press, Escape, returning to the session, a different fingerprint, remote disappearance, and the original answer payload sent once (including desktop number keys). The existing dialog audit includes permission and assistant approval dialogs.

## Screenshots read

Every image below was opened and read. Only fixture/demo data is shown. Digests are recorded in `test/helpers/name-sweep.mjs`. The numbered choices and their colours intentionally retain the existing content, including all three choices on desktop.

Only these four PNGs are retained in git. Every width and state, including 320px and both team roles, was shot and read; the remaining captures are held in the review temp directory.

| View | Screenshot |
|---|---|
| Phone 390, open | [phone-390-open.png](phone-390-open.png) |
| Phone 390, dismissed (re-shot) | [phone-390-closed.png](phone-390-closed.png) |
| Desktop 1280, open | [phone-1280-open.png](phone-1280-open.png) |
| Team viewer 390, open | [team-390-readonly-open.png](team-390-readonly-open.png) |

Choices fill one column in every view, the dialog container receives automatic focus without a keyboard ring, and Tab gives the X its keyboard ring. The return button uses the request's yellow, an icon and a pointer cursor, fills exactly the input's reserved box, and leaves Send disabled while the request is pending. The arrival rows assert each behavior.

## Sweep decisions

- Converted: session permission requests and agent questions (`web/ui/session.jsx`), the session quota notice, and assistant approvals on Home and in the assistant panel (`web/ui/assistant.jsx`).
- Left for review: `web/ui/phone-screen.jsx` and `views.jsx` polling errors are read failures, with no required answer; their inline error messages may still move surrounding content.
- Left for review: `web/ui/terminal.jsx` connection notices include reconnect/sign-in paths in the dedicated terminal view; changing their recovery flow needs a separate decision.
- Left for review: `web/ui/tasks.jsx` task questions and failures are rows of the dedicated task list responding to a submitted task; it is unclear whether they should interrupt the current screen.
- Left for review: `web/ui/automations.jsx` fresh run notices and paused-run warnings are informational status on the dedicated Automations screen; they can still expand its list.
- Left for review: `web/ui/accounts.jsx` changing login/usage states and `voices.jsx` background voice-install failures are status in a dedicated picker, not pending agent decisions.
- Left for review: the phone-only notifications opt-in (`web/src/phone.jsx`, styled by `web/ui/ui.css`) appears after unlock; it is optional and outside the shared request flow.
- Already overlays: toasts, automation notices delivered as toasts, the task chip, menus, popovers, assistant panel and confirms. User-opened details, forms and attachment feedback remain at their trigger.

Load path: unchanged. No live fleet or runtime was used for validation.

The generic `look.mjs` audit was also run at 390 and 1280 and its images read. Its remaining findings are the existing terminal skin's spacing/type/accent system, a contrast report on the disabled Send button, a branch name containing `null`, and background text deliberately covered by the modal. Those were left unchanged for this focused fix. The arrival rectangle checks and dialog behavior checks are the acceptance tests here. Physical phone keyboards and a deployed runtime are unchecked; validation used headless Chrome and fixtures only.
