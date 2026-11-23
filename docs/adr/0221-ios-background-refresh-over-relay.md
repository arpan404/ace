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
  the remembered daemon route. BGAppRefresh and push wakes share a bounded refresh. A cold
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
- After reading confirmed inbox state on a wake, the app writes the merged lock-screen
  snapshot and updates an existing Live Activity. The phone keeps the last confirmed summary
  when the transient connections close. The app can refresh while iOS grants execution time.
  The separately proposed ActivityKit push contract is recorded in ADR 0145.

## Tests

- The relay and daemon process test interrupts a feed with a registered phone away from its
  daemon, then reads after reconnect and resumes from the acknowledged position.
- The client grant-keeper tests simulate wall time passing while timers are suspended.
- The bridge and Swift tests cover push registration during wake, applying a feed once,
  releasing a transient machine and choosing a remembered route.
