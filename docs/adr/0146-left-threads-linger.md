# 0146: A thread the phone just left stays followed for five minutes

Status: Accepted. Date: 2026-11-13. Decided by: the owner. Amends
[ADR 0128](0128-resume-kept-threads.md), decision 4 ("never holds a subscription past the
read"), for threads the person opened and left.

## Context

The iPhone keeps the last six threads it showed (`ThreadShelf`). Leaving one released its lease,
and the client unsubscribed at once (`packages/client/src/subscriptions.ts`). Reopening it drew
the kept copy straight away, then subscribed again from its cursor and waited for the daemon's
replay. Until that replay landed, the person saw the thread as it was when they left it, and then
it jumped. The owner reported this on 2026-11-13 as "a glimpse of the old screen".

ADR 0128 made that replay cheap: only the thread's own events since the cursor. It still costs a
full network round trip, through the relay or Tailscale on a phone, every time the person goes
back to a thread they were just reading.

## Options considered

- **Show a loading state until the replay lands.** This never shows old content, but reopening
  is no faster. Rejected by the owner.
- **Keep all six shelf threads subscribed while the app is in the foreground.** They are always
  current, but this holds the most subscriptions and data, including on cellular.
- **Keep a left thread subscribed for five minutes (chosen).** Going back and forth between
  recent threads, the usual case, becomes instant and current, and the cost ends on its own.

## Decision

1. **A thread the phone leaves stays followed for five minutes.** The bridge takes an optional
   hold on it before letting the visit's lease go, so the subscription never drops in between
   (`apps/ios/bridge/thread-linger.ts`). Reopening it within the five minutes paints what changed
   meanwhile at once, with no new subscription.
2. **The hold is optional.** It takes only a spare subscription slot and gives way to any thread
   the person opens, as read-ahead's holds do.
3. **Bounded like the shelf.** At most six threads linger; past that, the one left longest ago is
   let go. Reloading a thread from the machine and clearing cached chats let go of lingering
   threads at once.

ADR 0128's read-ahead is unchanged: a thread read ahead is still released once it is confirmed.

## Consequences

- Reopening a recently left thread shows its current state without a visible jump.
- The machine streams to the phone for up to six extra threads for five minutes after the person
  leaves each one. Most are quiet; a working thread costs what it would cost while open.
- Only the iOS bridge does this. The shared client and the web app are unchanged.

## Tests

- `apps/ios/bridge/thread-linger.test.ts`: a thread left a moment ago is current the instant it
  is reopened, with no new subscription; a left thread is let go after the linger; only the most
  recently left threads linger.
