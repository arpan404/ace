# 0223: One Live Activity per machine, started, updated and ended by its daemon

Status: Accepted, amended 2026-11-28 (amendment 1). Date: 2026-11-24. The owner approved one Live Activity per paired machine,
driven by its daemon.
Amends [ADR 0145](0145-live-activity-push-counts-only.md): replaces decisions 2 (slots merged
on the phone), 3 (daemons never end the activity) and 4 (one handle kind), and refines 5.
Keeps 0145's decision 1 (counts only, never text) and 6 (one switch). Amends
[ADR 0106](0106-ios-remote-push-gateway.md), "Gateway contract (v1)": adds handle kinds, a
capabilities route and a Live Activity route. Spec:
[docs/specs/live-activity-push.md](../specs/live-activity-push.md).

## Context

iOS suspends ace about 30 seconds after it leaves the screen. The one Live Activity for all of
the person's agents (`AgentsLiveActivity`, content `LockSummary`) is updated locally, so it goes
stale within three minutes of suspension and never appears for work started while ace was
closed. The owner wants it to behave like Uber's: current while ace is closed, started by the
server, ended by the server.

ADR 0145 designed counts-only pushes for the single merged activity. Two of its choices block
what the owner now asks for:

- An ActivityKit push replaces the whole `content-state`, and each daemon knows only its own
  threads. 0145 therefore gave each machine a slot and had the widget merge the pushed slot
  with the app's snapshot of the others. The widget can't keep state between pushes, so a push
  from machine B drops machine A's pushed counts, and the snapshot it falls back to is only as
  fresh as the app's last run.
- For the same reason 0145 forbade daemons from ending the activity: only the app sees every
  machine. And push-to-start from one daemon would start an activity that knows nothing of the
  others.

Both problems come from several writers sharing one activity.

## Options considered

- **Keep one merged activity (ADR 0145).** No push-to-start and no end by push; the activity
  goes away only when the app runs. Fails the owner's goal.
- **Merged activity, each daemon sends every machine's counts.** Daemons would have to learn
  each other's state through the phone, which is suspended. Not possible.
- **One activity per thread** (the 2026-10-18 draft). Accurate, but one busy afternoon fills the
  Lock Screen, and every start spends a push-to-start. ace replaced per-thread activities with
  one activity on purpose.
- **One activity per machine (chosen).** Each activity has exactly one writer, its daemon, which
  sees that machine's whole trees. The daemon can start, update and end it correctly. Most people
  have one machine, so most see one activity; two busy machines show two.

## Decision

1. **One Live Activity per paired machine that has work going.** Attributes carry a phone-chosen
   slot (0 to 15) with no other meaning; the widget maps it to the machine's name and rows
   through the app-group snapshot. The existing all-agents activity is replaced.
2. **The daemon is the only source of the activity's state.** It starts it by push-to-start on
   a transition into busy, updates it on state changes, and ends it by push after the machine
   has been settled (nothing working, waiting, asking, limited, queued, unresponsive or in wake
   grace, across whole trees including children on other machines) for 120 seconds. The app,
   while open, may write the same state locally with rows added, never with an older `seq`.
3. **Pushes stay counts only** (ADR 0145, decision 1). The gateway builds the APNs payload from
   a fixed schema: counts, phase, `seq` and times. The only visible text a push can produce is the
   gateway's fixed push-to-start alert.
4. **Order is enforced by time and sequence.** Every push carries `aps.timestamp` and a
   `content-state.seq` that strictly increase per machine across restarts; at most one update per
   activity per second. iOS drops an update older than what it shows.
5. **Three sealed handle kinds: `alert`, `liveactivity`, `start`.** A handle can do only its
   kind. Handles sealed before this ADR open as `alert`. New routes: `GET /v1/capabilities`
   and `POST /v1/activity/<handle>`. A daemon uses Live Activity pushes only with a gateway whose
   capabilities list them, so old gateways keep working with new daemons.
6. **Priority 10 only where the person must act.** Start, a rise in needs-you or failed,
   needs-you clearing, and end. Everything else is priority 5, coalesced to 30 seconds, with a
   10-minute heartbeat while busy and a 15-minute stale date.

## Consequences

- The Lock Screen is current while ace is suspended or closed, and appears without opening ace.
- A person with two busy machines sees two activities. The Dynamic Island shows one or two, as
  iOS decides.
- The widget can show titles only when the app's snapshot matches the pushed `seq`; otherwise it
  shows counts alone. With ace closed for long, that is most of the time.
- The daemon gains a persisted per-machine `seq` and a pure scheduler; the gateway gains a
  schema it must keep in step with the Swift `ContentState`. A shared JSON fixture keeps them
  together.
- Push-to-start depends on iOS delivering the activity's update token to a woken app. If it
  doesn't, a push-started activity goes stale rather than wrong.
- It still depends on the ADR 0106 deploy checklist: a running gateway and a Release build with
  `aps-environment`.

## Tests

- Gateway process tests against the fake APNs: kinds can't be crossed, old handles open as
  `alert`, schema refusals, built headers and payload, capabilities.
- Daemon scheduler table tests: never `end` while any part of a tree is busy or within 120
  seconds of it; `seq` and timestamp increase across a restart; one push per second at most.
- Swift: `ContentState` decodes the gateway's fixture; a local update with a lower `seq` is
  refused.

## Amendment 1: no end while a remote child is watched

Accepted 2026-11-28 by the owner on #2778. It refines decision 3 (the daemon ends the activity)
for children delegated to other machines. Nothing else above changes.

A child on another paired machine counts as work on its parent's machine (spec rule 5). The
parent learns about it only by polling it with the ordinary `status` call (ADR 0078, ADR 0099),
and a poll only samples the child: the person there can start it again between two polls, and
the parent can't prove it stayed quiet.

1. **No `end` while this machine's ledger watches any remote child.** That is a child still
   working there (one whose pairing was lost included), or a settled child whose 24-hour
   re-check window is still open. A stop never confirmed counts while its window lasts.
   Once none is watched and the machine has been quiet for 120 seconds, the `end` goes.
2. **The check is bounded (ADR 0170).** Two `LIMIT 1` reads: the `machine_children_unsettled`
   partial index, and the `settled_at` range of `machine_children_settled`. Neither reads the
   settled history. They read the ledger directly, so the rule holds before the machines
   service starts.
3. **A held `end` is looked at again on the delivery lane's own timer**, one second later, with
   no other loop.
4. **A status answer counts only for the children it holds a view of.** A child left out of a
   successful reply learns nothing from it, so a reply can't advance or close a child's watch
   without saying anything about that child. A missing-thread refusal of a read of that child
   alone is still its answer.

**The cost, accepted.** A remote restart can't be missed, because no `end` goes while one could
happen unseen. In exchange, an activity whose work involved another machine stays up, reading
settled, until that child's re-check window closes: up to a day. It goes stale after 15 minutes
without a push (spec rule 10) and reads "as of" a time, never done. A stop never confirmed whose
window has ended is not waited on: it is shown as stopped, its cancel keeps going out (ADR 0052),
and finding it would need a side table filled in idle batches.

**Future work.** Ending sooner needs proof that every watched remote child stayed quiet: an `end`
that waits for a fresh read of each one, sent after the `end` came due, through the current
pairing, and not across an outage. A first version of that gate is on the `la-remote-fresh-read`
branch. Its reviews found faults in the remote-children subsystem that it relies on, which need
fixing first.

Tests: `apps/daemon/src/notification-activity-delivery.test.ts` (`end` waits while a remote
child is working and while a settled one is in its window, then goes once the window has closed
and 120 seconds have passed; a held `end` is looked at about once a second),
`apps/daemon/src/machines/child-ledger-watching.test.ts` (the check, and its plans against 50,000
retired rows), and `child-schedule.test.ts` and `children-recheck.process.test.ts` (an answer that
leaves a child out is no answer for it).
