# 0087: iOS local notifications; remote push deferred

Status: accepted. Date: 2026-10-18. Refines ADR 0012 for the native iOS app (ADR 0074). The
remote push design is kept as a deferred proposal in
[drafts/ios-push-notifications.md](drafts/ios-push-notifications.md).

## Context

Waking a suspended iPhone needs APNs, and only the holder of ace's Apple team key can push to the
App Store build. The draft's answer is an ace-operated push gateway, which needs a hosted-service
exception to ADR 0002, an Apple Developer account and keys. On 2026-10-18 the owner deferred
remote push. The app still needs alerts with no server, no APNs and no key anywhere.

The draft also found that the router counts any open socket as delivered. An iPhone that leaves
the foreground can keep its socket open while suspended, so an alert sent there is lost silently.

## Decision

**Alerts come only from the daemon.** The app registers `notification.register { channel:
"websocket", platform: "phone" }` on every connection and posts each server `notification`
message with `UNUserNotificationCenter`. Swift never derives an alert from thread status, so the
worker's whole-tree rules, burst window, snooze, quiet hours and presence suppression (ADR 0012)
stay the only alert policy. The stable notification id is the request identifier, so a repeat
replaces rather than stacks.

**Presence carries app state.** `presence.update` gains an optional `appState: "foreground" |
"background"`. The app sends `background` when it leaves the foreground. The daemon sends no
`notification` frame to a socket whose app is backgrounded and doesn't count it as delivered, so
the router falls through to any push address, or retries a websocket-only phone. The flag lives
on the socket; a new socket starts in the foreground.

**Catch-up feed.** Alerts that arrive while the app is suspended are recovered from a bounded,
per-device feed in the notification database:

- When a delivery job for a `platform: "phone"` device passes policy (current, not snoozed, not
  quiet, not viewed elsewhere), the worker records the alert before its transport runs. A retry
  keeps its first row. Each device keeps its newest 100 rows; rows expire with the job (24 hours).
  Revocation and device eviction delete them.
- `notification.feed { requestId, afterCursor }` (read scope) returns `cursor` (the table's
  high-water mark), `entries` after the cursor that still match canonical state, and `retracted`:
  recent ids that no longer do (the thread went back to work, the approval was answered, the
  thread was snoozed, archived or deleted). The app withdraws retracted alerts it already showed,
  so a stale "done" never lingers. A cursor beyond the high-water mark means the database was
  rebuilt, and the feed starts over.
- The table is created with `CREATE TABLE IF NOT EXISTS` on open. Existing format-4 databases gain
  it without a format bump, and an older build ignores it.

The app runs catch-up on every connection and every return to the foreground, and in a
`BGAppRefreshTask` (`app.ace.ios.notifications.refresh`, scheduled when the app backgrounds).
The task connects briefly, catches up and disconnects within about 20 seconds. iOS decides when,
or whether, it runs. A per-host ledger on the phone (cursor plus the last 512 shown ids) admits
each id once, across the live path, catch-up and relaunches.

**Actions.** `ACE_APPROVAL` alerts get Allow and Deny, both `.authenticationRequired`, Deny
`.destructive`, only when the daemon supplied both option ids. An action reads the thread's
confirmed state first (not syncing, not unconfirmed); if the interaction isn't pending with that
option, it sends nothing. Otherwise it submits `interaction.resolve` with the exact option id
through the SDK's durable outbox and waits for the receipt. If the app can't reach a confirmed
state within its budget, it sends nothing and posts a notice that opens the thread. A tap opens
the thread. A notification grants no authority: operate scope and first-answer-wins still apply.

**Permission and settings.** The app asks for notification permission once, after the first
thread arrives from a paired machine, never at first launch. Settings › Notifications holds the
on/off switch, quiet hours (`notification.preferences`) and per-thread snooze
(`notification.snooze`).

## Consequences

- Alerts are reliable while the app is open or running in the background, and best effort after
  that. A suspended or terminated app shows missed alerts only when iOS runs background refresh
  or the user opens the app. The settings sheet says so.
- No Apple key, gateway, APNs token or hosted service exists. ADR 0002 is unchanged.
- The daemon's direct APNs transport (ADR 0012) is untouched. Its removal and the gateway stay in
  the deferred draft. Live Activities are out of scope.
- Quiet-hour alerts are still dropped, not held (draft contradiction 7). Catch-up doesn't revive
  them.

## Verification

- `packages/notify/src/inbox.test.ts` (temp SQLite): catch-up by cursor, one entry per retried
  alert, phones only, no done offered after the thread works again, presence and snooze
  suppression, restart and rebuilt-database cursors, revocation.
- `apps/daemon/src/notification-feed.server.process.test.ts` (real websocket, worker and temp
  SQLite): a backgrounded phone gets no live frame and catches up once; a reconnecting phone is
  told to withdraw a done alert after the thread resumed.
- `apps/ios/bridge/notifications.test.ts` (real SDK, fixture daemon): live alerts only while on,
  catch-up per cursor, an action answers the exact pending option once, stale actions send nothing.
- `apps/ios/Tests/NotificationTests.swift`: id replacement and ledger, retraction, category rules,
  action → bridge resolve → confirmation, unreachable actions send nothing.
