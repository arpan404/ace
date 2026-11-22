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

Every socket's welcome carries its own `standingNonce`, and `standingHost`, the daemon's relay
host id (the fingerprint of its relay key), which is what grants and proofs name. It is a field of
its own: the welcome's `hostId` is the home's UUID and never what a grant names. Every socket
gets one: the app's page on loopback, an account device, a paired device. The client proves
standing with `account.standing { grant, proof }`. The `proof` is the device key's ECDSA P-256
signature over `ace-standing/v2\n<host>\n<nonce>\n<binding>\n<grant>`.

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
- it names the machine's **owner** (§3a), this host and the socket's device;
- the signature verifies with the key the grant names.

Grants are parsed as canonical base64url only: a respelling of the same bytes (unused low bits in
the last character) is refused everywhere a grant is read, and the market spends a grant by the
SHA-256 of the claims bytes it verified, so two spellings can't spend it twice.

The standing lasts until that grant's `exp`, and the client proves again every few minutes. A
grant refresh never extends it.

The device key is made in WebCrypto with its private half non-extractable, and kept in the
window's memory only. The tab proves for every client it uses. A worker-hosted client mirrors its
socket's challenge to the tab (`standingChallenge`), which sends the proof through the worker
(`apps/web/src/boot/standing-keeper.ts`, `window-prover.ts`).

### 3a. The machine's owner

The account the machine is signed in to is not who it answers to. The host token can change that
account (`PUT /v1/ace-account` with a ticket from any account), so a reader of `ACE_HOME` could
hand the machine to an account it signed in to itself, whose own person's grant is genuine. The
machine therefore keeps an **owner**, the account whose person's grants carry the person's
standing here, in `ace-owner.json`:

- **The first owner** is the account that the first person's proof's own grant names (§3): the
  session of a window signed in through a browser. It is never the account the machine is
  signed in to, which the host token can switch before anyone proves. A handover made before
  the person's first proof therefore doesn't make the handover's account the owner.
- **First use is a residual.** A reader present before the person's very first proof can prove
  first, with a person's grant of an account it signed in to itself, and become the owner. The
  person sees it in Settings ("This machine belongs to … · Not you?") and recovers with the
  local reset below.
- **A handover changes nothing**: a person's grant from any other account proves nothing, on any
  socket, whatever account the machine is signed in to.
- **Changing it** ends every paired device's person standing and cancels every pending person's
  link (§7). The devices stay paired with their other access, and the next person's proof sets
  the new owner. It takes one of two things:
  - a socket that proved the owner's own grant (`account.owner.release`; a paired device's key
    is not enough), from Settings' "Let it go";
  - a local reset that a reader can't do: removing `ace-owner.json` with the daemon stopped (a
    write to `ACE_HOME`).
- **Every change ends every standing**: each socket's standing records the owner generation it
  was proven under, and counts only while that is current. Claims and releases run one at a
  time:
  - a release moves the generation as it starts, drops what is kept beyond sockets, removes
    the file, then moves the generation again;
  - while it runs, nothing is proven or claimed;
  - a proof (account or paired) is committed only if the generation it read as it began is
    still current and no change is under way, so a proof begun before a release never lands
    after it, and never reclaims the machine.
- **The app shows it**: the daemon reports `owner` in its account status, and Settings says
  whose the machine is, with "Let it go" for the owner and "Not you?" (the reset steps) for
  anyone else (`apps/web/src/features/ace-account/machine-owner-row.tsx`).

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
the person's standing (§3), or a paired device's socket that proved it with its own key (§7):

- installs and the market's sensitive actions;
- answering a person-only market request;
- changing "Ask me before agents publish", alone, in a batch (`settings.setMany`) or by a reset:
  every key a write names is checked before any is written, all or none, and a reset leaves out
  what the socket may not write;
- making a person's pairing link.

The host token alone is refused (`reauth`, "do it in the ace app signed in as you"). The CLI holds
no session and no device key, so it can't prove the person. Its person-only commands say to use
the app, and it no longer offers `ace login` for them. Binding an `ace login` to one operation
would take a per-operation browser approval, which is not built.

### 6. The market

Market grants from anything but a `person` session are `kind: machine`. A sensitive action (ADR
0174 §2) needs a `device` grant from a person's session whose `action` claim is the request's
**intent**, `METHOD /path <SHA-256 of the exact body>`, and a sign-in from the last ten minutes.
The sensitive actions are withdraw, transfer and accepting or declining one, handle changes,
deleting an entry, applying for and checking verification, and a verified profile's edits. Apart
from the profile edits, they come from one table (`@ace/marketplace/person-only`), which maps each
action the daemon takes only from the person to the market routes it calls. The daemon's
person-only check and the market's sensitive routes both read it, so they can't drift. The market checks the body it received against that digest. It spends
each person's grant once (`spent_person_grants`), so a captured one does nothing on a second send.

The daemon still makes the request; one builder (`@ace/client/market-intent`) shapes it for both
the daemon and the app:

1. The market answers `person_grant`, and the daemon passes that on.
2. The app derives the intent from the person's own operation, never from the daemon's answer.
3. The app gets a grant for that intent with its own session.
4. The app sends the request again with it.

A different recipient, handle or reason is a different digest.

### 7. Pairing

A pairing link records whether its maker had the person's standing (`pairing_codes.person`). Only
`fleet.request pairing` from a socket that proved the person's standing on that very socket (§3,
or below) makes a person's link. A link made over HTTP (`POST /v1/pairings`) is always an
ordinary pairing, whoever's bearer token asks for it. A bearer token proves nothing: the CLI
keeps a paired device's bearer in its profile on disk, so a reader of `ACE_HOME` holds it. The
host token never makes a person's link either, however recently anyone signed in.

A paired device's **bearer token is never the person**. A reader of `ACE_HOME` holds the relay
host key, so on a self-hosted relay it can register as the host, and a paired client reconnecting
there hands it that token. So the redeeming app names `standingKey`, the public half of a P-256
key it keeps and never exports (the web app keeps it as a non-extractable `CryptoKey` in its
origin's IndexedDB, `apps/web/src/boot/paired-standing-key.ts`). The daemon stores it with the
device (`devices.standing_key`) when the link was a person's. A device that names no key never
carries the person's bit at all (`Devices.create`), so nothing it does derives from it. On each socket the device proves
with `device.standing { proof }`: that key's signature over
`ace-paired-standing/v1\n<host>\n<nonce>\n<binding>\n<deviceId>`, the same challenge and channel
binding as §3. A collected token, or a proof made for another socket or channel, proves nothing;
revoking the device ends its sockets.

The iPhone app makes one such key per machine it pairs, in the Secure Enclave (P-256,
`kSecAttrTokenIDSecureEnclave`, this device only, usable after first unlock), and keeps only its
tag in the Keychain. Everything the key touches is Swift's, so a compromised bridge script can't
misuse it:

- **The redemption.** Swift sends `POST /v1/pair` itself over pinned HTTPS, with the code and the
  key's public half. The bridge gets only the machine's answer, never the code, and can't name a
  key of its own.
- **The signing inputs.** On each paired machine's socket, Swift reads `standingHost` and
  `standingNonce` from the welcome that arrived on that socket, takes the binding from that
  socket's own transport (`none` on the pinned direct sockets paired iPhones use) and the device
  from its target. It builds `pairedStandingText` only from single canonical lines (printable
  ASCII without spaces), signs it and sends `device.standing` on that socket. It consumes the
  daemon's answer and tells the bridge only whether the machine took it.
- **The key's life.** It becomes the machine's when pairing succeeds, and the pairing fails if
  the phone can't record that. It is replaced when the machine is paired again and deleted when
  it is removed. A key that can't be deleted stays named until a later pairing or removal
  deletes it.

A phone without a Secure Enclave (the Simulator) names no key. A machine that refuses the proof
says so in Machines, with Pair again.

Devices paired before this change, or by an app that names no key (the iPhone app before it
did), are not the person's until paired again from a person's link by an app that does.

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
- **A device paired from a link one of those sockets made**, on each socket where it proved with
  the key it named at pairing.

Either only under the machine's owner (§3a): a person's grant from another account, whatever
account the machine is signed in to, proves nothing.

Nothing else is the person:

- the host token, with or without a recent sign-in;
- the CLI;
- anything in `ACE_HOME`;
- a daemon's own grants;
- sessions from before this version;
- a paired device's bearer token, however it was got;
- devices paired before this change, or by an app that names no standing key;
- the person's grant of any account but the owner's;
- the iPhone app on an account route, until it proves there (§3); on a paired route it names a
  standing key when it pairs (§7).

## Residuals

- **Out of scope by the threat model:**
  - writing ACE_HOME, including the daemon's `devices.person` bit and pairing codes;
  - replacing the daemon or answering at its loopback or direct address;
  - debuggers and memory readers;
  - driving the app's UI, or tampering with its renderer;
  - OS keychains that release the app's session to any process of the user (Linux Secret
    Service, Windows DPAPI, browser profiles).
- **Owner on first use.** A reader present before the person's very first proof can prove first
  and own the machine (§3a). Settings shows the owner so the person sees it, and the local reset
  recovers.
- **A link redeemed through an impersonated relay registration.** The pairing code travels on the
  relay channel pinned to the host key, which a reader holds: one that answers as the host on a
  self-hosted relay while the person redeems a person's link takes the code and can redeem it
  with its own key. That is answering at the daemon's endpoint (out of scope above); a link is
  single-use and short-lived, and the person sees their own device fail to pair.
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
| Older app paired from a person's link   | Names no standing key, so it is paired without the person's standing until it pairs again once updated.                              |
| Older backend, new market               | Sensitive actions are refused until the backend mints intent grants.                                                                 |

## Deploy order

1. **ace cloud:** apply D1 migration 0004, then deploy the Worker.
2. **The market:** apply its publishers migration 0003, then deploy the Worker.
3. **The daemon with the desktop and web apps**, together.
4. **The iPhone app**, once it sends `host` and `key` and proves on its sockets, and names a
   standing key when it pairs.

## Tests

- `apps/cloud/src/account-machine-credential.process.test.ts` (Worker and D1 under Miniflare).
- `apps/daemon/src/machine-credential.process.test.ts` (a real daemon through that Worker).
- `apps/daemon/src/machine-owner.process.test.ts` (a handover to another account, the owner
  letting go, a paired device's token without its key's proof).
- `apps/market/src/me-auth.process.test.ts` (a machine's grant, another payload, another request,
  a replay).
- `apps/daemon/src/cli-market-agent.process.test.ts` (the CLI never acts as the person).
- Unit tests: `device-grant.test.ts`, `grant.test.ts`, `answer-gate.test.ts`,
  `fresh-sign-in.test.ts`, `directory.test.ts`, `standing-keeper.test.ts`,
  `window-session.test.ts`, `diagnostic.test.ts`.

## Amendment 1 (2026-11-21): the owner's own machine asks once

Revised after three rounds of security review of #2533.

### What went wrong

On the owner's own Mac, signed in, turning a Spade bot's Computer use on said "Confirm it's
you", and confirming changed nothing. The desktop app sends Spade requests straight to Spade
(ADR 0123) unless a list says the change is the person's. That list, in the web app, was a
hand-kept copy of the daemon's and named only autonomy and move acceptance. ADR 0171 amendment 7
added the Permissions switches, the never-use list and the loosening routes to the daemon's copy
only. They went to Spade unstamped, Spade refused them, and proving standing on the daemon socket
couldn't help because the retry went the same direct way.

Now both read one list (`@ace/client/spade-person-only`). A route parity test reads Spade's
router and fails for any route whose handler reads the person's stamp, directly or through a
helper, that the list doesn't name. A direct reply that is Spade's standing refusal is sent again
through the daemon. That re-send is recovery from version skew (a newer Spade than this build's
list), not a security control: Spade's refusal is the control.

### The rule

**An agent can never loosen its own permissions.** An agent is anything holding only the daemon
token, an MCP lease or a provider process. Everything else gets out of the way.

### Decision

1. **A device key.** The desktop app's main process keeps one P-256 key pair per account backend,
   sealed with `safeStorage` in `<userData>/ace-standing-key.enc` and never in `ACE_HOME`
   (`apps/desktop/src/main/standing-key.ts`). The private half never leaves main. The key is
   bound to the account and to the session it was enrolled under.
2. **Person's statements.** Everything the key signs is a person's statement
   (`@ace/account-grant/person-statement`): one canonical text, a line per field in a fixed
   order, naming
   - the account and the device (the SHA-256 of the key's public point);
   - the purpose (`standing` or `enroll` today) and the action (`socket` today);
   - the target (here, a digest of the tagged connections) and the audience (the daemon's relay
     host id);
   - the verifier's single-use nonce, and when it was made and ends (a minute at most).

   The key signs nothing that doesn't parse as a statement for its own account and device. Any
   verifier holding the account's registered public keys checks it with `verifyStatement`.

3. **Main owns the exchange.** A window can only ask main "prove me" or "enroll", naming the
   account backend. It never hands main a challenge, a socket or an account.
   - **Tags.** Main adds a header (`x-ace-app-socket`) only to WebSocket upgrades to the daemon's
     exact transport address, from a page at the app's own origin, in the app's default session.
     The agents' browser and visualizations run in other partitions. A page can't read or set the
     header; main strips any it tries. A tag carries when main made it, and the daemon takes it
     only within a minute of that. A live socket's tag is never taken again. The daemon remembers every tag it
     took for twice the freshness window on a monotonic clock, then keeps a horizon (the latest
     time any forgotten tag carried) and refuses every tag at or before it, so no jump of the
     wall clock reopens one. A backward jump can refuse new tags until the wall clock passes the
     horizon; those sockets then prove per socket, as before.
   - **The daemon proves who it is.** Main fetches each challenge itself over HTTP with the host
     token, with no redirects followed (`POST /v1/standing/app/challenge`). It sends a fresh
     ephemeral X25519 key and its tags. The daemon answers with:
     - a single-use nonce, its host and owner;
     - for each tag that names a live socket, that connection's own nonce;
     - an HMAC over all of it, keyed by the X25519 secret between its relay key and main's
       ephemeral key.

     Main checks the HMAC against the relay key it pinned, in its sealed store, at the first
     enrollment. A later enrollment never moves the pin, whatever the home's key file says.

   - **Statements name connections.** Main signs a `standing` statement whose target is a digest
     of the challenge's `tag~connection` pairs. It sends the pairs beside it, at most 16 per
     statement (`APP_STANDING_MAX_SOCKETS`), in batches (`POST /v1/standing/app/prove`).
   - **What the daemon checks:**
     - the statement is genuine, live and canonical, and its nonce unused;
     - its account is the owner and its audience is this host;
     - its key is enrolled, and the digest matches the pairs;
     - each pair's tag still names the very connection it names.

     It then gives those sockets the person's standing, for as long as each lasts, under this
     owner.
4. **Enrolling needs the backend's word on a fresh sign-in.** App proofs are recorded as `app`,
   apart from the grant proofs recorded as `account`. Enrolling a key
   (`POST /v1/standing/app/key`, an `enroll` statement signed by the new key) takes both of
   these:
   - a grant ace's account backend minted from the person's own session (`market-publish`, kind
     `device`). It carries `authAt`, the time that session signed in through the browser, which
     must be within the last ten minutes. Its `action` names this daemon, this key and this
     challenge's nonce (`ace-enroll-device/v1 <host> <device> <nonce>`), so it enrolls nothing
     else, once. The daemon reads it with the keys it pins, from ace's backend or the one it is
     signed in to;
   - one of the statement's sockets having proved the owner's grant on itself.

   A socket proven with the key can't enroll another key, and an app proof never counts for
   enrolling. Main tries to enroll only within ten minutes of a new session arriving: rewriting
   the session it already has is no sign-in. "Let it go" and joining an organization still take
   an `account` proof.

5. **Revocation is durable and authenticated.**
   - Main writes the app's session through the same one-at-a-time queue as every other step:
     it reads the session saved before, compares, writes and revokes, with nothing in between.
     Two writes of one new session count as one sign-in.
   - Signing out writes the key's revocation to the sealed store before it clears the session,
     so a crash between leaves the key revoked, never the session gone and the key enrolled. A
     failure to write the revocation reaches the page, and the session stays.
   - Each pending revocation names the relay key of the daemon it was enrolled at (pinned before
     any enrollment is sent). Main sends `DELETE /v1/standing/app/key` with a fresh ephemeral
     X25519 key, and clears the entry only on that daemon's receipt: an HMAC over its host and
     the revoked key, keyed by the X25519 secret with the pinned relay key. A 200 from anything
     else clears nothing. Main tries again when the app starts and before every step. The daemon
     revoking it ends the standing it gave on open sockets.
   - Pending revocations are never dropped. While 64 wait, main enrolls no new key.
   - Proofs, enrollments, sign-ins and sign-outs run one at a time in main, so an enrollment in
     flight finishes before a sign-out revokes it. A new session revokes the key made under the
     one before, an enrollment that fails is revoked rather than forgotten, and enrolling
     replaces a key only after revoking the old one.
   - A change of owner drops every enrolled key with the owner file.
6. **Only where the store holds.** Main keeps a key only when all of these hold
   (`app-standing-gate.ts`):
   - the app is packaged;
   - it runs from its default profile (no `--user-data-dir`, no `ACE_DESKTOP_USER_DATA`);
   - no debugging switch is on;
   - the OS store seals without plaintext (Linux `basic_text` is refused);
   - on macOS, the running bundle meets ace's designated requirement: identifier `dev.ace.app`,
     Developer ID, team `5J88TLUP2J` (checked with `codesign`).

   Unsigned, ad-hoc and development builds prove per window, as before. A released app refuses to
   start with Chromium's remote-debugging or inspector switches; Electron's fuses already refuse
   run-as-Node, Node's inspector arguments and `NODE_OPTIONS`.

7. **No per-control re-asks.** A refused person-only change is proven again on that socket
   (`withStanding`) and sent once more before anything is shown. Confirm it's you tries the
   window's own proof first and opens a browser only when that fails. The first browser
   Confirm it's you after this version is the one that enrolls the key.

Unchanged: remote and relayed clients (one proof per socket, §3), paired devices (§7),
organization hosts (ADR 0209), and agents.

### Where this goes: account-rooted standing

Spade bots will also run in ace's cloud (the hosted runner, ADR 0205), so the person's standing
can't stay local-only. The key and the statement are shaped for that:

- **The device key** is a per-device key pair whose public half the person registers with their
  ace account (cloud.acehq.dev). The private half stays on the device.
- **Every proof or approval is a person's statement**: signed, short-lived and bound to one
  purpose, naming the account, the device, the action or route, the target bot and the expiry.
- **Spade verifies statements itself**, against the account's registered device keys, locally
  and in the cloud. The daemon becomes a relay and never a trusted stamper. That is what closes
  #2535 (below).

Not built in this amendment: cloud registration of device keys, the statement purposes for
Spade changes, and Spade-side verification. The daemon is today's only verifier.

### Threat model

**Read this first. Today, a person's standing for Spade changes holds against sandboxed agents
and the app's own renderers, not against unsandboxed processes of the same user.** Spade trusts
the daemon's stamp (`x-ace-person`, an HMAC keyed by `ACE_HOME/spade-person.key`, written in
`local-files.ts`, read by spade-server `security/attest.rs`). Spade's bearer token is a file too.
Any unsandboxed process of the user can read both, forge a stamp and loosen a bot without the
person. That is pre-existing, out of scope here, and tracked in #2535. The account-rooted model
above closes it.

Within that limit:

- **Held against a process holding only the daemon token** (an agent's MCP lease or provider
  process, sandboxed or not):
  - It can't enroll a key: that takes a socket that proved the owner's grant.
  - It can't make a statement: that takes the key, which only main holds.
  - It can't aim one of main's statements at its own socket. Main names only tags it made and
    never shows a page; a tag binds the first socket that came with it, within a minute of when
    main made it; and a statement names that very connection's nonce.
  - Reading `ace-owner.json` gives only public keys. A captured statement is spent by its nonce,
    and a statement for another daemon, account or lifetime is refused.
  - It can revoke the owner's key (`DELETE`): that only takes standing away.
- **Held against a process holding the person's session but no fresh sign-in** (on Linux or
  Windows, read from the keyring): it can prove per socket with the session's grants, as before
  this amendment. It can't enroll a key of its own: the backend's grant carries the session's
  own sign-in time, so that works only within ten minutes of the person's real browser sign-in
  (a residual window).
- **Held against something answering at the daemon's address without the relay key:** it can't
  produce the possession proof against the key main pinned, so main sends it no statement and no
  enrollment. Something holding the relay key itself (read from `ACE_HOME`) can still answer as
  the daemon; answering at the daemon's address is out of scope (§Threat model).
- **Held against a renderer under someone else's control:** it can ask main to prove the app's
  own sockets, which it already uses. It can't get a statement for any other socket. The
  renderer still holds the window's session, so it can act as the person on its own socket, as
  ADR 0190 already says (tampering with the renderer is out of scope).
- **Held against a second app instance on another profile or with debugging:** it keeps no key
  and refuses debugging switches. On macOS the Keychain releases the sealing key only to ace's
  signature.
- **Not held on Windows and Linux against an unsandboxed process of the user:** DPAPI and Secret
  Service unseal for any process of the user, so such a process can read the key. That matches
  the exposure of the saved session (`ace-account.enc`) and of Spade's stamp key above.
- **Longer standing:** a socket proven with the key keeps it until the socket closes, the key is
  revoked (sign-out) or the owner changes.

### Tests

- `apps/daemon/src/machine-owner.process.test.ts`:
  - one grant proof, then every tagged socket proves by main's statement alone;
  - a daemon-token holder can't enroll, can't prove with its own key or the owner's public key,
    can't replay or stretch a statement, and can't take a used tag;
  - a socket proven by the key can't enroll another;
  - signing out ends the standing on open sockets;
  - "Let it go" ends the key.
- `apps/daemon/src/services/spade-person-only.test.ts`: a daemon-token socket's Computer use
  switch reaches Spade unstamped.
- `packages/client/src/spade-person-only.test.ts`: route parity with Spade's guarded handlers.
- `apps/web/src/features/spade/spade-transport.test.ts`: every person-only route goes through
  the daemon in the desktop app.
- `apps/daemon/src/account-access/app-standing.test.ts`: stale and reused tags, connection
  nonces, the batch limit, and enrollment only with the backend's word on a recent sign-in.
- `apps/desktop/src/main/app-standing.test.ts`: possession against the pin, batches, rewrites
  that aren't sign-ins, durable revocation after an enrollment in flight.
- `packages/account-grant/src/person-statement.test.ts`, `apps/desktop/src/main/standing-key.test.ts`,
  `app-standing.test.ts` (desktop), `app-standing-gate.test.ts`, `apps/web/src/boot/app-standing.test.ts`.
