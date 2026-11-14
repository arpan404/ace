# ace-media build plan

How [ADR 0147](../adr/0147-ace-media-rust-media-pipeline.md) gets built. Builders work from this
file; when a PR changes a decision here, it changes this file in the same PR.

## Ground rules

- **Clean room.** Implement from Apple (VideoToolbox, CoreMedia), Microsoft (Media Foundation,
  Direct3D 11), VA-API (`va.h` and the Intel and Mesa driver docs), ITU-T H.264 and H.265, ISO/IEC
  14496-12 (ISO BMFF) and 14496-15 (AVC/HEVC in ISO BMFF), RFC 6455 (WebSocket), the Noise
  Protocol Framework revision 34, and RFC 8439 (ChaCha20-Poly1305). Never copy from, or closely
  paraphrase, ffmpeg, GStreamer, libav*, x264, x265 or any other media project.
- **No GPL, LGPL or AGPL dependencies,** and no shipped software H.264/HEVC encoder.
  `native/media/deny.toml` allows Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, Zlib,
  Unicode-3.0 and, for dev-dependencies only, MPL-2.0. `cargo deny check licenses` runs in
  `check:media`.
- **Pure core, thin shell.** Decision logic sits in crates with no I/O, no tokio and no clock
  reads: `now` is a parameter. Platform encoders sit behind traits that have fakes.
- **One owner per piece of logic.** A rule ported to Rust stays in TypeScript only until that
  phase's deletion PR. Shared vectors (below) keep the two identical until then.
- **Tests and checks.**
  - **Each PR's builder** runs the tests its own PR changes or adds, plus the checks listed for
    the PR. Those are always `bun run check:media` (fmt, clippy, test and deny in
    `native/media`) when Rust changed, and `bun run typecheck`, `bun run lint` and
    `bun run fmt:check` when TypeScript changed.
  - **The wave's integration check** runs `bun run check` on the integrated branch before the
    wave's PRs merge to `main`. It is the full gate and nothing skips it.
- Every commit carries exactly `Co-Authored-By: spade <bot@acehq.dev>`.

## Crate layout

```
native/media/
  Cargo.toml              workspace; edition 2024; rust-version 1.87 (as the Linux helper)
  deny.toml               licence and source policy
  README.md               how to build, test and bench
  crates/
    media-core/           pure: envelope, stream headers, pacing, link rate, scale, plan, keyframes
    media-wire/           pure: control-protocol serde types, MediaFrame ingest codec, stdio framing
    media-mp4/            pure: fragmented MP4 muxer and a small box reader for tests
    media-noise/          pure: Noise transport cipher, rekey, relay fragments, flow credit
    media-codec/          traits Encoder, Decoder, Scaler, StillCodec; fakes; JPEG and scaling
    media-vt/             macOS: VideoToolbox encode, decode, transcode (objc2 bindings)
    media-mf/             Windows: Media Foundation encode and decode on D3D11 (windows crate)
    media-vaapi/          Linux: VA-API encode, VPP and decode, libva loaded at run time
    media-nv/             NVIDIA: NVENC encode and NVDEC decode, driver libraries loaded at run time (ADR 0148)
    media-bitstream/      pure: H.264/H.265 NAL parsing, Annex B and AVCC/HVCC, SPS/PPS/VPS writers
    media-chrome/         last-resort encoder: a Chrome for Testing over its own CDP pipe
    ace-media/            the binary: tokio runtime, control, ingest, sources, viewers, relay, recorder
  vectors/
    envelope/ pacing/ link-rate/ scale/ plan/ gate/ quantizer/ device-control/
    noise/ flow-credit/ control/ mp4/ bitstream/
  bench/                  bench binaries (`cargo run --release --example <name>`)
```

**Dependencies.** Each must pass `cargo deny`:

- runtime and networking: `tokio`, `tokio-tungstenite`, `rustls` with `rustls-platform-verifier`;
- data and memory: `serde`, `serde_json`, `zeroize`;
- crypto: `chacha20poly1305` (RustCrypto) with its SIMD backends (NEON, AVX2). `ring` may replace it
  only if it benches faster and passes `cargo deny`;
- images, for the CPU fallback only (ADR 0148): `zune-jpeg` (decode), M5's deny-compliant JPEG
  encoder, `png` and `fast_image_resize`, each with NEON/AVX2 paths;
- platform bindings: `objc2` with `objc2-video-toolbox`, `objc2-core-media` and `objc2-metal`
  (macOS); `windows` (Windows); `libloading` (Linux for `libva`, and on both Linux and Windows
  for the NVIDIA driver's libraries). `media-nv`'s NVIDIA types are our own, written from
  NVIDIA's public docs: no SDK header or binary is vendored (ADR 0148 §3).
- There is no `x25519` and no handshake code: ace-media never runs a Noise handshake (ADR 0147 §5).

### media-core (pure)

Each module ports one TypeScript module and its tests. Its vectors are exported from the
TypeScript implementation (below).

| Module           | Ported from                                                  | What it decides                                                                                   |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `envelope`       | `packages/browser/src/stream-envelope.ts`                    | `ACES` pieces of at most 65,518 bytes; assembly to 8 MiB                                          |
| `headers`        | `stream-video.ts`, `stream-picture.ts`, `stream-audio.ts`    | kind 2/3/4/5 meta layouts, byte for byte                                                          |
| `fanout`         | `video-fanout.ts`, `picture-viewer.ts`, `picture-channel.ts` | per-viewer window (60 chunks / 8 MiB), drop-to-keyframe, the keyframe that waits, cumulative acks |
| `link_rate`      | `link-rate.ts`                                               | smoothed RTT against a 10 s floor, climb, fall, slow start, bounds 0.5–16 Mbit/s                  |
| `scale`          | `video-scale.ts`                                             | picture steps of 0.84 per side, at most six, step down after 1 s, step up after 3 s               |
| `plan`           | `video-policy.ts`                                            | encode sizes, shared encodes (25 % rule, at most 4 per tab), slowest member's rate                |
| `gate`           | `video-gate.ts`                                              | what a producer may still send while backed up, staying decodable                                 |
| `keyframes`      | `live-video.ts` timing rules                                 | forced keyframes at least 0.5 s apart, at least every 20 s, keyframe owed after a drop            |
| `quantizer`      | `quantizer-control.ts`                                       | QP 18–51, about 3 × log2(size ÷ target), keyframes 6 coarser                                      |
| `device_control` | `packages/devices/src/stream-control.ts`                     | the shared device encode takes the minimum of viewers' size, fps and bit rate                     |
| `screen_profile` | `packages/devices/src/stream-profile.ts`                     | screen and device rates for local, remote and relay                                               |
| `privacy`        | new (ADR 0147 §6), replaces `live.ts` capture-time epochs    | the recording barrier: sequenced epoch decisions, held frames, keyframe-first fragments (below)   |

### media-bitstream (pure)

- **Parsing.** Annex B start-code scanning, AVCC/HVCC length prefixes, and NAL types for H.264
  (5 IDR, 7 SPS, 8 PPS) and H.265 (19/20 IDR, 21 CRA, 32 VPS, 33 SPS, 34 PPS).
- **Conversions.** `avcC` and `hvcC` records to and from parameter sets (14496-15 §5.3, §8.3).
- **Writers.** SPS/PPS/VPS writers with exp-Golomb coding (H.264 §7.3.2, H.265 §7.3.2), used
  where VA-API needs packed headers.
- **Tests.** Vectors of parameter sets taken from the platform encoders' output in process tests,
  plus round trips.

### media-mp4 (pure)

- **Output.** Fragmented MP4: `ftyp`, then `moov` with `mvhd`, `trak`, `mdia`, `stsd`
  (`avc1`+`avcC`, `hvc1`+`hvcC`), `mvex` and `trex`. Then one `moof`+`mdat` per group of pictures,
  with `tfdt` and `trun` carrying sample sizes, durations and sync flags, and an `mfra` at a clean
  stop.
- **The timed JSON track** for the pointer and lease (ADR 0147 §6) is a sidecar `.jsonl` with the
  same time base, not an MP4 track, so every player plays the video.
- **Fragments and parts.** A fragment is written with one write and flushed at every keyframe. A
  part ends at 512 MiB or when the daemon cuts it.
- **Reader.** A small box reader exists for tests only.

### media-noise (pure)

- **`CipherState`.** ChaCha20-Poly1305 with a 64-bit little-endian nonce after 4 zero bytes, and
  `REKEY` = the first 32 bytes of ENCRYPT(k, 2^64−1, ∅, 32 zero bytes). Same as
  `packages/secure-channel/src/cipher.ts`.
- **`RelayStream` fragments.** First byte = kind (0 JSON, 2 binary, 4 deflated) plus 1 on the
  last fragment; at most 65,518 bytes of data per fragment; rekey after every 2^20th frame per
  direction, counted from the stream's start. Same as `apps/relay/src/channel.ts`.
- **`FlowCredit`.** Window 1 MiB, cost = max(length, 4 KiB), credit every quarter window, credit
  flag 7. Same as `packages/secure-channel/src/flow-credit.ts`.
- **Key handling.** Keys sit in `Zeroizing<[u8; 32]>`. Nothing implements `Debug` or `Serialize`
  for a key. See "Key hand-over" below for how they arrive.

### media-codec

```rust
pub trait Encoder: Send {
    fn configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError>; // codec, size, fps, rate or QP
    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError>;
    fn poll(&mut self) -> Option<EncodedUnit>; // Annex B or AVCC, with key flag and description
    fn caps(&self) -> EncoderCaps;             // hardware, codecs, max size, QP mode
}
pub trait Decoder: Send { fn decode(&mut self, unit: &EncodedUnit) -> Result<Option<Picture>, CodecError>; }
pub trait Scaler: Send { fn scale(&mut self, picture: &Picture, width: u32, height: u32) -> Result<Picture, CodecError>; }
pub enum Picture { Cpu(CpuPicture), Platform(PlatformPicture) } // PlatformPicture: CVPixelBuffer (IOSurface), ID3D11Texture2D, VASurface or GL texture
pub trait JpegCodec: Send { fn decode(&mut self, jpeg: &[u8], width: u32, height: u32) -> Result<Picture, CodecError>; fn encode(&mut self, picture: &Picture, quality: u8) -> Result<Vec<u8>, CodecError>; }
```

- **Fakes.** `FakeEncoder` emits deterministic units sized from a script, with keyframes on
  demand. `FakeDecoder` reports the size. Pacing and process tests use them.
- **Stills** take the GPU path of "Acceleration" below. The CPU path (`zune-jpeg`, then
  `fast_image_resize`, then M5's encoder) runs only where the probe found no hardware for a step.

## Acceleration (ADR 0148)

On a machine with a GPU, every step below runs on it. A step falls to the CPU only where the
probe found no hardware for it, and then the source says so.

| Platform, backend                                             | Capture → encoder                                                                                                                  | Colour and scale                                                                                                                                                                                                                                | Encode                                                                                 | JPEG decode (own producers)                                                                                                                                                                    | Stills: decode → scale → JPEG                                                                                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS, `media-vt` + Swift helper                              | ScreenCaptureKit hands IOSurface `CVPixelBuffer`s straight to `VTCompressionSession`: zero copy                                    | ScreenCaptureKit delivers NV12 (`420v`) at the encode size, so it scales and converts on the GPU. Other paths use Metal through `CVMetalTextureCache` from a `CVPixelBufferPool`. `VTPixelTransferSession` and vImage are only the CPU fallback | VideoToolbox H.264/HEVC, hardware required                                             | `VTDecompressionSession` with `kCMVideoCodecType_JPEG`, output at the encode size: hardware where its session reports `UsingHardwareAcceleratedVideoDecoder`, else the CPU path and one upload | VT decode with destination size set → VT `kCMVideoCodecType_JPEG` encode where its session reports `UsingHardwareAcceleratedVideoEncoder`, else one readback and CPU JPEG |
| Windows, `media-mf` (+ `media-nv` only where measured better) | WGC D3D11 texture → D3D11 video processor → NV12 texture → MFT through `MFCreateDXGISurfaceBuffer`: zero copy, no staging readback | `ID3D11VideoProcessor` (one `VideoProcessorBlt`)                                                                                                                                                                                                | MF hardware MFT (Intel, AMD, NVIDIA, Qualcomm); NVENC on D3D11 input if its bench wins | hardware MJPEG decoder MFT with D3D11 output where present; otherwise WIC (CPU)                                                                                                                | DXVA decode MFT → video processor → hardware MJPEG MFT, or WIC/CPU                                                                                                        |
| Linux Intel/AMD, `media-vaapi`                                | PipeWire DMA-BUF imported as a VA surface (`DRM_PRIME_2`): zero copy                                                               | VA-VPP (`VAEntrypointVideoProc`)                                                                                                                                                                                                                | VA-API `EncSlice`/`EncSliceLP`                                                         | VA-API `VAProfileJPEGBaseline` decode into a VA surface                                                                                                                                        | VA decode → VPP → VA-API JPEG encode (`EncPicture`, iHD); CPU encoder where the driver offers none                                                                        |
| Linux NVIDIA, `media-nv`                                      | PipeWire DMA-BUF → `EGLImage` (`EGL_EXT_image_dma_buf_import`) → GL texture, registered with NVENC: zero copy                      | GL blit to the encode size; NVENC converts RGB to YUV itself. No CUDA toolkit, no NPP                                                                                                                                                           | NVENC (OpenGL input)                                                                   | CPU (SIMD), then one upload to a GL texture. NVDEC's JPEG is hybrid CUDA + CPU and deprecated by NVIDIA, so it isn't used                                                                      | NVDEC (H.264/HEVC) with its output size set → one readback of the scaled picture → CPU JPEG                                                                               |
| No hardware encoder (VMs)                                     | —                                                                                                                                  | CPU                                                                                                                                                                                                                                             | `media-chrome`, the last resort                                                        | CPU                                                                                                                                                                                            | CPU                                                                                                                                                                       |

**Probe at start: bounded availability trials** (`crates/ace-media/src/probe.rs`).

- **What a trial does.** Each backend's `probe()` (owned by its B PR) opens a session and pushes
  one frame on a thread of its own, under a 2 s deadline that covers a cold driver start
  (CUDA or NVENC initialisation can take that long).
  - Trials run in parallel; `ready` waits at most 3 s for them.
  - A trial past its deadline is cancelled: its thread is abandoned and its session closed
    when it returns. It is recorded as `timed-out`.
  - A late success arrives as `capabilities.changed`.
- **What it reports.** `ready.capabilities` is a list of
  `{step: "encode" | "decode" | "jpeg-decode" | "jpeg-encode" | "scale", codec, backend:
"vt" | "mf" | "vaapi" | "nv" | "chrome" | "cpu", hardware, zeroCopy, state: "ok" |
"timed-out" | "failed", maxWidth, maxHeight}`.
  - `hardware` is what the session itself reports (VideoToolbox's
    `UsingHardwareAccelerated…` properties, an MFT's `MFT_ENUM_FLAG_HARDWARE`, a VA entrypoint,
    NVENC). It is never inferred from the chip family. VideoToolbox sessions that don't
    report the property (low-latency encode and JPEG sessions on macOS 27 return
    `kVTPropertyNotSupportedErr`) are opened with hardware required first; one that opens
    under that requirement counts as the session's answer, and one that doesn't is not
    hardware. `VTPixelTransferSession` reports nothing, so its `scale` step is
    `hardware: false`.
- **The helpers** report the same for capture → encode in their hello.
- **The probe never ranks.**

**Ranking: a separate benchmark** (`crates/ace-media/src/rank.rs`). It applies only where two
hardware encoders serve the same GPU, today Media Foundation's NVIDIA MFT and NVENC on Windows.

- **When it runs.** ace-media runs a 10 s encode of each candidate while no source is open,
  and cancels at once when one opens.
- **The result** is kept in `<dataDir>/media/encoder-rank.json`, keyed by adapter (PCI vendor
  and device id, and LUID), driver version and encode settings (codec and size bucket). A
  driver update makes a new key.
- **Before a result exists** the choice is deterministic: the MFT on Windows, NVENC on Linux
  NVIDIA (its only hardware encoder).

**Per source.** `source.status.acceleration` is
`{steps: [{step, backend, hardware, readbacks, uploads}], degraded, reason?}`. `readbacks` and
`uploads` count picture-sized GPU→CPU and CPU→GPU copies per frame (per still for stills). The
daemon puts it on `BrowserState.video`, `ScreenState` and `DeviceState`.

**Degraded, and the visible sentence.** A source is `degraded` when either holds:

- its video encode is not on hardware: the software MFT, the CPU, or the last-resort Chrome
  encoder;
- a step the probe listed as hardware `ok` is running on the CPU (a failed or timed-out trial,
  or a watchdog fired).

A step on the CPU because the machine has no hardware for it is that machine's expected path,
not a fallback: JPEG on NVIDIA, JPEG encode on most AMD. Only a degraded source's live view
carries one sentence in its existing status line, with no icon. For example: "Video runs on
the processor here: this computer has no hardware video encoder." `ace doctor` prints the whole
table, including timed-out trials and the ranking cache.

**CPU paths that remain:**

- **SIMD.** `fast_image_resize`, `zune-jpeg` and M5's JPEG encoder take NEON or AVX2 paths,
  detected at run time. A bench fails if the scalar path runs on a CPU that has them.
- **A fixed worker pool.** CPU media work (fallback scale, JPEG and the CPU still path) runs on
  `ace-media`'s pool: one thread per physical core minus one, at least 1, at most 8. It runs
  with bounded queues and per-job deadlines, never on the tokio threads that run control,
  delivery or relay.
- **Buffer pools.** Picture buffers (`CVPixelBufferPool`, D3D11 texture rings, VA surface pools,
  NVENC registered resources, CPU slabs) and envelope/AEAD buffers are pooled per source and per
  encode. In steady state a stream makes **zero heap allocations per frame**, counted by a
  counting allocator in `bench/alloc`.
- **AEAD.** RustCrypto ChaCha20-Poly1305 with SIMD (decided in M4), sealing in place into pooled
  buffers.

## Control protocol (daemon ↔ ace-media)

### Transport

- **Lanes.** There are three.
  - **Normal lane.** The child's stdin carries daemon → ace-media; stdout carries
    ace-media → daemon. stderr is log text, which the daemon rate-limits into its log.
  - **Priority lane.** One duplex connection to ace-media's private control socket (a Unix
    socket in the 0700 runtime folder, or a named pipe whose ACL admits only the current user).
    The daemon opens it right after `ready`. Only the messages marked "priority" below use it:
    `revoke`, `connection.close`, `relay.close`, `source.epoch`, `record.epochs` and
    `shutdown` in, and `revoked`, `closed`, `epoch.applied` and `epochs.applied` out.
    - ace-media serves this lane on a task of its own and, before taking any message from the
      normal lane, checks it first (a biased select).
    - No message on it carries a payload larger than 256 bytes, so bulk traffic on the normal
      lane can never hold it back.
  - **Egress lane.** A second connection to the same socket, opened with the priority lane right
    after `ready` and kept for the process's lifetime. It sits idle when no route needs it.
    It carries egress frames from ace-media to the daemon (see "Routes and setting
    combinations"), with nothing else on it.
    - If it drops, ace-media is killed and restarted like any lane failure: lanes authenticate
      once per process, so a lane is never reopened.
  - **Lane authentication.** Both socket lanes authenticate with a 32-byte lane secret. The
    daemon sends it in `init`'s binary payload over stdin, which is already private to the two
    processes. ace-media compares in constant time, wipes its copy once both lanes are up, and
    takes no further lane connections until it restarts.
  - **Lane hello** (`packages/media/src/lanes.ts`). A socket lane's first 37 bytes are `"ACEL"`,
    a u8 lane tag (1 priority, 2 egress) and the 32-byte lane secret. ace-media answers one byte,
    `0x01`, and the connection then carries that lane's frames. On a wrong secret, an unknown or
    repeated tag, or a connection after both lanes are up, it closes the connection without
    answering, and the supervisor treats that as a lane failure.
- **Frames** (all lanes except egress). `u32 BE frame length` (the bytes after this field, at
  most 8 MiB on the normal lane, 64 KiB on the priority lane), then `u32 BE JSON length`, the
  JSON message in UTF-8, then an optional binary payload (the rest of the frame).
- **Exit.** ace-media exits within 1 s of stdin closing.
- **As built in M7** (`native/media/crates/ace-media`: the pure `engine`, `auth`, `secret` and
  `probe`, and the I/O in `shell`).
  - **Sockets.** The control and ingest sockets are `m<pid>c.sock` and `m<pid>i.sock` in
    `init.runtimeDir`, removed at exit. ace-media refuses (exit 1) a runtime directory that is a
    symlink, is owned by another user or isn't mode 0700, and binds its sockets under a 0177
    umask, so they are never reachable by anyone else. A path longer than `sun_path` allows is
    a start failure. The control socket keeps accepting after both lanes are up and closes
    every later connection after its hello, unanswered; at most 8 connections may be sending a
    hello at once.
  - **Grant order.** Grants on the normal lane arrive with non-decreasing `issued` (one FIFO, one
    monotonic sequence); one older than a grant already seen is refused as `revoked`. So a
    revocation is forgotten once a later grant arrives. Past 4,096 outstanding revocations the
    oldest is dropped and every grant at or below its `issued` is refused (fail closed).
  - **Closed ids.** `connection.close`, `relay.close`, revocations and expiry remember the closed
    connection and stream ids for the process's lifetime, and a grant naming one is refused
    (`unknown-connection`) before any ticket is stored or key imported. Past 65,536 remembered
    ids ace-media exits 1, so the restart ends every connection.
  - **Limits.** 256 open sources and 65,536 handles (`source.status ended` with reason
    `source-limit`); 1,024 connections (a refused `media.ticket` gets `connection.closed` with
    reason `limit`), 4,096 viewers (logged) and 1,024 relay streams (`relay.failed` `limit`).
    Outbound lanes hold at most 32 MiB (normal) and 1 MiB (priority) of queued bytes; past
    that, or on a failed write, ace-media exits 1. Neither lane ever waits for the other.
  - **Producers before their hello.** At most 64 producer connections, 16 of them without an
    accepted hello; more are closed at accept. A connection has 2 s from accept (the WebSocket
    handshake included) to send its hello, and may send only what a hello needs: the hello
    frame's header announces its size, so a larger first frame is refused unread, and a
    WebSocket client may send 8 KiB of upgrade request and one hello message. The token is
    read into wiped buffers on every path. A shared buffer inside the WebSocket library can't
    be wiped from outside; it is reused for the next message.
  - **Exit codes.** 0 after stdin EOF or `shutdown`; 2 when the first message isn't a valid `init`
    or any normal-lane frame is invalid; 1 when a socket lane drops or a socket can't be bound.
  - **Secrets.** Tickets and ingest tokens live in one locked 64 KiB slab (2,048 slots), compared
    in constant time and wiped when used, closed or revoked; a full slab refuses the grant. The
    lane secret has a locked page of its own until both lanes are up.
  - **Ingest status.** `source.open` reports `starting`; the first unit `playing`; a producer
    connection that closes without an end frame `retrying` with `attempts`; an end frame `ended`.
    Tokens are single use, so a producer that reconnects needs the daemon to reopen the source.
    The origins ace-media must read itself (`simulator`, `scrcpy`, `emulator-frames`) report
    `ended` with reason `reader-unavailable` until their readers land, so the daemon keeps them.
  - **Not built yet, failing at once so the daemon falls back:** `still.take` (`still.failed`
    `stills-unavailable`, F2), `relay.dial` (`relay.failed` `relay-unavailable`, D2), and
    `record.start` (`record.failed` `recorder-unavailable`, F1). The recorder seam is wired: a
    recording's frames pass through `media-core::privacy` and `record.epochs` is answered with
    `epochs.applied` either way. `listen` is accepted and its payload wiped (D1);
    `ready.listen.loopbackPort` is 0.
  - **Probe.** One trial today, M5's CPU path (`jpeg-decode`, `jpeg-encode`, `scale` on `cpu`,
    never `hardware`). Backends add a `probe::Trial`; trials run on threads of their own and
    `ready` waits at most the 2 s trial deadline.
  - **Windows.** The lanes on named pipes with a current-user ACL are not built; the binary exits
    1 there.
  - **Acceptance.** `bun run check:media` builds the binary and runs `@ace/media`'s supervisor
    process test against it. `cargo run --release -p ace-media --example ingest` measures the
    ingest budget: 0.37 % of a core for 60 fps of 33 KB units on the Mac (0.04 % idle).

### Types

- **Rust.** `media-wire::control` holds `ToMedia` and `FromMedia`, `#[serde(tag = "type")]`, with
  unknown fields rejected on the Rust side.
- **TypeScript.** `packages/media/src/wire.ts` (package `@ace/media`, daemon-internal, not
  `@ace/protocol`) holds Zod schemas for `FromMedia` and plain TS types for `ToMedia`.
  - The daemon parses `ready` fully and checks that `version` equals its own (ADR 0125: a
    process of the same build).
  - It parses later messages with the same schemas, hoisted (no per-call `z.object`).
- **The contract.** `native/media/vectors/control/*.json` holds one fixture per message type.
  Rust round-trips each one; `packages/media/src/wire.test.ts` parses each `FromMedia` fixture
  and type-checks each `ToMedia` fixture. A message added on one side without its fixture fails
  both.
- **Identifiers.** Ids (`source`, `viewer`, `connection`, `stream`, `recording`, `request`,
  `session`) are opaque strings of up to 64 characters that the daemon mints.
- **Byte values.** Byte values never travel in JSON; they go in the frame's binary payload.
  Secrets (the lane secret, relay keys, TLS private keys, tickets) only ever travel in a binary
  payload, never in a JSON string. Each payload's layout is fixed, as given below.
- **Ordering.** Every grant on the normal lane (`media.ticket`, `viewer.open`, `relay.keys`)
  carries `issued`, the daemon's monotonic issue sequence. Revocations on the priority lane carry
  the same sequence, so ace-media can refuse a grant issued before a revocation that reached it
  first.

### Daemon → ace-media (`ToMedia`)

"Owner" means `{session, device, admission}`. `admission` is `{kind: "pairing", generation}` or
`{kind: "account", account}` (decision 4.2 of the ADR).

| Message            | Lane     | Fields                                                                                                                                                                                                                                                                                                                                                       | Payload                                                                   |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `init`             | normal   | `protocol: 1, version, runtimeDir, dataDir, settings: {recordings, stills, encode, delivery}`                                                                                                                                                                                                                                                                | the 32-byte lane secret                                                   |
| `ping`             | normal   | `id`                                                                                                                                                                                                                                                                                                                                                         | —                                                                         |
| `shutdown`         | priority | `graceMs`                                                                                                                                                                                                                                                                                                                                                    | —                                                                         |
| `listen`           | normal   | `loopback: true, remote?: {addresses[], port, certificateBytes, keyBytes}`                                                                                                                                                                                                                                                                                   | the certificate chain (PEM), then the private key (PEM), at those lengths |
| `source.open`      | normal   | `source, handle, token, threadId?, tabId?, sessionId?, deviceId?, epoch, origin`, where `origin` is one of `{kind:"tab"}`, `{kind:"tab-pictures"}`, `{kind:"user-tab"}`, `{kind:"embedded"}`, `{kind:"screen", platform}`, `{kind:"simulator", streamUrl, stillUrl}`, `{kind:"scrcpy", host, port}`, `{kind:"emulator-frames", path, width, height, stride}` | the 32-byte ingest token                                                  |
| `source.page`      | normal   | `source, width, height, scale` (the page's CSS size; the screen's points)                                                                                                                                                                                                                                                                                    | —                                                                         |
| `source.codecs`    | normal   | `source, codecs[]` (what the producer's encoder supports, from its probe)                                                                                                                                                                                                                                                                                    | —                                                                         |
| `source.picture`   | normal   | `source, ageMs, epoch` (private-context screencast frame, ADR 0147 §2.2)                                                                                                                                                                                                                                                                                     | the base64 JPEG text as received                                          |
| `source.epoch`     | priority | `source, seq, epoch, followsPrivate` (K2) (only for sources ace-media reads itself, where ace-media is the producer; see "Recording privacy barrier")                                                                                                                                                                                                        | —                                                                         |
| `record.epochs`    | priority | `source, seq, decided, clear: [from, to][], discard: [from, to][]` (decisions on epochs up to `decided`, applied in `seq` order)                                                                                                                                                                                                                             | —                                                                         |
| `source.close`     | normal   | `source`                                                                                                                                                                                                                                                                                                                                                     | —                                                                         |
| `source.egress`    | normal   | `source, on` (G1: send this source's units back on the egress lane; off until sent)                                                                                                                                                                                                                                                                          | —                                                                         |
| `media.ticket`     | normal   | `connection, owner, issued, expiresAt` (single use, 30 s)                                                                                                                                                                                                                                                                                                    | the 32-byte ticket                                                        |
| `viewer.open`      | normal   | `viewer, connection, owner, issued, source, codecs[], viewport: {width, height, dpr, scale}, local, audio`                                                                                                                                                                                                                                                   | —                                                                         |
| `viewer.configure` | normal   | `viewer, viewport, audio`                                                                                                                                                                                                                                                                                                                                    | —                                                                         |
| `viewer.close`     | normal   | `viewer`                                                                                                                                                                                                                                                                                                                                                     | —                                                                         |
| `relay.dial`       | normal   | `stream, url` (the `/join` address with the relay's `media` ticket: rendezvous only)                                                                                                                                                                                                                                                                         | —                                                                         |
| `relay.out`        | normal   | `stream`                                                                                                                                                                                                                                                                                                                                                     | one handshake or welcome frame, already sealed by the daemon              |
| `relay.pull`       | normal   | `stream` (deliver the next inbound frame to the daemon)                                                                                                                                                                                                                                                                                                      | —                                                                         |
| `relay.keys`       | normal   | `stream, connection, owner, issued`                                                                                                                                                                                                                                                                                                                          | the key block (see "Key hand-over")                                       |
| `relay.close`      | priority | `id, stream, reason`                                                                                                                                                                                                                                                                                                                                         | —                                                                         |
| `connection.close` | priority | `id, connection, reason` (its main session closed)                                                                                                                                                                                                                                                                                                           | —                                                                         |
| `revoke`           | priority | `id, issued, device, admission?` (no `admission`: every admission of the device)                                                                                                                                                                                                                                                                             | —                                                                         |
| `record.start`     | normal   | `recording, source, directory, maxBytes, pointerTrack`                                                                                                                                                                                                                                                                                                       | —                                                                         |
| `record.cut`       | normal   | `recording, reason: "size"` (privacy is never a cut: it is a barrier)                                                                                                                                                                                                                                                                                        | —                                                                         |
| `record.meta`      | normal   | `recording, epoch, data` (pointer or lease change; written with the epoch's decision)                                                                                                                                                                                                                                                                        | —                                                                         |
| `record.stop`      | normal   | `recording`                                                                                                                                                                                                                                                                                                                                                  | —                                                                         |
| `still.take`       | normal   | `request, source, maxWidth, maxHeight, maxPixels, quality, deadlineMs`                                                                                                                                                                                                                                                                                       | —                                                                         |

### ace-media → daemon (`FromMedia`)

| Message                         | Lane     | Fields                                                                                                                                                                                                                          | Payload           |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `ready`                         | normal   | `protocol, version, pid, capabilities: [{step, codec?, backend, hardware, zeroCopy, state, maxWidth, maxHeight}] (see "Acceleration"), ingest: {socket, websocketPort}, control: {socket}, listen: {loopbackPort, remotePort?}` | —                 |
| `capabilities.changed`          | normal   | `capabilities` (the whole list again, same entries as `ready`; replaces it)                                                                                                                                                     | —                 |
| `pong`                          | normal   | `id, stats: {sources, viewers, connections, cpuMs, rssBytes, bytesOut, priorityLagMs}`                                                                                                                                          | —                 |
| `revoked` / `closed`            | priority | `id` (every matching socket shut, its keys zeroed, its queued grants dropped)                                                                                                                                                   | —                 |
| `epoch.applied`                 | priority | `source, seq, epoch` (ace-media, as producer, now stamps `epoch`)                                                                                                                                                               | —                 |
| `epochs.applied`                | priority | `source, seq, written, dropped`                                                                                                                                                                                                 | —                 |
| `source.status`                 | normal   | `source, status: "starting" \| "playing" \| "retrying" \| "ended", reason?, attempts?, acceleration?: {steps: [{step, backend, hardware, readbacks, uploads}], degraded, reason?} (K2)`                                         | —                 |
| `source.want`                   | normal   | `source, encodes: EncodeSpec[]` (the daemon applies it: `aceVideo.encodes`, `ace.video.encodes`, the helper's `stream.configure`, scrcpy's options)                                                                             | —                 |
| `source.keyframe`               | normal   | `source, encode, reason: "viewer" \| "drop" \| "resume"`                                                                                                                                                                        | —                 |
| `source.audio`                  | normal   | `source, on`                                                                                                                                                                                                                    | —                 |
| `viewer.playing`                | normal   | `viewer, playing`                                                                                                                                                                                                               | —                 |
| `viewer.stats`                  | normal   | `viewer, rate, fps, dropped, rttMs` (1 Hz)                                                                                                                                                                                      | —                 |
| `connection.open`               | normal   | `connection, kind: "direct" \| "relay", owner`                                                                                                                                                                                  | —                 |
| `connection.closed`             | normal   | `connection, reason`                                                                                                                                                                                                            | —                 |
| `grant.refused`                 | normal   | `kind, id, reason: "owner" \| "revoked" \| "expired" \| "unknown-connection"`                                                                                                                                                   | —                 |
| `relay.dialed` / `relay.failed` | normal   | `stream` / `stream, reason`                                                                                                                                                                                                     | —                 |
| `relay.in`                      | normal   | `stream` (answers one `relay.pull`)                                                                                                                                                                                             | one inbound frame |
| `record.part`                   | normal   | `recording, path, index, bytes, durationMs, gaps`                                                                                                                                                                               | —                 |
| `record.done` / `record.failed` | normal   | `recording, parts[]` / `recording, reason`                                                                                                                                                                                      | —                 |
| `still.done`                    | normal   | `request, width, height`                                                                                                                                                                                                        | the JPEG          |
| `still.failed`                  | normal   | `request, reason`                                                                                                                                                                                                               | —                 |
| `log`                           | normal   | `level, message, fields` (never keys, tokens, tickets or picture bytes; `relay.keys`, `listen` and `init` payloads are never logged on either side)                                                                             | —                 |

### Ingest framing (`MediaFrame` v1)

Producers send media frames on the ingest socket or pipe, or one per binary message on the
loopback WebSocket (`ws://127.0.0.1:<websocketPort>/ingest`). The WebSocket accepts only the
`Origin`s `chrome-extension://<video extension id>` and `app://video-encoder`. Big-endian:

```
0   u32  magic "ACEM"
4   u8   version (1)
5   u8   kind: 1 video unit, 2 audio packet, 3 still picture, 4 end of source, 5 hello
6   u16  header length H (from offset 0 to the payload; at least 44, at most 4096)
8   u32  payload length (at most 8 MiB)
12  u32  flags: bit 0 keyframe, bit 1 unchanged picture, bit 2 description present
16  u32  age in µs since capture (for pacing and A/V sync only; privacy never uses time)
20  u16  coded width        22  u16  coded height
24  u16  display width      26  u16  display height (CSS pixels or points)
28  u16  scale × 1000       30  u8   rotation (quarter turns)
31  u8   codec: 1 H.264 Annex B, 2 H.264 AVCC, 3 HEVC Annex B, 4 HEVC HVCC, 5 VP8, 6 VP9, 7 JPEG, 8 PNG, 9 Opus
32  u32  encode id (the producer's own; 0 for a producer with one encode)
36  u32  privacy epoch the producer stamped (video and audio alike; 0 before any is given)
40  u16  codec string length C (WebCodecs codec string, ASCII)
42  u16  description length D (avcC, hvcC, or for Opus: u32 sample rate, u8 channels)
44  C    codec string
..  D    description
H   ..   payload
```

- **Hello.** The first frame on a connection is a hello (kind 5) whose payload is the source
  token. A connection whose first frame isn't a valid, unused token for an open source is closed.
- **Shared codec.** The codec lives in `media-wire::frame`, and in TypeScript in
  `packages/media/src/frame.ts`, which is portable (no Node built-ins) so the video extension's
  bundle includes it. Vectors live in `vectors/frame/`.
- **Restarts.** The ingest socket path and WebSocket port change on every ace-media start.
  Producers learn them from the daemon with each `stream.configure` or capture start, so a
  restart never leaves a producer writing to a dead address.
- **Epochs at the producer.** Stamping rules are in the next section. The daemon gives
  producers each new epoch with `aceVideo.epoch`, `ace.video.epoch` or the helper's
  `stream.configure.epoch`, and the producer's answer to that call is its acknowledgement. For
  sources ace-media reads itself (serve-sim, scrcpy, the emulator frame file, `source.picture`),
  ace-media is the producer: it gets `source.epoch` and acknowledges with `epoch.applied`.

### Recording privacy barrier (`media-core::privacy`)

The problem: messages and frames reach ace-media on separate connections, in any order. A frame
captured after a tab went private can arrive before any word of the transition, and a keyframe
captured before a resume can arrive after it.

The barrier uses no shared clock and no cross-process timestamps. Only the daemon's own clock,
the producers' own acknowledgements and sequence numbers order anything.

- **Epochs are short intervals.** Per source, epochs are consecutive integers that the daemon
  issues on every privacy transition and every 100 ms while a recording of the source runs.
- **Stamping.** The producer stamps every video and audio frame with the epoch it held when it
  captured the frame, and acknowledges each new epoch once it applies it.
  - Producers with a capture timestamp on their own clock stamp by capture time against the
    moment they applied each epoch: the helpers (ScreenCaptureKit presentation time and
    `mach_absolute_time`, WGC `SystemRelativeTime` and QPC, PipeWire `spa_meta_header` and
    `CLOCK_MONOTONIC`). That is one process reading one clock.
  - Producers without one (the offscreen document, the desktop's encoder page, ace-media's own
    reads) stamp at read time. After an epoch that follows a private one, they stamp a frame
    with it only if the frame was read at least 100 ms after the epoch was applied. Earlier
    frames get the private epoch. This covers the capture pipeline's queue, which is at most
    three frames, and the gap is measured in the producer itself. For its own reads, ace-media knows an epoch
    follows a private one from `source.epoch.followsPrivate`.
- **The daemon decides each epoch, using only its own clock.** Let `sent(k)` be when it sent
  epoch k to the producer and `acked(k+1)` when it received the producer's acknowledgement of
  k+1.
  - Every frame stamped k was captured after the producer applied k, so after `sent(k)`, and
    before it applied k+1, so before `acked(k+1)`.
  - Epoch k is **clear** if the source was public for the whole of `[sent(k), acked(k+1)]`;
    otherwise it is **discarded**. An epoch that a transition overlaps is never clear.
  - The decision for k is made only once `acked(k+1)` arrives. A producer that doesn't
    acknowledge holds back decisions, never releases frames. After 2 s without an
    acknowledgement, the daemon discards the open epochs and asks for a keyframe.
- **Decisions are sequenced** (`record.epochs`, priority lane). Each message carries the
  source's next `seq`, the highest epoch it decides (`decided`), and the clear and discarded
  ranges.
  - ace-media applies them strictly in `seq` order. A message whose `seq` is ahead of the next
    expected one is held until the gap fills; one at or behind it is ignored.
  - The pause, the resume and the "watermark" are all just decisions in this one ordered
    stream. A watermark can't overtake a pause, because there is no separate watermark.
- **What ace-media writes.**
  - **Held.** A frame whose epoch isn't yet decided is held, at most 2 s or 32 MiB per
    recording. Past that the oldest are dropped, the recording marks a gap, and the next
    fragment waits for a keyframe.
  - **Written.** A frame in a clear epoch is written.
  - **Dropped.** A frame in a discarded epoch is dropped. So is a frame whose epoch is above any
    the daemon issued.
  - **Fragments.** After any discarded epoch, a gap or an overflow, the next fragment starts
    only at a keyframe in a clear epoch. Deltas before it are dropped, and ace-media asks for a
    keyframe (`source.keyframe reason: "resume"`).
  - **Late keyframes.** A delayed keyframe from a discarded epoch is dropped whenever it
    arrives.
  - **Audio** follows the same epochs, and is written only once the video fragment has
    started.
  - **Answers.** ace-media answers `epochs.applied` with what it wrote and dropped.
- **Restarts.** On an ace-media restart the daemon reissues each recorded source's current
  epoch, and `seq` starts again at 0 for the new process. Frames held at the crash are lost, as
  a gap. On a producer restart the daemon resends the current epoch, and nothing is written
  until the producer acknowledges it.
- **Live views** are not filtered by the barrier. What a viewer may see is the daemon's grant,
  as today. The barrier governs recordings only, as ADR 0088's epochs did.
- **Tests.** These are pure, in `media-core::privacy` (M8) and the daemon's decision logic
  (`packages/media/src/epochs.ts`), plus one process test in F1. The process test feeds a fake
  producer's frames and the daemon's messages on their real, separate connections, with
  injected delays:
  - frames captured after a transition arrive before any decision;
  - **the priority lane is delayed by seconds** while frames keep flowing: they are held, not
    written, and overflow becomes a gap;
  - decisions arrive with `seq` out of order;
  - the producer's acknowledgement of the next epoch is delayed past a transition, so the
    epoch is discarded;
  - an old keyframe from a discarded epoch arrives after the resume;
  - a frame read within 100 ms of the epoch after a private one;
  - audio crossing a transition;
  - ace-media restarting between a pause and its resume.

  The assertion in every case: no written sample was captured while the source was private,
  and every part decodes on its own.

### Media connection authorization

Every media connection, direct or relay, has one owner: the main session that asked for it,
its device, and that device's admission (pairing with a credential generation, or account
admission).

- **`media.connect`** (on an authenticated main session, any scope that may view) makes a
  connection id and a single-use 32-byte ticket. The ticket is valid for 30 s and bound to the
  owner. The daemon records the connection under the session: `MediaConnections` in
  `packages/media`, keyed like `files-relay.ts`'s client maps.
- **Direct.** The client connects to ace-media's listener with the ticket. ace-media accepts
  it only once, before `expiresAt`, and only if no revocation for that owner has an `issued`
  later than the ticket's.
- **Relay.** The relay's `media` ticket only arranges the meeting (ADR 0147 §5.2). The client's
  `hello` on the stream must carry the `media.connect` ticket. The daemon checks it during the
  handshake it runs through ace-media, in this order:
  1. the device token, as for any channel (`relayHello`);
  2. that the ticket's owner has the same device and admission kind;
  3. that the owning session is still open.

  Only then does it send `welcome` and `relay.keys`.

- **What a media connection accepts from the client:** `browser.ack`, `devices.ack`,
  `screen.ack` and pings. Anything else (a subscribe, an RPC, an HTTP exchange, a request for
  keys or tickets) closes it with the reason logged.
- **Grants.** `viewer.open` comes from a subscribe on the owning session that names the
  connection. The daemon refuses a subscribe naming a connection of another session. For the
  source, it runs the same checks as today: thread access, workspace, scope, and `admin` for
  screen and devices.
  - ace-media checks the grant's owner against the connection's owner.
  - It refuses grants for unknown or closed connections, and grants issued before a revocation
    that matches them (`grant.refused`).
- **Closing.** The connection closes when any of these happens:
  - the owning session closes (`connection.close` on the priority lane);
  - the credential is revoked or replaced (`revoke` with `admission: pairing`);
  - an account admission lapses (`revoke` with `admission: account`). This hooks the same
    `account.onChange` the relay uses;
  - its ticket was never used and expired.

  Pairing and account stay distinct: revoking a pairing never closes account-admitted
  connections of the same install, and an account change never closes pairing-admitted ones.

- **Negative tests** (D1 for direct, D2 for relay). Each case asserts the refusal, and that no
  envelope piece reaches the wrong party:
  - a ticket reused, expired, or presented by another device;
  - a ticket from session A used to bind a subscribe on session B;
  - a subscribe naming another device's connection;
  - a `viewer.open` whose owner differs from its connection's (sent straight to ace-media);
  - a revoked pairing generation;
  - a pairing revocation leaving an account-admitted connection open, and the reverse;
  - an account device removed mid-stream;
  - a client sending a subscribe, an RPC frame or an HTTP request on a media connection;
  - a relay `media` ticket whose hello names `files` or the main channel;
  - a normal client ticket whose hello names `media`;
  - a grant queued on the normal lane behind a revocation for its owner.

### Key hand-over (`relay.keys` payload)

The payload is a fixed 120-byte block, big-endian. The flow fields are
`packages/secure-channel/src/flow-credit.ts`'s state; that file gains `FlowCredit.exportState()`,
and the hand-over requires its `queued` to be 0, which holds because the daemon consumed
everything it pulled:

```
0    32  send key
32   32  receive key
64   u64 send nonce (next)
72   u64 receive nonce (next)
80   u64 frames sent (rekey schedule)
88   u64 frames received (rekey schedule)
96   u8  flow flags: bit 0 limited (this side sent its start), bit 1 counting (the peer's start arrived)
97   u8  reserved (0)        98   u16 reserved (0)
100  u32 flow window (cost units this side may still send)
104  u32 flow unacked (counted cost received, not yet credited back)
108  u32 flow owed (consumed cost owed to the peer)
112  u32 flow uncounted (fragments that predate the peer's start)
116  u32 CRC-32C of bytes 0..116 (catches framing bugs; not a security check)
```

- **Daemon side** (`packages/secure-channel` gains `CipherState.exportInto(buffer, offset)`).
  The method writes the key and nonce straight into the caller's buffer and destroys the
  state, so no other copy is made in JS.
  - The daemon allocates one `Uint8Array(120)` for the block and one for the frame header.
  - It writes the frame with the block as a separate chunk. Once the pipe write's callback
    reports completion it runs `block.fill(0)`; on a write error too.
  - It never builds a string from key bytes.
  - It logs only `relay.keys {stream}`.
- **ace-media side.** The control reader reads every payload into a `Zeroizing<Vec<u8>>`
  allocated to the frame's length, never through a shared `BufReader`.
  - `relay.keys` parses the block into `Zeroizing<[u8; 32]>` keys and drops the payload buffer,
    which wipes it, before installing the cipher states.
  - Key pages are locked with `mlock` or `VirtualLock` where permitted (best effort).
- **The same rules** cover the lane secret in `init`, tickets in `media.ticket` and
  `source.open`, and the TLS private key in `listen`.
- **What JavaScript can't promise:** copies the engine or `@noble/ciphers` made internally
  (expanded key state, garbage-collected copies of small typed arrays), and the bytes in the
  kernel pipe buffer until ace-media reads them. These are the same exposure today's relay
  channels have, and the ADR says so (§5.5).
- **Never exposed.**
  - No `Debug`, `Display` or `Serialize` for key types.
  - ace-media's panic hook prints no payloads.
  - Core dumps are off (`RLIMIT_CORE` 0; `PR_SET_DUMPABLE` 0 on Linux, which also stops
    same-user `ptrace`).
  - On Windows, key pages are registered with `WerRegisterExcludedMemoryBlock`.
  - `ace doctor` and diagnostics show stream ids and states, never payloads.
- **Test** (D2). It drives a stream through hand-over and a rekey, then:
  - scans ace-media's stdout and stderr, the daemon's log and the diagnostics bundle for the
    key bytes, in hex and in base64;
  - checks that the daemon's block buffer is all zeros after the write callback;
  - fakes a crash to check that core dumps are off.

### Routes and setting combinations (`packages/media/src/routes.ts`)

`mediaRoutes(settings, health, capabilities)` is pure. For each source kind it returns:

- the producer target: the daemon, or ace-media's ingest;
- the tee: whether the daemon copies frames it receives into ace-media's ingest;
- the egress: whether ace-media sends the source's frames back to the daemon;
- the recorder, the still maker and the deliverer: each is legacy (in the daemon) or ace-media.

Health is `healthy`, `restarting` or `unavailable`; anything but `healthy` makes every `auto`
behave as `legacy`. The daemon applies a change of routes by reconfiguring producers (a new
ingest address, or back to the daemon) at the next keyframe.

**Where frames come from.** A consumer in the daemon (the legacy deliverer, recorder or still
maker) needs frames in the daemon. A consumer in ace-media needs them in ace-media.

- **Tee.** It is on when the producer target is the daemon and any consumer is in ace-media.
- **Egress.** It is on when the producer target is ace-media and **any** consumer is in the
  daemon.
- **Never both.** Tee and egress are never on for the same source.

| `encode` | Producer target | Tee on when                                         | Egress on when                                                                            |
| -------- | --------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| legacy   | daemon          | any of `delivery`, `recordings`, `stills` is `auto` | never                                                                                     |
| auto     | ace-media       | never                                               | any of `delivery`, `recordings`, `stills` is `legacy` (or ace-media isn't healthy for it) |

So `encode` and `delivery` on `auto` with `recordings` or `stills` on `legacy` turn egress on.
The legacy recorder and still maker get their input, and the viewers are still served by
ace-media.

- **Egress format.** Every frame on the egress lane is a 12-byte egress header, then the
  `MediaFrame` exactly as ingested or encoded:

  ```
  0  u32  magic "ACEE"
  4  u32  source handle (the `handle` the daemon gave in `source.open`)
  8  u32  ace-media's sequence for this source (gaps mean dropped frames)
  12 ..   MediaFrame
  ```

  - **Handles** are `u32`s the daemon assigns in `source.open`, never reused while one
    ace-media process lives. The lane is authenticated, so a handle can only come from the
    process the daemon started.
  - **Dispatch.** The daemon dispatches by handle, never by encode id: encode ids are the
    producer's own, and two sources may share them. A frame with an unknown handle, or the
    handle of a closed source, is dropped and counted in diagnostics.

- **Egress routing in the daemon** (`packages/media/src/egress.ts`). Each source's frames go to
  exactly the consumers routed to the daemon:
  - the deliverer: `LiveVideo.publish` and the picture hubs, the same entry points today's
    producers feed;
  - the legacy recorder: `session-recording.ts` and `recording-feed.ts`, which keep applying
    their own privacy rules;
  - the legacy still maker: the latest keyframe or JPEG per source, as today.
- **Bounds.** Egress is bounded at 4 MiB in flight. When full, ace-media applies
  `media-core::gate` per source: drop deltas to the next keyframe, then ask the producer for
  one. A full egress for one source never delays another's priority messages, because those are
  on their own lane.
- **Tests.**
  - `routes.test.ts`: all 16 setting combinations × 3 health states × capabilities present or
    absent. It asserts that every source kind has a producer target, a recorder, a still maker
    and a deliverer; that every consumer has an input (tee or egress on exactly when the table
    says); that tee and egress are never both on; and that no consumer is ace-media while it
    isn't healthy.
  - G1's process test: two sources **with the same encode id**, interleaved on one egress
    connection, each reach only their own consumers. A frame with an unknown or closed handle
    is dropped.
  - Q1 (below): all 16 combinations end to end, with ace-media healthy, against one browser
    tab, one Mac screen (or a fake helper off macOS) and one fake device. It includes
    `encode`+`delivery` on `auto` with `recordings` and `stills` on `legacy`, which must record
    and make stills through egress. Four corner combinations also run with ace-media killed
    mid-stream and with it unavailable. Each case asserts that a viewer gets pictures, a
    recording decodes, and a still returns.

- **As built in G1** (`packages/media/src/{routes,route-watch,egress}.ts`; the engine's
  `egress` module and the shell's egress lane in `ace-media`).
  - **Telling ace-media.** The daemon turns a source's egress on or off with `source.egress`
    (normal lane, after `source.open`; off by default). ace-media holds no route of its own.
  - **Capabilities.** `mediaRoutes` takes `RouteCapabilities`: the source kinds whose
    producers can stream into ace-media (E1–E4) and whether ace-media records (F1), makes stills
    (F2) and serves viewers (D1). `builtRouteCapabilities` has none of them, so every `auto`
    acts as `legacy` until the PR that lands a piece turns its flag on.
  - **Watching.** `RouteWatch` keeps the current table. The daemon calls `update()` on a setting
    change and from the supervisor's `replay` and `onExit`, and reconfigures the kinds
    `onChange` lists, so a producer routed to a dead ace-media is pointed back at the daemon at
    once.
  - **Writer.** Each unit of a source with egress on takes the next sequence, sent or dropped.
    Video goes through one `ChunkGate` per encode id (at most 16 per source; a forgotten one is
    logged and starts again at a keyframe), and a unit is copied into its egress bytes only once
    its gate lets it through. The first unit of an encode after egress turns on must be a
    keyframe (else `source.keyframe` `resume`), and a refused send asks for one with `drop`.
    Audio and pictures are never gated and never open a video gate. An empty lane always takes
    one frame, so a keyframe larger than 4 MiB still passes once the lane drains. A full egress
    never ends the process; a dropped or failed egress lane does.
  - **Router.** `EgressRouter` mints handles (from 1, never reused while the daemon lives) and
    keeps each handle's source kind. For every unit it reads the kind's live route through the
    callback it was built with (`RouteWatch.routes()[kind]`), so it holds no copy that can
    drift: once the route moves the producer back to the daemon, units ace-media sent before
    it heard `source.egress` off are dropped, never delivered twice. It dispatches to the
    consumers the route keeps in the daemon, marks a unit after a sequence gap, and counts
    invalid frames, unknown and closed handles, gaps, and those unrouted units.

### Supervision (`@ace/media` `MediaSupervisor`)

**Injected.** Spawn, clock, timers, random (for jitter), the binary's path and the runtime folder.

- **Binary.** Releases run `media/ace-media(.exe)`, relative to the release root. Development
  runs `native/media/target/{debug,release}/ace-media` or `ACE_MEDIA_PATH`.
- **Start.**
  - ace-media starts lazily, on the first `need()` (a source, viewer, recording or still).
  - The daemon sends `init`, then expects `ready` within 5 s; otherwise it kills the process and
    counts a failure.
  - It then sends `listen`, and replays every open source and recording from the daemon's own
    state. **The daemon's state is the truth; ace-media holds none across restarts.**
- **Health.**
  - The daemon sends `ping` every 5 s. Three missed `pong`s kill the process.
  - `pong.stats` feed diagnostics and the `bytesOut`/`cpuMs` acceptance checks.
- **Restart.**
  - Backoff is 0.5 s, then doubling to 30 s, ±20 % jitter, reset after 60 s healthy.
  - Five failures in 2 minutes mark ace-media `unavailable` for 10 minutes, with the last
    stderr lines and exit code in diagnostics (`ace doctor`, ADR 0092). Settings set to `auto`
    then use their legacy path while it exists.
  - Exit code 2 (protocol or version mismatch) stops restarts until the daemon itself
    restarts.
- **Idle.** The daemon sends `shutdown` after 60 s with no need. ace-media closes connections,
  finishes recording fragments and exits within `graceMs`. Past that it is killed.
- **Orphans.** ace-media exits on stdin EOF. On Linux it also sets
  `prctl(PR_SET_PDEATHSIG, SIGKILL)`. On Windows the daemon puts it in a job object with
  `KILL_ON_JOB_CLOSE`.
- **Effects of a restart** (ADR 0147 §5.7):
  - every media connection closes;
  - sources reopen, and the daemon shows them as retrying until their first unit. ace-media holds
    no state across restarts, so the new process reports a replayed source `starting`, then
    `playing` at its first unit;
  - recordings continue in a new part;
  - pending stills fail and fall back to their legacy path.
- **Revocation deadline** (ADR 0147 §5.6).
  - `revoke`, `connection.close` and `relay.close` go out on the priority lane at once,
    whatever is queued on the normal lane.
  - From that moment the daemon mints nothing for that owner: no tickets, grants or keys.
  - ace-media answers `revoked`/`closed` once the matching sockets are shut, their keys zeroed
    and their queued grants dropped.
  - With no answer within **250 ms**, or if the priority lane itself is down, the supervisor
    kills ace-media (`SIGKILL`, or `TerminateProcess` through the job object). That ends every
    media socket. It counts as a failure for backoff, and the daemon's state replays as after
    any restart, without the revoked owner.
  - `pong.stats.priorityLagMs`, the oldest unanswered priority message, is in diagnostics.
- **Tests** (M6 for the supervisor with a fake child, D2 for the real binary):
  - revocation answered within 50 ms p99 while the normal lane is saturated (MB-sized
    `source.picture` and `relay.out` frames back to back) and the egress lane is full;
  - a child that stops reading (`SIGSTOP`, or a fake that never answers), killed at 250 ms
    ± timer slack, after which the client's media socket closes within 500 ms;
  - a `viewer.open` and a `relay.keys` written to the normal lane before a `revoke` for their
    owner never take effect (`grant.refused`);
  - a priority lane that drops causes a kill and a restart.
- **Rule.** The supervisor never blocks agent tools: every call that needs ace-media has a
  deadline and a fallback.
- **As built in M6** (`packages/media/src/supervisor.ts`, with its rules in
  `supervision-policy.ts`, `health.ts`, `grants.ts`, `media-binary.ts`, `diagnostics.ts` and
  `supervisor-host.ts`).
  - **Setting gate.** `need()` does nothing while every media setting is `legacy`, the default,
    so nothing starts ace-media until a setting turns `auto`.
  - **Sends.** `send()` returns false while ace-media isn't up with both lanes, while it is
    shutting down after idle, or when a revocation already covers the grant. The caller falls
    back; sources and recordings come back through `replay`, which runs once both lanes are up
    and `listen` is sent. A need that arrives during an idle shutdown starts a new process
    once the old one exits.
  - **Pings.** A ping's 5 s pong deadline starts when its bytes are written, not when it is
    queued, and no second ping queues behind an unwritten one, so normal-lane backpressure never
    counts as missed pongs. A child that stops reading stdin altogether is killed separately:
    normal-lane bytes pending and no write completing across six ping intervals.
  - **Lanes.** A socket lane's close is watched from the moment it connects, so a lane that
    drops while the other is still authenticating ends the run.
  - **Revocations.** `revoke()` writes to the priority lane and drops queued, unwritten grants it
    covers (same device and admission with `issued` at most the revocation's, the connection,
    or the stream), zeroing their payloads. It resolves `answered`, `killed` (the process is
    gone, so every socket is) or `not-running`.
  - **Exits.** `onExit` lists the stills, connections, sources and recordings the process held,
    for their owners to fail or replay. A recording stays listed after `record.stop` until its
    `record.done` or `record.failed`. It also says whether the exit counted as a failure; an idle
    shutdown and `dispose()` don't. Secret payloads (`init`, `media.ticket`, `source.open`,
    `relay.keys`, `listen`) are zeroed after their write callback, or when dropped unwritten.
    The lane secret comes from the platform CSPRNG unless a test injects `randomBytes`.
  - **Binary.** `mediaBinaryPath` takes an explicit mode. A release runs only
    `media/ace-media(.exe)` under the bundle root of the daemon's entry (the release folder or
    the desktop app's resources, as `@ace/service/spade-layout` defines) and ignores the
    environment, since the binary receives secrets. Development honours `ACE_MEDIA_PATH`, then
    the source tree's release build, then its debug build.

## Helper changes

### Windows (`native/screen-helper-windows`, Media Foundation)

1. **D3D11 device.** Create the device with `D3D11_CREATE_DEVICE_VIDEO_SUPPORT` and set
   `ID3D11Multithread::SetMultithreadProtected(TRUE)`. Share it through `IMFDXGIDeviceManager`
   (`MFCreateDXGIDeviceManager`, `ResetDevice`).
2. **Colour and scale on the GPU.** `ID3D11VideoProcessor` converts BGRA to NV12 and scales in
   one `VideoProcessorBlt`, replacing today's scale-then-readback. There is no staging readback
   on the hardware path.
3. **Encoder choice.** Use `MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE |
MFT_ENUM_FLAG_SORTANDFILTER, NV12 in, MFVideoFormat_HEVC / MFVideoFormat_H264 out)`.
   - Async hardware MFTs need `MF_TRANSFORM_ASYNC_UNLOCK` and are driven by
     `METransformNeedInput` / `METransformHaveOutput`. Send them `MFT_MESSAGE_SET_D3D_MANAGER`.
   - The fallback is Microsoft's software H.264 MFT (synchronous, system-memory NV12 after a
     readback).
   - Machines with no MFT at all (N editions without the Media Feature Pack) report no
     encoder, and ace-media uses its last-resort encoder.
   - **NVIDIA (ADR 0148).** The NVIDIA hardware MFT is the deterministic first choice. The
     probe only checks that `media-nv` (NVENC with D3D11 input, the same NV12 or RGB texture)
     is available. `media-nv` replaces the MFT only once the ranking benchmark (see
     "Acceleration") has measured the MFT worse on this adapter, driver and encode settings.
4. **Settings.**
   - `CODECAPI_AVLowLatencyMode`;
   - `CODECAPI_AVEncMPVDefaultBPictureCount = 0`;
   - a large `CODECAPI_AVEncMPVGOPSize` (keyframes on demand);
   - `CODECAPI_AVEncCommonRateControlMode` (low-delay VBR), with `CODECAPI_AVEncVideoEncodeQP`
     for ace's quantizer control where the MFT takes it;
   - `CODECAPI_AVEncVideoForceKeyFrame` on request.
5. **Input samples** come from `MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), nv12, 0,
FALSE)`.
6. **Output.** Annex B. The parameter sets come from `MF_MT_MPEG_SEQUENCE_HEADER`, and the helper
   puts them before every IDR that lacks them.
7. **Rate.** Capture goes to 60 fps while a viewer watches as video; the 30 fps cap stays for
   JPEG stills. XXH3 dirty-tile skipping stays: an unchanged picture is not encoded.
8. **Frames** go to ace-media's named pipe as `MediaFrame`s, through `media-wire` (a path
   dependency). JPEG stills for agents stay as they are.
9. **Test matrix.**
   - The Windows test VM covers the software MFT path and the no-MFT path.
   - The owner's machines with Intel, NVIDIA, AMD and Qualcomm (arm64) GPUs cover the hardware
     MFTs. Their quirks (output types offered only after the first input, ignored QP) are
     handled by probing, and a watchdog replaces an MFT that has had input for a second without
     output, as the browser encoder does.

### Linux (`native/screen-helper-linux`, VA-API)

1. **Loading.** `libloading` opens `libva.so.2` and `libva-drm.so.2` at run time (and the NVIDIA
   libraries of item 6). There is no link dependency. With none present, the helper reports no
   encoder.
2. **Device choice.** Probe `/dev/dri/renderD*` and pick the first node whose driver lists
   `VAEntrypointEncSliceLP` or `VAEntrypointEncSlice` for `VAProfileHEVCMain` or
   `VAProfileH264High`/`Main`/`ConstrainedBaseline` (iHD and Mesa radeonsi).
3. **Capture.** Offer `SPA_DATA_DmaBuf` with the modifiers VA can import (`vaQuerySurfaceAttributes`,
   `VA_SURFACE_ATTRIB_MEM_TYPE_DRM_PRIME_2`), so the picture never touches the CPU. On compositors
   that send only shared memory, upload with `vaCreateImage`/`vaPutImage`.
4. **Colour and scale.** VA video processing (`VAEntrypointVideoProc`) converts BGRx/RGBx to NV12
   and scales in the same pass.
5. **Encoding.**
   - Sequence, picture and slice parameter buffers for IPPP with one reference and no B-frames.
   - IDR on request.
   - Low-delay CBR/VBR through `VAEncMiscParameterRateControl`, or CQP for ace's quantizer
     control.
   - Packed SPS/PPS (and VPS for HEVC) written by `media-bitstream` when the driver asks for
     them (`VAConfigAttribEncPackedHeaders`).
6. **NVIDIA** (ADR 0148) has no VA-API encode, so the helper uses `media-nv`.
   - **Loading.** `libnvidia-encode.so.1` is opened at run time.
   - **Import.** The DMA-BUF is imported with `EGL_EXT_image_dma_buf_import` into a GL texture
     on the NVIDIA EGL device.
   - **Scale.** A GL framebuffer blit scales it to the encode size.
   - **Encode.** NVENC, opened with `NV_ENC_DEVICE_TYPE_OPENGL`, takes the registered texture
     (`NV_ENC_INPUT_RESOURCE_TYPE_OPENGL_TEX`, ARGB) and converts colour itself.
     - Low latency means `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`, no B-frames, and an infinite
       GOP with IDR on request.
   - **Dependencies.** No CUDA toolkit, no NPP and no CPU copy.
   - **Fallback.** A driver without the pinned NVENC API version falls back to the last-resort
     encoder, and the machine says so.
7. **Rate.** The 10 fps default becomes 60 fps while watched as video. Nothing is encoded while
   nobody watches, as today.
8. **Frames** go to ace-media's ingest socket as `MediaFrame`s. JPEG stills stay.
9. **Test matrix.** Ubuntu, Fedora and Debian on GNOME Wayland, and Omarchy on Hyprland. Intel
   (iHD) and AMD (radeonsi) for hardware; a VM for the fallback.

### macOS (`native/screen-helper`, Swift)

- **Capture and encode stay.** ScreenCaptureKit, VideoToolbox and the helper's signature, which
  carries the Screen Recording permission, are unchanged.
- **Zero copy (ADR 0148).** While a viewer watches as video, `SCStreamConfiguration` asks for
  `420v` (NV12) at the encode size. ScreenCaptureKit then scales and converts on the GPU, and
  its IOSurface `CVPixelBuffer`s go to `VTCompressionSession` untouched. BGRA at full size is
  asked for only for agents' JPEG stills. Dirty-rect change detection stays, and the
  full-picture FNV hash runs only when ScreenCaptureKit reports no dirty rects.
- **Frames.**
  - `stream.configure` gains `ingest: {socket, token}` and `epoch`.
  - The helper opens that socket, sends the hello, and writes `MediaFrame`s (H.264 Annex B,
    with HEVC later) instead of frame packets on the daemon socket. It stamps each frame with
    the epoch at its ScreenCaptureKit callback.
  - With `ingest` absent, it keeps sending frame packets to the daemon (the legacy route).
  - JPEG stills for agents keep the existing path.
- **`--encode-frames`** (emulator) writes to the ingest socket too.
- **`--transcode`** is deleted after its replacement in `media-vt` ships (phase 2 deletion).
- **The helper's identity must not change.** Its bundle id (`dev.ace.screen-helper`), its
  signing identity and its designated requirement are what macOS ties the Screen Recording grant
  to.
  - `tools/release` records the expected requirement in `native/screen-helper/identity.txt`.
  - E3 and every later PR that touches the helper check that the built
    `AceScreenHelper.app` still matches it (`codesign -d -r-`).
  - R1 checks the same on the packaged app.

## Clients

- **Protocol additions** (`packages/protocol`):
  - `media.connect` → `{connection, url?, ticket, expiresAt}` (no `url` when only the relay
    reaches this client); the relay media hello carries the same ticket;
  - `MediaConnectionId`;
  - an optional `media: {connection}` on `browser.subscribe`, the device stream request and the
    screen subscribe;
  - `codecs` on the device and screen subscribes;
  - the relay hello's `channel: "media"`;
  - the relay client's `purpose=media` (`apps/relay`, `apps/cloud`).

  `bun run docs:protocol` regenerates the protocol docs.

- **Web and remote desktop** (`apps/web/src/lib/video`, `packages/client*`):
  - open one media connection per daemon connection;
  - send acks on it;
  - resubscribe with the new connection id after it reconnects;
  - decode HEVC Annex B device and screen pictures (WebCodecs without a description).
- **iOS:** the HEVC change below, and the media connection, through the shared JS bridge.
  Swift implements the socket (native host, one JS contract).

### iOS HEVC

1. **Codec list.** `apps/ios/bridge/browser-live.ts`: `nativeVideoCodecs` comes from the host
   contract (`host.video.decoders()`). It is `["hvc1.1.6.L153.B0", "avc1.42E033"]` when
   `VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC)` is true, otherwise
   `["avc1.42E033"]`. The device and screen subscribes send the same list.
2. **Decoder.** `apps/ios/Sources/Browser/H264Decoder.swift` becomes `VideoDecoder.swift`:
   - an `avcC` description goes to `CMVideoFormatDescriptionCreateFromH264ParameterSets`;
   - an `hvcC` description goes to `CMVideoFormatDescriptionCreateFromHEVCParameterSets`, with
     its VPS/SPS/PPS taken from the record;
   - decoding into `AVSampleBufferDisplayLayer` is unchanged. `BrowserVideoChunk.swift` carries
     the codec.
3. **Pictures.** `Devices/AnnexB.swift` learns HEVC NAL types (VPS 32, SPS 33, PPS 34, IDR 19/20,
   CRA 21) for device and screen pictures.
4. **Tests.**
   - A Swift test decodes recorded HEVC and H.264 chunks (fixtures from the `video-profile.ts`
     encodes) to the expected size.
   - A bridge test checks the list includes HEVC exactly when the host says so.
5. **This PR is independent:** Chrome tab capture already encodes HEVC first.

## Packaging

- **The build.** `tools/release/src/ace-media.ts` follows `spade-server.ts`:
  - a triple map for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`
    and `win32-x64`;
  - `ACE_MEDIA_BIN` to supply a prebuilt binary;
  - otherwise `cargo build --release --locked -p ace-media` in `native/media` with
    `ACE_MEDIA_VERSION`, after which the binary's `--version` must equal the release's.
  - Linux builds in the Debian 12 container. The existing glibc check applies, and `ldd` must
    show only libc, libm, libdl, libpthread and Rust's libgcc_s unwinding runtime (matching the screen helper and Spade; no `libva`).
- **Layout.** Archives and the desktop app carry `media/ace-media` (`.exe` on Windows).
  `apps/desktop/scripts/package.ts` adds `media` to its resource folders.
- **macOS.** The binary is signed with the Developer ID and the hardened runtime by the same
  electron-builder pass that signs `spade/spade-server`, and notarized with the app. It needs no
  entitlements. Ad-hoc signed in local builds.
- **Windows.** Authenticode through the same `signtoolOptions` as `spade-server.exe`.
  `authenticode.test.ts` covers the new file.
- **Licences.** `tools/release/src/licenses.ts` adds ace-media's third-party notices (from
  `cargo about` or the workspace's own listing), as for `spade-server`.
- **Size budget.** At most 8 MB per binary. `bench/size.ts` reports it.
- **Packaged checks, on every release target**, run by `tools/release/src/smoke.ts` against the
  built archive and desktop package, not the source tree:
  - **Launch.** The packaged daemon starts the packaged `media/ace-media` from its release path,
    gets `ready` with the release's version and a `pong`, and stops it cleanly.
  - **macOS.** The app passes `codesign --verify --deep --strict`. `media/ace-media` carries the
    Developer ID, the hardened runtime flag and no entitlements. `spctl --assess` accepts the
    app, and the notarization ticket is stapled.
  - **Windows.** `signtool verify /pa` passes on `ace-media.exe`, alongside the existing
    Authenticode checks.
  - **Linux.** The glibc and `ldd` checks above run on the binary from the archive.
  - **All targets.** The signed manifest's checksum matches the file.
- **Screen helper identity.** Packaging must not re-sign `AceScreenHelper.app`, so the
  packaged helper's designated requirement must equal `native/screen-helper/identity.txt`. A
  change there would make every Mac ask for Screen Recording again.

## Shared vectors

- **K1 lands the exporter harness and every exporter before any port** (see the PR list), so
  M1, M2 and M4 only consume vectors. The privacy vectors are new, with no TypeScript original, so M8 writes them.
- **Exporters.** Each TypeScript package that owns a ported rule gets
  `scripts/media-vectors.ts`. It runs the pure module over scripted scenarios (a list of inputs
  with times) and writes `native/media/vectors/<area>/*.json` with the outputs. The packages are
  browser (envelope, headers, fanout, link rate, scale, plan, gate, quantizer), secure-channel
  (cipher with rekey, flow credit), relay (fragmenting) and devices (stream control).
- **Drift guard.** `media-vectors.test.ts` in each package checks that the committed JSON still
  equals the TypeScript output, so a change on either side without the other fails a test.
- **Rust.** The Rust tests replay every vector.
- **After deletion.** When a phase's deletion PR removes the TypeScript, its vectors are frozen
  and owned by the Rust tests.
- **Noise transcripts.** The noise vectors come from a TypeScript run of a full relay stream:
  key, nonces, a fragment sequence crossing a rekey (with a test-only `REKEY_INTERVAL` override
  of 16), and credit fragments. The Rust implementation must produce the same ciphertext byte
  for byte.

## Pull requests

Each PR owns the paths listed and nothing else. "Needs" means it merges after those. PRs in the
same wave run in parallel; a wave merges to `main` after its integration check (`bun run check`
on the integrated branch). Every PR runs its own tests plus the checks in the ground rules.

### Wave 0 (now, parallel)

| PR                                  | Owns                                                                                                                                        | Tests                                                                                                                               | Bench and acceptance                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **P0a** Fix H.264 screen recordings | `packages/screen/src/recording.ts`                                                                                                          | a recording fed a delta while a write is in flight decodes end to end (frames in = frames out)                                      | none                                                                                         |
| **P0b** Pieces fit one Noise frame  | `packages/browser/src/stream-envelope.ts`                                                                                                   | a 300 KB chunk crosses a relay channel as exactly ⌈bytes ÷ 65,498⌉ encrypted frames; web and iOS assemblers take the smaller pieces | relay frames per keyframe halved                                                             |
| **I1** iOS HEVC                     | `apps/ios/**` (decoder, AnnexB, bridge codec list)                                                                                          | as in iOS HEVC above                                                                                                                | iOS browser view over the `video-link.ts` page: same picture at ≤ 60 % of the H.264 bit rate |
| **M0** Workspace scaffold (#1950)   | `native/media/{Cargo.toml,deny.toml,README.md}`, empty crates, `scripts/check-media.ts`, the `check:media` script (fmt, clippy, test, deny) | `cargo test` runs                                                                                                                   | none                                                                                         |

### Wave 1 (needs M0; parallel)

K1 is the contract every later PR builds on. It merges first in this wave; M3, M5 and R1 don't
depend on it.

| PR                                   | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Tests                                                                                                                                                                                                                                                                                                          | Bench and acceptance                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **K1** Contracts and vectors         | `media-wire::{control,frame,keys}` (every message in both tables, both lanes, the `MediaFrame` codec, the key block); `packages/media/{package.json,tsconfig.json,src/{wire,frame,key-block}.ts}`; `vectors/{control,frame,key-block}/`; the exporter harness and every exporter (`scripts/media-vectors.ts` in browser, secure-channel, relay and devices) with their drift tests and committed vectors; the media-core module files (`envelope.rs`, `headers.rs`, `fanout.rs`, `link_rate.rs`, `scale.rs`, `plan.rs`, `gate.rs`, `keyframes.rs`, `quantizer.rs`, `device_control.rs`, `screen_profile.rs`, `privacy.rs`), empty, declared in `lib.rs` | every control fixture round-trips in Rust and parses in Zod; a `FromMedia` type without a fixture fails; `MediaFrame` round trip, and rejection of bad magic, lengths over the limits and headers under 44 bytes; key block round trip and CRC; each package's drift test passes against its committed vectors | none                                                                                                                     |
| **M3** fMP4 muxer                    | `media-mp4`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | box layout vectors; a crash mid-fragment leaves a file valid to the last fragment; H.264 and HEVC samples round trip through the reader; a part that starts after a gap starts at a keyframe                                                                                                                   | `bench/mux`: 1080p60 16 Mbit/s ≤ 0.5 % of a core                                                                         |
| **M5** Codec traits and CPU fallback | `media-codec` (traits incl. `JpegCodec`, fakes, the CPU fallback: `zune-jpeg`, the deny-compliant JPEG encoder, `fast_image_resize`, the worker pool, picture buffer pools)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | fake encoder scripts; JPEG decode → scale → encode sizes and quality; the NEON/AVX2 path is taken on CPUs that have it (scalar only when forced); pool jobs never run on the calling thread; zero allocations per frame after warm-up (`bench/alloc`)                                                          | `bench/still --path cpu`: 1206×2622 JPEG → 1568 px ≤ 6 ms on the Mac, ≤ 10 ms on x86 AVX2 (Bun.Image ≈ 10 ms on the Mac) |
| **R1** Packaging                     | `tools/release/src/ace-media.ts`, `tools/release/src/smoke.ts` (the packaged checks), `apps/desktop/scripts/package.ts` (media folder), licences, signing lists, `native/screen-helper/identity.txt`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the staged binary reports the release version and a wrong version is refused; the `ldd` check on Linux; on each target's release build, the packaged launch and signature checks and the screen helper identity check from "Packaging"                                                                         | binary ≤ 8 MB                                                                                                            |

### Wave 2 (needs K1; parallel, disjoint files)

| PR                            | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Bench and acceptance                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **M1** Envelope and headers   | `media-core/src/{envelope,headers}.rs` only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | every envelope and header vector byte-identical                                                                                                                                                                                                                                                                                                                                                                                                                                             | `bench/envelope`: ≥ 10 GB/s piece split, single core, Apple M-series         |
| **M2** Pacing core            | `media-core/src/{fanout,link_rate,scale,plan,gate,keyframes,quantizer,device_control,screen_profile}.rs` only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | every pacing vector replayed with identical decisions                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bench/fanout`: 100 viewers × 60 fps decisions ≤ 1 % of a core               |
| **M8** Privacy barrier core   | `media-core/src/privacy.rs`, `vectors/privacy/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | every ordering in "Recording privacy barrier", as pure scenarios: frames and decisions in both arrival orders, decisions with `seq` gaps and out of order, a delayed priority lane, late acknowledgements making an epoch discarded, held frames and overflow, late keyframes from discarded epochs, read-time stamping within 100 ms of the epoch after a private one, audio, a restart replay; the daemon-side decision rule in `packages/media/src/epochs.ts` against the same scenarios | none                                                                         |
| **M4** Noise transport        | `media-noise`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | TS transcripts reproduced byte for byte, across a rekey; flow-credit vectors; state installed from a key block continues a TS-started stream exactly                                                                                                                                                                                                                                                                                                                                        | `bench/seal`: ChaCha20-Poly1305 ≥ 1.5 GB/s single core (TS today ≈ 240 MB/s) |
| **M6** Supervisor and lanes   | `packages/media/src/{supervisor,lanes}.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | backoff, jitter, crash-loop window, idle shutdown, version mismatch, missed pongs, lane authentication; revocation answered and the kill at 250 ms with a fake child that stops answering; priority messages overtake a saturated normal lane (fake child, injected clock)                                                                                                                                                                                                                  | none                                                                         |
| **K2** Contracts for ADR 0148 | `media-wire::control` (`source.epoch` gains `followsPrivate: boolean`, so ace-media stamping its own reads can apply the 100 ms rule after a private epoch (decided in M8, #1970); `ready.capabilities` as the list of steps with `state`, replacing K1's `{encoders, decoders, stills}` shape; `capabilities.changed`, `source.status.acceleration` with steps, copies and `degraded`, the helper-hello capability fields); `packages/media/src/wire.ts` and `vectors/control/` fixtures; `packages/protocol` (`acceleration` on `BrowserState`, beside `video`, on `ScreenState` and `DeviceState`; `encoders` in `ScreenCapabilities`, see "K2 contract clarifications") and the regenerated protocol docs | every new fixture round-trips in Rust and parses in Zod, including `source.epoch` with `followsPrivate` true and false; protocol schemas accept the new optional fields, and older clients ignore them                                                                                                                                                                                                                                                                                      | none                                                                         |

### Wave 3 (parallel)

| PR                                | Needs          | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Tests                                                                                                                                                                                                                                                                                                                                           | Bench and acceptance                                                                                                   |
| --------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **M7** ace-media core             | M1, M5, M6, M8 | `crates/ace-media` (runtime, normal and priority lanes with lane authentication, ingest socket/pipe, loopback WS ingest with origin and token checks, sources, epochs, health, idle, revocation bookkeeping with `issued`)                                                                                                                                                                                                                                                                                                                                    | one process test: `@ace/media` supervises the real binary; a fake producer streams; kill -9 → restart within backoff, sources replayed, `source.status` starting then playing; the priority lane answered within 50 ms p99 while the normal lane is saturated                                                                                   | idle RSS ≤ 15 MB; ingest 60 fps 33 KB units ≤ 1 % of a core                                                            |
| **B1** VideoToolbox backend       | M5             | `media-vt` (encode, decode with destination size, Metal scale/convert via `CVMetalTextureCache` with `VTPixelTransferSession`/vImage only as CPU fallback, VT JPEG decode and encode, transcode, `CVPixelBufferPool`s); its `probe()` (one bounded availability trial, cancellable)                                                                                                                                                                                                                                                                           | encode H.264/HEVC at 1280×800 and 2560×1600, forced keyframe, rate change in place, decode back to size; transcode (decode → scale → encode) with no CPU copy; JPEG decode and encode report `hardware` exactly when their sessions report hardware use; the probe reports `zeroCopy` truthfully (a test forces a CPU copy and expects `false`) | `bench/encode --backend vt`: 2560×1600 HEVC ≥ 100 fps, 1080p H.264 ≥ 240 fps; Mac numbers in "Acceleration acceptance" |
| **B2** Media Foundation backend   | M5             | `media-mf` (D3D11 video processor, hardware MFTs with D3D11 input, DXVA decode, hardware MJPEG decode/encode MFTs where present, WIC as CPU fallback, texture rings); its `probe()` (one bounded availability trial, cancellable)                                                                                                                                                                                                                                                                                                                             | the same as B1 on a GPU machine; on the Windows VM: the software MFT path and no MFT reported; staging readbacks counted and 0 on the hardware path                                                                                                                                                                                             | VM: 1080p30 software H.264 ≥ 30 fps (labelled fallback); GPU numbers in "Acceleration acceptance"                      |
| **B3** VA-API backend + bitstream | M5             | `media-vaapi` (encode, VPP, DMA-BUF import, VA JPEG decode and encode, surface pools), `media-bitstream`; its `probe()` (one bounded availability trial, cancellable)                                                                                                                                                                                                                                                                                                                                                                                         | SPS/PPS/VPS writer vectors; on an Intel or AMD host: encode → decode round trip from an imported DMA-BUF with no CPU copy; VA JPEG decode/encode where the driver lists them; with `libva` absent: reports no backend, no crash                                                                                                                 | Linux Intel/AMD numbers in "Acceleration acceptance"                                                                   |
| **B4** Last-resort encoder        | M5             | `media-chrome` (Chrome for Testing over its own `--remote-debugging-pipe`, running its own encoder page fed binary pictures over loopback WebSockets; see "B4 notes"), used only when the probe found no hardware encoder at all; its `probe()` (one bounded availability trial, cancellable)                                                                                                                                                                                                                                                                 | JPEG pictures in → H.264 units out; Chrome crash → restarted, encode resumes at a keyframe; never chosen on a machine whose probe lists a hardware encoder; the source reports its encode step with `backend: "chrome"`                                                                                                                         | parity with today's encoder Chrome (60 fps at 1280×800), reported on a VM                                              |
| **B5** NVENC/NVDEC backend        | M5             | `media-nv`: own `#[repr(C)]` bindings for one pinned API version, written from NVIDIA's public docs; run-time loading of the driver's libraries (Linux `libnvidia-encode.so.1`, `libnvcuvid.so.1`, `libcuda.so.1`; Windows `nvEncodeAPI64.dll`, `nvcuvid.dll`, `nvcuda.dll`); NVENC with OpenGL (Linux) and D3D11 (Windows) input; NVDEC (H.264/HEVC only; never its hybrid JPEG) with output scaling; only the P1–P7 presets with tuning info; the developer-only `ACE_NV_HEADERS` layout check; its `probe()` (one bounded availability trial, cancellable) | on an NVIDIA host: encode → decode round trip from a GL texture made from a DMA-BUF, with no CPU copy; NVDEC still at the requested size; a missing or too-old driver → no backend, no crash; `cargo deny` and a repo check that no NVIDIA header or binary is committed                                                                        | Linux NVIDIA numbers in "Acceleration acceptance"; on Windows NVIDIA, the MFT-vs-NVENC result recorded                 |

### Wave 4: phase 1 (parallel)

The daemon tees the frames it already has into ace-media's ingest (the `encode: legacy` routes),
so phase 1 doesn't wait for the producers' move in phase 2.

| PR                | Needs         | Owns                                                                                                                                                                                                                                                                                                                                                                                                                          | Tests                                                                                                                                                                                                                                                                                                        | Bench and acceptance                                                                                                                                           |
| ----------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** Recordings | M3, M7, M8    | the recorder in `ace-media`; daemon wiring in `packages/screen` (`session-recording.ts`), `packages/devices` (`recording-feed.ts`, `video.ts`), `packages/browser` (`session-recording.ts`: video-fed recording, the epoch issue, acknowledgement and decision logic in `packages/media/src/epochs.ts`, the pointer track); epochs on the tee; setting `media.recordings`                                                     | a screen, device and browser recording each play in QuickTime, Chrome and Windows' player; **the reordered control/ingest process test** from "Recording privacy barrier"; kill ace-media mid-recording → parts up to the last fragment kept and the recording continues; a daemon stall → gap, never a leak | 1080p60 recording ≤ 2 % of a core end to end; no ffmpeg on PATH needed                                                                                         |
| **F2** Stills     | M7, B1–B3, B5 | `still.take` in `ace-media`, on the GPU path of "Acceleration" (decode on the GPU, scale with the decoder's output size or the video processor, hardware JPEG encode where offered), with M5's CPU path only as the fallback; daemon wiring in `packages/devices` (`simulator-frames.ts`, `h264-jpeg.ts`, `android-screenrecord.ts`, `one-off-screenshot.ts`), `packages/screen/src/model-capture.ts`; setting `media.stills` | stills from H.264, HEVC and JPEG sources at the requested box; each still reports its path, and on a machine whose probe lists hardware decode and JPEG encode the path is `hardware`; deadline exceeded → the legacy path returns the still; ace-media down → legacy                                        | GPU and CPU still latency per platform in "Acceleration acceptance"; daemon RSS flat over 10 min of stills at 2 fps from three simulators (the 11-02 workload) |

### Wave 5: phase 2

G1 merges first: it makes `encode: auto` a complete route while `delivery` is still legacy. E1–E4
then run in parallel and turn `encode: auto` on only through G1's routes. A1 follows E1–E4,
because it consumes their hellos and the backends' probes.

| PR                                        | Needs                | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Bench and acceptance                                                                                                                                        |
| ----------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1** Egress and routes                  | M7                   | the egress lane in `ace-media`; `packages/media/src/{routes,egress}.ts` (the egress header, dispatch by source handle to the deliverer, the legacy recorder and the legacy still maker); `source.open` handles; pointing producers back at the daemon when ace-media is unavailable                                                                                                                                                                                                                                                                            | `routes.test.ts` (every setting combination × health × capabilities); a process test where a fake producer sends to ace-media, the egress returns the units, and a legacy viewer, the legacy recorder and the legacy still maker all get them; two interleaved sources with equal encode ids reach only their own consumers; unknown and closed handles dropped; a full egress drops to the next keyframe; the egress connection idles and carries again without reopening; ace-media killed → the producer reconfigured to the daemon within 2 s                               | egress adds ≤ 1 ms p95 per unit; daemon CPU for one 16 Mbit/s stream unchanged from today's direct route ± 1 %                                              |
| **E1** Windows helper encodes             | B2, B5, G1, K2       | `native/screen-helper-windows` (the hello's capability fields; WGC texture → D3D11 video processor → MFT, or NVENC where measured better; texture ring)                                                                                                                                                                                                                                                                                                                                                                                                        | its hello reports capture → encode capability (K2 fields), from a trial at helper start; VM: the software MFT stream decodes in the web client's WebCodecs over legacy delivery (through egress); the no-MFT VM falls back to the last-resort encoder and says so; on a GPU machine: 0 staging readbacks per frame; epochs stamped at capture                                                                                                                                                                                                                                   | Windows numbers in "Acceleration acceptance" (today: JPEG + encoder Chrome at 30–60 % per viewer)                                                           |
| **E2** Linux helper encodes               | B3, B5, G1, K2       | `native/screen-helper-linux` (the hello's capability fields; DMA-BUF → VA surface, or → GL texture for NVENC; VPP or GL blit)                                                                                                                                                                                                                                                                                                                                                                                                                                  | its hello reports capture → encode capability (K2 fields); GNOME and Hyprland on Intel, AMD and NVIDIA; DMA-BUF zero-copy paths, plus the shared-memory upload path, reported `zeroCopy: false`; no VA-API and no NVIDIA → the last-resort encoder, said so; through egress to legacy delivery                                                                                                                                                                                                                                                                                  | Linux numbers in "Acceleration acceptance"                                                                                                                  |
| **E3** Mac and device producers to ingest | B1, G1, K2           | `native/screen-helper` (the hello's capability fields, ingest writer, epochs, `420v` at the encode size straight to VT), `packages/devices` (serve-sim, scrcpy and emulator sources opened in ace-media), the Simulator transcode in `media-vt` (VT decode at the target size → VT encode, no CPU copy)                                                                                                                                                                                                                                                        | its hello reports capture → encode capability (K2 fields); the Mac screen, Simulator (passthrough and transcode) and Android stream through ace-media and egress with the same headers as today; the screen path and the transcode report `hardware` and `zeroCopy`; **the screen helper's designated requirement equals `identity.txt`**                                                                                                                                                                                                                                       | Simulator 59 fps passthrough with ace-media ≤ 1 % of a core; Mac screen and transcode numbers in "Acceleration acceptance"                                  |
| **E4** Browser producers to ingest        | B1–B5, G1            | `packages/browser/video-extension/offscreen.ts` (MediaFrame over loopback WS, epochs), `apps/desktop/src/main/browser/video-encoder.ts` + preload, `chrome-video.ts` (start arguments carry the ingest URL, token and epoch), private-context `source.picture` forwarding, the `packages/browser-extension` native host → ingest, JPEG-source encode in ace-media with hardware JPEG decode straight into encoder surfaces; setting `media.encode`                                                                                                             | tab, embedded, private-context and "Use my Chrome" tabs stream through ace-media and egress; ingest refused for a wrong origin or a reused token; JPEG sources report `hardware` exactly where the probe observed a hardware JPEG decoder, and otherwise the C path of the expectations with one upload                                                                                                                                                                                                                                                                         | `video-link.ts` unchanged or better over egress (median 60, p10 ≥ 59); "Use my Chrome" numbers in "Acceleration acceptance", with no encoder Chrome running |
| **A1** Capabilities and fallback state    | K2, M7, B1–B5, E1–E4 | `native/media/crates/ace-media/src/{probe,rank,acceleration}.rs` (bounded trials with deadlines and cancellation, `capabilities.changed`, the ranking benchmark and its cache, per-source steps and `degraded`); `packages/media/src/acceleration.ts` (the daemon's store of capabilities and per-source acceleration); the state field only in `packages/browser/src/live-video.ts` (`status()`), `packages/screen/src/bridge.ts` and `packages/devices/src/bridge.ts`; `apps/daemon/src/doctor/media.ts`, registered in `apps/daemon/src/doctor/features.ts` | each backend faked absent in turn → the expected `cpu` or `chrome` step, and `degraded` only where the rule says (NVIDIA CPU JPEG is not degraded; a hardware-listed step on the CPU is); a fake backend that lists a codec but fails its trial frame → no hardware; a trial that hangs → `timed-out` within 2 s, `ready` within 3 s, and a late success arrives as `capabilities.changed`; the ranking runs only while no source is open, is cancelled when one opens, is cached per adapter, driver and settings, and falls back to the deterministic choice without a result | probe ≤ 3 s at worst, ≤ 500 ms on a warm machine; ranking ≤ 20 s total, once per key                                                                        |

### Wave 6: phase 3

D1 is accepted with a standalone protocol test client
(`packages/media/src/testing/media-test-client.ts`). It speaks `media.connect`, the media
connection, acks and the relay media hello, so D1 and D2 don't wait for C1. The integrated
acceptance with the real web and iOS clients is C1's and C2's, and Q1 runs after them.

| PR                           | Needs          | Owns                                                                                                                                                                                                                                                                                                                                                                                                       | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Bench and acceptance                                                                                                                                                                                                                                                          |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** Delivery in ace-media | M2, E3, E4, A1 | viewers, plans and `source.want` in `ace-media`; the direct listener (loopback, and TLS from `listen`); `media.connect`, `MediaConnections` and `media.ticket` in the daemon; `viewer.*` wiring in `packages/browser` (`live-video.ts` becomes a thin driver), `packages/screen` (`bridge.ts`), `packages/devices` (`bridge.ts`); protocol additions; the standalone test client; setting `media.delivery` | with the test client: a tab, a screen and a device on one media connection; **the direct negative authorization tests** from "Media connection authorization"; revoke closes the connection within 250 ms; ace-media restart → picture back within 2 s p95                                                                                                                                                                                              | new `packages/browser/bench/media-link.ts` beside `video-link.ts`, driven by the test client, in `check:perf`: median ≥ 59 fps, p10 ≥ 55 on the default link; daemon `bytesOut` for video = 0; the local hop adds ≤ 2 ms p95                                                  |
| **D2** Relay media streams   | D1, M4         | `apps/relay` (self-hosted) and `apps/cloud` (Worker): the `media` purpose and tickets, the `media` host feature; `apps/daemon/src/files-relay.ts`: the handshake through ace-media and `relay.keys`; `packages/secure-channel` `exportInto`/`exportState`; relay streams in `ace-media`                                                                                                                    | process test with the real self-hosted relay and the test client: handshake through ace-media, keys handed over with no frame lost or duplicated, a rekey crossed; **the relay negative authorization tests**; the key scans and the zeroed block from "Key hand-over"; revocation within 50 ms p99 under a saturated normal lane and a full egress; a stopped child killed at 250 ms; ace-media kill → the client reconnects and resumes at a keyframe | 10 relay viewers at 16 Mbit/s: ace-media ≤ 5 % of a core in total (≤ 0.5 % per viewer, native AEAD with SIMD, sealing into pooled buffers, 0 allocations per frame), daemon CPU within 1 % of no viewers; `bench/seal` ≥ 1.5 GB/s per core on the Mac, ≥ 1.2 GB/s on x86 AVX2 |
| **C1** Web media connection  | D1, D2         | `apps/web/src/lib/video/*`, the media connection in `packages/client*`, HEVC pictures; the degraded sentence in the web live views (`apps/web/src/features/computer-use/live-view.tsx`, the browser panel's and the device screen's status lines)                                                                                                                                                          | the sentence shows exactly when `degraded` is true; reconnect and resubscribe; acks routed; legacy delivery still works against a daemon with `media.delivery: legacy`                                                                                                                                                                                                                                                                                  | `media-link.ts` rerun with the real web client: the same numbers as D1                                                                                                                                                                                                        |
| **C2** iOS media connection  | D1, D2, I1     | `apps/ios/**`: the media socket in Swift, bridge routing; the degraded sentence in the iOS live views                                                                                                                                                                                                                                                                                                      | the same as C1 (including the sentence) on a simulator over the relay                                                                                                                                                                                                                                                                                                                                                                                   | 60 fps median on the phone-link profile of `video-link.ts`                                                                                                                                                                                                                    |
| **Q1** Route matrix          | C1, C2, F1, F2 | `packages/media/src/routes.process.test.ts`, which joins `test:process`                                                                                                                                                                                                                                                                                                                                    | all 16 setting combinations end to end with ace-media healthy, including `encode` and `delivery` on `auto` with `recordings` and `stills` on `legacy` (fed by egress); the four corner combinations also with ace-media killed mid-stream and with it unavailable; each asserts a viewer gets pictures (web and iOS bridge), a recording decodes with its privacy barrier held, and a still returns                                                     | must pass on the release candidate before any X PR merges                                                                                                                                                                                                                     |

### Wave 7: deletion (one PR per phase, after a release ships with `auto` as the default and needs no fallback, and Q1 passed on that release)

| PR             | Deletes                                                                                                                                                                                                                                                                                   | Acceptance tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **X1** phase 1 | ffmpeg recording and still paths, `Bun.Image` frame transcodes, JPEG-file browser recordings; `legacy` for `media.recordings` and `media.stills` (a stored `legacy` reads as `auto`)                                                                                                      | **Recovery:** ace-media killed mid-recording → the recording continues in a new part. **Unavailable:** with ace-media unavailable, a recording refuses to start with a stated reason, never silently records nothing; agent stills still return through the source's own capture (helper JPEG, `simctl`/`adb` screenshots through the model-image path), which X1 keeps as the stills fallback. **Consumers:** `typecheck` and `check:deps` (a new rule forbidding imports of the removed modules) pass. **Ownership:** the Rust privacy and mp4 vectors stay green, as does the reordered-barrier process test |
| **X2** phase 2 | the CDP base64 chunk path in `chrome-video.ts`, the daemon-run encoder Chrome, `picture-video.ts`, Swift `--transcode`, frame packets from helpers to the daemon, the tee; `legacy` for `media.encode`                                                                                    | **Recovery:** ace-media killed → producers reconnect to the new ingest and the picture returns within 2 s p95. **Unavailable:** with ace-media unavailable, live views show `video.status: retrying` with the reason, never a blank pane without one, and agent tools still work. **Delivery:** egress still serves `media.delivery: legacy` until X3. **Identity:** the screen helper's identity matches `identity.txt`. **Consumers:** `typecheck` and `check:deps` pass. **Ownership:** the route table, without the removed values, stays green                                                             |
| **X3** phase 3 | `video-fanout.ts`, `link-rate.ts`, `video-scale.ts`, `video-policy.ts`, `picture-viewer.ts`, `picture-channel.ts`, the daemon's stream and relay sends of video, the egress lane, clients' legacy delivery; `legacy` for `media.delivery`; the vectors frozen into `native/media/vectors` | **Recovery:** ace-media killed → web and iOS reconnect their media connections and resume at a keyframe. **Unavailable:** live views say why. **Old clients:** a client without a media connection gets a status asking it to update, not a blank view. **Bytes:** `media-link.ts` shows daemon `bytesOut` for video = 0. **Consumers:** `check:deps` forbids daemon packages from encoding video envelopes. **Ownership:** every frozen vector passes in Rust, and the authorization and revocation tests from D1 and D2 stay green                                                                            |

## Benchmarks

- **`native/media/bench/`** has `envelope`, `fanout`, `seal`, `mux`, `still --path {gpu,cpu}`,
  `jpeg --path {gpu,cpu}`, `encode --backend {vt,mf,vaapi,nv,chrome}`, `alloc`, `ingest` and
  `size`.
  - Each prints one JSON line in the format `video-link.ts` uses, and fails below its acceptance
    number unless `ACE_MEDIA_BENCH_REPORT_ONLY=1`.
  - Run them with `bun run bench:media`.
- **`packages/browser/bench/media-link.ts`** runs the whole pipeline (real Chrome, ace-media, a
  simulated link) beside `video-link.ts`. It joins `check:perf` with D1. While the legacy path
  exists, `video-link.ts` keeps running against it.
- **Load.** Benches record load average at start and refuse to enforce above 2 × the core count,
  so a loaded machine reports instead of failing.

### Acceleration acceptance (ADR 0148)

**How it's measured.**

- **CPU** is the process's CPU time over a 30 s run, as % of one core. Screen rows count the
  helper (capture and encode); the other rows count ace-media.
- **Content.** Screen rows use the `video-profile.ts` scrolling page at full screen. "Use my
  Chrome" rows use 1920×1080 JPEG at quality 80 and 60 fps. Stills take the current picture of
  a 1206×2622 HEVC stream to 1568 px.
- **Sampling.** Each run discards a warm-up first: 5 s, or 300 frames, or 20 stills. It then
  measures 30 s, or at least 200 stills. Every measure takes 3 runs: CPU is the median of the
  runs, and latency is the p95 over the pooled samples.
- **Enforcement** follows the path expectations below: per step, the expected path for the
  machine's observed capabilities, and the allowed picture readbacks (GPU → CPU) and uploads
  (CPU → GPU). A bench fails when a step runs below its expected path, or makes more copies
  than allowed, as reported in `source.status.acceleration`. Encoded bitstreams coming back
  from a GPU encoder are not counted as copies.
- **Pinned and target columns.** Only a pinned column is a guarantee: the machine, GPU, driver
  or OS build, and sampling are recorded in the table below. An unpinned column is a target,
  reported as "target, not measured" in a PR until a machine is pinned, never left out.

**Bench machines.**

| Column           | Machine and GPU                                            | OS and driver                                                              | Status                                     |
| ---------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ |
| Mac              | owner's MacBook Pro, Apple M4 Max                          | macOS 27.0; the bench records the build                                    | pinned                                     |
| Windows test VM  | the test VM (no GPU: Microsoft's software MFT)             | Windows 11; the first run records edition and build, which becomes the pin | pinned at first run, fallback numbers only |
| Windows with GPU | to be named, one per vendor (Intel, NVIDIA, AMD, Qualcomm) | the driver version is recorded                                             | target                                     |
| Linux Intel      | to be named (an Intel GPU on iHD)                          | distribution, kernel, Mesa and `intel-media-driver` versions               | target                                     |
| Linux AMD        | to be named (radeonsi)                                     | distribution, kernel and Mesa versions                                     | target                                     |
| Linux NVIDIA     | to be named                                                | distribution, kernel and NVIDIA driver (≥ 590, for the P1–P7 presets)      | target                                     |

**Path expectations.** For each column and path: the steps that must be on hardware (H) or the
CPU (C), then the allowed readbacks / uploads per frame (or per still). "Observed" means the
probe's trial session reported hardware for that step on that machine; where it didn't, the
step's C form applies, and so do its copy counts.

| Path                                         | Mac                                                           | Windows with GPU                                            | Windows VM                      | Linux Intel                                                      | Linux AMD                                          | Linux NVIDIA                                    |
| -------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Screen: capture → scale/convert → encode     | H → H → H; 0 / 0                                              | H → H → H; 0 / 0                                            | H → C → C (software MFT); 1 / 0 | H → H → H; 0 / 0 (DMA-BUF); shared-memory capture 0 / 1          | as Intel                                           | H → H (GL blit) → H; 0 / 0; shared memory 0 / 1 |
| "Use my Chrome": JPEG decode → encode        | observed: H → H, 0 / 0; else C → H, 0 / 1                     | hardware MJPEG MFT: H → H, 0 / 0; else WIC C → H, 0 / 1     | C → C; 0 / 0                    | observed VA JPEG: H → H, 0 / 0; else C → H, 0 / 1                | as Intel                                           | C → H; 0 / 1 (no NVIDIA JPEG decode is used)    |
| Simulator transcode: decode → scale → encode | H → H → H; 0 / 0                                              | —                                                           | —                               | —                                                                | —                                                  | —                                               |
| Still: decode → scale → JPEG                 | observed JPEG encode: H → H → H, 0 / 0; else H → H → C, 1 / 0 | hardware MJPEG MFT: H → H → H, 0 / 0; else H → H → C, 1 / 0 | C → C → C; 0 / 0                | observed VA JPEG encode: H → H → H, 0 / 0; else H → H → C, 1 / 0 | H → H → C; 1 / 0 unless VA JPEG encode is observed | H (NVDEC) → H (NVDEC output size) → C; 1 / 0    |
| Delivery and relay AEAD                      | C (SIMD); 0 / 0                                               | C (SIMD); 0 / 0                                             | C; 0 / 0                        | C (SIMD); 0 / 0                                                  | C (SIMD); 0 / 0                                    | C (SIMD); 0 / 0                                 |

| Measure                                                   | Mac (owner's M4 Max)                                  | Windows with GPU (Intel, NVIDIA, AMD, Qualcomm when available) | Windows test VM (no GPU: fallback, reported) | Linux Intel iHD          | Linux AMD radeonsi              | Linux NVIDIA                       |
| --------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------- | ------------------------ | ------------------------------- | ---------------------------------- |
| 1080p60 screen encode, CPU per stream                     | ≤ 3 %                                                 | ≤ 5 %                                                          | software MFT 1080p30 ≥ 30 fps                | ≤ 5 %                    | ≤ 5 %                           | ≤ 5 %                              |
| 4K30 HEVC screen encode, CPU per stream                   | ≤ 4 %                                                 | ≤ 6 %                                                          | —                                            | ≤ 6 %                    | ≤ 6 %                           | ≤ 6 %                              |
| CPU copies of a picture on the hardware path              | 0                                                     | 0 (no staging readback)                                        | —                                            | 0 (DMA-BUF)              | 0 (DMA-BUF)                     | 0 (DMA-BUF → GL)                   |
| "Use my Chrome" JPEG → video, CPU                         | ≤ 6 % with observed hardware JPEG decode, else ≤ 25 % | ≤ 8 % with a hardware MJPEG MFT, else ≤ 25 % (WIC)             | reported                                     | ≤ 8 % (VA JPEG)          | ≤ 8 % with VA JPEG, else ≤ 25 % | ≤ 25 % (CPU decode, one GL upload) |
| Simulator transcode 1206×2622 → 1280 px tall, 60 fps, CPU | ≤ 3 %                                                 | —                                                              | —                                            | —                        | —                               | —                                  |
| Still p95, hardware path (per the expectations above)     | ≤ 8 ms                                                | ≤ 12 ms                                                        | —                                            | ≤ 10 ms (VA JPEG encode) | ≤ 15 ms (CPU JPEG)              | ≤ 15 ms (NVDEC, CPU JPEG)          |
| Still p95, CPU path                                       | ≤ 20 ms                                               | ≤ 30 ms                                                        | ≤ 40 ms                                      | ≤ 30 ms                  | ≤ 30 ms                         | ≤ 30 ms                            |
| Relay AEAD, one core                                      | ≥ 1.5 GB/s                                            | ≥ 1.2 GB/s                                                     | reported                                     | ≥ 1.2 GB/s               | ≥ 1.2 GB/s                      | ≥ 1.2 GB/s                         |
| Delivery per 16 Mbit/s relay viewer, CPU (with AEAD)      | ≤ 0.3 %                                               | ≤ 0.5 %                                                        | reported                                     | ≤ 0.5 %                  | ≤ 0.5 %                         | ≤ 0.5 %                            |
| Delivery per local viewer, CPU                            | ≤ 0.1 %                                               | ≤ 0.2 %                                                        | reported                                     | ≤ 0.2 %                  | ≤ 0.2 %                         | ≤ 0.2 %                            |
| Heap allocations per frame, steady state                  | 0                                                     | 0                                                              | 0                                            | 0                        | 0                               | 0                                  |

For scale, today's measurements (ADR 0147's Context): the Linux and Windows screens cost
30–60 % of a core per viewer, and the daemon's `Bun.Image` takes about 10 ms per still.

## K1 contract clarifications

- `source.open`'s `token` column denotes its binary payload, not a JSON field. The JSON has
  no token. Control messages and nested contract objects reject unknown fields and tags on
  both sides, as specified by the Rust control contract; opaque `record.meta.data` and
  `log.fields` retain arbitrary JSON, including unknown fields. This differs from lenient
  provider event decoding: these are version-matched internal contracts, not provider events.
- `EncodeSpec` is `{id, codec, width, height, fps, bitrate, quantizer?}`; ids and dimensions
  are unsigned 32-bit integers, codec is a string. Decoder capability entries use the same
  `{codec, hardware, backend}` shape as encoders. `record.done.parts` entries have the
  `{path, index, bytes, durationMs, gaps}` fields of `record.part` without `recording`.
  `stills` is a boolean, `log.level` is `debug | info | warn | error`, and `gaps` is a count.
- JSON counters and issue sequences are nonnegative safe integers (at most 2^53−1); epochs,
  handles, encode ids, dimensions and lengths are u32. Key-block counters remain full u64.
  Epoch ranges are inclusive ordered pairs. Empty identifiers are allowed; the maximum is
  64 Unicode scalar values. Reasons, backend, platform and codec strings remain open strings.
- MediaFrame codec 0 is the absent codec for hello/end frames; other codec values are 1 to 9.
  Rotation is 0 to 3. Hello payloads have exactly 32 bytes. Bytes between the codec description
  and H are opaque extensions and survive re-encoding, as do unknown flag bits. Unknown
  versions and kinds are rejected. One decode consumes exactly one frame, rejecting trailing bytes.
- K1 tests and package-local exporter scripts are included in its path ownership. The
  daemon-internal `@ace/media` package manifest exports only the K1 wire, frame and key-block
  modules and provides the standard workspace typecheck configuration, so incremental and full
  workspace checks both include these contracts. No platform implementation is introduced.
  The exporter harness lives alongside the browser exporter.
- K1 necessarily updates `media-wire/Cargo.toml` and the workspace `Cargo.lock` for serde,
  serde_json and zeroize. They are part of its codec ownership. The relay exporter uses the
  production channel fragmenter with a test-only cipher subclass scheduling rekeys at 16,
  rather than changing the production channel's interval or public API. These are synthetic
  keys only. Protocol vectors are generated once; exporters regenerate only legacy-rule vectors.
- Optional control fields use absence for none; explicit JSON null is rejected on both sides,
  including nested optionals. Shared control-boundary fixtures cover absent, present and null
  for every optional field. Identifiers must be well-formed Unicode and contain at most 64
  scalar values. Rust constrained values have private storage and checked constructors, so
  constructing a value cannot bypass the same validation its deserializer applies.

## K2 contract clarifications

- `source.epoch.followsPrivate` is a required boolean: true when the epoch before this one was
  private. ace-media uses it only for the sources it reads itself, to keep reads within 100 ms of
  applying the epoch on the private one.
- A capability entry (`ready.capabilities`, `capabilities.changed`) is `{step, codec?, backend,
hardware, zeroCopy, state, maxWidth, maxHeight}`. `step` is one of `encode`, `decode`,
  `jpeg-decode`, `jpeg-encode`, `scale`; `backend` one of `vt`, `mf`, `vaapi`, `nv`, `chrome`
  (the last-resort encoder), `cpu`; `state` one of `ok`, `timed-out`, `failed`. On the control
  lanes these are closed sets, rejected when unknown, like every K1 contract. `codec` is the
  WebCodecs codec string, absent for `scale`. `maxWidth` and `maxHeight` are u32 and 0 when the
  trial didn't succeed. A step running on the last-resort encoder is `encode` with
  `backend: "chrome"`; there is no separate `path` field.
- `capabilities.changed` carries the whole list, which replaces the one from `ready`. It is
  sent only after `ready`; one before it is a protocol error. The supervisor's `capabilities()`
  and snapshot report the latest list, and the message still reaches the daemon's handler.
- `source.status.acceleration` is optional: absent until the source has chosen its steps.
  It is `{steps: [{step, backend, hardware, readbacks, uploads}], degraded, reason?}`, with
  `readbacks` and `uploads` as u32 counts and `reason` an open string. Explicit null is rejected
  for `acceleration`, `acceleration.reason` and a capability's `codec`, as for every K1 optional.
- Client-facing copies live in `packages/protocol/src/media-acceleration.ts`: `MediaAcceleration`
  (the same shape) on `BrowserState.acceleration`, `ScreenState.acceleration` and
  `DeviceState.acceleration`, and `MediaCapability` (the capability entry) as
  `ScreenCapabilities.encoders`, the helpers' capture → encode report in their hello. Unlike the
  control lanes these keep step, backend and state as open strings, so a newer daemon's names
  never fail an older client. On the browser it sits beside `video`, not inside it:
  `BrowserState.video` exists only while the live video retries, and making it present while
  playing would fail older clients, whose schema requires `status: "retrying"`.

## B4 notes

- **Its own page, not the video extension.** `media-chrome` serves `assets/encoder.html` at
  `http://127.0.0.1:<port>/<token>/` and the page opens two WebSockets back to it: pictures in,
  chunks out, both binary, so nothing is base64 in JSON. The token is random per browser and
  reaches Chrome only over the debugging pipe (`Target.createTarget`); the sockets take only the
  page's origin, and the listener closes once both are open. The extension's `openPictures` stays
  with the daemon's encoder Chrome until X2 removes it.
- **Pictures.** JPEG as it is (`jpeg_picture`, decoded by Chrome's `ImageDecoder`), or CPU
  RGBA, BGRA, NV12 and RGB (widened to RGBX). Output is AVCC with the avcC description on
  keyframes, Constrained Baseline at the lowest level that holds the size and rate. The page asks
  for `prefer-software`, so `hardware: false` is true of what runs.
- **Fixed command line.** Callers pass the executable and the profile root, never switches: the
  sandbox, web security, the debugging transport and the profile can't be changed from outside.
- **Lifetime.** A guard owns Chrome and its profile from the moment it exists, on every path.
  Chrome runs in its own process group (Unix) or a kill-on-close job (Windows), and cleanup ends
  the whole tree. If ace-media dies, Chrome exits because its debugging pipe closes (checked on
  macOS and Windows); Linux also sets `PR_SET_PDEATHSIG`, from a reaper thread that lives as
  long as Chrome. Abandoned profiles (`chrome-encoder-*`, this user's, a minute old, owner and
  `SingletonLock` holder gone) are reclaimed at start.
- **Bounds.** The page's request head is read under an absolute deadline (one second per
  client), and the token is compared in constant time. Unread replies from the pipe (16), page
  events (256) and chunk bytes (64 MiB) are bounded; past a bound the session ends with the
  reason, like a protocol error.
- **Supervision.** At most three pictures in flight, then `Backpressure`. A browser that exits
  or crashes is replaced on the next picture, configured the same way, and that picture is a
  keyframe. Deaths and failed launches both count, and a failed launch is retried after a
  doubling backoff (pictures get `Backpressure` meanwhile). After three in a row with no chunk
  the encoder gives up for good. `poll_result` reports a browser death or a page encoder failure
  once, after the units already out.
- **Selection.** `last_resort_needed` is true only when no other backend's encode trial is
  hardware and `ok`. The trial (`probe`) runs on its own thread and returns `timed-out` at its
  deadline; the abandoned thread closes its browser.
- **Windows.** Chrome takes the pipe from C runtime descriptors 3 and 4, handed over through
  `STARTUPINFO.lpReserved2`, with a `STARTUPINFOEX` handle list so only those handles and `NUL`
  are inherited. Chrome and Edge are found where the daemon looks (Program Files, LocalAppData,
  `PATH`).
- **Measured** on the M-series Mac (shared, load average 16–38 during the runs), Chrome for
  Testing 153, `cargo run --release -p media-chrome --example encode`, 10 s after 2 s warm-up:

  | Input                         | fps out | CPU, Chrome's processes | CPU, ace-media side | Latency p50 / p95 |
  | ----------------------------- | ------- | ----------------------- | ------------------- | ----------------- |
  | 1920×1080 JPEG q80 @ 30, 6 Mb | 30.1    | 79 % of a core          | 0.9 %               | 11 / 19 ms        |
  | 1920×1080 RGBA @ 30, 6 Mb     | 28.1    | 79 % of a core          | 5.7 %               | 12 / 129 ms       |
  | 1280×800 JPEG q80 @ 60, 8 Mb  | 60.1    | 77 % of a core          | 1.0 %               | 6 / 11 ms         |

  Cold start to a configured encoder is 0.4–0.7 s and the probe trial 0.65 s here.

  On the Windows 11 ARM64 VM (VMware, 8 vCPU, Edge, native build): 1920×1080 JPEG q80 @ 30
  gave 30.1 fps out, p50/p95 13/21 ms; 1280×800 JPEG q80 @ 60 gave 60.1 fps, 7/11 ms. The bench
  doesn't measure CPU on Windows. Cold start there is 1.3–1.5 s and the probe trial 1.7 s, close
  to the probe's 2 s deadline, so a slower VM's first trial may time out; a late success then
  arrives as `capabilities.changed`. An x64 Windows VM and a Linux VM are still unmeasured.
