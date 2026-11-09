# Draft: Spade acts on a person's machines

Date: 2026-11-08. Status: **proposed**, waiting for the owner's review. Builds on
[ADR 0110](../0110-cloudflare-relay.md) and [ADR 0111](../0111-account-machine-access.md). Would
amend [ADR 0002](../0002-local-cli-providers.md) with a third hosted exception, after the relay
and the push gateway ([ADR 0106](../0106-ios-remote-push-gateway.md)). This is the ADR that
[ADR 0107](../0107-rail-and-panel-sidebar.md) said Spade needs before it goes live.

## Context

Spade is ace's cloud agent. Its backend is a private Rust service on Linux VMs, linked into this
repository as the `private/spade` submodule and built into the apps only when present. The owner
decided (2026-11-08) that Spade's agents can use a person's connected daemons and devices:
start, steer and read ace threads, drive the browser and computer use, and control the daemon.

Today only a person's own devices reach a daemon. A device on the account gets admin
(ADR 0111). Spade is not a device the person holds, and unlike the relay it reads what it
touches: thread text, page contents, screenshots. So it needs its own grant, its own consent on
each machine, and narrower access than admin.

## Proposal

### Spade is a client of the daemon

Spade's backend connects to a machine the way a device does: through the hosted relay's
`/client?hostId=…`, with the same Noise handshake and the same wire protocol. It is not a new
transport. It holds no provider credentials. Coding work it starts runs on the person's own
CLIs on their own machine, exactly as when they start it from their phone.

### Off until the person turns it on, per machine

- Settings on each machine gets **Spade can use this machine**, off by default. Only a device
  with admin on that machine, or the machine itself, can turn it on, so a machine code already
  protects it.
- The person picks what Spade may do there. Each one maps to a set of daemon calls the daemon
  enforces:
  - **Threads:** read threads, start, message, steer and stop agents.
  - **Browser:** the agent browser tools.
  - **Computer use:** the screen tools. The existing "Apps agents can't use" list applies to
    Spade too.
  - **Files:** read and change files in the person's projects.
  - **Daemon:** settings, restarts and updates.
- Turning it on pins Spade's static Noise key on that machine, so a forged grant alone does not
  open it. Changing the machine code turns Spade off there, as it makes every device enter the
  new code.

### Grants

A new grant kind, `spade`, in `@ace/account-grant`. The backend signs one only for an account
that has linked Spade, with the same five-minute lifetime and refresh rule as device grants. The
relay admits it when the grant's account owns the host. The daemon checks the signature, expiry,
account, Spade's pinned key and the machine's Spade setting, then limits the connection to the
chosen scopes. It never gets admin.

### Whose machines

Spade acts only on machines of the account that asked. In a group chat, a request from one
member never reaches another member's machines. Marketplace bots get only the scopes the person
grants that bot inside Spade. The daemon enforces the machine's scopes either way.

### Seeing and stopping it

- Every call carries who acted: Spade, which bot, and the account that asked. The daemon
  records it with the event. Threads Spade starts say so in the thread list and header.
- While Spade is working on a machine, ace shows one line, "Spade is using this Mac", with a
  Stop button. Stop and turning the setting off close Spade's connections at once. Signing out at
  the backend ends access within one grant lifetime.

### Approvals stay with the person

The daemon adds no approval layer of its own: provider approvals stay provider-native. Spade
never answers approvals. When a thread it started waits on the person, Spade says so in its chat
and the person answers in ace. Spade's own confirmations (sending, buying, deleting through
connectors) happen in Spade.

## Consequences

- Spade sees in plain text whatever it reads on a machine. The consent screen says so, and
  Spade's data retention policy has to be written before launch.
- The relay, account backend, `@ace/account-grant` and the daemon's admission each need a
  change. The daemon gains per-connection scope checks for the five areas.
- A compromised Spade backend could act on every machine that turned Spade on, within each
  machine's scopes. Per-machine opt-in, narrow scopes, the visible "using this Mac" line and
  instant Stop are the protections.

## Open

- Which models Spade's own reasoning uses, and who pays for them.
- Whether Spade may wake a sleeping machine or only uses machines already online.
