# 0088: Wire compression for remote clients

Status: accepted. Date: 2026-10-19. Refines ADR 0006 (large payloads) and ADR 0070 (remote access).

## Context

Snapshots, history pages and the web app are the largest things a client downloads: up to 1 MiB
of JSON per thread window and about 400 KB gzip (1.3 MB raw) of renderer files. Until now nothing
was compressed. Recorded provider sessions deflate 5–17×. A phone on cellular pays for every byte,
while a desktop on the same Mac does not: on loopback, deflating a 1 MiB message adds about 4 ms
and saves no transfer time.

## Decision

**WebSocket: standard per-message deflate (RFC 7692) on the remote listener only.** The TLS
listeners (LAN, Tailscale, runtime-toggled) shake hands on a second `ws` server configured with
`remoteSocketCompression`; loopback keeps the uncompressed one. No protocol change: clients that
offer the extension (browsers, Node `ws` and built-in WebSocket, Apple `URLSession`, OkHttp) get
it, and others keep working uncompressed.

- No context takeover in either direction. Each message is compressed alone, so the size of one
  TLS record says nothing about earlier messages, and zlib state does not grow per socket. The
  ratio cost is small because only large messages are compressed.
- Threshold 1 KiB. Live deltas are mostly smaller and are sent as-is.
- `maxPayload` (1 MiB) bounds the inflated size, so a small compressed frame cannot expand past
  the normal limit; the socket closes with 1009.
- Screen and device video packets are sent with `compress: false`: H.264/JPEG does not shrink.
  File-transfer chunks are compressed, since they are often source text.

`URLSession` offers a bare `permessage-deflate`. A forum report describes inflate errors on
large frames from an unnamed server, so we checked: macOS `URLSession` against `ws` with these
options decoded 300 B to 1.5 MB messages exactly, in both directions, with and without context
takeover. iOS needs no app change.

**HTTP: br/gzip for renderer text files.** `.html`, `.js`, `.css` and `.svg` files of at least 1 KiB
are compressed once per file version and kept in memory (32 MiB bound), on both listeners; the
cost is paid once, not per request. Attachments, icons and images are already compressed or are
served by byte range, and access JSON is tiny, so they stay identity.

**Relay: not compressed.** The relay carries Noise ciphertext, which does not compress, and no
client app uses the relay yet. Compressing inside the encrypted channel would need negotiation in
the stream protocol and a size-leak review; it is deferred until a client uses the relay.
