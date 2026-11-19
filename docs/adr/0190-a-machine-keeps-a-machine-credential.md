# 0190: The person's standing comes only from proof a reader of ACE_HOME can't make

Status: accepted. Date: 2026-11-18. Amends [ADR 0111](0111-account-machine-access.md) (who holds
what, grants, a machine signing in), ADR 0115 (paired devices), ADR 0174 §2 (the market's
sensitive actions) and ADR 0178 §12.7 and §12.8 (who counts as the person; a fresh sign-in no
longer does). Closes the gap ADR 0178 §12.8 names as "the machine's own ace session". Revised
after two rounds of review of #2310.

## Threat model

**The guarantee holds against a process of the same user that can read anything.** It reads every
file in `ACE_HOME`: the host token, `ace-account.json`, the relay host key and the TLS key. It talks
to the daemon over any of its sockets, and to ace's backend, relay and market over the network,
for as long as it likes. Such a process can't act as the person, even when it waits for the person
to sign in.

**Out of scope: a process that can change what runs or what the person sees.** That stronger
attacker can already act as the person, and only OS-level separation stops it (a sandbox for coding
agents, a separate user, platform app isolation). Examples:

- **Writing ACE_HOME**, including the daemon's database (`devices.person`, pairing codes) or its
  code and endpoint file.
- **Replacing the daemon**, or answering at its loopback address in its place.
- **Attaching a debugger** to the app, the daemon or the browser, or reading their memory.
- **Driving the app's UI**: synthetic input, accessibility automation, a remote-debugging port.
- **Tampering with the renderer**: a patched app bundle, an injected extension.
- **Reading the OS keychain where the OS hands it to any process of the user.** That is Linux's
  Secret Service and Windows DPAPI, and a browser profile; on macOS the Keychain is bound to the
  signed app.

ADR 0178 §12.7 already treats the host token as "the person's whole authority" for honest clients.
This ADR draws the line for the person-only actions against the reader above.

## Context

When the person signed in to ace in the app, the app handed its ace session to its daemon, and the
daemon wrote it to `ACE_HOME/ace-account.json`. The backend minted a device grant for any device
from any session, and every daemon counted an account device as the person. So a reader of that
file could act as the person. Review then found the same shape in more places:

- links any admin made pairing devices that counted as the person;
- the host token plus "someone signed in in the last ten minutes" counted as the person;
- person grants that anyone relaying a socket could replay;
- format 1 grants that older daemons take as the person;
- market grants bound only to a method and path.

**The rule: the person's standing comes only from proof the reader above can't make or replay, end
to end, across mixed versions.** One proof qualifies: **a browser sign-in, held by the client that
made it, used through a key only that client's memory holds, on one socket or for one request at a
time.**

A recent sign-in is not proof of who is asking now, so it authorizes nothing (§5).

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
- `legacy`: a session from before this version, which may sit in any older daemon's file.

A sign-in says who will hold it (`AceLoginRequest.holder`). `ace login` is `machine`, and so is a
sign-in without a return address, which is how older daemons start one. A session is marked
`exposed` when an older daemon asks for a machine grant with it, or when a daemon exchanges it from
its session file.

**Only `person` speaks for the person.** A `legacy` session never does, with no transition window,
so its client signs in again. A session that is gone, expired or retired by the time a grant is
decided gets nothing, in any format.

### 2. Machine credentials

`POST /v1/machine-credentials` issues a credential for one host id. It takes either a session the
daemon holds (`ace login`, an old session file), or an **enrollment ticket** the app got with its
own session from `POST /v1/machine-enrollments`. A ticket is single use, lasts ten minutes and is
bound to the host id. The app hands its daemon the ticket, never the session.

- **Host-key proof.** The request carries the relay host key and an HMAC over the host id and the
  credential. The HMAC key is the X25519 secret between the relay host key and the backend's
  published exchange key (`/v1/keys` `exchangeKey`).
- **The daemon chooses the credential** and writes it to `ace-account.pending.json` first, with
  the sign-in it is to replace (`predecessor`). If the answer is lost, the daemon asks again with
  the same credential and gets the same answer, or recovers it on the next start. It recovers it
  only while that predecessor is still the machine's sign-in; a stale one is signed out at the
  backend.
- **One sign-in change at a time.** The daemon runs exchange, adoption and recovery one after
  another (`oneSignIn`).
- **One guarded D1 batch** does the issue:
  1. Mark the session exposed if it was on a disk.
  2. Insert the credential, only while the session's token is unretired or the ticket unspent.
  3. Retire the token (`sole`) or spend the ticket.
- **What a credential can do:** machine grants for its own host only; device grants in format 2
  with a machine's standing (§4); machine-kind market grants (§6). It can't be exchanged again,
  can't forget machines, and can't ask for a person's grant.

### 3. The person's standing on a socket

A device grant request may name `host` and `key`, the device's P-256 public key. For a `person`
session the backend then returns a **person's grant**:

```
{ v: 2, kid, kind: "device", aud: "ace-daemon", standing: "person",
  account, subject, host, key, iat, exp }
```

Every socket's welcome carries its own `standingNonce`: the app's page on loopback, an account
device, a paired device. The client proves standing with `account.standing { grant, proof }`. The
`proof` is the device key's ECDSA P-256 signature over
`ace-standing/v2\n<host>\n<nonce>\n<binding>\n<grant>`.

`binding` is the socket's **channel binding**:

- On a relayed socket it is the Noise handshake hash, which the client and the daemon each derive
  from their own end of the stream.
- On a socket with no secure channel of its own it is `none`: loopback, or a pinned direct path,
  where reaching the right daemon is the network's job.

A reader of `ACE_HOME` holds the relay host key, so it can answer the app as the host through the
relay and pass on the real daemon's nonce. The proof the app makes then names that impostor's
handshake hash, which the real daemon's stream doesn't have, so it fails there. (Answering at
loopback or on a direct path instead is endpoint spoofing, which is out of scope.)

The daemon accepts a proof only when all of these hold:

- the grant verifies against the keys this build pins;
- it says `person`;
- it names this daemon's account, this host and the socket's device;
- the signature verifies with the key the grant names.

The standing lasts until that grant's `exp`, and the client proves again every few minutes. A
grant refresh never extends it.

The device key is made in WebCrypto with its private half non-extractable, and kept in the
window's memory only. The tab proves for every client it uses. A worker-hosted client mirrors its
socket's challenge to the tab (`standingChallenge`), which sends the proof through the worker
(`apps/web/src/boot/standing-keeper.ts`, `window-prover.ts`).

### 4. Device grant formats, and older daemons

Older daemons treat any format 1 device grant as the person. So **only a `person` session ever
gets a format 1 device grant**:

| Principal                                         | Device grant                                   | Person's grant        |
| ------------------------------------------------- | ---------------------------------------------- | --------------------- |
| `person` session                                  | format 1 (for older daemons)                   | with `host` and `key` |
| `legacy` or `exposed` session, machine credential | format 2, `standing: machine`, bound to `host` | never                 |

A format 1 parser refuses format 2. So nothing a machine kept, and no session from before this
version, reaches an older daemon as the person. Newer daemons admit either format with admin and
no standing. The relay admits format 2 at `/client`, and a bound grant only for its own host.

### 5. No ambient freshness

A sign-in in the last ten minutes no longer authorizes anything. A reader of the host token could
otherwise wait for the person to sign in and act in that window. These need a socket that proved
the person's standing (§3), or a device paired from a link such a socket made (§7):

- installs and the market's sensitive actions;
- answering a person-only market request;
- changing "Ask me before agents publish";
- making a person's pairing link.

The host token alone is refused (`reauth`, "do it in the ace app signed in as you"). The CLI holds
no session and no device key, so it can't prove the person. Its person-only commands say to use
the app, and it no longer offers `ace login` for them. Binding an `ace login` to one operation
would take a per-operation browser approval, which is not built.

### 6. The market

Market grants from anything but a `person` session are `kind: machine`. A sensitive action (ADR
0174 §2) needs a `device` grant from a person's session whose `action` claim is the request's
**intent**, `METHOD /path <SHA-256 of the exact body>`, and a sign-in from the last ten minutes.
The sensitive actions are withdraw, transfer and answering one, handle changes, verification, and
a verified profile's edits. The market checks the body it received against that digest. It spends
each person's grant once (`spent_person_grants`), so a captured one does nothing on a second send.

The daemon still makes the request; one builder (`@ace/client/market-intent`) shapes it for both
the daemon and the app:

1. The market answers `person_grant`, and the daemon passes that on.
2. The app derives the intent from the person's own operation, never from the daemon's answer.
3. The app gets a grant for that intent with its own session.
4. The app sends the request again with it.

A different recipient, handle or reason is a different digest.

### 7. Pairing

A pairing link records whether its maker had the person's standing, and the device it pairs keeps
that (`devices.person`, `pairing_codes.person`). The maker had it only if its socket proved the
person's standing (§3), or it is itself a device paired from a person's link. Both ways of making
links check this: `fleet.request pairing`, and `POST /v1/pairings` with a paired device's
credential. The host token never makes a person's link, however recently anyone signed in.
Devices paired before this change are not the person's until paired again.

### 8. Sign-in and migration

- **The app** gets an enrollment ticket for its daemon's relay host id, and `PUT /v1/ace-account`
  sends the daemon only the ticket. The desktop app derives the host id from the home's
  `relay/noise-static.key`; a browser uses the one the daemon reports.
- **`ace login`** signs in as `machine` and exchanges at once with `sole`.
- **An old session file** is exchanged once on start and rewritten. Until then the daemon works
  with a machine's standing and reports `signInAgain`. No thread or local data is touched.

### 9. Logs and dumps

- Diagnostic redaction removes fields named `grant`, `*Grant`, `standing` and `*proof`, two-part
  signed grant tokens, and `ace.grant.` values.
- Crash dumps stay on the machine.
- Triage agents are told never to open the account files or the relay key.

## Who acts as the person after this

- **An ace app signed in as the person in a browser on this backend version**: the desktop app's
  and the web app's windows. It acts as the person on each socket where it proved its grant with
  its in-memory key, to its own machine over loopback and to other machines on the account. It can
  also make market sensitive requests with a grant for that exact request.
- **A device paired from a link one of those sockets made.**

Nothing else is the person:

- the host token, with or without a recent sign-in;
- the CLI;
- anything in `ACE_HOME`;
- a daemon's own grants;
- sessions from before this version;
- devices paired before this change;
- the iPhone app on the account route, until it proves on its sockets. Paired from a person's
  link, it is the person's.

## Residuals

- **Out of scope by the threat model:**
  - writing ACE_HOME, including the daemon's `devices.person` bit and pairing codes;
  - replacing the daemon or answering at its loopback or direct address;
  - debuggers and memory readers;
  - driving the app's UI, or tampering with its renderer;
  - OS keychains that release the app's session to any process of the user (Linux Secret
    Service, Windows DPAPI, browser profiles).
- **Admin.** A machine credential still opens every machine on the account with admin (ADR 0111);
  the machine code limits that.
- **Older daemons** stay as exposed as before to format 1 grants from a person's own session, until
  they upgrade.

## Mixed versions

| Pairing                                 | Result                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Older daemon, new backend               | Connects as before. Its session is `exposed` or `legacy`, so its device grants are format 2, which other older daemons refuse.       |
| New daemon, older backend               | No exchange key, so it keeps a session as before. No person's grants exist, so nothing is the person.                                |
| New app, older daemon                   | Format 1 grant from the person's session, as before. Sign-in hands it a ticket it can't read, so it stays signed out until upgraded. |
| Older app or the iPhone app, new daemon | Admin, no standing. Its person-only actions are refused.                                                                             |
| Older backend, new market               | Sensitive actions are refused until the backend mints intent grants.                                                                 |

## Deploy order

1. **ace cloud:** apply D1 migration 0004, then deploy the Worker.
2. **The market:** apply its publishers migration 0003, then deploy the Worker.
3. **The daemon with the desktop and web apps**, together.
4. **The iPhone app**, once it sends `host` and `key` and proves on its sockets.

## Tests

- `apps/cloud/src/account-machine-credential.process.test.ts` (Worker and D1 under Miniflare).
- `apps/daemon/src/machine-credential.process.test.ts` (a real daemon through that Worker).
- `apps/market/src/me-auth.process.test.ts` (a machine's grant, another payload, another request,
  a replay).
- `apps/daemon/src/cli-market-agent.process.test.ts` (the CLI never acts as the person).
- Unit tests: `device-grant.test.ts`, `grant.test.ts`, `answer-gate.test.ts`,
  `fresh-sign-in.test.ts`, `directory.test.ts`, `standing-keeper.test.ts`,
  `window-session.test.ts`, `diagnostic.test.ts`.
