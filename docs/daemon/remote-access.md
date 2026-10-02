# Remote access to your daemon

Remote access connects your own devices to your own machine. Provider logins stay in the installed CLIs. The daemon has no hosted service or relay.

## Start and pair

Node 24+ and OpenSSL are required for remote access. From the repo root:

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

Enable remote access before running `ace pair`. Pairing prints an HTTPS URL and a terminal QR code. A companion client reads the URL's fragment, verifies the daemon's public-key fingerprint during TLS negotiation, then posts the code to the redemption endpoint. The fragment is never part of the HTTP request URL. This backend includes a Node client helper; a browser or mobile pairing UI is a separate client task.

Treat the pairing URL as a credential until redeemed or expired. A code lasts five minutes and can create one device. Restarting the daemon invalidates all pending codes and tickets. Paired devices and the TLS identity persist across restarts.

## Listeners and configuration

| Setting              | Default                     | Behavior                                                                |
| -------------------- | --------------------------- | ----------------------------------------------------------------------- |
| `ACE_HOME`           | `~/.ace`                    | SQLite, local credential, private TLS identity and daemon endpoint file |
| `ACE_PORT`           | `4242`                      | HTTP and WebSocket listener on `127.0.0.1`                              |
| `ACE_LISTEN`         | `local`                     | `local`, `lan` or `tailscale`                                           |
| `ACE_REMOTE_PORT`    | local port plus one         | Separate HTTPS/WSS listener; ephemeral when `ACE_PORT=0` or `65535`     |
| `ACE_ADVERTISE_HOST` | first external IPv4 address | LAN pairing URL address, useful with multiple network interfaces        |

LAN mode listens on IPv4 wildcard `0.0.0.0`. Tailscale mode runs `tailscale status --json`, requires a running backend and binds only its IPv4 address. A detection failure stops startup and prints setup guidance; it never switches to LAN exposure automatically.

The loopback listener remains available in both remote modes. The token file is an implicit admin credential accepted only by this listener. The remote TLS listener rejects that credential even for connections originating on loopback.

For systems where direct Tailscale binding is unavailable, a raw TCP Serve forwarder can preserve ace's TLS identity:

```sh
ACE_LISTEN=lan ACE_REMOTE_PORT=4243 ace start
tailscale serve --tcp=443 tcp://localhost:4243
```

Replace the pairing URL authority with the Serve hostname and port 443, preserving its fragment. This recipe also leaves the explicit LAN listener enabled. Tailscale must already be running. Do not forward the local HTTP/admin listener. Raw TCP forwarding preserves the ace key pin; TLS termination at a proxy changes the key that the client sees. See the [Tailscale Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve#use-a-tcp-forwarder).

OpenSSL creates an RSA-2048 self-signed certificate valid for ten years under `ACE_HOME/tls`. The directory has mode 0700 and the private key has mode 0600. The pin is the lowercase hex SHA-256 digest of the public key's DER SPKI representation, rather than the certificate's digest. Clients verify the pin and certificate validity before sending HTTP headers. See Node's [HTTPS pinning example](https://github.com/nodejs/node/blob/main/doc/api/https.md) for the underlying primitives. Removing the TLS identity changes the pin and requires pairing again.

## HTTP API

All JSON endpoints return HTTP 200 on success and `{ "error": "..." }` otherwise. Responses are `Cache-Control: no-store`; there are no redirects, CORS grants, cookies or query-string credentials. Requests are capped at 4 KiB. Bearer tokens go only in the `Authorization` header.

| Method and path           | Credential          | Request                                     | Response                                                     |
| ------------------------- | ------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| `GET /v1/status`          | admin               | none                                        | `{ running: true, remote: null \| { origin, fingerprint } }` |
| `POST /v1/pairings`       | admin               | `{ scopes?: ["read", "operate", "admin"] }` | `{ url, expiresAt }`                                         |
| `POST /v1/pair`           | pairing code        | `{ code, name }`                            | `{ device, token }`                                          |
| `POST /v1/tickets`        | device bearer token | none                                        | `{ ticket, expiresAt }`                                      |
| `GET /v1/devices`         | admin               | none                                        | device records, including revoked devices                    |
| `DELETE /v1/devices/<id>` | admin               | none                                        | `{ revoked: true }`                                          |

Only the host/admin that creates the code chooses scopes. Redemption cannot add scopes. The default grant is `read` plus `operate`. `read` permits subscriptions, output reads and item pages, `operate` permits all current agent commands, and `admin` includes both and device administration. Ping and unsubscribe remain available to authenticated devices.

A device record has `id`, `name`, `scopes`, `createdAt`, `lastSeenAt` and nullable `revokedAt`. SQLite stores these in `devices(id, name, token_hash, scopes, created_at, last_seen_at, revoked_at)`. Tokens contain 32 random bytes encoded as 64 hexadecimal characters. Only SHA-256 hashes are stored; tokens and hashes are absent from device listings. Device authentication and ticket use update `lastSeenAt`.

Pairing requests are limited to five per source address per minute, including malformed requests, with a global cap of 100 per minute. A forwarded connection uses the proxy's source address. Forwarded headers are not trusted. Pending codes are capped at 100. Tickets are capped at 10,000 globally, 32 pending per device and 120 issuances per device per minute, including tickets consumed immediately. Revocation releases that device's pending tickets and rate entries immediately. Ticket expiry uses an indexed min-heap, so issuance never scans retained ticket history. Entries are removed on consumption, expiry or revocation, with no retained heap tombstones. Wrong/expired credentials return 401, missing scope returns 403, rate/cap limits return 429 and pairing with remote access disabled returns 409.

## WebSocket authentication and client helper

Exchange a device bearer token for a ticket over pinned HTTPS. Open WSS at the same origin with no query string, then send:

```json
{ "type": "hello", "protocolVersion": 1, "deviceId": "<paired device id>", "ticket": "<ticket>" }
```

A ticket lasts sixty seconds and is consumed by one hello. It is bound to the paired device's ID. Device tokens are rejected in hello. Local clients can continue sending hello with their token-file credential. Exactly one of `token` or `ticket` is required.

Scope checks run before subscriptions or command receipts. Revoking a device disconnects every socket authenticated by its tickets, cancels its subscriptions, and invalidates its bearer token and outstanding tickets immediately. A caller-selected local device ID cannot cause revocation of the host credential.

The daemon exports `@ace/daemon/client-access` for Node consumers:

```ts
import { redeemPairing, accessRequest, ticketSocket } from "@ace/daemon/client-access";
import { SocketTicket } from "@ace/protocol";

const pairing = new URL(pairingUrl);
const origin = pairing.origin;
const fingerprint = new URLSearchParams(pairing.hash.slice(1)).get("fingerprint");
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

Run `bun run --filter @ace/daemon bench:remote` for an informational benchmark through real HTTP, SQLite and cryptographic credential generation. It requests successive batches of 1,000, 3,000 and 6,000 tickets across 314 devices, leaving 10,000 pending without bypassing the per-device limits. No timing threshold gates tests. Results and the comparison against the previous ticket scan are in [remote-verification.md](./remote-verification.md).

The allocation policy receives time and hashed identities from the I/O layer. Credential entropy and IDs, TLS certificate signing and temporary IDs, network-interface/status discovery, and client certificate clocks are injected at their boundaries. Default adapters use the host's crypto, OpenSSL, Tailscale and clock. Complete device records and lifecycle timestamps are validated before SQLite changes, so rejected public store operations preserve existing rows.

## Dependency decisions

`qrcode-generator` 2.0.4 is accepted under MIT for terminal encoding. It is pure JavaScript, has no runtime dependencies, and its imported encoder is roughly 51 KiB. Using an established encoder avoids maintaining QR error correction and mask selection in daemon code. Our terminal renderer is written fresh. The package's larger published size includes several distributions and type declarations.

`jsqr` 1.4.0 is accepted under Apache-2.0 as a test-only decoder with no runtime dependencies. Tests rasterize the terminal output and independently scan it, so a decorative or wrong QR payload fails. Zod is the repo's existing schema dependency, now declared directly by the daemon for Tailscale status validation.

Future work includes the mobile/browser transport, explicit TLS-key rotation, and relay design that preserves the user's own daemon and a pinned connection. No relay is implemented here.
