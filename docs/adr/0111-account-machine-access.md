# 0111: An ace account opens every machine on it

Status: accepted. Date: 2026-11-02. Owner decision of 2026-11-02. Amends
[ADR 0100](0100-ace-account-backend.md), where an account granted no machine access, and
[ADR 0110](0110-cloudflare-relay.md), whose relay admitted any proven host. Pairing codes,
LAN, Tailscale and self-hosted relays are unchanged and need no account.

## Decision

### Access

- A device signed in to an ace account has admin on every machine (daemon) signed in to the
  same account. No pairing step.
- A machine may set a **machine code** (a PIN or password). Then a device on the account must
  enter it once on that machine before access, so a stolen account login alone does not open
  it. The code is checked only by the daemon, inside the end-to-end encrypted channel. ace's
  backend never sees it.
- ace's hosted relay requires an account on both ends: a daemon registers only with its
  account, and a client reaches only machines on its own account.

### Who holds what

| Holder                           | Keeps                                                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend (Cloudflare Worker + D1) | WorkOS integration; hashed ace sessions; encrypted WorkOS refresh tokens; pending logins; machines (host id, account, name, platform, last seen); the grant signing key |
| Daemon                           | Its ace session; which devices passed its machine code, with the code's version; the code as a slow hash                                                                |
| Client                           | Its ace session                                                                                                                                                         |

### Grants

A grant is a short-lived statement signed by the backend with Ed25519. It is not a session and
is never stored.

- Claims: version, kind (`machine` or `device`), account id, the device or machine's own id,
  issued at, expiry. Lifetime five minutes.
- Encoding: base64url of the claims JSON, a dot, base64url of the signature over those bytes.
- The backend publishes its public keys at `GET /v1/keys`. Daemons fetch and cache them from
  their configured account origin; a new key id is fetched once, unknown keys after that are
  refused.
- Signing and verification live in `@ace/account-grant`, a pure package (noble Ed25519) used by
  the Worker, the daemon and clients. One implementation.

### Flows

**A machine signs in.** The daemon gets an ace session through the same login flow as the
apps (the desktop app hands its session to the local daemon when the person signs in, and
again whenever the daemon starts or restarts signed out, unless the daemon's lapsed session
was another account's; it never signs a daemon out or switches a signed-in one. Headless
machines run `ace login`, which prints the login URL). It asks the backend for a `machine` grant and connects to
the hosted relay's `/host` with it. The relay's Durable Object checks the grant, completes the
Noise handshake that proves the host key, and records host id → account in D1. Binding
therefore rests on two proofs: the session proves the account, the handshake proves the
machine. A machine signing in to another account moves to it.

**A device connects.** The client lists its machines (`GET /v1/machines`), gets a `device`
grant, and connects to `/client?hostId=…`. The relay refuses unless the grant's account owns
that host. The client pins the host id from the directory and sends the grant in `hello` as its
credential. The daemon verifies the signature, expiry and that the account is its own; if a
machine code is set and this device has not passed the current code, the daemon asks for it.
A correct code is remembered for this device and code version. Access is admin.

Grants travel to the relay in the `Sec-WebSocket-Protocol` header (`ace.grant.<token>`), which
browsers can set and URL logs do not record.

**Revocation.** Each connection needs a fresh grant, so signing a device out at the backend,
or a WorkOS account deletion, ends its access within one grant lifetime. Changing the machine
code requires every device to enter the new one.

### Machine code

Set and cleared only from a device that already has admin on that machine, or locally on the
machine. Stored as scrypt. Five wrong attempts lock code entry on that machine for 15 minutes,
counted per machine, not per device.

## Consequences

- Whoever controls the account (or ace's backend signing key) can reach every machine without
  a machine code. The machine code and WorkOS's own MFA are the protections; the settings UI
  says so where the code is offered.
- The backend becomes a dependency for account connections. Pairing tokens over LAN or
  Tailscale keep working while it is down.
- The Node account backend from #1412 moves to the Worker; `apps/relay` returns to a plain
  self-hostable relay with anonymous registration.
