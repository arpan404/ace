# 0223: An iPhone connection never visibly drops for a quick reconnect

Status: proposed. Date: 2026-11-24. Extends [ADR 0115](0115-one-device-one-machine.md) (one
machine over direct and relay) and [ADR 0221](0221-ios-background-refresh-over-relay.md).

## Context

On the iPhone a connection that worked would show "Reconnecting to <machine>" for every
socket replacement: a Wi-Fi to cellular hand-over, a socket found dead after the app was
suspended, or a move between the relay and the direct address. The header read the runtime's
state as it was, so even a reconnect that finished in a second was seen. A path that went
unsatisfied for a moment also told every runtime the phone was offline, which closed sockets
that would have lived through the blip. And a machine reachable both ways started on its direct
address and probed it after every network change, on cellular too.

App Store rules keep the app from staying alive in the background (no silent audio, no VoIP
keepalive). iOS suspends it about 30 seconds after it leaves the screen, so a reconnect after a
return is unavoidable. The goal is that it isn't seen.

## Decision

- **Display grace.** Each machine's runtime has a shown connection state beside its real one
  (`ConnectionGrace`). When a ready connection leaves ready, the shown state stays ready for 6
  seconds. A reconnect that succeeds inside that time is never seen. Past it the real state
  shows. A refusal (`fatal`) shows at once, and a machine that never connected shows its real
  state from the start. Only the words and dots read the shown state: the inbox header, its empty
  state, and the Machines and Account rows. Sends, reads and confirming a row read the real state,
  so a row is never settled from stale data while the grace hides a reconnect.
- **Offline hold.** The runtimes hear "offline" only once the path has stayed unsatisfied for 4
  seconds, and "online" at once (`OfflineHold`). A socket that really died still closes and
  retries by itself. An interface change still makes every ready socket answer a ping within
  seconds (the wake probe), so a healthy socket is kept and a dead one is replaced.
- **Route handover.** Direct is tried only on Wi-Fi or wired Ethernet. Off Wi-Fi a machine with
  a relay starts on it, never probes direct, and a machine on direct moves to its relay when the
  phone leaves Wi-Fi. On Wi-Fi a working relay is kept until the direct address answers a probe
  opened beside it, a socket that opens only for the daemon's pinned key. The probe never closes
  the relay. The existing hold and cooldown still apply.

## Consequences

- A quick reconnect, from a network change or a return from suspension, is invisible. One that
  takes longer than 6 seconds shows the real state, so the header never claims a connection for
  long that isn't there.
- The handover to direct is still a runtime switch, covered by the grace. The probe proves the
  daemon is at the address. It doesn't prove the device's hello is accepted there. A hello
  refused on direct falls back to the relay under the existing cooldown. A true make-before-break
  switch (a second, authenticated path beside the relay, as the SDK's multipath does for the
  desktop, [ADR 0114](0114-fastest-path.md)) would need two native sockets per runtime and is left
  for later.
- A Tailscale direct address is not used on cellular while the relay works.
