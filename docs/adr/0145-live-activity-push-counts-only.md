# 0145: Live Activity pushes carry one machine's counts, never text

Status: Proposed. Decision 1 decided by the owner on 2026-11-13; decisions 2 to 6 await
approval. Date: 2026-11-13. Amends [ADR 0106](0106-ios-remote-push-gateway.md), "Gateway
contract (v1)": adds a second handle kind. Supersedes the "Live Activity for a working thread"
section of [drafts/ios-push-notifications.md](drafts/ios-push-notifications.md).

## Context

The iPhone shows one Live Activity for all of the person's agents (`AgentsLiveActivity.swift`).
Its content is a `LockSummary`: counts plus up to six rows with thread titles, merged across
every paired machine. Today it updates only while ace runs (`pushType: nil`), so a suspended app
leaves it stale within three minutes.

ADR 0106 gives alerts end-to-end encryption: the gateway and Apple see ciphertext, and a
Notification Service Extension decrypts it. Live Activities have no such extension. iOS decodes
a Live Activity push's `content-state` itself, so whatever a push carries is readable by the
gateway and by Apple.

Two more facts shape the design:

- A push replaces the activity's whole `content-state`. Each daemon knows only its own threads.
  If machine A pushed its counts, it would erase machine B's, and an activity could read "nothing
  working" while B works. That breaks AGENTS.md priority 1.
- The widget extension can read the app group. The app already writes the lock-screen snapshot
  there (`LockSnapshotStore`), titles included, and those titles never leave the phone.

## Options considered

- **Full content in pushes.** This gives the richest Lock Screen, but the gateway and Apple
  would read thread titles. ADR 0106 promises they never do. Rejected by the owner.
- **No Live Activity push.** The activity goes stale whenever the app is suspended, which is
  exactly when it matters. Rejected by the owner.
- **Background pushes (`content-available`) that wake the app to refresh.** iOS throttles them
  and never delivers them to an app the person force-quit. The activity would still go stale.
- **Counts only, merged on the phone (chosen).** A push carries one machine's numbers. The widget
  combines them with the phone's own snapshot of the other machines.

## Decision

1. **A Live Activity push carries bounded integers and timestamps only.** No titles, thread ids,
   host ids, questions or previews. The gateway builds `content-state` itself from a fixed schema,
   with counts of needs-you, working, failed, waiting and limited threads, a slot number, a
   sequence number and the time. It refuses a body with any other field or a value out of range.
   Apple and the gateway learn how many threads each machine has in each state, and when.
2. **Each machine owns one slot, and the phone merges.** At registration the phone gives each
   paired machine a small slot number (0 to 15) that carries no other meaning. A push fills only
   its own slot. The widget view shows the pushed slot's counts, takes every other machine's
   last counts from the app-group snapshot, and marks those "as of" the snapshot time. A machine
   the snapshot knows as busy stays busy until it says otherwise.
3. **Daemons never end the activity.** Only the app ends it, because only the app sees every
   machine. A daemon whose own threads have gone quiet pushes zero counts. The app's existing
   rule (`AgentsActivityPlan`: quiet everywhere for two minutes) still decides when it ends.
4. **A second handle kind, `liveactivity`.** The app starts the activity with `pushType: .token`
   and registers its push token with each machine. Each daemon gets a gateway handle sealed with
   kind `liveactivity`. Such a handle can't send alerts, and an alert handle can't update an
   activity. The gateway sends `apns-push-type: liveactivity` to the topic
   `<bundle>.push-type.liveactivity`. A new token (a restarted activity) re-registers. Ending the
   activity unregisters, and APNs `410` removes the address as it does for alerts.
5. **Updates are rate-bounded and go stale honestly.** A change into or out of needs-you, or
   into failed, goes at once at priority 10. Any other count change goes at priority 5, at most
   once per 30 seconds per activity. An unchanged state is never sent. Every update sets
   `stale-date` to 15 minutes ahead, and a busy machine sends a priority-5 heartbeat every 10
   minutes, so a machine that goes offline leaves a stale activity, not a frozen "Working".
6. **The same switch covers both kinds of push.** Each machine's `notifications.remotePush`
   turns off alerts and Live Activity pushes from that machine. The sentence beside the switch
   says that alerts are encrypted and that Live Activity counts are visible to ace's push
   service and Apple.

ADR 0106 is otherwise unchanged: alert payloads stay end-to-end encrypted, and nothing travels
back through the gateway.

## Consequences

- The Lock Screen activity stays current while the app is suspended, and its titles still come
  only from the phone.
- The gateway gains a schema it must keep in step with the widget's decoder. A field added to
  one without the other is refused or ignored, never shown wrongly.
- The widget view has more to do: it merges a push with the snapshot and has to show which
  counts are older.
- Apple's budget for priority-10 Live Activity updates is limited. Decision 5 keeps
  priority-10 updates to the moments the person must act.
- It all depends on the ADR 0106 deploy checklist: a paid Apple team with Push Notifications,
  and a running gateway. Until both exist, the activity behaves as it does today.

## Tests

- Gateway: a `liveactivity` handle can't push an alert, and an alert handle can't push an
  activity update. A body with an extra field, a string or an out-of-range count gets `400`.
  The built payload has the liveactivity push type, topic, stale date and priority.
- Daemon scheduler, pure and table-tested: state changes go at once, count-only changes are
  coalesced to 30 seconds, an unchanged state is never sent, the heartbeat runs while busy, and
  no daemon ever sends `end`.
- Widget merge, pure Swift: a push from A with zero counts while the snapshot says B is busy
  still reads busy, with B's counts marked "as of" the snapshot time.
