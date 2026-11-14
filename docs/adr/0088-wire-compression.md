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

## Sending less before compressing (2026-11-14)

On a 3G link a second carries about 50 KB, so what is sent matters as much as how it is
compressed. Storage does not change: provider data is still kept in full. Only clients that ask
get the shorter shapes; every other client gets exactly what it got before.

**Hello trim `raw-on-demand`.** Items whose raw payloads clients only show, in the raw-frames
view, come without them and marked `rawOmitted: true`, in snapshots, item pages and windows, turn
steps and live `item.created` / `item.updated` events. Clients read some raw payloads for what a
step says or whether it shows, so those stay: notices (refusals, delivery errors, screen steps,
retries, diagnostics, native stderr), MCP and custom tool calls (ace's own tools' results,
arguments and measurements), and messages whose raw changes what the projection's readers say
of them (a provider's system message the transcript hides, the native identity that folds a
replayed answer into the first, a legacy provider notice's source). For messages the rule asks
those readers with and without the raw, so it follows them. The rule is `rawShownOnly` in
`packages/projection/src/wire-trim.ts`. A view reads the payloads with `item.raw`
(`{threadId, itemId, from}` → the stored `raw`, or a tool call's `call.raw`, oldest first, from
`from`, as many as fit 1 MiB and at least one, with `next` while more remain), under the same
checks as reading the item: read scope and a thread the device may read.

**Hello framing `short-deltas`.** An events message names its thread once (`threadId`) and
carries each streamed delta as `{seq, firstSeq?, at, d: [itemId, agentId, field, append]}`. The
event id is left out: clients order, dedupe and resume by `seq`, and nothing reads a delta's id;
a reader gives it `~<seq>`. Deltas of several threads in one message go whole.

Live events are serialised once for every connection. Each event keeps at most one trimmed
encoding beside the whole one (`event-encodings.ts`): an item event without its shown-only raw,
or a delta in short form; no event is both. Every connection that takes it shares it.

**Holding deltas on a slow link.** Streamed deltas wait to share a frame: 16 ms on loopback and
on a remote link that keeps up, 100 ms on a remote socket with 8 KiB or more queued, 250 ms past
64 KiB. The daemon has no per-socket round-trip measure, so the queued backlog (`bufferedAmount`,
or a relayed channel's held bytes) is the signal, kept in one per-socket estimate
(`apps/daemon/src/link-estimate.ts`, `linkEstimate(socket)`) that other daemon code can read.
Only messages made entirely of streamed deltas wait; anything else (an approval, a question, a
status, a completion, a reply) goes at once and takes what is held with it.

**Security.** `item.raw` is allowlisted for compression: it carries the same provider payloads
snapshots and pages carried, compressed, before this trim, and no ace credential. Every message
is still compressed alone.

Measured on the recorded fixtures (`apps/daemon/bench/wire-trims.ts`): the largest snapshot
deflates to 6.2 KB instead of 15.9 KB, its 200-item page to 5.4 KB instead of 15.1 KB; a delta's
events message is 218 B instead of 314 B; `item.updated` loses 53% of its bytes; in a burst on a
slow remote link, 23 deltas share a frame instead of 7. Frames under the 1 KiB threshold would
shrink about a third if deflated alone; lowering the relay threshold, and a shared dictionary,
are left for later.
