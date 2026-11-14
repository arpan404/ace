# 0150: Fewer round trips to the first content

Status: accepted. Date: 2026-11-14. Decided by: the owner (networking audit, 2026-11-14: every
connection feels instant on 3G). Amends [ADR 0114](0114-fastest-path.md) (race stagger, pings,
pong deadline) and the paired socket ticket of [ADR 0070](0070-runtime-remote-access.md).

## Context

On 3G a round trip costs about 400 ms. Counted from code, a paired device on a direct path
(LAN or Tailscale) needed 8 round trips between "connect" and the first replay frame: TCP, TLS
and the WebSocket upgrade; then a ticket exchange on a new HTTP connection (TCP, TLS, POST);
then the hello and its welcome; then the subscribe and its replay. Through ace's relay, the
web client also fetched a new account grant on every connect, once per raced path. A single
late pong failed the active path over, which on a relay-only phone is a whole reconnect, and a
fixed 150 ms race stagger dialed every path every time.

## Decision

1. **Read subscribes go with the hello.** The daemon handles a socket's messages in order and
   nothing after the hello before its welcome (`socket-input.ts`, `server.ts`), as daemons
   already in the field do. So the client sends its thread and sidebar subscribes right after
   the hello. Commands, the outbox replay and read markers still wait for the welcome and the
   host binding. A thread subscribe resuming from a cursor records the database it assumed (the
   last welcome's, or the one its disk copy was kept under); when the welcome names another,
   the client unsubscribes it before any of its frames are applied and subscribes from scratch.
2. **The ticket exchange overlaps the dial.** The socket credential is asked for when the socket
   starts dialing, not when it opens; a raced path asks for its route's credential as it starts.
   A relay attempt fetches its own, as before, since it needs it to dial.
3. **The welcome hands over the next ticket.** A hello that opens with a ticket may set
   `nextTicket: true`. The daemon then puts one fresh ticket in the welcome
   (`welcome.ticket: { ticket, ttlMs }`). It is issued from the same pool as an exchanged one:
   one use, 60 s, bound to the device and its credential generation, voided by revocation and by
   pairing the install again, and counted against the device's quota (a spent quota just hands
   none over). Only clients that ask get one, so the pool doesn't fill with tickets older clients
   ignore; relayed sockets get none. The client keeps it in memory only, strips it from the
   welcome it passes on, and uses it for its next hello if it has at least 15 s left. A handed
   ticket the daemon refuses (it restarted) is replaced by an exchange at once, never a stop.
4. **The web client keeps its account grant.** Grants are kept in memory per ace session until
   two minutes before they run out; concurrent asks share one fetch, so a race fetches once. The
   margin stays above the grant keeper's 60 s refresh lead. The daemon still checks expiry.
5. **Liveness scales to the link.** The pong deadline is four smoothed round trips, at least 2 s
   and at most 10 s. With a warm standby one miss fails over; without one, two misses in a row.
6. **The race stagger scales too.** It is 1.5 times how long the last race took to open its
   winner, between 150 ms and 2 s. A path that fails fast still lets the next one start at once.
7. **Timers.** A socket the path manager pings carries no second ping loop: the connection's
   heartbeat stands down (a wake probe still runs). Hidden windows ping every 40 s, inside the
   daemon's 60 s idle limit. A connect's single 120 s deadline is now one per stage (the socket
   opening; the hello waiting for its welcome): 30 s, or four times what that stage took last
   time, at most 120 s. A daemon that says `starting` still gets the whole 120 s.

The client keeps one link estimate, the active path's smoothed round trip, readable through
`ClientApi.linkEstimate()` for other features.

## Consequences

- Direct path, measured with a scripted daemon behind a delaying proxy (TLS not modelled):
  first connect 6 → 3 flights, reconnect 5 → 3 with no exchange. With TLS 1.3: 8 → 4.
- Once the exchange overlaps the dial, the handed ticket saves little latency; it saves the
  extra HTTP connection, its bytes and its radio time, and the case where the exchange is slower
  than the dial. It only helps within the ticket's 60 s life.
- Security: every path stays authenticated and identity-pinned; the hello still carries one
  short-lived, one-use credential; the handed ticket is never written to disk or logs. The
  subscribes sent before the welcome name only thread ids and cursors, to the endpoint that
  already received the credential, and the welcome's host check still drops a wrong daemon.
- Older daemons ignore `nextTicket` and never hand a ticket over; older clients never ask and
  ignore an unknown welcome field.
