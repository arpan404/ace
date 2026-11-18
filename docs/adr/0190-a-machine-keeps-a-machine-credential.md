# 0190: A machine keeps a machine credential, never the person's session

Status: accepted. Date: 2026-11-18. Amends [ADR 0111](0111-account-machine-access.md) (who holds
what, grants, a machine signing in) and the account-device row of ADR 0178 §12.7 and §12.8.
Closes the gap §12.8 names as "the machine's own ace session".

## Context

When the person signed in to ace in the app, the app handed its ace session to its daemon, and
`ace login` claimed one for the daemon itself. Either way the daemon wrote that session to
`ACE_HOME/ace-account.json`: mode 0600, but readable by every process of that user, an
unsandboxed coding agent included. The backend mints a device grant for any device id from any
session (`POST /v1/grants`), and the daemon counts an admitted account device as the person. So a
process that read the file could mint itself a genuine device grant, connect as an account device
(on this machine or any other on the account) and act as the person for person-only actions:
market installs and withdrawals, answering person-only requests, the guarded setting, and anything
later built on the same standing. It couldn't make a sign-in fresh (`authAt` stays the person's
real sign-in time), but it didn't need to.

Two security reviews found it. The rule this ADR adopts: **nothing a machine stores can yield the
person's standing.**

## Decision

### 1. Two credentials

| Credential         | Who holds it                                                                                                                                        | What its grants may say                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Person's session   | The client the person signed in on, in its secure storage or memory: the desktop app (Electron `safeStorage`), the web app's window, the iPhone app | Device grants with the person's standing                                    |
| Machine credential | The daemon, in `ace-account.json`                                                                                                                   | Machine grants for its own host id; device grants with a machine's standing |

A **machine credential** is issued by the backend for one machine: its host id on ace's relay (the
id its relay key proves in the Noise handshake, `relayHostIdFor`). It is an opaque 43-character
token, like a session, stored only as its digest (`machine_credentials`, migration 0004).

- It can mint `machine` grants (relay, Spade Cloud, market) for its own host id only; another host
  id is refused (`403 other_machine`).
- It can mint `device` grants (ADR 0182, a machine reaching another machine of the account), but
  their standing grant always says `machine`.
- It can't be exchanged for another credential (`403 machine_credential`) and can't forget a
  machine from the account's list.
- It holds no WorkOS token. It lives on the session it was exchanged from: every read of the
  credential reads that session, which refreshes it with WorkOS (ADR 0100), so a revoked or deleted
  account loses its machines as it loses its sessions. A credential whose session is gone, or now
  names another account, is removed.

### 2. The exchange

`POST /v1/machine-credentials`, bearer an ace session, body `{ hostId, sole?, exposed? }`, answers
an `AceAccountGrant` whose token is the credential.

- **The app hands its session over** (`PUT /v1/ace-account`, unchanged for the app). The daemon
  exchanges it in memory (`sole: false`) and writes only the credential. The app keeps its session,
  which keeps the person's standing: it was never on the machine's disk.
- **`ace login`**: the daemon claims the session from the browser sign-in, exchanges it at once
  with `sole: true`, and writes only the credential. With `sole`, the backend moves the session to a
  digest no token has, so the token the daemon held in memory stops working, and signing the
  machine out removes that session too. If the exchange fails, the sign-in ends without writing
  anything and the session is signed out; the person runs `ace login` again.
- **A backend without machine credentials** (an older or self-hosted one) answers 404. The daemon
  then keeps the session as before: such a backend has no standing to protect.

### 3. Standing grants

Format 1 grants (`v: 1`) are unchanged: the relay, older daemons and the market parse them
strictly, so a new claim in them would break every older reader. Standing is a second grant
beside the device grant:

```
{ v: 2, kid, kind: "device", standing: "person" | "machine", account, subject, iat, exp }
```

Signed with the same key, encoded the same way (`@ace/account-grant`: `signStandingGrant`,
`verifyStandingGrant`). Format 1 parsers refuse it, and its parser refuses format 1, so neither
stands in for the other. `POST /v1/grants` returns it as `standing` with every plain device grant.

**Which sessions speak for the person.** Sessions gain a `standing` column:

- `person`: every sign-in from this version on, held only by the client that signed in.
- `legacy`: every session from before. Any of them may sit in an older daemon's
  `ace-account.json`, and the backend can't tell which, so they have a machine's standing.
- `exposed`: a session a machine was seen keeping. The backend marks a session exposed when it
  mints a `machine` grant with it (only a daemon does that: an older daemon with the session in its
  file), and when a daemon exchanges it from its session file (`exposed: true`). A legacy session a
  daemon exchanges is exposed too. Exposed never changes back. An older daemon that runs `ace login`
  after the backend is deployed writes a `person` session to its file; it is exposed at the
  daemon's first relay grant, seconds later. That window closes when the daemon is upgraded.

A device grant's standing grant says `person` only for a `person` session. A machine credential's
always says `machine`.

`ACE_LEGACY_PERSON_UNTIL` (an ISO date, unset by default) lets a deployment keep legacy sessions
that no machine was seen keeping at the person's standing until then, so clients aren't asked to
sign in again on the day this ships. It reopens the hole for a session copied from an older
daemon's file that never connected since, so the default is none.

### 4. The daemon

An account device's hello may carry `standing` beside `grant` (also in `hello.early`, ADR 0155).
The daemon admits the device on its format 1 grant as before, with admin (ADR 0111). It counts the
device as **the person** only when the standing grant:

- verifies against the grant keys this build pins (`shippedGrantKeys`, `@ace/account-grant/keys`;
  never keys fetched from the session's origin, which the host token sets, or from
  `ACE_ACCOUNT_URL`);
- says `person`;
- names the device grant's account (this daemon's) and the hello's device id;
- hasn't expired.

Anything else (no standing grant, a machine's, another key, another device) is a machine's
standing: admin, but person-only actions need a fresh sign-in, exactly as over the host token
(ADR 0178 §12.7). The standing is fixed for the socket at its hello; `account.grant.refresh` keeps
the socket open as before.

**No transition on the daemon.** A format 1 grant alone gives a machine's standing from the first
release. A window in which a bare format 1 grant still counted as the person would let anything
holding a machine credential leave the standing grant out and pass; the only safe transition is on
the backend, and only if a deployment chooses it (§3).

**The standing grant never reaches the relay.** Clients offer only the format 1 grant in
`Sec-WebSocket-Protocol`; the standing grant travels inside the end-to-end encrypted hello.

### 5. Migration

`ace-account.json` gains `kind: "machine"`. A file without it holds a session from before. On
start (and on each renewal round until it works) the daemon exchanges it once, with
`exposed: true` and `sole` when `ace login` made it, writes the credential in its place (an atomic
rename, so the session's bytes are no longer in the file), and carries on with the same sign-in:
no manual step, no sign-out, and no thread or local data is touched.

- A backend that no longer knows the session (401) signs the machine out, as before.
- Any other failure keeps the session and the daemon working; its grants already have a machine's
  standing at the backend. `GET /v1/ace-account` says `signInAgain: true` until the exchange
  succeeds, and signing in again in the app, or `ace login`, replaces it.
- A copy taken before the upgrade: an `ace login` session's token is retired at the exchange, so the
  copy is dead. A handed-over session is the app's own and keeps working for the app, but it is
  exposed, so the copy (and the app) mint device grants with a machine's standing until the person
  signs in again in the app.

### 6. Who acts as the person after this

Without a fresh sign-in:

- **A device on the account** whose client signed in in a browser after this backend version, and
  whose client sends the standing grant (the desktop and web app from this release). Its session
  lives only in that client.
- **A paired device** (ADR 0115, and ADR 0178 §12.8 once it lands), unchanged by this ADR.

Not: the host token or anything holding it, any process reading `ACE_HOME` (machine credential,
legacy session file), a daemon's own device grants (ADR 0182), a client with a session from before
this version (until it signs in again), and the iPhone app until it sends the standing grant.

Anyone can still act as the person for §12.7's actions with a **fresh sign-in**: an `ace login`
completed in a browser in the last ten minutes, which a process holding only machine files can't
complete. The other route ADR 0178 §12.8 names, a browser-approved single-use challenge bound to a
requesting device's key and this host id, is the follow-up that will give the app's page on a
daemon the app didn't start its standing; it is not built here.

## What this doesn't stop

- **A client's own store.** The person's session is as safe as the client's storage. On macOS the
  Keychain item is bound to the signed app. Linux's Secret Service and Windows DPAPI release it to
  any process of the same user, so there a same-user process can still read the desktop app's
  session (`ace-account.enc`) and act as the person. Closing that needs a device-bound key (Secure
  Enclave, TPM) and is separate work.
- **A process that can read another process's memory** (a debugger, ptrace where the OS allows
  it), as ADR 0178 §12.7 says.
- **Admin on the account's machines.** A machine credential still opens every machine on the
  account as an account device (ADR 0111): that is the account model, and a machine code (ADR 0111) is what limits it. What it can't do is the person's part.

## Compatibility

| Pairing                                      | Result                                                                                                                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Older daemon, new backend                    | Works as before: its session mints format 1 machine and device grants. The session is marked exposed on its first machine grant, so its device grants have a machine's standing.                   |
| New daemon, older backend                    | The exchange answers 404: the daemon keeps the session as before. Device grants carry no standing grant, so no account device is the person until the backend is deployed.                         |
| New client, older daemon                     | The hello's `grant` is format 1, and the older daemon ignores `standing`. Its strict `hello.early` parser refuses the field, so NK falls back to the XX attempt (ADR 0155), one round trip slower. |
| Older client (or the iPhone app), new daemon | Admitted with a machine's standing until it sends the standing grant.                                                                                                                              |
| Relay                                        | Unchanged: format 1 grants in the subprotocol.                                                                                                                                                     |

Key rotation is unchanged (`ACE_GRANT_PREVIOUS_KEY`, `docs/relay/accounts.md`): standing grants are
signed and published by the same keys, and the daemon checks them against the keys its build pins,
so a rotation adds the next key to `shippedGrantKeys` a release ahead, as for fresh sign-ins.

## Deploy order

1. Apply migration 0004 to the account D1, then deploy the Worker. Older daemons and clients keep
   working (above). From then on, only new sign-ins speak for the person.
2. Release the daemon and the desktop and web apps together.
3. Ship the iPhone app sending `standing` beside `grant`.

Releasing the daemon before the backend leaves every account device without the person's standing
until the backend is deployed (fail-closed, not broken).

## Tests

- `apps/cloud/src/account-machine-credential.process.test.ts` (the Worker and D1 under Miniflare):
  a browser sign-in's device grants have the person's standing; a machine credential's never do, it
  speaks only for its machine and can't be traded up; a session an older daemon keeps, or one from
  before, loses the person's standing; an `ace login` session exchanged by its only holder stops
  working by its token; an older daemon still connects to the relay with format 1 grants and device
  standing.
- `apps/daemon/src/machine-credential.process.test.ts` (a real daemon through that Worker): a
  process that reads `ace-account.json` can't act as the person, with or without the standing grant;
  the person signed in in a browser does; a machine credential's device grants never give person
  standing; an existing session file is exchanged once and removed; a handed-over one is exchanged
  and its session never speaks for the person again.
- Unit: `personStanding` (`device-grant.test.ts`), standing grant format (`grant.test.ts`), the
  legacy window (`directory.test.ts`), and the client carrying the standing grant
  (`machine-code-gate.test.ts`, `relay-nk.test.ts`, `grant-cache.test.ts`).
