# 0221: iPhone background refresh uses the remembered daemon route

Status: proposed. Date: 2026-11-23. Extends [ADR 0087](0087-ios-local-notifications.md)
(notification catch-up), [ADR 0106](0106-ios-remote-push-gateway.md) (alert wakes) and
[ADR 0155](0155-relay-connect-in-one-round-trip.md) (relay sessions).

## Context

A phone waking in the background has a short execution window. Account discovery and
probing an unreachable paired address can consume that window before the phone reads its
notifications. Reading a feed also does not tell the daemon whether iOS applied it. The relay
can drop between the request, the response and the receipt.

## Decision

- A background launch opens remembered machines concurrently. It tries a known account relay
  first when available, falls back to a pinned direct route if the relay fails, and uses the
  remembered organization for member grants. An existing runtime keeps its cursor and wakes
  its connection. On wake an open socket checks the wall-clock deadline for grant refresh.
  A closed socket reconnects and obtains a current grant through the usual Keychain-backed route.
- The APNs alert payload requests a background fetch alongside extension delivery. The
  notification service extension renders the encrypted alert locally. When iOS wakes the app,
  it authenticates the payload, records the push's ID for deduplication and follows up over
  the remembered daemon route. BGAppRefresh and push wakes share a bounded refresh. Each OS callback reports its completion exactly once, by its
  own 25-second deadline, independent of the refresh's cooperative 18-second budget. Expiration
  reports failure at once, and a result the shared refresh returns afterwards is ignored. A cold
  wake can read the feed while iOS is still returning the push token, preserving the address
  already registered with the daemon. The authenticated welcome links the daemon ID in the
  push to the phone's directory entry. A relay-only machine can have a different directory ID.
- The phone sends its saved cursor with every feed read. The bridge holds one page until the
  native ledger applies it and saves the cursor. If the socket drops before application,
  the kept cursor and IDs determine what to retry. The ledger saves each landed alert ID so a
  retry after a partial batch can skip alerts already applied.
- `notification.feed` with an explicit `afterCursor` reads from that position. Omitting it
  reads from the authenticated device's daemon checkpoint, which starts at zero.
  `checkpoint: true` submits an already-applied cursor and returns the committed cursor
  with empty entry and retraction arrays. Checkpoints are per device and monotonic within
  a database. Rebuilding the notification database drops its checkpoints. A phone's explicit
  cursor beyond the new head restarts the scan over retained alerts. Explicit reads also let
  a client rebuild local state independently of the daemon checkpoint.
- One phone reached directly and over its account relay is two device ids, and the phone keeps
  one cursor per machine. The daemon serves one feed for both: a read includes the inbox rows
  of every id the pairing proof links to the socket's device (ADR 0115), each alert once at its
  first cursor, so a relay wake delivers alerts recorded for the direct pairing and neither
  route's head skips the other's. We chose this over a cursor per authenticated identity on the
  phone because that would only stop the skip: the relay wake would still find nothing.
- On an organization's host the feed is a filtered read: a member may request it, and the
  daemon keeps only entries and retractions of trees the member may read now (a summary only
  when every thread it names is readable). The member's checkpoint is their own device's. The
  host still refuses a member's phone registration, since pushes are not filtered per member,
  so the bridge goes on to the feed after that refusal and the wake can finish.
  Until pushes are filtered per member, a member's catch-up feed on an organization host is
  empty: the inbox records alerts only for registered phones, and opening registration to
  members would send them alerts for trees they may not read. The wake still finishes promptly
  with nothing in it. A member's feed cursor also stops at the newest entry their own device
  holds (their checkpoint when none), so it does not show how many alerts the host sends.
- A phone's linked ids go to the worker most recently seen first, account device first. The
  worker keeps sixteen, so past that the stalest pairings are dropped, and the daemon logs
  once per socket when it cuts the list.
- After reading confirmed inbox state on a wake, the app writes the merged lock-screen
  snapshot and updates an existing Live Activity. The phone keeps the last confirmed summary
  when the transient connections close. The app can refresh while iOS grants execution time.
  The separately proposed ActivityKit push contract is recorded in ADR 0145.

## Tests

- The relay and daemon process test interrupts a feed with a registered phone away from its
  daemon, then reads after reconnect and resumes from the acknowledged position.
- The feed process test reads an alert recorded for one paired id from a linked id, then
  returns to the first with the saved cursor and sees nothing twice.
- The policy, feed-view and `CompletionGate` unit tests cover a member's filtered feed and the
  exactly-once, deadline-bound completion.
- The client grant-keeper tests simulate wall time passing while timers are suspended.
- The bridge and Swift tests cover push registration during wake, applying a feed once,
  releasing a transient machine and choosing a remembered route.
