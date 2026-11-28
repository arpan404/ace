# Live Activities and alerts that stay current while ace is closed

Status: draft, 2026-11-24. Architecture: [ADR 0223](../adr/0223-one-live-activity-per-machine-driven-by-its-daemon.md).
Builds on [ADR 0106](../adr/0106-ios-remote-push-gateway.md) (push gateway),
[ADR 0145](../adr/0145-live-activity-push-counts-only.md) (counts only, never text),
[ADR 0221](../adr/0221-ios-background-refresh-over-relay.md) (background refresh over the relay)
and [ADR 0115](../adr/0115-one-device-one-machine.md) (one id per device).

## Problem

iOS suspends ace about 30 seconds after it leaves the screen, and we accept that: no fake
background modes. From then on the Lock Screen and Dynamic Island Live Activity freezes. Today
the app updates it locally (`pushType: nil`) and only while it runs, so within three minutes it
reads "as of 7:26 AM". It never appears for work that started while ace was closed.

A person who starts an agent on the Mac and walks away has to open ace to learn whether it needs
them. Uber and Uber Eats set the bar here: the Lock Screen stays current with the app closed,
and alerts arrive when something needs you.

## Solution

The daemon becomes the source of the Lock Screen while ace is closed. It sends Apple pushes
through ace's push gateway:

1. **Updates by push.** When a machine's agents change state (working, needs you, failed,
   settled), its daemon pushes an ActivityKit update to that machine's Live Activity, and ends
   the activity by push once all of its work has settled.
2. **Push-to-start.** When an agent starts working on a machine and no activity for that machine
   is showing, the daemon starts one on the phone without ace being opened.
3. **Alerts.** "Needs your approval", "finished" and "failed" keep arriving as normal
   notifications through the existing encrypted alert path (ADR 0106). This spec lists what is
   still missing for that to work on a shipped build.

What the person sees: one Live Activity per paired machine that has work going ("MacBook Pro:
1 needs you · 2 working"). The machine name, thread titles and the Allow/Deny request come from
the phone's own app-group snapshot, never from a push. A push carries counts only.

## Behaviour

### Showing the activity

1. A machine's Live Activity shows that machine's counts: needs you, working, failed (unseen),
   waiting (queue, recovery, network, provider, unresponsive), limited, background. Its
   headline uses the same words as today's `LockSummary.parts`.
2. The machine's name and up to three thread rows come from the app-group snapshot, and only
   when the snapshot's `seq` for that machine equals the content's `seq`. Otherwise the activity
   shows counts alone with "Open ace for details". A row never shows a status older than the
   counts beside it.
3. With two or more busy machines there are two or more activities. iOS stacks them on the Lock
   Screen; the Dynamic Island shows the most urgent (needs you first) as iOS decides.
4. Pushes never put text on the Lock Screen. Every word comes from the widget's fixed strings or
   from the phone's snapshot. The only exception is the push-to-start alert, whose text the
   gateway fixes ("ace" / "An agent started working").

### Correctness of state (AGENTS.md priority 1)

5. The daemon classifies every thread the phone may read with the same whole-tree rule its
   inbox rows use (the shared row status classifier in `@ace/ui-core`, fed by the daemon's
   tree status). A delegated child on another machine whose edge is not settled counts as
   working on the parent's machine.
6. The machine is **busy** while any thread works, waits, needs the person, is held at a limit,
   runs a background command, has queued or uncertain messages, is `unresponsive`, or is in
   the wake grace of ADR 0012. Unknown states count as busy.
7. The activity says **settled** only when nothing is busy. The daemon sends `end` only after
   the machine has stayed settled for 120 seconds (the app's `quietGrace` today), so a tree
   between turns or between delegations never reads as done.
8. The `end` content says what finished ("3 done · 1 failed") and stays on the Lock Screen for
   15 minutes (`dismissal-date`).
9. Work that starts again after `end` gets a new activity (push-to-start, or the app if open).
   An ended activity is never revived.
10. If the daemon goes offline, the activity goes stale at its `stale-date` (15 minutes after
    the last push) and reads "as of <time>", never a frozen "Working" and never "done".

### Ordering

11. Every push carries `aps.timestamp` (seconds) and a `seq` in `content-state`. Both increase
    strictly per machine, including across daemon restarts (the daemon persists the last value
    it sent and uses `max(last + 1, now)`). iOS ignores an update older than the content it
    shows, so a late push can't regress state.
12. Because `aps.timestamp` has one-second resolution, the daemon sends at most one update per
    activity per second; a second change in the same second waits for the next one and carries
    the newer state.
13. The app, while open, may update its machine's activity locally with richer rows, but only
    with a state whose `seq` is at least the activity's current `seq`. It never writes counts
    of its own; they come from the daemon's latest state over the socket.
14. A stale `end` can't undo newer work: `end` is sent only from a settled state, and a new
    activity has its own identity.

### Rate and priority

15. Priority 10: push-to-start, a rise in needs-you, a rise in failed, leaving needs-you to
    nothing, and `end`. Everything else is priority 5.
16. Priority-5 count changes are coalesced to one per 30 seconds per activity. An unchanged
    state is never sent, except a priority-5 heartbeat every 10 minutes while busy, which moves
    the stale date on.
17. If the phone reports frequent updates are off (`ActivityAuthorizationInfo
.frequentPushesEnabled`), the 30-second and 10-minute intervals double.
18. Quiet hours and snooze (ADR 0012) turn priority-10 updates into priority 5. Updates carry no
    alert and no sound.
19. On a gateway `429` the daemon waits for `Retry-After` and then sends only the newest state.

### Tokens

20. The phone sends each paired machine, in `notifications.sync`, its **push-to-start token**
    (`Activity<MachineActivityAttributes>.pushToStartTokenUpdates`) and, for that machine's own
    activity, the **activity push token** (`activity.pushTokenUpdates`), each with its APNs
    environment. A machine never receives another machine's activity token.
21. The daemon registers each token with the gateway as its own handle kind (`start`,
    `liveactivity`), cached like alert handles and renewed a day before expiry.
22. A new token replaces the old one. When the phone sees its activity end or be dismissed, it
    drops that token on the next sync. The daemon drops an activity token once it has sent
    `end` for it.
23. A phone that started an activity by push-to-start gets its update token when iOS next runs
    the app, and sends it over the remembered route (ADR 0221). Until then the daemon can't
    update that activity; the activity goes stale at its stale date rather than reading wrong.
24. Turning Live Activities off (in ace or in iOS Settings), turning `notifications.remotePush`
    off on the machine, unpairing, or revoking the device removes both tokens from the daemon.
25. One phone reached directly and over the relay (two device ids linked by ADR 0115) gets one
    Live Activity stream, not two: the daemon keys Live Activity state by token.
26. On an organization host, member phones get no Live Activity pushes, as with alerts
    (ADR 0221), until pushes are filtered per member.

### Gateway

27. `GET /v1/capabilities` returns `{ "kinds": ["alert", "liveactivity", "start"] }`. A `404`
    means an older gateway: the daemon sends alerts only and asks again after an hour.
28. `POST /v1/registrations` accepts an optional `kind` (`alert` by default). The handle seals
    the kind. An alert handle can't update or start an activity; a `liveactivity` handle can't
    send alerts or start; a `start` handle can only start. Wrong kind: `403`.
29. `POST /v1/activity/<handle>` takes the JSON body below, validates it against a fixed
    schema, and builds the APNs payload itself. An extra field, a string where a number belongs,
    or a value out of range gets `400`.
30. The gateway sends `apns-push-type: liveactivity`, topic `<bundle>.push-type.liveactivity`,
    the requested priority, and `apns-expiration` of the stale date. `410` and invalid-token
    reasons are remembered as for alerts.
31. The gateway logs route and status only, as today. Bodies, counts, tokens and handles are
    never logged.

### Alerts in the background

32. "Needs your approval", "finished" and "failed" keep coming through the encrypted alert path
    (ADR 0106) with Allow/Deny on approvals. A Live Activity update never replaces an alert.
33. Release and TestFlight builds carry the `aps-environment` entitlement (today only builds
    made with `ACE_PUSH=YES` do), so a shipped app gets an APNs token at all.

## Decisions

See ADR 0223 for why one activity per machine, why the daemon owns start and end, and why the
gateway builds the payload.

### Activity attributes and content state

Shared by the app and the widget extension. Times are integers (seconds since 1970) so no date
decoding strategy is involved; the schema must decode exactly what the gateway sends.

```swift
struct MachineActivityAttributes: ActivityAttributes {
    /// Which paired machine, as a phone-chosen slot (0...15) with no other meaning. The widget
    /// maps it to the machine's name and rows through the app-group snapshot.
    var slot: Int
    var version = 1

    struct ContentState: Codable, Hashable {
        var seq: Int            // strictly increasing per machine
        var at: Int             // seconds since 1970, when the daemon computed it
        var phase: String       // "busy" | "settled"
        var needsYou: Int, working: Int, failed: Int
        var waiting: Int, limited: Int, background: Int
        var done: Int           // finished since the activity started; shown on end
        var rows: [LockRow]?    // local updates only; a push never carries rows
    }
}
```

Unknown `phase` values decode as busy. Counts are clamped to 0...999 by the gateway.

### Daemon to gateway

`POST /v1/activity/<handle>`, VAPID authorization as today, `content-type: application/json`,
at most 1,024 bytes:

```json
{
  "v": 1,
  "event": "start" | "update" | "end",
  "timestamp": 1795500000,
  "priority": 5 | 10,
  "staleAfter": 900,
  "dismissAfter": 900,
  "slot": 0,
  "state": { "seq": 41, "at": 1795500000, "phase": "busy",
             "needsYou": 1, "working": 2, "failed": 0, "waiting": 0,
             "limited": 0, "background": 0, "done": 3 }
}
```

`slot` (0...15) is required for `start` and forbidden for `update` and `end`.
`dismissAfter` (0...14400) is required for `end` and forbidden for `start` and `update`.
`staleAfter` is 60...3600. Both dates are relative to `timestamp`.

### Gateway to APNs

```json
{
  "aps": {
    "timestamp": 1795500000,
    "event": "update",
    "content-state": { "seq": 41, "at": 1795500000, "phase": "busy", "needsYou": 1, "...": 0 },
    "stale-date": 1795500900
  }
}
```

`start` adds `"attributes-type": "MachineActivityAttributes"`, `"attributes": { "slot": 0,
"version": 1 }`, the fixed alert and `"input-push-token": 1` to request the update token on iOS 18
and later. `end` adds `"dismissal-date"`.

### Phone to daemon

`notifications.sync` gains an optional `liveActivity` object: `{ startToken?, activityToken?,
environment, frequentUpdates, slot }`. Older daemons ignore it. Removing the object removes
both tokens. On the wire the bridge sends it as `notification.register`'s optional
`liveActivity` (`PhoneLiveActivity` in `@ace/protocol`), registering again whenever it changes,
so a machine holds the tokens only while the phone is registered with it.

### Daemon

A pure scheduler (tested on its own) turns the machine's classified threads plus the clock into
the next push or nothing: rules 6 to 19. A thin shell feeds it the tree status changes the
notification worker already sees, persists `seq` and the last timestamp, and posts to the
gateway. It shares the alert path's settings (`notifications.remotePush`,
`notifications.pushGatewayUrl`), handle cache and backoff. Status mapping: `201` sent; `404`
re-register; `410` drop the token; `429` and `5xx` back off; anything else drop the update.

### Gateway limits

| Limit                             | Default      |
| --------------------------------- | ------------ |
| Updates per `liveactivity` handle | 240 per hour |
| Starts per `start` handle         | 12 per hour  |
| Live Activity body                | 1,024 bytes  |

Existing per-IP and per-daemon limits apply to every kind.

## Failure modes

- **Gateway down or old.** Alerts and activities fall back to today's behaviour: the app
  updates locally while it runs, and the activity goes stale when it doesn't.
- **APNs throttles priority 10.** Rules 15 and 16 keep priority 10 to moments the person must
  act. Throttled updates arrive late; `aps.timestamp` keeps a late one from regressing state.
- **Update token not yet known after push-to-start.** The activity shows its start state until
  its stale date. The daemon does not push-to-start again for that machine while a started
  activity is within its stale window.
- **Daemon restarts mid-work.** It reads the persisted `seq`, recomputes state and pushes the
  current one at priority 5.
- **Person dismisses the activity.** The phone drops the token; the daemon starts a new one only
  on the next transition into busy, not on the next count change.

## Privacy and security

- A push carries counts, a slot, a sequence and times. Apple and the gateway learn how many
  threads each machine has in each state, and when. No title, id, host id, question, preview,
  code or prompt leaves the Mac this way (ADR 0145, decision 1).
- The settings sentence beside "Push when the app is closed" says that alerts are encrypted and
  that Live Activity counts are visible to ace's push service and Apple.
- Tokens reach only the person's own paired daemons, over the authenticated socket (direct or
  account relay). Handles are sealed to the registering daemon's key, so only the daemon a phone
  paired with can push to that phone's tokens. A leaked handle is useless without that key.
- The gateway still holds no provider credentials, no database and no device directory
  (ADR 0002, ADR 0106). The APNs key is ace's own, in the existing gateway configuration; Live
  Activity pushes need no new secret.

## Testing

- **Gateway** (`apps/push-gateway` process tests against `testing/fake-apns.ts`): kinds can't be
  crossed; schema refusals; built headers (push type, topic, priority, expiration) and payload
  (timestamp, event, content-state, stale and dismissal dates, start attributes and fixed
  alert); per-kind limits; `410` memory; capabilities; logs carry no body or token. Old handles
  without a kind still send alerts.
- **Daemon scheduler** (pure, table tests): rules 6 to 19, in particular "never `end` while a
  child on another machine is pending", "never `end` within 120 seconds of being busy",
  "`seq` and timestamp increase across a restart", "two changes in one second send one push".
- **Daemon wiring** (one process test against a real local gateway and fake APNs): a thread
  working, asking, and finishing produces start, updates and end in order; `remotePush` off
  sends nothing; a revoked device's tokens are gone.
- **iOS** (Swift tests): the content state decodes the gateway's exact JSON (a shared fixture
  written by the gateway test); the widget shows rows only when snapshot `seq` matches; the
  local-update guard refuses a lower `seq`.
- **On a phone** (owner, development build against a sandbox gateway): lock the phone, start an
  agent on the Mac, see the activity appear, approve from the Lock Screen, see it end.

## Rollout

1. Deploy the new gateway first. It is backward compatible: old daemons keep sending alert
   handles, which open as `alert`.
2. Ship the daemon. It asks for capabilities and sends Live Activity pushes only to a gateway
   that lists them.
3. Ship the app. Older daemons ignore `liveActivity` in the sync; the app keeps updating
   locally for them.
4. The ADR 0106 deploy checklist still applies; nothing works on a shipped build until the
   gateway runs at `push.acehq.dev` and Release builds carry `aps-environment`.

## Work

1. #2758: gateway handle kinds, capabilities and the Live Activity route.
2. #2759: daemon stores and registers the phone's tokens (after #2758).
3. #2760: daemon pushes updates and ends the activity (after #2759).
4. #2761: iOS per-machine activity, tokens and pushed content-state (after #2758, #2759; parallel
   with #2760).
5. #2762: push-to-start from the daemon (after #2760, #2761).
6. #2763: alerts on shipped builds, gateway deploy and Release entitlement (independent).

## Out of scope

- Thread titles or any text in pushes (ADR 0145, decision 1, owner decision).
- Broadcast channels (iOS 18): they are for many viewers of one event.
- Android.
- Filtering pushes per organization member.

## Open questions

- **Titles on the Lock Screen while closed.** Counts only is the owner's decision of 2026-11-13.
  Uber-style "Fixing the login bug · Working" would need titles in plaintext pushes.
- **Push-to-start without opening ace.** Confirm on a device that iOS 18 wakes the app to deliver
  the update token after a push-to-start, and how quickly. If it doesn't reliably, a
  push-started activity can't be updated until ace next runs.
- **`NSSupportsLiveActivitiesFrequentUpdates`.** On by default here; owner to confirm.
