# 0147: ace-media, a Rust media pipeline

Status: accepted. Amended by [ADR 0148](0148-ace-media-gpu-accelerated.md) (GPU acceleration,
NVENC). Date: 2026-11-14. Decided by: the owner.

- **2026-11-13:** "lets use rust based pipeline for the video pipeline for spade. So we can also
  replace the bun streaming for heavy such work".
- **2026-11-14:** "lets build the best and super performant and efficient media pipeline and
  replace current pipeline for best result". The code lives in `native/media/` and the process
  is `ace-media`. It takes the per-viewer data plane and relay encryption, so Bun touches no
  video bytes. iOS turns on HEVC. Each phase ships behind a setting, then the TypeScript path
  is deleted.

Amends:

- [ADR 0088](0088-remote-browser-view-v2.md): who carries, paces and records video;
- [ADR 0011](0011-screen-and-computer-use.md) and [ADR 0049](0049-linux-screen-helper.md):
  screens are encoded as video in the helpers;
- [ADR 0064](0064-in-app-devices.md): device stills and recordings;
- [ADR 0084](0084-use-my-chrome.md): "Use my Chrome" frames go to ace-media;
- [ADR 0110](0110-cloudflare-relay.md): a `media` relay ticket.

Builds on:

- [ADR 0002](0002-local-cli-providers.md): ace is never hosted;
- [ADR 0123](0123-spade-runs-as-its-own-service.md);
- [ADR 0125](0125-validate-at-trust-boundaries.md);
- [ADR 0142](0142-a-bots-computer.md) and [ADR 0143](0143-cowork-computer-use.md).

The build plan is [docs/media/plan.md](../media/plan.md).

## Context

Every live view on every client receives one binary format: ADR 0088's `ACES` stream envelope,
carrying H.264, HEVC, VP9 or VP8, paced by each viewer's acks. A measurement on 2026-11-13
(Apple M4 Max, heavily loaded) found the cost in different places:

- **Bun forwarding already-encoded video** costs about 1–2 % of a core per stream. That covers
  tabs in ace's Chrome, the Mac screen, and Simulator and Android live video. The
  `video-link.ts` bench held a 60 fps median (p10 59) with the daemon's whole browser-video
  stack at about 2 % of a core.
- **Chrome is used as an encoder for JPEG-only sources:**
  - Linux and Windows screens, once per viewer;
  - "Use my Chrome" tabs;
  - private-context tabs.

  The helper encodes a JPEG on the CPU, the daemon base64s it into a second Chrome of
  10 processes, and that Chrome decodes it and encodes H.264. That is two lossy steps at
  30–60 % of a core per stream.

- **Pixel transcodes in the daemon's process.** `Bun.Image`, and sharp before it, takes about
  10 ms per frame. It was half of the daemon's busy samples in the 2026-11-02 profile, and frame
  buffers drove a 1 GB footprint.
- **ffmpeg.** Recordings and Android stills need it, and it is not shipped.
- **H.264 screen recordings drop deltas** while a write is in flight, so they don't decode.
- **Relay encryption runs on the daemon's one JS thread.** It is pure-JS ChaCha20-Poly1305 at
  about 240 MB/s: 0.8 % of a core per 16 Mbit/s remote viewer and about 1.2 ms blocked per
  300 KB keyframe, growing with the number of viewers. That thread also keeps agent state.

A Spade bot's browser and screen are ace threads (ADR 0142 §2), so the bot uses these same
paths. Spade itself carries no pixels.

## Options considered

- **Keep TypeScript and optimise.**
  - Chrome stays the encoder for JPEG sources, ffmpeg stays required, and the bytes stay on the
    daemon's thread.
  - Rejected.
- **Put the pipeline inside `spade-server`.**
  - Spade is optional and can be hidden (ADR 0139), and it runs on its own lifecycle
    (ADR 0123). Every agent thread's live view would then depend on Spade, and every pixel of
    the person's screen would sit in the process that runs bots' shells.
  - Rejected.
- **A Rust media process that encodes and records, while the daemon keeps delivery.** The
  daemon would still forward every byte and encrypt it for the relay. The owner chose to
  move delivery too.
- **Chosen: `ace-media`, a Rust process the daemon runs.**
  - It owns every video byte after capture: encode, transcode, stills, recording, per-viewer
    pacing and delivery, and relay encryption.
  - The daemon decides and authorizes. It never carries video.
- **Transports.**
  - **ADR 0088's envelope stays.** Clients already decode it and it is end-to-end encrypted on
    the relay.
  - **WebRTC stays rejected.** It needs TURN, a hosted media relay, which ADR 0002 rules out.
  - **WebTransport is not used.** The relay, a Worker WebSocket, can't carry it. It remains a
    possible later direct path.

## Decision

### 1. One media process

1. **`ace-media` is one Rust binary per daemon,** built from `native/media/` (its own Cargo
   workspace, Apache-2.0).
   - **Start and stop.** The daemon starts it on the first source, viewer, recording or still
     that needs it. It stops it after 60 s with none of them.
   - **Control.** It is controlled over the child's stdin and stdout. It exits when stdin
     closes, so a daemon that dies leaves no orphan.
   - **Restarts.** The daemon restarts it with jittered backoff (0.5 s doubling to 30 s, reset
     after 60 s healthy). Recovery needs no button.
   - **Crash loops.** Five crashes in two minutes mark ace-media unavailable for 10 minutes,
     with the reason in diagnostics. Every setting in decision 9 falls back to its legacy path
     while that path still exists.
2. **The daemon decides; ace-media carries.**
   - **The daemon keeps:**
     - authentication, pairing and the relay host registration;
     - who may see what: private tabs, Spade's bots, cowork, revocation and account
       admission;
     - Chrome and CDP;
     - the helpers' control channels;
     - every JSON message to clients, including the cowork pointers and `personActive`
       (ADR 0143 §11), `video.status` and agent screenshots.
   - **ace-media keeps:** encoded and decoded pictures, encoders and decoders, per-viewer
     windows, link rate, picture scale, encode planning, keyframe rules, the envelope,
     recordings, stills, the media sockets, and the session keys of media relay streams.
3. **The control protocol** is length-prefixed JSON over stdio, which is the normal lane. Two
   more lanes run on ace-media's private control socket:
   - a priority lane, for revocation, closes and privacy barriers and their answers;
   - an egress lane, open for the process's lifetime and idle when unused, that carries frames
     back to the daemon for any consumer still on its legacy path: delivery, recordings or
     stills.

   The plan lists every message.
   - The daemon parses ace-media's `ready` message fully. The versions must match, or the
     process is stopped.
   - Later control messages are parsed with Zod, which is cheap at their rate.
   - Per-frame data never travels as JSON. Media framing is binary with fixed-layout headers.

### 2. Producers send to ace-media, not to the daemon

1. **Producers connect to ace-media directly.** They use its ingest socket (a Unix socket in a
   0700 runtime folder, or a named pipe that only the current user may open) or a loopback
   WebSocket. Each connection carries a single-use token that the daemon minted for one
   source.
   - **Mac screen.** The Swift helper sends its VideoToolbox H.264 there. Capture stays in the
     helper, whose Screen Recording permission belongs to its signature.
   - **Windows and Linux screens.** Their helpers send H.264, or HEVC where the hardware
     encodes it.
   - **Browser tabs.** The daemon's Chrome (the video extension's offscreen document) and the
     desktop's embedded encoder page send encoded chunks over the loopback WebSocket. They
     keep tab capture and WebCodecs. The base64 CDP binding remains only as the legacy path.
   - **Devices.**
     - ace-media reads serve-sim's H.264 itself.
     - It reads scrcpy's video socket through the adb forward the daemon sets up.
     - It reads the emulator's frame file itself.
     - The Simulator transcode moves from the Swift helper into ace-media.
   - **"Use my Chrome".** The native messaging host sends screencast frames to ace-media's
     ingest and acknowledges them to the extension itself.
2. **One bounded exception.** Tabs in a thread's private browser context can only be captured
   by CDP screencast, and Chrome gives ace one CDP pipe, which the daemon holds. The daemon
   forwards those frames' base64 text to ace-media as it arrives, without decoding it. That
   is the only video byte left on the daemon's thread.

### 3. Encoders, decoders, licences

- **Encoder order:**
  1. the platform's hardware encoder: VideoToolbox, Media Foundation, or VA-API with `libva`
     loaded at run time;
  2. the platform's software encoder where the OS provides one (VideoToolbox, Microsoft's
     H.264 MFT);
  3. a last-resort encoder Chrome that **ace-media** owns and drives over its own CDP pipe,
     for machines with neither, such as Linux VMs.
- **Probing.** Every encoder is probed and has a watchdog, as the browser encoder does
  today.
- **Licences.** No GPL code and no shipped software H.264 or HEVC encoder. A licence check
  (`cargo deny`) enforces it.
- **Clean room.** Everything is written from Apple, Microsoft, VA-API, ITU-T H.264/H.265 and
  ISO/IEC 14496-12/-15 documentation, never from ffmpeg, GStreamer or another media project's
  code.

### 4. Clients get a media connection

1. **The envelope stays ADR 0088's, with one change.** A piece is at most 65,518 bytes, so each
   piece fits one Noise frame. Today a full 65,536-byte piece needs two.
2. **Each client opens one media connection per daemon,** besides its main socket.
   - **Direct clients.** The client asks the daemon with `media.connect` and gets a URL and a
     single-use ticket for ace-media's listener:
     - on loopback, plain WebSocket;
     - on the LAN and Tailscale listeners, the daemon's own TLS identity, which the daemon
       hands ace-media in memory.
   - **Relay clients.** The client opens a relay stream with the new `media` purpose.
   - **The media connection carries:**
     - from server to client, envelope pieces;
     - from client to server, the existing `browser.ack`, `devices.ack` and `screen.ack`
       messages.
   - **Binding.** Subscriptions still go to the daemon, naming the media connection. The daemon
     authorizes them and tells ace-media which sources each viewer may receive. ace-media
     sends nothing that wasn't granted.
   - **Owner.** A media connection belongs to the authenticated main session that asked for it
     with `media.connect`. It is bound to that session, its device, and how that device was
     admitted:
     - a pairing, with the credential's generation;
     - or an account device, with its admission, which holds only while the machine keeps the
       device on its account.

     Pairing and account admission stay distinct, as in the relay code today. Revoking a
     pairing closes only the media connections the pairing opened, and an account change
     closes only those the account admitted.

   - **Lifetime.** The connection lives no longer than any of the things it is bound to. It
     closes when its main session closes, when its credential is revoked or replaced, or when
     its admission lapses.
   - **Grants.** A subscription may name only a media connection owned by the same main
     session, and only sources that session may see (the same checks as today: thread access,
     workspace, `admin` for screens and devices). A subscription naming another session's or
     another device's media connection is refused. The daemon puts the owner (session, device,
     admission) on every grant it sends ace-media, and ace-media refuses a grant whose owner
     differs from the connection's. Each grant is checked twice.
3. **iOS turns on HEVC** where the device decodes it in hardware, for browser video and for
   device and screen pictures.

### 5. Relay encryption: who holds the keys

Each relay stream is its own WebSocket to the relay with its own Noise XX session (ADR 0110).
ace-media must own the socket of a media stream, but the host's static key never leaves the
daemon.

1. **Only the daemon holds the static key.** ace-media never runs a Noise handshake and never
   asks for a key operation.
2. **ace-media dials; the daemon handshakes through it.**
   - The relay sends the host a `media` ticket. It does so only for hosts that registered the
     `media` feature, as with `http` tickets.
   - The daemon tells ace-media to dial `/join` with that ticket.
   - ace-media then relays bytes until the handshake ends: frames from the relay go to the
     daemon as `relay.in`, and the daemon's frames go out as `relay.out`.
   - The daemon runs the responder handshake with its own static and ephemeral keys, exactly as
     for every other stream. To the handshake, ace-media is as untrusted as the relay itself.
   - The daemon pulls inbound frames one at a time (`relay.pull`). It decrypts the client's
     `hello` and admits the device as for any channel. It requires `channel: "media"` and the
     single-use ticket that the client's authenticated main session got from `media.connect`,
     then sends the `welcome`. The connection is bound as in decision 4.2.
   - **A relay `media` ticket only arranges the meeting.** It carries no authority over
     sources, RPC, HTTP or keys. A media stream that isn't admitted and bound gets no grants and
     no keys. Once bound it accepts only acks; any other message (a subscribe, an RPC, an HTTP
     exchange, anything asking for keys) closes it. The host refuses a `media` ticket whose
     hello names another channel, and a client ticket whose hello names `media`.
3. **Hand-over.** The daemon sends `relay.keys`. The JSON names only the stream. The key
   material travels in the frame's binary payload, never in a JSON string:
   - the send and receive keys and their next nonces;
   - the frame counts that schedule rekeys;
   - the flow-credit state.

   The daemon writes the key bytes straight from its cipher states into one buffer it
   allocated for this, then destroys the cipher states. It zeroes that buffer once the pipe
   write completes.

   From then on ace-media alone encrypts and decrypts the stream. Because the daemon decrypted
   only the frames it pulled, nothing in flight is lost or seen twice.

4. **Rekeying** continues Noise's `REKEY` every 2^20 frames per direction, counted from the
   stream's start, exactly as `apps/relay/src/channel.ts` does. Test transcripts from the
   TypeScript implementation check the Rust one byte for byte.
5. **After hand-over the keys live only in ace-media's memory.**
   - In Rust they sit in zeroizing buffers. The control reader reads every payload into a
     buffer that is wiped when dropped. Key pages are locked where the OS allows.
   - They are never written to disk, never sent back to the daemon, never logged, and never in
     diagnostics.
   - Crash reports can't carry them:
     - ace-media disables core dumps (`RLIMIT_CORE` 0, and `PR_SET_DUMPABLE` 0 on Linux);
     - on Windows it excludes key pages from error reports (`WerRegisterExcludedMemoryBlock`);
     - its panic hook prints no payloads.
   - **The daemon side is honest about JavaScript's limits.**
     - A key is never put in a string, because strings can't be wiped.
     - The daemon wipes every buffer it owns.
     - It can't wipe copies the JS engine or the cipher library made internally, or the bytes
       the kernel's pipe buffer holds until ace-media reads them. Those are the same exposure
       today's relay channels already have.
6. **Revocation stays the daemon's, and has a deadline.**
   - **The trigger.** A device is revoked, its pairing replaced, an account device no longer
     admitted, or a main session that owns media connections closes.
   - **The message.** The daemon sends `revoke` or `connection.close` on a priority control
     lane of its own, so no bulk traffic can delay it. Every revocation has an id and the
     daemon's issue sequence.
   - **What ace-media does.** It handles the priority lane ahead of everything else. It shuts
     the matching sockets and zeroes their keys. It drops every queued grant, ticket and
     `relay.keys` for that owner issued before the revocation, so a grant already in the normal
     lane can't take effect after it. Then it answers `revoked` with the id.
   - **The deadline.** With no answer within 250 ms, the daemon kills ace-media. Every media
     stream ends with the process, so revocation completes either way. The daemon stops
     minting anything for a revoked owner at once.
7. **When ace-media restarts, every media stream ends.** Session keys can't be recovered and are
   never re-created for an old stream.
   - Clients reopen their media connection with backoff and resubscribe, which they already do
     on reconnect.
   - Viewers start again at a keyframe.
   - When the daemon restarts, ace-media exits with it, and clients reconnect everything.

### 6. Recordings and stills

- **Recordings.** Recordings are fragmented MP4 written by ace-media straight from the encoded
  stream, without re-encoding.
  - Each keyframe starts a fragment, which is flushed to disk. A crash loses at most one group
    of pictures, and the daemon continues the recording in a new part.
  - **Browser recordings** use the tab's video encode instead of a JPEG screencast. A recording
    nobody watches gets its own encode.
  - **Privacy epochs** (ADR 0088) become a barrier that holds in any order of arrival.
    Control messages and frames reach ace-media on separate connections, so a frame captured
    after a tab went private can arrive before any word of the transition. The barrier uses no
    shared clock; sequence numbers, the producers' own acknowledgements and the daemon's own
    clock order everything.
    - **Epochs on every frame.** Per source, epochs are short consecutive intervals. The daemon
      issues one on every privacy transition and every 100 ms while a recording runs.
    - **Stamping.** Every video and audio frame carries the epoch its producer held when it
      captured the frame, and the producer acknowledges each epoch it applies. A producer that
      can only stamp at read time gives a frame the epoch after a private one only if the
      frame was read 100 ms or more after it applied that epoch.
    - **Decisions.** The daemon decides each epoch k once the producer acknowledges k+1. Epoch
      k is clear only if the source was public for the whole time from sending k to receiving
      that acknowledgement; otherwise it is discarded. The decisions go to ace-media in one
      sequenced stream, which ace-media applies strictly in order, holding any that arrive
      early. There is no separate pause or watermark message that could overtake another.
    - **Writing.** ace-media writes a frame only once its epoch is decided clear. It holds
      undecided frames (at most 2 s or 32 MiB, then a gap), and drops frames of discarded
      epochs, including late keyframes. After any discard or gap, the next fragment starts only
      at a keyframe in a clear epoch. Audio follows the same epochs. A stalled daemon or a slow
      lane makes a recording lag or gap. It never makes it leak.
  - **Cowork.** The agent's pointer and the person's lease are kept as a timed JSON track
    beside the MP4, never drawn into the pictures.
- **Stills.** Stills for agents and models come from ace-media: the current picture, decoded on
  the platform decoder, then scaled and encoded as JPEG. Where a source has its own JPEG (the
  helpers' agent captures, serve-sim, `adb screencap`), ace-media scales that instead. A still
  ace-media can't produce before its deadline falls back to today's path, so agent tools never
  fail because media is down.

### 7. Spade and cowork

- **Bots get the pipeline as threads do.** A bot's browser and screen are ace threads, so they
  get the encoders, the recordings ("what the bot did") and the media connections like any
  thread.
- **`spade-server` stays without pixels.** Its terminal stays SSE text.
- **Bot VMs.** A future bot VM runs a helper and ace-media and produces the same envelope.

### 8. Packaging

- **One more binary per release target:** macOS arm64 and x64, Windows x64 and arm64, Linux x64
  and arm64.
- **Where it ships:** at `media/ace-media`, inside the desktop app and the standalone archives,
  under the signed manifest, at ace's version. A binary whose `--version` differs is refused.
- **macOS.** Developer ID with the hardened runtime, notarized with the app. It needs no TCC
  permission because it captures nothing.
- **Windows.** Authenticode.
- **Linux.** Built in the Debian 12 container (glibc 2.36). `libva` is never a link dependency.

### 9. Migration

1. **The phases are the order of work:**
   - phase 0: fixes that the legacy path keeps;
   - phase 1: recordings and stills;
   - phase 2: encode and ingest;
   - phase 3: per-viewer delivery and relay encryption.
2. **Each phase has a setting.** The settings are `media.recordings`, `media.stills`,
   `media.encode` and `media.delivery`.
   - Each is `auto` (ace-media, falling back to the legacy path when ace-media is unavailable
     or lacks the capability) or `legacy`.
   - `auto` becomes the default when the phase lands.
   - **Every combination is a complete route.** That is 16 combinations, each with ace-media
     healthy, restarting or unavailable.
     - With `media.encode: auto`, producers send to ace-media. Whenever any consumer of a
       source is still on its legacy path (delivery, recordings or stills), ace-media sends that
       source's frames back over the egress lane, with the same drop-to-keyframe rule. Each
       egress frame names its source by the handle the daemon assigned it, and the daemon
       hands the frame to exactly the legacy consumers routed for that source.
     - With `media.encode: legacy` and recordings, stills or delivery on `auto`, the daemon
       tees the frames it receives into ace-media's ingest.
     - When ace-media becomes unavailable, the daemon points producers back at itself.

     The routing is one pure function, tested over every combination. An end-to-end matrix
     test must pass on the release candidate before any deletion PR merges.
3. **Deletion.** After a release ships with `auto` as the default and needs no fallback, a
   deletion PR removes that phase's TypeScript path. That includes:
   - the daemon's fanout, link rate and envelope;
   - the CDP base64 chunk path;
   - the daemon-run encoder Chrome;
   - `picture-video.ts`;
   - `Bun.Image` frame transcodes;
   - ffmpeg recordings;
   - the Swift `--transcode` mode.

   Clients drop their legacy delivery in the same release that the daemon does.

## Consequences

- **Bun touches no video bytes** once every setting is `auto`, except the screencast of
  private-context tabs (decision 2.2). Until then the egress and tee routes carry bytes through
  the daemon by design.
  The daemon's thread keeps agent state without keyframes, ciphers or transcodes in its way.
- **Linux and Windows screens** are encoded once, on the GPU where there is one, instead of a
  CPU JPEG plus a Chrome decode and encode per viewer.
- **ffmpeg is no longer needed.** Recordings keep the stream's own quality.
- **Every client changes once,** to open a media connection. The envelope is unchanged, and the
  relay's Worker and self-hosted server learn the `media` ticket.
- **A second process holds stream keys.** They are per stream, never the host's identity, and
  they die with the process.
- **There is more native code** to build, sign and test on six targets, and each platform
  encoder's quirks become ace's to handle. The last-resort encoder Chrome keeps every machine
  covered.
