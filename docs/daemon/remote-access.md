# Remote access to your daemon

Remote access connects your own devices to your own machine. Provider logins stay in the installed CLIs. The optional [ace account backend](../relay/accounts.md) handles ace login and relay transport; agent execution stays on your own machine. You may also host a relay yourself.

## Start and pair

Node 26+ and OpenSSL are required for remote access. From the repo root:

```sh
bun install
node apps/daemon/src/cli.ts start                         # loopback only
ACE_LISTEN=lan node apps/daemon/src/cli.ts start          # LAN TLS
ACE_LISTEN=tailscale node apps/daemon/src/cli.ts start    # Tailscale TLS
```

The daemon package declares the `ace` bin. To register it for your shell, run `bun link` in `apps/daemon`. The examples below use that command:

```sh
ace status
ace pair                     # grants read and operate
ace pair read                # read-only phone
ace pair admin               # explicitly grant device administration
ace devices list
ace devices revoke <id>
ace doctor
```

`ace start` stays in the foreground and stops on SIGINT or SIGTERM. `ace status` prints JSON with `running: false` when the daemon is stopped. `ace doctor` uses provider-kit discovery for version and authentication probes. It sends no prompts.

Remote access is on by default: a fresh install serves the local network, and a machine signed in to an ace account is also on ace's relay. A saved choice always wins, so a machine where you turned remote access off stays off. In Settings > Fleet, under How this Mac is reached, turn each network on or off: the local network and Tailscale, and under More options a relay of your own, in any combination. Each applies immediately, including in the desktop app; no restart is needed. A machine signed in to an ace account is also reachable through ace's relay whenever remote access is on, with nothing else to turn on ([ADR 0112](../adr/0112-remote-networks-together.md)). `host.displayName` names this computer in Settings and machine pickers.

Remote access must be on (it is by default) before running `ace pair`. Pairing prints an HTTPS URL and a terminal QR code. A companion client reads the URL's fragment, verifies the daemon's public-key fingerprint during TLS negotiation, then posts the code to the redemption endpoint. The fragment is never part of the HTTP request URL. Opening `/pair` loads the shipped web app from the TLS listener. Confirm this device's name to redeem the code, save its device token and connect using a one-use ticket. The connect screen also accepts a pairing link or a code plus computer address. Browsers require trusted HTTPS and cannot perform native public-key pinning; use only a link obtained from your own computer and trust its certificate before pairing. The Node client helper verifies the fragment's public-key fingerprint before sending credentials.

By default a pairing link opens the web app this computer serves (`https://<lan-or-tailscale-address>/pair#…`), whose version always matches the daemon. Turning on the global `remote.hostedPairingLink` setting (Settings > Fleet > More options > Pairing links open app.acehq.dev) makes new links open ace's hosted web app instead: `https://app.acehq.dev/pair#host=<this computer's address>&fingerprint=…&code=…`. The hosted app may run a different version. Every client reads the computer's address from `host` when it is present, and the browser still has to trust this computer's HTTPS certificate.

Treat the pairing URL as a credential until redeemed or expired. A code lasts five minutes and can create one device. Restarting the daemon invalidates all pending codes and tickets. Paired devices and the TLS identity persist across restarts.

## Listeners and configuration

| Setting                | Default                     | Behavior                                                                |
| ---------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `ACE_HOME`             | `~/.ace`                    | SQLite, local credential, private TLS identity and daemon endpoint file |
| `ACE_PORT`             | `4242`                      | HTTP and WebSocket listener on `127.0.0.1`                              |
| `ACE_LISTEN`           | `local`                     | `local`, `lan` or `tailscale`                                           |
| `ACE_REMOTE_PORT`      | local port plus one         | Separate HTTPS/WSS listener; ephemeral when `ACE_PORT=0` or `65535`     |
| `ACE_ADVERTISE_HOST`   | first external IPv4 address | LAN pairing URL address, useful with multiple network interfaces        |
| `ACE_WEB_ORIGINS`      | none                        | Comma-separated http(s) origins of web apps that may manage devices     |
| `ACE_ACCOUNT_URL`      | none                        | ace account backend that `ace login` signs in to                        |
| `ACE_HOSTED_RELAY_URL` | none                        | ace's hosted relay: the only relay this daemon offers machine grants to |

LAN mode listens on IPv4 wildcard `0.0.0.0`. Tailscale mode runs `tailscale status --json`, requires a running backend and binds only its IPv4 address. When the tailnet has MagicDNS and HTTPS certificates turned on (Tailscale admin console › DNS), the listener serves Tailscale's publicly trusted certificate to clients that ask for this machine's ts.net name, and pairing links name that host (`https://<machine>.<tailnet>.ts.net:<port>`), so browsers pair with no warning. Until that certificate is served, or if it can't be fetched or has expired, links use the 100.x address, which works for native clients and the CLI. The daemon fetches it with `tailscale cert`, refreshes it twice a day and keeps ace's own certificate for every other name. On Linux, let ace fetch it with `sudo tailscale set --operator=$USER`. Native clients still pin ace's key, and also accept a publicly trusted certificate for the exact ts.net name ([ADR 0097](../adr/0097-tailscale-https-certificates.md)). A detection failure stops startup and prints setup guidance; it never switches to LAN exposure automatically.

### Networks run together

`remote.enabled` is the switch for all of remote access, on by default. Under it, each network has its own global setting, and any combination runs at once ([ADR 0112](../adr/0112-remote-networks-together.md)):

| Setting            | Default | Serves                                                                                        |
| ------------------ | ------- | --------------------------------------------------------------------------------------------- |
| `remote.lan`       | on      | The local network: the direct listener on every address                                       |
| `remote.tailscale` | off     | Tailscale: the direct listener on the 100.x address, with Tailscale's certificate when issued |
| `remote.relay`     | off     | A relay: `remote.relayUrl` when set, otherwise ace's relay                                    |
| `remote.relayUrl`  | empty   | Your own relay. Optional: empty means ace's relay                                             |

LAN and Tailscale share one listener. With both on it binds every address (which reaches the Tailscale address too) and links name the Tailscale address, which also works away from the LAN; with Tailscale alone it binds only the 100.x address. A relay serves every channel through the encrypted relay: the main conversation, pairing redemption (self-hosted relays only) and the file, browser, screen, device and provider sign-in channels. See [Through a relay](#through-a-relay).

While remote access is on and the machine is signed in to an ace account, the daemon also registers on ace's relay (`ACE_HOSTED_RELAY_URL`, `wss://relay.acehq.dev` by default) with a fresh machine grant, whatever else it serves. That is what lists the machine on the account and lets the account's devices open it. Signing out stops the registration; signing in to another account registers again under it. The daemon never registers twice on one relay: turning the relay on with no address, or naming ace's relay as your own, is the same registration.

**Failures stay with their network.** A fresh install that can't open the LAN port, or where Tailscale isn't running, still starts: the failing network shows its reason in status and the others serve. Each network starts, fails and recovers on its own. Tailscale being down never stops the LAN or a relay; a relay refusing the machine never stops the LAN. Turning on a network that can't start right now (Tailscale not running, no LAN address) is refused with the reason and nothing else changes. A network that fails later shows its reason in status and is tried again with backoff (1 s doubling to 30 s), except ace's relay waiting for a sign-in or refusing the machine: that waits until the machine signs in again. A relay that drops reconnects with backoff. Remote access never moves to the LAN on its own: with Tailscale alone, a Tailscale outage opens nothing.

**Settings from before.** Earlier versions had one `remote.transport` choice. The settings file migrates forward on its first read: `local` and `lan` become the LAN, `tailscale` becomes Tailscale alone, `relay` becomes the LAN plus the relay (it always kept the LAN for pairing), and a saved `remote.relayUrl` keeps its relay on. The file then holds the three settings instead of `remote.transport`. An older app that writes `remote.transport` still works: the write becomes the networks it means.

**Status.** `ace status` and `GET /v1/status` report `remoteAccess.networks`: `lan`, `tailscale`, `relay` (the relay you turned on) and `account` (ace's relay for your account), each with `state` (`off`, `on`, `waiting` or `failed`), an `error` when it isn't serving, and its `address`. The older fields stay: `enabled` is true while any network serves, `transport` names one network (your relay while it serves, else Tailscale, else LAN, else ace's relay), and `error` repeats the first network error.

`ACE_LISTEN`, when explicitly supplied, overrides the direct listener preferences, including `local`. `ACE_RELAY_URL` independently forces an outbound relay; a signed-in machine still registers on ace's relay beside it. Settings shows an override notice and disables network controls while either override is present. Unset the launch override to use runtime settings. Changes close direct remote sockets, relay channels, pending codes and tickets; local host sessions and stored devices survive.

The loopback listener remains available in both remote modes. The token file is an implicit admin credential accepted only by this listener. The remote TLS listener rejects that credential even for connections originating on loopback.

For systems where direct Tailscale binding is unavailable, a raw TCP Serve forwarder can preserve ace's TLS identity:

```sh
ACE_LISTEN=lan ACE_REMOTE_PORT=4243 ace start
tailscale serve --tcp=443 tcp://localhost:4243
```

Replace the pairing URL authority with the Serve hostname and port 443, preserving its fragment. This recipe also leaves the explicit LAN listener enabled. Tailscale must already be running. Do not forward the local HTTP/admin listener. Raw TCP forwarding preserves the ace key pin; TLS termination at a proxy changes the key that the client sees. See the [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve#use-a-tcp-forwarder).

OpenSSL creates an RSA-2048 self-signed certificate valid for ten years under `ACE_HOME/tls`. The directory has mode 0700 and the private key has mode 0600. The pin is the lowercase hex SHA-256 digest of the public key's DER SPKI representation, rather than the certificate's digest. Clients verify the pin and certificate validity before sending HTTP headers. See Node's [HTTPS pinning example](https://github.com/nodejs/node/blob/main/doc/api/https.md) for the underlying primitives. Removing the TLS identity changes the pin and requires pairing again.

## On Windows

Remote access needs no administrator rights on Windows. What differs from macOS and Linux:

- **Tailscale.** ace runs `tailscale.exe` from PATH, else from Tailscale's install folder (`%ProgramFiles%\Tailscale\tailscale.exe`), looked up on every call, so a daemon started before Tailscale was installed still finds it. `ace doctor` looks in the same places. Windows has no `tailscale set --operator`: Tailscale answers `tailscale cert` only for the Windows account connected in the Tailscale app (or an administrator), so a refused certificate says to connect Tailscale from this account. Until the certificate arrives, devices use ace's pinned certificate over the 100.x address, as elsewhere.
- **TLS identity.** Windows ships no OpenSSL, so ace makes its self-signed, pinned identity with Node's crypto (RSA 2048, SHA-256, ten years, `CN=ace`). Clients pin its public key exactly as they pin the OpenSSL-made one.
- **LAN address.** Windows lists Hyper-V, WSL, VPN and VM adapters (`vEthernet (WSL)`) beside the real one, often first. Pairing links use the first other IPv4 address that isn't link-local. `ACE_ADVERTISE_HOST` still wins.
- **Windows Defender Firewall.** The first time ace listens on the LAN or on its Tailscale address, Windows may ask whether to allow ace's Node runtime on private or public networks. Allowing it creates a firewall rule and needs an administrator once. Declining (or a standard account that can't approve) leaves the listener running but blocked: local use keeps working and paired devices can't connect until a rule is added in Windows Security › Firewall & network protection › Allow an app through firewall. Tailscale Serve avoids the prompt entirely, because Tailscale's own service receives the traffic and forwards it to localhost: start ace with `ACE_LISTEN=lan` and `ACE_REMOTE_PORT=4243`, run `tailscale serve --tcp=443 tcp://localhost:4243`, and keep the pairing URL's fragment (the public-key pin) while replacing its authority with the Serve hostname.
- **Sleep and network changes.** Connections drop while Windows sleeps and paired clients retry when it wakes. Tailscale keeps the 100.x address across network changes; a LAN address can change with the network, so pair again or set `ACE_ADVERTISE_HOST`.

## Your ace account and the machine code

A machine signed in to an ace account opens to every device signed in to the same account,
with admin access and no pairing ([ADR 0111](../adr/0111-account-machine-access.md)). Pairing,
LAN, Tailscale and self-hosted relays keep working without an account.

**Signing the machine in.** The daemon holds one ace session in `ACE_HOME/ace-account.json`
(mode 0600; never logged). The desktop app hands it its own session when you sign in to ace in
the app, and tells it when you sign out. On a machine without the app, `ace login` starts the
sign-in, prints the address to open, and waits until you finish it in a browser; `ace logout`
signs the machine out. `ace status` shows the account under `remoteAccess.account`.

**ace's relay.** While remote access is on and the machine is signed in, the daemon registers
on ace's hosted relay (`ACE_HOSTED_RELAY_URL`) beside whatever else it serves: LAN, Tailscale or
a relay of your own. It asks the account backend for a fresh, five-minute machine grant before
every registration and offers it as the `ace.grant.<grant>` WebSocket subprotocol. With the
relay turned on and no address of its own, the relay is ace's: while the machine is signed out,
or after the relay refuses it, that network shows "Sign in to your ace account on this machine…"
and does not retry on a timer; signing in starts it again. Signing out stops the registration;
the LAN and Tailscale keep serving. Self-hosted relays stay anonymous: they echo an offered grant without checking it,
and the daemon offers them none.

**Account devices.** A client on the account connects to `/client` with a device grant as its
subprotocol, then sends it in `hello` (`grant` instead of `token` or `ticket`). The daemon
accepts it only while signed in, and only a `device` grant signed by a key from the account
backend's `GET /v1/keys` (cached, refetched once for a new key id and at most once a minute),
not expired, for the daemon's own account and for the `deviceId` in the hello. Anything else
is refused like any bad credential. An admitted device has admin on that channel until the
machine signs out, moves to another account or changes its machine code; then its open
account channels close.

**Machine code.** A machine may require a code (a PIN or password, 4 to 128 characters) so a
stolen account login alone does not open it. Set it with `ace machine-code set` (read from
stdin or typed without echo) or `PUT /v1/machine-code` from an admin, and clear it with
`ace machine-code clear`. It is stored as an scrypt hash with a version that grows on every
change, and only the daemon checks it; the account backend never sees it. An account device
that has not passed the current version is refused before welcome with an `error` frame whose
code is `machine_code_required`, `machine_code_wrong` or `machine_code_locked`, and the channel
closes; the client asks for the code and opens a new channel with `machineCode` in its hello.
A right code is remembered per device, account and code version in the daemon's SQLite store.
Five wrong codes lock code entry on the machine (not per device) for 15 minutes. Changing or
clearing the code makes every device enter the new one.

## Through a relay

**Main conversation.** A client opens a relay channel to `/client?hostId=<relay host id>`, pins that host key in the Noise handshake, and sends the same `hello` it sends a direct socket, without `channel` (a ticket, a paired device's token, or an account `grant`). The daemon serves it with the same handler as its own listener: same scopes, admission, outbox backpressure, snapshot and replay by `afterSeq`, idle timeout and close codes. The relay has no close frame, so the daemon's last message is `{ "type": "channel.close", "code", "reason" }` (4003 revoked, 4008 idle, 4009 backpressure, 4013 capacity, the resync code); a channel that ends without it reads as 1006 and the client reconnects with backoff. A refused hello gets `error` `unauthorized` (or a `machine_code_*` code for an account device) before the channel closes. `hello.compression: ["deflate-raw"]` lets the daemon deflate bulk JSON. In `@ace/client`, `relayRoute({ relayUrl, hostId, credential, socket, schedule })` gives `ClientOptions` its `transport` and `credential`; each attempt fetches its own credential, so a five-minute account grant is fresh every time.

**Pairing through a self-hosted relay.** Links name the LAN or Tailscale address while either serves. With neither serving and a self-hosted relay running, `POST /v1/pairings` and `fleet.request` issue links that open the web app (app.acehq.dev unless another is chosen) with `#relay=<wss url>&hostId=<relay host id>&code=…&scopes=…`. The client opens a relay channel pinned to that host id and sends `{ "type": "pair.redeem", "code", "name" }` as its only message; the daemon answers `pair.result` (`{ ok: true, device, token }`, or `{ ok: false, error: "invalid" | "rate_limited" | "unavailable" }`) and closes. Codes keep the same rules: five minutes, single use, scopes chosen by the host, nothing logged. Relayed redemptions share one rate limit (five a minute) besides the global one. `redeemPairingViaRelay` in `@ace/client/access` does this. ace's hosted relay admits only devices signed in to an ace account, which never need pairing, so pairing goes through self-hosted relays only.

**Machine code over the wire.** An admin connection can send `machine.code.status`, `machine.code.set` (`code`, 4 to 128 characters) and `machine.code.clear`, each with a `requestId`; the daemon answers `machine.code.result` with `{ ok: true, status }` (the account and machine code state, as `GET /v1/ace-account` returns it) or `{ ok: false, error: "forbidden" | "unavailable" | "busy" }`. An account device that sets the code keeps its own access. A `machine_code_locked` refusal carries `lockedUntil`.

**Settings over the wire.** An admin connection reads and changes the same things Settings reads over HTTP with `fleet.request`: `{ op: "remoteStatus" }` answers `{ kind: "remoteStatus", status }`, what `GET /v1/status` reports as `remoteAccess` (listeners, relay route, ace account); `devices`, `pairing` and `revoke` answer as `GET /v1/devices`, `POST /v1/pairings` and `DELETE /v1/devices/<id>`. Each runs the same code as its route with the same admin rule, and a pairing grants only scopes the caller holds. The web app uses these on every connection, so a machine reached through a relay shows the same Settings. Signing the machine in or out of its ace account stays HTTP only: it needs the host's own credential, which never travels over a relay.

## HTTP API

All JSON endpoints return HTTP 200 on success and `{ "error": "..." }` otherwise. Responses are `Cache-Control: no-store`; there are no redirects, cookies or query-string credentials. Requests are capped at 4 KiB. Bearer tokens go only in the `Authorization` header.

`GET /v1/status`, `GET /v1/devices`, `POST /v1/pairings`, `POST /v1/pair`, `POST /v1/tickets`, `DELETE /v1/devices/<id>`, and the account routes `/v1/ace-account`, `/v1/ace-account/login` and `/v1/machine-code` (the only ones whose preflight allows `PUT`; each still needs an admin credential, and signing in or out the host's) accept cross-origin calls from an explicit allowlist: the desktop renderer (`app://ace`, ADR 0054), ace's hosted web app (`https://app.acehq.dev`) and the origins in `ACE_WEB_ORIGINS`. `bun run dev` and `dev:web` set it to their Vite origin. An allowed `Origin` is echoed in `Access-Control-Allow-Origin`; any other origin gets no CORS headers and its preflight gets 403. Every response carries `Vary: Origin`, and credentials mode is never allowed, so the token still has to be sent explicitly. Requests without an `Origin` (the CLI, same-origin) are unaffected. Pairing redemption and tickets accept only the same configured origins, so the desktop connect screen, the hosted web app and an explicitly allowed web app can pair.

The loopback WebSocket listener shares the HTTP access allowlist: an upgrade carrying any other `Origin` gets 403. The remote listener authenticates paired devices by a single-use ticket, independent of `Origin`. React Native WebSockets may send a URL-derived `Origin` (`https://<lan-ip>:<port>`); those clients need no origin configuration. Remote browser clients likewise require a ticket, rather than an origin allowlist entry. An Origin header is never a substitute for authentication. Sockets that have not authenticated have their own budget (128 on loopback, 64 on the remote listener with at most 16 per address) and are terminated if they send no valid `hello` within 5 seconds.

The device service caps state subscribers at 64 across all clients to bound state fan-out. Only main and devices admin channels hold a subscriber; files, screen and browser channels do not. Excess sockets close before welcome with application code 4013 and reason `connection_limit`, without a pre-welcome error frame. The main client exposes `error.code === "limit"` while reconnecting, retries with a minimum five-second delay and exponential backoff, and clears the error after welcome. Dedicated `deviceTransport` channels likewise expose a `DeviceClient` snapshot limit error and retry after five seconds, increasing to thirty seconds on repeated saturation; commands are never replayed. Transient service admission failures close with 1011 and reason `service_unavailable` and follow ordinary reconnect backoff. Closing an admitted socket releases its slot.

| Method and path              | Credential          | Request                                     | Response                                                      |
| ---------------------------- | ------------------- | ------------------------------------------- | ------------------------------------------------------------- |
| `GET /v1/status`             | admin               | none                                        | `{ running: true, remote: null \| { origin, fingerprint } }`  |
| `POST /v1/pairings`          | admin               | `{ scopes?: ["read", "operate", "admin"] }` | `{ url, expiresAt }`                                          |
| `POST /v1/pair`              | pairing code        | `{ code, name }`                            | `{ device, token }`                                           |
| `POST /v1/tickets`           | device bearer token | none                                        | `{ ticket, expiresAt }`                                       |
| `GET /v1/devices`            | admin               | none                                        | device records, including revoked devices                     |
| `DELETE /v1/devices/<id>`    | admin               | none                                        | `{ revoked: true }`                                           |
| `GET /v1/ace-account`        | admin               | none                                        | the machine's account, pending sign-in and machine code state |
| `PUT /v1/ace-account`        | host token          | `{ origin, token }` (an ace session)        | account state, once the backend confirms the session          |
| `POST /v1/ace-account/login` | host token          | `{ origin? }`                               | account state with `login: { url, expiresAt }`                |
| `DELETE /v1/ace-account`     | host token          | none                                        | account state, signed out                                     |
| `PUT /v1/machine-code`       | admin               | `{ code }`                                  | account state                                                 |
| `DELETE /v1/machine-code`    | admin               | none                                        | account state                                                 |

Only the host/admin that creates the code chooses scopes. Redemption cannot add scopes. The default grant is `read` plus `operate`. The pairing dialog offers view-only, view-and-act and administrator access. Advanced access grants `projects` and `accounts` independently; admin does not imply these scopes. Every device row lists the actual stored grant. `read` permits subscriptions, output reads and item pages, `operate` permits all current agent commands, and `admin` includes both and device administration. Ping and unsubscribe remain available to authenticated devices.

A device record has `id`, `name`, `scopes`, `createdAt`, `lastSeenAt` and nullable `revokedAt`. SQLite stores these in `devices(id, name, token_hash, scopes, created_at, last_seen_at, revoked_at)`. Tokens contain 32 random bytes encoded as 64 hexadecimal characters. Only SHA-256 hashes are stored; tokens and hashes are absent from device listings. Device authentication and ticket use update `lastSeenAt`.

Pairing requests are limited to five per source address per minute, including malformed requests, with a global cap of 100 per minute. A forwarded connection uses the proxy's source address. Forwarded headers are not trusted. Pending codes are capped at 100. Tickets are capped at 10,000 globally, 32 pending per device and 120 issuances per device per minute, including tickets consumed immediately. Revocation releases that device's pending tickets and rate entries immediately. Ticket expiry uses an indexed min-heap, so issuance never scans retained ticket history. Entries are removed on consumption, expiry or revocation, with no retained heap tombstones. Wrong/expired credentials return 401, missing scope returns 403, rate/cap limits return 429 and pairing with remote access disabled returns 409.

## WebSocket authentication and client helper

Exchange a device bearer token for a ticket over pinned HTTPS. Open WSS at the same origin with no query string, then send:

```json
{ "type": "hello", "protocolVersion": 1, "deviceId": "<paired device id>", "ticket": "<ticket>" }
```

A ticket lasts sixty seconds and is consumed by one hello. It is bound to the paired device's ID. Device tokens are rejected in hello. Local clients can continue sending hello with their token-file credential. Exactly one of `token`, `ticket` or `grant` is required; `grant` (an account device grant, with an optional `machineCode`) is accepted on relayed channels only.

Scope checks run before subscriptions or command receipts. Revoking a device disconnects every socket authenticated by its tickets, cancels its subscriptions, and invalidates its bearer token and outstanding tickets immediately. A caller-selected local device ID cannot cause revocation of the host credential.

The daemon exports `@ace/daemon/client-access` for Node consumers:

```ts
import { redeemPairing, accessRequest, ticketSocket } from "@ace/daemon/client-access";
import { parsePairingLink } from "@ace/client/access";
import { SocketTicket } from "@ace/protocol";

// Reads both link forms: the daemon's own address, or app.acehq.dev naming it in `host=`.
const link = parsePairingLink(pairingUrl);
const origin = new URL(link.daemon).origin;
const fingerprint = link.fingerprint;
if (!fingerprint) throw new Error("Missing pin");
const { device, token } = await redeemPairing(pairingUrl, "My phone");
const ticket = SocketTicket.parse(
  await accessRequest(origin, "/v1/tickets", {
    method: "POST",
    token,
    fingerprint,
  }),
);
const socket = ticketSocket(origin.replace("https:", "wss:"), fingerprint);
socket.once("open", () =>
  socket.send(
    JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      deviceId: device.id,
      ticket: ticket.ticket,
    }),
  ),
);
```

Persist `token` in the client's secure credential storage. The helper checks the TLS pin before any request bytes are written, rejects unpinned remote requests, and refuses credentials in HTTP or socket URLs. The helper caps responses at 1 MiB and checks certificate validity using one clock reading per handshake. Its clock can be supplied through `accessRequest` or `ticketSocket`. It uses Node TLS and is not a browser/React Native transport. Those clients need an equivalent native certificate-pinning boundary. Trust begins with the URL shown on the host's terminal.

## Performance and runtime boundaries

Run `bun run --filter @ace/daemon bench:remote` for an informational benchmark through real HTTP, SQLite and cryptographic credential generation. It requests successive batches of 1,000, 3,000 and 6,000 tickets across 314 devices, leaving 10,000 pending without bypassing the per-device limits. No timing threshold gates tests.

The allocation policy receives time and hashed identities from the I/O layer. Credential entropy and IDs, TLS certificate signing and temporary IDs, network-interface/status discovery, and client certificate clocks are injected at their boundaries. Default adapters use the host's crypto, OpenSSL, Tailscale and clock. Complete device records and lifecycle timestamps are validated before SQLite changes, so rejected public store operations preserve existing rows.

## Dependency decisions

`qrcode-generator` 2.0.4 is accepted under MIT for terminal encoding. It is pure JavaScript, has no runtime dependencies, and its imported encoder is roughly 51 KiB. Using an established encoder avoids maintaining QR error correction and mask selection in daemon code. Our terminal renderer is written fresh. The package's larger published size includes several distributions and type declarations.

`jsqr` 1.4.0 is accepted under Apache-2.0 as a test-only decoder with no runtime dependencies. Tests rasterize the terminal output and independently scan it, so a decorative or wrong QR payload fails. Zod is the repo's existing schema dependency, now declared directly by the daemon for Tailscale status validation.

Future work includes explicit TLS-key rotation. See the [encrypted relay documentation](../relay/README.md) for the relay itself.
