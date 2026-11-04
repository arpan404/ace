# 0112: Remote networks run together

Status: accepted. Date: 2026-11-03. Owner decision of 2026-11-03. Amends
[ADR 0070](0070-runtime-remote-access.md), where remote access used one transport at a time,
and [ADR 0111](0111-account-machine-access.md), where a machine reached ace's relay only when
the relay was its chosen transport.

## Context

`remote.transport` picked one network: `lan`, `tailscale` or `relay`. A machine is recorded on
its ace account only when its daemon registers on ace's hosted relay, so a machine signed in to
an account but serving Tailscale never appeared on the account, and the person's phone, signed
in to the same account, found no machines. Signing in should be all it takes.

The relay choice also could not be saved without a self-hosted address, although ace runs a
relay of its own.

## Decision

- Remote access serves the LAN, Tailscale and a relay together. Each is its own global setting
  (`remote.lan`, `remote.tailscale`, `remote.relay`) under the `remote.enabled` switch. Any
  combination runs.
- While remote access is on and the machine is signed in to an ace account, the daemon
  registers on ace's relay, whatever else it serves, with a fresh machine grant per
  registration. Signing out stops it; another account registers again.
- `remote.relay` with no `remote.relayUrl` is ace's relay. A self-hosted address is optional.
  ace's relay named as the person's own is the same registration: the daemon never registers
  twice on one relay.
- LAN and Tailscale share one listener: every address with the LAN on, the 100.x address with
  Tailscale alone. Links name Tailscale when it serves, else the LAN, else a self-hosted relay.
- Each network starts and fails on its own. Turning on a network that can't start is refused,
  and nothing else changes. Later failures show per network and retry with backoff, except
  ace's relay waiting for a sign-in or refusing the machine, which waits for the person.
  Remote access never falls back to the LAN on its own.
- Status reports each network (`remoteAccess.networks`: `lan`, `tailscale`, `relay`,
  `account`) and keeps `enabled`, `transport` and `error` for older clients.
- Settings migrate forward: a stored `remote.transport` becomes the networks it served
  (`local`/`lan`: LAN; `tailscale`: Tailscale only; `relay`: LAN plus the relay), and a saved
  relay address keeps its relay on. An older app's `remote.transport` write is translated the
  same way. The key stays in the schema, never stored.

## Consequences

- The owner's machine on Tailscale, once signed in, is listed on the account and opens from the
  phone with no change of network.
- A signed-in machine with remote access on always holds a connection to ace's relay. Turning
  remote access off, or signing out, is how a person keeps it off ace's relay.
- `remote.transport` reads as its default from new daemons. Older apps that show it show the
  LAN; they still write it correctly.
- Doctor checks every network that's on, not one transport.
