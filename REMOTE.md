# Remote Access Architecture

This document describes how ace remote connections work today.

## Summary

ace has two connection modes:

- local direct connection for desktop/web usage on the same machine
- relay-based remote connection for access from another device over the internet or across NAT

Local usage does not require a relay. Remote usage does.

The relay is a transport router, not a trusted plaintext endpoint. Both the host and the viewer connect outward to the relay, and the actual RPC traffic stays end-to-end encrypted between them.

## Connection Modes

### Local direct mode

Use this when the desktop app or browser is talking to the ace server running on the same machine.

Flow:

```text
Desktop/Web UI -> local ace server /ws
```

Characteristics:

- no relay required
- no public IP required
- same transport model as the existing local app
- unaffected if the relay is disabled or offline

### Relay remote mode

Use this when a viewer device needs to connect to a host device that is not directly reachable.

Flow:

```text
Viewer -> relay -> host
```

Characteristics:

- works without a fixed public IP on the host
- host only makes outbound connections
- viewer only makes outbound connections
- relay stays in the data path
- payload traffic is end-to-end encrypted

## Core Components

### Host server / daemon

The host is the real ace server process. It owns:

- RPC handlers
- provider sessions
- filesystem access
- orchestration state
- local `/ws` server

When remote relay is enabled, the host also:

- loads its long-lived relay device identity
- opens one outbound WebSocket to the configured relay
- registers itself as a remote host
- accepts relay route requests from approved viewers
- bridges relay traffic into the existing local `/ws` RPC path

Important detail: the relay transport sits underneath the existing RPC server. We did not build a second remote-only RPC stack.

### Relay server

The relay is a standalone service. It is responsible for:

- host and viewer registration
- pairing claim routing
- route open / route close lifecycle
- forwarding handshake messages
- forwarding encrypted frames

The relay is not responsible for:

- decrypting RPC traffic
- storing transport keys
- understanding Ace RPC payloads

### Viewer clients

Viewer clients can be:

- web
- desktop
- CLI
- mobile

All of them use the same relay transport model and the same pairing model. Desktop and web share the same renderer-side relay path.

## End-to-End Flow

### Local path

```text
Desktop/Web UI                  Local Ace Server
      |                                |
      |------ direct /ws RPC --------->|
      |<----- direct /ws RPC ----------|
      |                                |
```

### Remote path

```text
Host Ace Server              Relay Server               Viewer
      |                            |                      |
      |-- outbound ws connect ---->|                      |
      |-- registerHost ----------->|                      |
      |                            |                      |
      |                            |<-- outbound connect -|
      |                            |<-- registerViewer ---|
      |                            |                      |
      |                            |<-- routeOpen --------|
      |<------- routeRequest ------|                      |
      |-- routeReady / approve --->|                      |
      |                            |---- routeReady ----->|
      |                            |                      |
      |<==== handshake messages forwarded through relay =>|
      |                            |                      |
      |==== encrypted frames =====>|==== forwarded ======>|
      |<=== encrypted frames ======|<=== forwarded =======|
      |                            |                      |
      |-- bridge into local /ws RPC server -------------->|
```

The key architectural decision is the bridge on the host side: once the relay route is established, the host feeds that remote traffic into its existing local WebSocket RPC surface.

## Pairing and Authorization

Pairing is the trust bootstrap.

1. The host creates a pairing link.
2. The link carries relay metadata, host identity metadata, and one-time bootstrap pairing material.
3. The viewer imports or claims that link.
4. The host approves the pairing.
5. Both sides derive a stable relay authorization key from the pairing material.
6. Future route opens use short-lived proofs derived from that stored authorization key.

This means:

- the raw bootstrap pairing secret is not the long-term route credential
- normal route opens do not rely on resending the original pairing secret
- paired devices can reconnect through the configured relay without direct host addressing

## Encryption

Remote relay traffic is end-to-end encrypted between viewer and host.

Primitives in use:

- `X25519` for key exchange
- `HKDF + BLAKE2s` for key derivation
- `XChaCha20-Poly1305` for frame encryption and authentication

Session model:

- each device has a long-lived identity keypair
- each route uses fresh ephemeral handshake keys
- host and viewer exchange only public handshake material through the relay
- both sides independently derive the same transport keys
- separate directional keys are used for each traffic direction
- keys are rotated on reconnect and rekey thresholds

The relay can see:

- device IDs
- route IDs
- control message types
- ciphertext sizes and timing

The relay cannot see:

- plaintext RPC payloads
- terminal/file/session contents
- derived transport keys

## Single Relay Model

ace currently allows exactly one active relay server per host runtime.

That is an intentional constraint.

Benefits:

- simpler operational model
- predictable routing
- easier settings UX
- easier failure analysis

Behavior:

- if relay is disabled, the host does not register to any relay
- if relay is enabled, the host registers to one effective relay URL
- new pairings use that relay
- changing the relay URL moves future remote traffic to the new relay
- after changing relay servers, older remote pairs should be re-paired against the new relay

## Configuration

### Desktop / web app settings

The user-facing setting is:

```ts
remoteRelay: {
  enabled: boolean;
  defaultUrl: string;
  allowInsecureLocalUrls: boolean;
}
```

Meaning:

- `enabled`: turns relay-based remote hosting on or off
- `defaultUrl`: the single relay endpoint to use
- `allowInsecureLocalUrls`: allows local `ws://` relay URLs for development only

Defaults:

- managed relay URL: `wss://relay.ace.app/v1/ws`
- insecure local relay URLs disabled by default

### Headless / daemon usage

Headless runs use the same server-side relay model.

Supported override path:

- `ACE_RELAY_URL`
- `--relay-url` on the supported CLI flows

This lets a user self-host the relay and point the daemon at it without code changes.

## User-Facing Integration

### Desktop and web

Desktop and web support:

- enabling or disabling remote relay hosting
- changing the relay URL in settings
- creating relay pairing links
- importing relay pairing links
- connecting to saved relay-backed remotes
- reconnect/disconnect status for relay routes

Desktop also supports `ace://pair?...` deep links for importing pair links directly into the app.

### CLI

CLI supports relay-backed remote flows as well:

- create pairing links
- import pairing links
- list remotes
- remove or revoke remotes
- ping relay-backed remotes

### Mobile

Mobile uses the same relay architecture, with secure storage for relay secrets and persisted public host metadata for discovery.

## Security and Storage Model

We split public metadata from secret material.

- server and CLI keep relay identities in local files with restricted permissions
- web persists public remote metadata separately from relay secrets
- mobile persists public metadata separately from relay secrets
- relay auth material is kept out of generic app storage where possible

This improves at-rest handling, but it does not change the browser origin threat model. If hostile script runs in the same origin, it can still use the app's own APIs.

## Operational Notes

- local desktop/web usage works without the relay
- remote internet access requires the relay
- relay outages do not break local usage
- relay outages do break relay-based remote access until the relay returns
- only one relay server is active at a time
- self-hosted relays are supported by changing the configured relay URL

## Recommended Usage

- use local direct mode for local work
- use relay mode for remote access across devices
- use `wss://` for real deployments
- use `ws://127.0.0.1:...` only for local development relay testing
- re-pair devices after moving a host to a different relay server
