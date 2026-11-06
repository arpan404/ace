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

- A new install's paired device takes the install id as its device id (unless that id is taken).
  Its paired credential and its account grant then name one device, whichever path it uses.
- Pairing again from an install that holds a device keeps that record and its id: the new
  link's name, scopes and expiry replace the old ones, and the old token stops working.
- A paired hello that names an install stamps the record with it (`devices.install_id`,
  schema 28) and folds the install's other records into it (`merged_into`): one already
  stamped with the install, and records it left behind before installs had ids (the same name,
  not used since this record was made). A folded record is listed under the one it folded into
  and revoked with it. If a folded record's own token is used again, it was another device
  after all: it unfolds and is listed again. Folding never removes access, so it needs no
  cleanup button.
- An account hello from an install marks the same install's paired record seen. Revoking that
  pairing closes only what the pairing opened, never the install's account sockets
  (`4003` wipes a device's data, ADR 0114).

### One entry per machine on a client

- A paired entry whose saved paths (said by the daemon over its pinned connection) name an
  account machine's relay host id **is** that machine. The client lists it once from the start,
  not after a proof: the paired entry steps aside, the account entry expects that daemon id on
  every path (a welcome from any other drops the path), and it inherits the paired entry's paths
  and its paired address. A browser may use the paired address directly, because it accepted
  that certificate when it paired.
- An entry's listing id stays what it is today: the daemon id for a paired machine, the relay
  host id for an account machine. Both map to one daemon, and the turned-off list (below)
  records both.

### Best path

- Unchanged from ADR 0114, but for one rule: a direct path (the LAN, Tailscale) that answers its
  probe always wins back over a relay, after the 10 s hold. Between two direct paths, or two
  relays, the candidate must still be 20% and 5 ms faster. The order is the same computer, the
  LAN, Tailscale, the person's own relay, ace's relay.
- iOS chooses between a merged machine's pinned direct route and the account relay route in a
  pure route plan: direct while it connects, the relay when it doesn't, and direct again on a
  network change or wake once it answers.
- "Auto" routing erred because an account machine in a browser had only ace's relay, and a
  machine reachable both ways was two entries, one of them failing; both are gone.

### Turning a machine off on a device

- Each machine can be turned off on one device without forgetting it. Off, it stays listed with
  a quiet "Off on this device", nothing on that device connects to it, and its threads leave the
  inbox and every list; its notifications, Live Activities and widget rows are hidden on iOS.
  Turning it on connects again with the same entry, credential, cache and permissions.
- The choice is the device's alone: kept in its storage by host id (`ace.machines.off` on the web;
  iOS's own store), read when the app starts, never sent to the machine. Forgetting the machine
  clears it. This window's own daemon has no switch.
- Web and desktop: Turn off and Turn on on the machine's row in Settings and a row on its page.
  iPhone: a swipe or menu action on the machine's row and a switch on its page, in system list
  grammar and motion.

## Consequences

- Records left behind by older apps fold away the next time the install connects with a build
  that sends its install id; until then they stay listed.
- A record is folded by name and disuse. Two devices with the same name, one unused since the
  other paired, fold together until the unused one connects again; nothing is lost either way.
- An install id is not a secret. Whoever holds a valid pairing code may name any install id,
  so they can take over that install's record: its id and what is keyed by it, with the code's
  scopes, and the old token stops working. A pairing code is already the owner's grant of a
  device, and the code chooses the scopes; a signed challenge per install would close this and
  is a follow-up.
- The daemon's paired device ids are no longer all daemon-minted: a new install's is its install
  id. Device ids were already opaque to every reader.
- The account backend still lists machines by relay host id only. Listing the daemon id there
  too would merge a machine before its paired entry has ever learned its paths; that needs a
  relay migration and is a follow-up.
