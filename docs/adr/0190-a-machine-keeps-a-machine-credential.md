# 0190: The person's standing comes only from proof a same-user process can't make

Status: accepted. Date: 2026-11-18. Amends [ADR 0111](0111-account-machine-access.md) (who holds
what, grants, a machine signing in), ADR 0115 (paired devices), ADR 0174 §2 (the market's
sensitive actions) and the account-device and paired-device rows of ADR 0178 §12.7. Closes the gap
ADR 0178 §12.8 names as "the machine's own ace session". Revised after review of #2310.

## Context

When the person signed in to ace in the app, the app handed its ace session to its daemon, and
`ace login` claimed one for the daemon itself. Either way the daemon wrote that session to
`ACE_HOME/ace-account.json`, readable by every process of that user, an unsandboxed coding agent
included. The backend minted a device grant for any device id from any session, and every daemon
counted an admitted account device as the person. So a process that read the file could mint
itself a device grant and act as the person: market installs and withdrawals, answering
person-only requests, the guarded setting.

Review found the same shape in five more places:

- Pairing links any admin (or the host token) made paired devices that counted as the person.
- The desktop app sent its raw session to whatever answered at the daemon address in ACE_HOME.
- A person's grant was a bearer token any recipient could replay, and a format 1 refresh kept a
  socket's standing.
- Older daemons treat any format 1 device grant as the person, and a machine could still mint one.
- The market took sensitive actions from a machine's grant.

**The rule: the person's standing comes only from proof that a process of the same user can't
produce or replay, end to end, across mixed versions.** Two proofs qualify:

- **A browser sign-in, held by the client that made it**, used through a key that lives only in
  that client's memory, on one socket at a time (§3).
- **A browser sign-in in the last ten minutes** (ADR 0174 §2), read from a grant a pinned key
  signed for this machine (§5).

Everything else has a machine's standing: the host token, anything in ACE_HOME, a machine's
credential, a device whose pairing link no person made. It has admin where it has admin, but
person-only actions need one of the two proofs.

## Decision

### 1. Who holds what

| Holder                             | Keeps                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An ace app the person signed in on | Its session: the desktop app in `safeStorage`, the web window in memory only (never `sessionStorage`), the iPhone app in the Keychain. A device key in memory (§3). |
| The daemon                         | A **machine credential** bound to its relay host id, in `ace-account.json`; one it is asking for, in `ace-account.pending.json`. Never a session.                   |
| The backend                        | Sessions with their `standing`; machine credentials and enrollment tickets as digests (migration 0004).                                                             |

A session's `standing` is one of three values:

- `person`: an app's sign-in from this version on.
- `exposed`: a session a machine keeps.
- `legacy`: a session from before this version.

A sign-in says who will hold it (`AceLoginRequest.holder`). `ace login` is `machine`, and so is any
sign-in without a return address, which is how older daemons start one. A session is marked
`exposed` when an older daemon asks for a machine grant with it, or when a daemon exchanges it from
its session file. Only `person` speaks for the person. `ACE_LEGACY_PERSON_UNTIL` could extend that
to `legacy` sessions for a transition; it is unset, and should stay so.

### 2. Machine credentials

`POST /v1/machine-credentials` issues a credential for one host id. It takes a session the daemon
holds (`ace login`, an old session file), or an **enrollment ticket** the app got with its own
session from `POST /v1/machine-enrollments`. A ticket is single use, lasts ten minutes and is bound
to the host id. The app hands its daemon the ticket, never the session.

- **Host-key proof.** The request carries the relay host key and an HMAC over the host id and the
  credential. The HMAC key is the X25519 secret between the relay host key and the backend's
  published exchange key (`/v1/keys` `exchangeKey`, derived from the encryption key). A host id the
  key doesn't name, or a proof any other key made, is refused (`@ace/account-grant/machine-proof`).
- **The daemon chooses the credential** and writes it to `ace-account.pending.json` before it asks.
  If the answer is lost, the daemon asks again with the same credential and gets the same answer,
  or tries the credential on its next start.
- **One guarded batch** does the whole issue:
  1. Mark the session exposed if it was kept on a disk.
  2. Insert the credential, only while the session's token is unretired or the ticket unspent.
  3. Retire the token (`sole`) or spend the ticket.

  Two exchanges racing for one session or ticket issue one credential.

- **What a credential can do:**
  - Machine grants for its own host only.
  - Device grants only in format 2, with a machine's standing (§4).
  - Market grants as `kind: machine` (§6).

  It can't be exchanged again, can't forget machines, and can't ask for a person's grant. It lives
  on its session, so a signed-out or deleted account loses its machines too.

### 3. The person's standing on a socket

A device grant request may name `host` (the daemon's relay host id) and `key` (the device's P-256
public key). For a `person` session the backend then returns a **person's grant** beside the
format 1 grant that older daemons need:

```
{ v: 2, kid, kind: "device", aud: "ace-daemon", standing: "person",
  account, subject, host, key, iat, exp }
```

The daemon gives every account device's socket a fresh `standingNonce` in its welcome. The client
proves standing with `account.standing { grant, proof }`. The `proof` is the device key's ECDSA
P-256 signature of `ace-standing/v1\n<host>\n<nonce>\n<grant>`. The daemon accepts it only when all
of these hold:

- The grant verifies against the keys this build pins.
- It says `person`.
- It names this daemon's account, this host and the socket's device.
- The signature verifies with the key the grant names.

The standing lasts until that grant's `exp`. The client proves again after each
`account.grant.refresh`; a refresh alone never extends it.

- A grant captured on the way is worthless without the device key. A proof is worthless on any
  other socket (another nonce) or daemon (another host).
- The device key is made in WebCrypto with its private half non-extractable, kept in the window's
  memory and never written anywhere (`apps/web/src/boot/standing-key.ts`).

### 4. Device grant formats, and older daemons

Older daemons treat any format 1 device grant as the person. So the backend never mints a format 1
device grant from anything a machine holds:

| Principal                             | Device grant                                   | Person's grant        |
| ------------------------------------- | ---------------------------------------------- | --------------------- |
| `person` session                      | format 1 (for older daemons)                   | with `host` and `key` |
| `legacy` session (an older app's)     | format 1                                       | never                 |
| `exposed` session, machine credential | format 2, `standing: machine`, bound to `host` | never                 |

A format 1 parser refuses format 2, so a machine's device grant never reaches an older daemon as
the person; older daemons simply can't be reached with one. Newer daemons admit format 1 or format
2 with admin and no standing; a format 2 grant bound to another host is refused. The relay admits
format 2 at `/client`, and a bound grant only for its own host.

### 5. Fresh sign-in

`MachineAccount.freshSignIn` mints a market grant for this machine's relay host id and verifies it
against the pinned keys (`shippedGrantKeys`, `@ace/account-grant/keys`). The grant must be:

- a machine grant;
- for this account and this host;
- signed in within ten minutes of the daemon's clock (`authAt`, with a minute ahead allowed).

This is what lets the host token do a person-only action, and what lets it make a person's pairing
link (§7). A backend whose key isn't pinned makes nothing fresh.

### 6. The market

Market grants from anything but a `person` session are `kind: machine`. A sensitive action (ADR
0174 §2) needs a `device` grant whose `action` claim names that request, `METHOD /path`, and a
sign-in from the last ten minutes. The sensitive actions are withdraw, transfer and accepting one,
handle changes, verification, and a verified profile's edits. Anything else is refused with
`person_grant`, and only a `person` session may ask for a grant with `action`.

The daemon still runs the request:

1. The market answers `person_grant`, and the daemon passes that on with the `action`.
2. The app asks for a grant naming that request with its own session.
3. The app sends the request again with that grant (`marketplace.request.personGrant`).

A grant captured on the way can only repeat the request the person asked for. The CLI holds no
session, so it says to do it in an app. The daemon's market grants name its relay host id, not the
`host-id` file's UUID.

### 7. Pairing

A pairing link records whether its maker had the person's standing, and the device it pairs keeps
that (`devices.person`, `pairing_codes.person`). The maker had it if either:

- its socket was the person's: a person's paired device, or an account device that proved it on
  that socket; or
- it used the host token with a fresh sign-in (§5).

Both ways of making links check this: `fleet.request pairing` and `POST /v1/pairings`. Devices
paired before this change have no record of who made their links, so they are not the person's
until they pair again from a link the person makes.

### 8. Sign-in and migration

- **The app** asks the backend for an enrollment ticket for its daemon's relay host id, and
  `PUT /v1/ace-account` sends the daemon only the ticket. The desktop app derives the host id from
  the home's `relay/noise-static.key`; a browser uses the one the daemon reports in its account
  status. The app can't authenticate its local daemon against a process that reads the same files,
  so what it sends is worth no more than those files: a machine credential.
- **`ace login`** signs in as `machine` and exchanges at once with `sole`; nothing of the session is
  written. If the exchange fails, the sign-in ends signed out.
- **An old session file** is exchanged once on start (`exposed`, plus `sole` for `ace login`'s) and
  rewritten. Until it is, the daemon keeps working with a machine's standing and reports
  `signInAgain`. No thread or local data is touched.
- **A backend without machine credentials** answers 404 or publishes no exchange key, and the
  daemon keeps a session as before.

### 9. Logs and dumps

- Diagnostic redaction removes fields named `grant`, `*Grant`, `standing` and `*proof`, two-part
  signed grant tokens, and `ace.grant.` subprotocol values.
- Crash dumps stay on the machine (Crashpad never uploads).
- After an exchange, nothing of the session stays in the daemon's memory.
- Triage agents are told never to open the account files or the relay key.

## Who acts as the person after this

Without a fresh sign-in:

- **An ace app's account device** that signed in in a browser on this backend version, on each
  socket where it proves the person's grant with its in-memory key. Today that is the desktop app's
  and the web app's windows.
- **A paired device paired from a link the person made** (§7).

With a fresh sign-in, the host token too, for ten minutes: for person-only actions, and for making
a person's pairing links.

Not the person:

- the host token alone;
- any process reading `ACE_HOME` (machine credential, pending credential, an old session file);
- a daemon's own device grants;
- an app session from before this version, until it signs in again;
- any account device that doesn't prove on its socket;
- devices paired before this change, or from a link the host token alone made.

**The iPhone app:** on the account route (through ace's relay) it has a machine's standing until it
sends `host` and `key` and proves on its sockets. Paired to a daemon from a link the person made,
it is the person's.

## What this doesn't stop

- **A client's own store.** The desktop app's session is as safe as `safeStorage`. macOS binds the
  Keychain item to the signed app, but Linux's Secret Service and Windows DPAPI give it to any
  process of the same user, which can then sign in as the person. A browser profile is the same.
  Closing that needs a device-bound key (Secure Enclave, TPM).
- **Reading process memory** (a debugger, ptrace where allowed), as ADR 0178 §12.7 says.
- **Admin.** A machine credential still opens every machine on the account with admin (ADR 0111);
  the machine code limits that.
- **Older daemons** stay exposed in two ways until they upgrade. A format 1 grant from a person's
  session or an older app's still acts as the person there, and a process can get one only from
  that app's store. Their own session files also stay on disk.
- **An older daemon that runs `ace login`** before upgrading is covered: its session is `machine`
  from birth, so its file yields no person's grant.

## Mixed versions

| Pairing                                   | Result                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Older daemon, new backend                 | Connects as before. Its session is `exposed` (or `machine` from birth): its device grants are format 2, which other older daemons refuse.                        |
| New daemon, older backend                 | No exchange key, so it keeps a session as before. No person's grants exist, so no account device is the person.                                                  |
| New app, older daemon                     | Format 1 grant in the hello, as before; the older daemon ignores the nonce flow. Sign-in hands it a ticket it can't read, so it stays signed out until upgraded. |
| Older app (or the iPhone app), new daemon | Admitted with admin and a machine's standing. Its sensitive market actions fail with an error it can't read.                                                     |
| Older backend, new market                 | Sensitive actions are refused until the backend can mint person's grants with `action`.                                                                          |
| Relay                                     | Format 1 and format 2 at `/client`; format 1 machine grants at `/host`.                                                                                          |

## Deploy order

1. **ace cloud:** `wrangler d1 migrations apply ACCOUNTS --remote --env production` (0004), then
   deploy the Worker. This only adds behaviour: older apps and daemons keep working, older daemons'
   sessions become `exposed` at their next relay grant, and `ACE_LEGACY_PERSON_UNTIL` stays unset.
2. **The market Worker.** From then on, sensitive actions need the person's grant.
3. **The daemon with the desktop and web apps**, together: the desktop app signs its daemon in with
   a ticket that only a new daemon reads.
4. **The iPhone app**, with `host`, `key` and `account.standing` on its account route.

Releasing the daemon before step 1 fails closed: account devices lack the person's standing, and
signing in from the app fails, until the backend is deployed.

## Tests

- `apps/cloud/src/account-machine-credential.process.test.ts` (Worker and D1 under Miniflare).
- `apps/daemon/src/machine-credential.process.test.ts` (a real daemon through that Worker).
- `apps/market/src/me-auth.process.test.ts` (sensitive actions refuse a machine's grant, and a
  person's grant for another request).
- Unit tests: `device-grant.test.ts` (the proof), `grant.test.ts` (formats, host-key proof),
  `fresh-sign-in.test.ts`, `directory.test.ts`, `grant-cache.test.ts`, `window-session.test.ts`,
  `diagnostic.test.ts`.
