# 0115: One id per device, one entry per machine

Status: accepted. Date: 2026-11-05. Owner decision of 2026-11-05. Builds on
[ADR 0114](0114-fastest-path.md), whose paths and switching it keeps, and
[ADR 0111](0111-account-machine-access.md), whose account access rule it keeps.

## Context

The same phone showed up as several devices, and the same machine as several machines.

- **Devices.** A daemon minted a fresh device id on every pairing. Pairing the same app again
  (after removing the machine, signing out and back in, or reaching it a new way) left the old
  record active beside the new one, with nothing linking them. An app's ace account device id
  was another value again: random per browser, and per account origin on iOS
  (`ace.account.device.<origin>`). So one install was a paired device and an account device
  under two unrelated ids.
- **Machines.** A machine has two ids: its daemon's own (`host-id`, sent in `welcome`) and its
  relay host id (from its relay key; the account backend lists machines by it). A machine both
  paired and on the account was listed twice until its account entry had connected over a
  relay and proved it was the same daemon. On iOS it was always listed twice: `merge`
  compared a daemon id with a relay host id.
- **Automatic routing.** A path that won back from a relay had to be 20% and 5 ms faster. On a
  fast relay the client stayed on it after the LAN came back, and an account entry in a
  browser could not use the LAN at all.

## Decision

### An install id per app install

- Each install (the iPhone app, the desktop app, each browser profile) makes one **install id**
  on first run: a UUIDv7 (`uuidV7`, `appInstallId` in `@ace/client/install-id`; Swift on iOS),
  kept for good: origin storage on the web, the desktop app's `app://ace` storage in its
  userData, the Keychain on iOS. It is made again only when missing. The clock and randomness
  are passed in.
- An install that already had an account device id adopts it as its install id, so the machine
  code passes daemons remember for it still hold.
- The install id is the install's **account device id** (the device grant's subject), the same
  across signing out and in and across accounts.
- Pairing sends it (`installId` on `/v1/pair` and on `pair.redeem` through a relay), and so does
  every hello (`hello.installId`). Older daemons ignore both; an older app sends neither and
  gets today's behaviour.

### One device record per install on a daemon

- A new install's paired device gets an id the daemon mints, never the install id: an install id
  is not a secret, and a record named by one would share whatever the install's account device
  keeps under that id. The record is stamped with the install id instead.
- Pairing again from an install that holds a device keeps that record and its id: the new
  link's name, scopes and expiry replace the old ones, and the old token stops working. A client
  whose socket closes with `4001` "Credential replaced" reads its credential again and
  reconnects; a plain `4001` refusal stays fatal. A web pairing refused with the token its worker
  started with reads the stored token again and starts one new worker if it changed; the iPhone
  reopens a machine it pairs again with the new credential and grants. So
  does everything the old token opened: each paired session, ticket and authority lease carries
  the generation of the credential that opened it, a ticket asked for with the old credential
  opens nothing, and the old credential's sockets and relay channels close with `4001`
  ("Credential replaced", not the `4003` wipe). The install's account sockets are not the
  pairing's and stay open.
- A paired hello that names an install stamps the record with it (`devices.install_id`,
  schema 28) and folds into it the records the install left behind before installs had ids:
  the same name, not used since this record was made, and no access this record lacks. A
  folded record is listed under the one it folded into and revoked with it: its sockets,
  tickets, notifications and relay channels end as the survivor's do. If a folded record's own
  token is used again, it was another device after all: it unfolds and is listed again.
  Folding never removes access, so it needs no cleanup button.
- Naming an install proves nothing (an install id is not a secret), so a hello never folds a
  record another credential already holds for that install, and the caller isn't stamped beside
  it: both stay listed. Only a pairing code from that install takes such a record over.
- An account hello from an install marks the same install's paired record seen. A paired
  record and an account device are one device for command receipts only once that account
  device has proved, in its own admitted hello, that it holds the record's credential: the hello
  carries `link: { deviceId, proof }` beside its grant, where `proof` is the base64url
  HMAC-SHA256 of `ace-link/v1\n<paired id>\n<account id>` keyed by the hex SHA-256 of the paired
  token (all the daemon keeps of it). The daemon records the link on the paired record
  (`devices.account_link`, schema 29); a new credential for that record clears it until it is
  proved again. A stamp, a claimed install id or a matching name links nothing. Once linked, a
  command first sent over the pairing and sent again through the account is answered from its
  receipt, never refused or run twice. The raw token is never sent on the account connection;
  web and iOS compute the proof from the pairing they hold for that machine. A client re-binds the sends it saved under the
  install's other id on that machine to the id it connects with (`deviceAliases`), so a route
  change loses no queued send. Revoking that
  pairing closes only what the pairing opened, never the install's account sockets
  (`4003` wipes a device's data, ADR 0114).

### One entry per machine on a client

- A paired entry whose saved paths (said by the daemon over its pinned connection) name an
  account machine's relay host id **is** that machine. The client lists it once from the start,
  not after a proof: the paired entry steps aside, the account entry expects that daemon id on
  every path (a welcome from any other drops the path), and it inherits the paired entry's paths
  and its paired address. A browser may use the paired address directly, because it accepted
  that certificate when it paired. A browser pairs an address without a fingerprint of its own;
  the fingerprint the daemon gives for that address over the authenticated connection is saved
  with the pairing, and entries saved before recover it from their saved paths.
- A paired entry that learns such paths while its account entry is already open merges then:
  the paired entry steps aside, and the account entry gains its address and looks for a better
  route at once. An account entry that is refused (its authorization, or a machine code still to
  enter) takes no pairing aside; it does once it is admitted, so a working pairing is never
  hidden behind an entry that can't open.
- An entry's listing id stays what it is today: the daemon id for a paired machine, the relay
  host id for an account machine. Both map to one daemon, and the turned-off list (below)
  records both.

### Best path

- Unchanged from ADR 0114, but for one rule: a direct path (the LAN, Tailscale) that answers its
  probe always wins back over a relay, after the 10 s hold. Between two direct paths, or two
  relays, the candidate must still be 20% and 5 ms faster. The order is the same computer, the
  LAN, Tailscale, the person's own relay, ace's relay.
- iOS chooses between a merged machine's pinned direct route and the account relay route in a
  pure route plan: direct while it connects, the relay when it doesn't (also when the relay is
  learned only after direct stopped reaching the machine), and direct again on a network change
  or wake once a pinned WebSocket to it opens. Never sooner than 10 s after taking the relay,
  and after a move back that fails before it is ready, not for 30 s, doubling to 5 minutes; a
  move back that reaches ready resets the wait. A network change or wake inside the hold or
  the wait is not dropped: the plan says when it may look again, and the app looks then, once,
  unless the machine is turned off, removed or moves route first.
- "Auto" routing erred because an account machine in a browser had only ace's relay, and a
  machine reachable both ways was two entries, one of them failing; both are gone.

### Turning a machine off on a device

- Each machine can be turned off on one device without forgetting it. Off, it stays listed with
  a quiet "Off on this device", nothing on that device connects to it, and its threads leave the
  inbox and every list; its notifications, Live Activities and widget rows are hidden on iOS.
  Turning it on connects again with the same entry, credential, cache and permissions.
- The choice is the device's alone: kept in its storage by host id (`ace.machines.off` on the web;
  iOS's own store), read when the app starts, never sent to the machine. Forgetting the machine
  clears it. Off is kept under every id the device knows the machine by (its daemon id and its
  relay host id), so a machine turned off as an account machine stays off once it is known to be
  a paired one; turning it on or forgetting it clears both. Turning machines off withdraws their
  finishes from iOS's "threads finished" summary, which is posted again over the rest or
  withdrawn.
- A paired device's grants (what the pairing allows) are kept by machine and device on iOS:
  one install id names the phone on every machine, so a device id alone no longer tells two
  pairings apart. Grants saved by device alone move to their machine on the next launch. This window's own daemon has no switch.
- Web and desktop: Turn off and Turn on on the machine's row in Settings and a row on its page.
  iPhone: a swipe or menu action on the machine's row and a switch on its page, in system list
  grammar and motion.

## Consequences

- Records left behind by older apps fold away the next time the install connects with a build
  that sends its install id; until then they stay listed.
- A record is folded by name and disuse. Two devices with the same name, one unused since the
  other paired, fold together until the unused one connects again; nothing is lost either way.
- An install id is not a secret. Whoever holds a valid pairing code may name any install id,
  so they can take over that install's paired record, with the code's scopes, and the old token
  (and everything it opened) stops working. They get none of the install's account device's
  receipts: the record's id is the daemon's own, and its account link is cleared by the new
  credential. A hello alone, without a code, takes nothing over. A pairing code is already the owner's grant of a
  device, and the code chooses the scopes; a signed challenge per install would close this and
  is a follow-up.
- The daemon's paired device ids are no longer all daemon-minted: a new install's is its install
  id. Device ids were already opaque to every reader.
- The account backend still lists machines by relay host id only. Listing the daemon id there
  too would merge a machine before its paired entry has ever learned its paths; that needs a
  relay migration and is a follow-up.
