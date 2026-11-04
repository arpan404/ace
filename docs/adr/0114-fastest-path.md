# 0114: Reach each machine over its fastest working path

Status: accepted. Date: 2026-11-04. Owner decision of 2026-11-04. Builds on
[ADR 0112](0112-remote-networks-together.md), where a machine serves the LAN, Tailscale, the
person's own relay and ace's relay together, and [ADR 0111](0111-account-machine-access.md),
whose account access rule it keeps.

## Context

A machine reachable several ways was still reached one way: a paired machine kept the single
address it was paired with, and an account machine always went through ace's relay, even with
the phone on the same Wi-Fi. Switching networks meant a dropped connection and a reconnect
with backoff.

## Decision

A client reaches each machine over the fastest path that works and moves between paths on its
own, make-before-break, without ever weakening security.

### Paths

Best first: the same computer, the LAN, Tailscale, the person's own relay, ace's relay.

- The daemon names its paths in `host.identity.result.paths` (`MachinePath` in
  `packages/protocol`): each direct path with the TLS listener's public-key fingerprint, each
  relay with the machine's relay host key. The same computer is the TLS listener at
  `127.0.0.1`, named only while the LAN is on (the LAN listener binds every address). Plain
  `ws` stays loopback-only and the desktop app's own connection is unchanged.
- A client learns paths only from the machine itself, over a connection that is already
  authenticated and identity-pinned. Nothing comes from the network (no mDNS trust).
- A paired machine's directory entry keeps the paths and the last winning kind (directory
  version 2; a version 1 directory reads as is and is rewritten as version 2). The paired
  address stays its route; paths add to it. Account machines aren't saved, so their paths stay
  in memory.

### Algorithm

Pure decisions live in `packages/client/src/path-plan.ts` and `path-switch-plan.ts`; the
shell that runs them on timers is `Multipath` (`multipath.ts`, `path-race.ts`,
`path-handshake.ts`).

1. **Connect: race.** Every connect and reconnect races the paths, last winner first, then
   best ranked. The first starts at once, each next one 150 ms later or as soon as the one
   before it fails. The first path whose secure transport opens (TLS with its pin checked, or a
   relay's pinned handshake) carries the attempt; the others close. Its hello then runs on it.
   This is one step earlier than "first to finish hello": the hello's credential differs per
   path (a ticket on a direct socket, a token or grant on a relay), so it cannot be sent on
   every path at once.
2. **Measure.** The active path is pinged every 5 s while visible, 15 s while hidden; the round
   trip is smoothed (EWMA, an eighth of each sample).
3. **Upgrade.** On a network change, on wake, and every 30 s while on a worse path, better
   ranked paths are probed with a check that opens no session, supplied by the platform's
   dialer. A browser probes a direct path with two bodiless requests to the daemon's HTTPS
   listener and takes the second, which reuses the connection and so costs about one round
   trip, like the ping it is compared with. Relays aren't probed: a relay that got better is
   picked by the next race. A probed path wins if it is at least 20% and 5 ms faster; the same
   computer always wins. Then, make-before-break:
   1. the new path opens and says hello with the same credential, and must be welcomed by the
      same daemon (`hostId`);
   2. one synchronous swap: new sends use the new path, and every view resubscribes there
      from its last applied seq; events it already holds are dropped by seq;
   3. the old path keeps delivering the replies it owed for up to 2 s. Then it closes;
      requests it never answered fail as offline (as on any lost connection) and commands it
      never answered are sent again by id on the new path, in the order first sent. The daemon
      answers a known command id from its receipt instead of running it again. Until each
      command the old path owes is answered or sent again, newer commands wait, so none
      overtakes an older one (queries and views don't wait).
   4. the client's socket generation (`connectionGeneration`) changes, as on a reconnect:
      whatever the daemon keeps per socket (terminal and browser streams, settings and other
      service subscriptions) attaches again on the new path, from its own cursor where it has
      one, and ignores what the old socket still sends under its old ids. The app's presence
      is said again on the new socket.

   The old connection is never closed before the swap; any failure before it closes only the
   new path.

4. **Failover.** While on the LAN or Tailscale, the best relay is kept authenticated and idle
   as a warm standby, pinged every 30 s. It tells the daemon it is in the background, so it
   never counts as an alert's delivery; what it hears before it is promoted is dropped, not
   repeated. A standby that fails rests, and another relay, or the same one once its rest ends,
   takes its place. A socket error, or a ping on the active path that
   hears nothing for 2 s, swaps to the standby at once and asks every unanswered command
   again. Without a standby the connection reconnects, racing the remaining paths.
5. **Anti-flap.** After a switch the client stays 10 s unless the path fails. A failed path
   rests 1 s, 2 s, 4 s … up to 60 s.

### Security

- **Rights come from the credential, never the path.** A device uses the same credential on
  every path, so a view-only device is view-only on every path.
- **Signing in wins over pairing** (owner decision of 2026-11-04). A device signed in to the
  ace account the machine is on is admitted as admin on every path (the same computer, the LAN,
  Tailscale, its own relay, ace's relay), even if the same device was also paired earlier with
  fewer scopes. Pairing scopes apply only to devices that reach the machine without an account
  grant. A hello carries exactly one credential; a signed-in device sends its grant. In a
  window's machine pool, a machine also paired from the same device steps aside while its
  account entry is open (once that entry has proved, over a relay, that it reaches the same
  daemon), and comes back when the account entry closes.
- **Account grants on direct sockets.** A direct socket admits a device grant through the same
  `admitDevice` check as the relay (account, device id, machine code), shared in
  `relay-hello.ts` (`accountHello`). A machine code refusal is sent as the relay sends it, then
  the socket closes with 4011; the client stops as `machine_code` (with `lockedUntil`) and asks
  for the code, as over the relay. An account device is never taken for the host credential.
- **Every path proves the same machine.** Direct paths pin the TLS fingerprint; relays pin the
  machine's Noise host key; every path's welcome must name the same daemon. A mismatch drops
  that path for good, reports it (`Multipath` `mismatch`), and the client never falls back to
  an unpinned or unchecked connection. Once a connection has been welcomed, a reconnect race
  that reaches another daemon drops that path too. An account machine keeps the daemon id it
  first learned over a relay (whose handshake pins the host key) and expects it on every path.
- **Browsers can't pin** a self-signed certificate. A browser (web, desktop renderer) uses a
  direct path only when it can check it: the address it was paired with, or a Tailscale
  `ts.net` name with the publicly trusted certificate Tailscale issues for exactly that name
  (ADR 0097). Relays always work, since their pin is in the handshake. The desktop app allows
  every address a machine's worker may dial before the worker starts.
- **Browsers trust Tailscale's public certificate on `ts.net` paths** (owner decision of
  2026-11-04), instead of a pinned fingerprint. The safeguards stay: only names ending in
  `.ts.net`, only names the machine itself named over an authenticated, identity-pinned
  connection, and the welcome must name the same daemon before any swap. One order is
  accepted as it is: the credential reaches the `ts.net` host before its welcome names the
  daemon. A paired device posts its device token to that host's `/v1/tickets` to get the
  socket ticket; an account device sends its grant in the hello. So if a `ts.net` name ever
  pointed at another node (the machine renamed and the name reused), that node, which is on
  the person's own tailnet and holds a certificate for the name, would see the token or a
  grant good for five minutes before the client drops the path. Checking identity first isn't
  simple: the daemon's HTTPS listener has no unauthenticated proof of who it is (a signed
  challenge with the host key would be new), so that is a follow-up, not done here.
- **The host token never leaves the desktop.** Other apps on the same computer use their own
  device credential, over the TLS listener, even on loopback.
- **An account socket stays open only while it holds a grant** (owner decision of
  2026-11-04). A device grant lasts five minutes (ADR 0111) and used to be checked only at
  hello, so an account socket could stay open long after its grant ended. Now the daemon
  keeps each account main socket's grant expiry (`account-access/grant-lease.ts`,
  `grant-socket.ts`), on every path: direct, relayed, and the standby, which is a socket like
  any other. The welcome tells the client how long its grant has left (`grantTtlMs`). Before
  that runs out the client fetches a new device grant and sends it on the same socket
  (`account.grant.refresh`); the daemon checks it as it checks a hello's grant, through
  `admitDevice` (signature, expiry, its own account, the socket's device id, the current
  machine code), keeps the socket on the account it was admitted for, and moves the expiry on
  (never back), answering `account.grant.refresh.result`. The client (`grant-keeper.ts`)
  refreshes a minute before expiry and times the next refresh from the new grant's own
  lifetime, so client and backend clocks needn't agree; a failed fetch tries again after 10 s.
  If no valid refresh arrives by the expiry plus 30 s, the daemon closes the socket with 4014
  "Account grant expired". 4014 is not final: the client reconnects as after any drop, with a
  fresh grant, since every connection attempt already fetches one. A client that never
  refreshes (an older build, or iOS until it adopts this) is closed at expiry and reconnects
  the same way; a daemon that doesn't send `grantTtlMs` is never sent a refresh. Dedicated
  channels (files, devices, browser, screen, sign-in) aren't timed: they end when the
  account changes, as before, and their grant is checked when they open.
- **Revocation closes every path at once.** Revoking a paired device closes all its sockets,
  direct and relayed (unchanged). An account change (signed out, another account, a new
  machine code) now rechecks `stillAdmitted` on direct sockets as well as relay channels and
  closes every account path, the standby included.

## Measured

On one Mac, loopback, against a real daemon (`multipath.process.test.ts`):

- The swap, including every view's resubscribe being sent, holds the client 0.19–0.29 ms.
- Failover to the warm standby: 1.6–4.1 ms from the active socket dropping to the next event
  arriving on the standby (2.8 ms after the review fixes), once the standby has settled. The
  connection never leaves `ready`. A standby only just opened can take a few hundred ms: the
  daemon handles a socket's messages in order, and its first presence waits for the
  notifications worker to start.

## Consequences

- An account device on the same Wi-Fi as its machine still uses ace's relay in a browser,
  unless the machine serves Tailscale with a `ts.net` name; the native apps (which can pin)
  get the LAN.
- A paired machine's worker reads its paths when it starts: paths a machine names for the
  first time are used from the next start of its worker.
- The desktop renderer could pin with a certificate verifier in the main process; not done
  here.

### iOS follow-up

The native iOS client (ADR 0074) is out of scope here. It needs: the directory's `paths` and
`lastPath`; a dialer per path that pins the TLS public-key fingerprint (URLSession delegate) and
the relay host key; a cheap probe (a pinned TLS handshake); `NWPathMonitor` for network changes
and wake; and to hand those routes to the shared `Multipath` through its host contract, so the
decisions stay in the shared JavaScript. It also needs to pass a fresh-grant source
(`ClientOptions.grant`) so its account sockets refresh their grant instead of reconnecting
every five minutes.
