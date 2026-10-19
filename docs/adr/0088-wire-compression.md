# 0088: Wire compression for remote clients

Status: accepted. Date: 2026-10-19. Refines ADR 0006 (large payloads) and ADR 0070 (remote access).

## Context

Snapshots, history pages and the web app are the largest things a client downloads: up to 1 MiB
of JSON per thread window and about 400 KB gzip (1.3 MB raw) of renderer files. Recorded
provider sessions deflate 5–17×. A phone on cellular pays for every byte, while a desktop on the
same Mac does not: on loopback, deflating a 1 MiB message adds about 4 ms and saves no transfer
time.

Compressing before encryption can leak what a message holds through its length when a secret and
attacker-influenced data share one compression context (CRIME, BREACH).

## Decision

**What may be compressed is an allowlist** (`apps/daemon/src/compression-policy.ts`): transcript
and history bulk (events, snapshots and their parts, item, turn and entity pages, search, catalog,
model and usage results). None of it carries an ace credential. Workspace, source-control,
project, device and browser messages stay uncompressed even when large, since URLs and command
output beside them can hold tokens. A new message type is uncompressed until someone decides it
is safe. Every message is compressed alone; no context carries over.

**WebSocket: per-message deflate (RFC 7692) on the remote listener only.** The TLS listeners (LAN,
Tailscale, runtime-toggled) shake hands on a second `ws` server with `remoteDeflate`; loopback
keeps the uncompressed one. No protocol change: clients that offer the extension (browsers, Node
`ws` and built-in WebSocket, Apple `URLSession`, OkHttp) get it, others keep working uncompressed.

- No context takeover in either direction, threshold 1 KiB, so most live deltas go as-is.
- `maxPayload` (1 MiB) bounds the inflated size; a compressed frame that inflates past it closes
  the socket with 1009.
- Screen and device video packets and file bytes are sent with `compress: false`.
- A remote socket that has sent a large message keeps its zlib streams (about 300 KiB) until it
  closes, at most about 75 MB at the 256-socket cap. `ws` runs at most 10 deflate jobs at once.

`URLSession` offers a bare `permessage-deflate`. A forum report describes inflate errors on large
frames from an unnamed server, so we checked: macOS `URLSession` against `ws` with these options
decoded 300 B to 1.5 MB messages exactly, in both directions, with and without context takeover.
OkHttp's `RealWebSocket` offers the extension and accepts `no_context_takeover`. Neither mobile
client needs an app change.

**Relay: deflate inside the encrypted channel, per message.** A peer that says it inflates
(`hello.compression`) gets allowlisted JSON messages of 1 KiB or more deflated alone, before
encryption, as a separate fragment kind; inflation is capped at the logical message limit.

**HTTP: br/gzip for renderer text files.** `.html`, `.js`, `.css` and `.svg` files of at least 1 KiB
are compressed once per file version and kept in memory (32 MiB, least recently used out), on both
listeners; the cost is paid once, not per request. Attachments, icons and images are already
compressed or are served by byte range, and access JSON is tiny, so they stay identity.
