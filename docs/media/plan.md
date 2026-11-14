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
- **Tests and checks.** Builders run only the tests their own PR touches, plus
  `cargo test --workspace` in `native/media`. They never run the full Vitest suite or
  `bun run check`.
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
- crypto: `chacha20poly1305` (RustCrypto);
- images: `zune-jpeg` (decode), `jpeg-encoder` (encode, already used by the Linux helper),
  `png`, `fast_image_resize`;
- platform bindings: `objc2` with `objc2-video-toolbox` and `objc2-core-media` (macOS), `windows`
  (Windows), `libloading` (Linux, for `libva`).
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
  for a key.

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
pub enum Picture { Cpu(CpuPicture), Platform(PlatformPicture) } // PlatformPicture: CVPixelBuffer, ID3D11Texture2D or VASurface
```

- **Fakes.** `FakeEncoder` emits deterministic units sized from a script, with keyframes on
  demand. `FakeDecoder` reports the size. Pacing and process tests use them.
- **Stills** are always CPU: decode or take the source's JPEG, scale with `fast_image_resize`,
  encode with `jpeg-encoder`.

## Control protocol (daemon ↔ ace-media)

### Transport

- **Channel.** The child's stdin carries daemon → ace-media; stdout carries ace-media → daemon.
  stderr is log text, which the daemon rate-limits into its log.
- **Frames.** `u32 BE frame length` (the bytes after this field, at most 8 MiB), then
  `u32 BE JSON length`, the JSON message in UTF-8, then an optional binary payload (the rest of
  the frame).
- **Exit.** ace-media exits within 1 s of stdin closing.

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
- **Identifiers.** Ids (`source`, `viewer`, `connection`, `stream`, `recording`, `request`)
  are opaque strings of up to 64 characters that the daemon mints. Byte strings in JSON are
  base64. Nonces are decimal strings, because they are 64-bit.

### Daemon → ace-media (`ToMedia`)

| Message            | Fields                                                                                                                                                                                                                                                                                                                                        | Payload                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `init`             | `protocol: 1, version, runtimeDir, dataDir, settings: {recordings, stills, encode, delivery}`                                                                                                                                                                                                                                                 | —                                                            |
| `ping`             | `id`                                                                                                                                                                                                                                                                                                                                          | —                                                            |
| `shutdown`         | `graceMs`                                                                                                                                                                                                                                                                                                                                     | —                                                            |
| `listen`           | `loopback: true, remote?: {addresses[], port, certificates: string[] (PEM), key: string (PEM)}`                                                                                                                                                                                                                                               | —                                                            |
| `source.open`      | `source, token, threadId?, tabId?, sessionId?, deviceId?, origin`, where `origin` is one of `{kind:"tab"}`, `{kind:"tab-pictures"}`, `{kind:"user-tab"}`, `{kind:"embedded"}`, `{kind:"screen", platform}`, `{kind:"simulator", streamUrl, stillUrl}`, `{kind:"scrcpy", host, port}`, `{kind:"emulator-frames", path, width, height, stride}` | —                                                            |
| `source.page`      | `source, width, height, scale` (the page's CSS size; the screen's points)                                                                                                                                                                                                                                                                     | —                                                            |
| `source.codecs`    | `source, codecs[]` (what the producer's encoder supports, from its probe)                                                                                                                                                                                                                                                                     | —                                                            |
| `source.picture`   | `source, ageMs` (private-context screencast frame, ADR 0147 §2.2)                                                                                                                                                                                                                                                                             | the base64 JPEG text as received                             |
| `source.close`     | `source`                                                                                                                                                                                                                                                                                                                                      | —                                                            |
| `media.ticket`     | `ticket, connection, device, expiresAt` (single use, 30 s)                                                                                                                                                                                                                                                                                    | —                                                            |
| `viewer.open`      | `viewer, connection, source, codecs[], viewport: {width, height, dpr, scale}, local, audio`                                                                                                                                                                                                                                                   | —                                                            |
| `viewer.configure` | `viewer, viewport, audio`                                                                                                                                                                                                                                                                                                                     | —                                                            |
| `viewer.close`     | `viewer`                                                                                                                                                                                                                                                                                                                                      | —                                                            |
| `relay.dial`       | `stream, url` (the `/join` address with the `media` ticket)                                                                                                                                                                                                                                                                                   | —                                                            |
| `relay.out`        | `stream`                                                                                                                                                                                                                                                                                                                                      | one handshake or welcome frame, already sealed by the daemon |
| `relay.pull`       | `stream` (deliver the next inbound frame to the daemon)                                                                                                                                                                                                                                                                                       | —                                                            |
| `relay.keys`       | `stream, connection, device, send: {key, nonce}, receive: {key, nonce}, sent, received, flow: {counting, spent, unconsumed, peerCounting}`                                                                                                                                                                                                    | —                                                            |
| `relay.close`      | `stream, reason`                                                                                                                                                                                                                                                                                                                              | —                                                            |
| `revoke`           | `device` (closes every connection, stream and viewer of the device)                                                                                                                                                                                                                                                                           | —                                                            |
| `record.start`     | `recording, source, directory, maxBytes, pointerTrack`                                                                                                                                                                                                                                                                                        | —                                                            |
| `record.cut`       | `recording, reason: "private" \| "size"`                                                                                                                                                                                                                                                                                                      | —                                                            |
| `record.meta`      | `recording, ageMs, data` (pointer or lease change)                                                                                                                                                                                                                                                                                            | —                                                            |
| `record.stop`      | `recording`                                                                                                                                                                                                                                                                                                                                   | —                                                            |
| `still.take`       | `request, source, maxWidth, maxHeight, maxPixels, quality, deadlineMs`                                                                                                                                                                                                                                                                        | —                                                            |

### ace-media → daemon (`FromMedia`)

| Message                         | Fields                                                                                                                                                                          | Payload           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `ready`                         | `protocol, version, pid, capabilities: {encoders: [{codec, hardware, backend}], decoders: [...], stills}, ingest: {socket, websocketPort}, listen: {loopbackPort, remotePort?}` | —                 |
| `pong`                          | `id, stats: {sources, viewers, connections, cpuMs, rssBytes, bytesOut}`                                                                                                         | —                 |
| `source.status`                 | `source, status: "starting" \| "playing" \| "retrying" \| "ended", reason?, attempts?`                                                                                          | —                 |
| `source.want`                   | `source, encodes: EncodeSpec[]` (the daemon applies it: `aceVideo.encodes`, `ace.video.encodes`, the helper's `stream.configure`, scrcpy's options)                             | —                 |
| `source.keyframe`               | `source, encode`                                                                                                                                                                | —                 |
| `source.audio`                  | `source, on`                                                                                                                                                                    | —                 |
| `viewer.playing`                | `viewer, playing`                                                                                                                                                               | —                 |
| `viewer.stats`                  | `viewer, rate, fps, dropped, rttMs` (1 Hz)                                                                                                                                      | —                 |
| `connection.open`               | `connection, kind: "direct" \| "relay", device`                                                                                                                                 | —                 |
| `connection.closed`             | `connection, reason`                                                                                                                                                            | —                 |
| `relay.dialed` / `relay.failed` | `stream` / `stream, reason`                                                                                                                                                     | —                 |
| `relay.in`                      | `stream` (answers one `relay.pull`)                                                                                                                                             | one inbound frame |
| `record.part`                   | `recording, path, index, bytes, durationMs`                                                                                                                                     | —                 |
| `record.done` / `record.failed` | `recording, parts[]` / `recording, reason`                                                                                                                                      | —                 |
| `still.done`                    | `request, width, height`                                                                                                                                                        | the JPEG          |
| `still.failed`                  | `request, reason`                                                                                                                                                               | —                 |
| `log`                           | `level, message, fields` (never keys, tokens or picture bytes)                                                                                                                  | —                 |

### Ingest framing (`MediaFrame` v1)

Producers send media frames on the ingest socket or pipe, or one per binary message on the
loopback WebSocket (`ws://127.0.0.1:<websocketPort>/ingest`). The WebSocket accepts only the
`Origin`s `chrome-extension://<video extension id>` and `app://video-encoder`. Big-endian:

```
0   u32  magic "ACEM"
4   u8   version (1)
5   u8   kind: 1 video unit, 2 audio packet, 3 still picture, 4 end of source, 5 hello
6   u16  header length H (from offset 0 to the payload; at most 4096)
8   u32  payload length (at most 8 MiB)
12  u32  flags: bit 0 keyframe, bit 1 unchanged picture, bit 2 description present
16  u32  age in µs since capture (ace-media stamps now − age; no clock sharing)
20  u16  coded width        22  u16  coded height
24  u16  display width      26  u16  display height (CSS pixels or points)
28  u16  scale × 1000       30  u8   rotation (quarter turns)
31  u8   codec: 1 H.264 Annex B, 2 H.264 AVCC, 3 HEVC Annex B, 4 HEVC HVCC, 5 VP8, 6 VP9, 7 JPEG, 8 PNG, 9 Opus
32  u32  encode id (the producer's own; 0 for a producer with one encode)
36  u16  codec string length C (WebCodecs codec string, ASCII)
38  u16  description length D (avcC, hvcC, or for Opus: u32 sample rate, u8 channels)
40  C    codec string
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
  - sources reopen, with `source.status: retrying` until their first unit;
  - recordings continue in a new part;
  - pending stills fail and fall back to their legacy path.
- **Rule.** The supervisor never blocks agent tools: every call that needs ace-media has a
  deadline and a fallback.

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

1. **Loading.** `libloading` opens `libva.so.2` and `libva-drm.so.2` at run time. There is no
   link dependency. With either missing, the helper reports no encoder.
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
6. **NVIDIA.** It has no VA-API encode, so the last-resort encoder applies. NVENC is a later,
   separate decision.
7. **Rate.** The 10 fps default becomes 60 fps while watched as video. Nothing is encoded while
   nobody watches, as today.
8. **Frames** go to ace-media's ingest socket as `MediaFrame`s. JPEG stills stay.
9. **Test matrix.** Ubuntu, Fedora and Debian on GNOME Wayland, and Omarchy on Hyprland. Intel
   (iHD) and AMD (radeonsi) for hardware; a VM for the fallback.

### macOS (`native/screen-helper`, Swift)

- **Capture and encode stay.** ScreenCaptureKit, VideoToolbox and the helper's signature, which
  carries the Screen Recording permission, are unchanged.
- **Frames.**
  - `stream.configure` gains `ingest: {socket, token}`.
  - The helper opens that socket, sends the hello, and writes `MediaFrame`s (H.264 Annex B,
    with HEVC later) instead of frame packets on the daemon socket.
  - JPEG stills for agents keep the existing path.
- **`--encode-frames`** (emulator) writes to the ingest socket too.
- **`--transcode`** is deleted after its replacement in `media-vt` ships (phase 2 deletion).

## Clients

- **Protocol additions** (`packages/protocol`):
  - `media.connect` → `{url, ticket, expiresAt}`;
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
    show only libc, libm, libdl and libpthread (no `libva`).
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

## Shared vectors

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
same wave run in parallel.

### Wave 0 (now, parallel)

| PR                                  | Owns                                                                                                                                        | Tests                                                                                                                               | Bench and acceptance                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **P0a** Fix H.264 screen recordings | `packages/screen/src/recording.ts`                                                                                                          | a recording fed a delta while a write is in flight decodes end to end (frames in = frames out)                                      | none                                                                                         |
| **P0b** Pieces fit one Noise frame  | `packages/browser/src/stream-envelope.ts`                                                                                                   | a 300 KB chunk crosses a relay channel as exactly ⌈bytes ÷ 65,498⌉ encrypted frames; web and iOS assemblers take the smaller pieces | relay frames per keyframe halved                                                             |
| **I1** iOS HEVC                     | `apps/ios/**` (decoder, AnnexB, bridge codec list)                                                                                          | as in iOS HEVC above                                                                                                                | iOS browser view over the `video-link.ts` page: same picture at ≤ 60 % of the H.264 bit rate |
| **M0** Workspace scaffold           | `native/media/{Cargo.toml,deny.toml,README.md}`, empty crates, `scripts/check-media.ts`, the `check:media` script (fmt, clippy, test, deny) | `cargo test` runs                                                                                                                   | none                                                                                         |

### Wave 1 (needs M0; parallel)

| PR                                   | Owns                                                                                                                                  | Tests                                                                                                                                                    | Bench and acceptance                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **M1** Envelope, headers, MediaFrame | `media-core::{envelope,headers}`, `media-wire::frame`, `packages/media/src/frame.ts`, browser vectors exporter (envelope, headers)    | every envelope and header vector byte-identical; MediaFrame round trip; malformed frames rejected                                                        | `bench/envelope`: ≥ 10 GB/s piece split, single core, Apple M-series         |
| **M2** Pacing core                   | `media-core::{fanout,link_rate,scale,plan,gate,keyframes,quantizer,device_control,screen_profile}` + exporters in browser and devices | every pacing vector replayed with identical decisions                                                                                                    | `bench/fanout`: 100 viewers × 60 fps decisions ≤ 1 % of a core               |
| **M3** fMP4 muxer                    | `media-mp4`                                                                                                                           | box layout vectors; a crash mid-fragment leaves a file valid to the last fragment; H.264 and HEVC samples round trip through the reader                  | `bench/mux`: 1080p60 16 Mbit/s ≤ 0.5 % of a core                             |
| **M4** Noise transport               | `media-noise` + exporters in secure-channel and relay                                                                                 | TS transcripts reproduced byte for byte, across a rekey; flow-credit vectors                                                                             | `bench/seal`: ChaCha20-Poly1305 ≥ 1.5 GB/s single core (TS today ≈ 240 MB/s) |
| **M5** Codec traits                  | `media-codec` (traits, fakes, JPEG, scale)                                                                                            | fake encoder scripts; JPEG decode → scale → encode sizes and quality                                                                                     | `bench/still`: 1206×2622 JPEG → 1568 px ≤ 6 ms (Bun.Image ≈ 10 ms)           |
| **M6** Control protocol              | `media-wire::control`, `packages/media/src/{wire,supervisor}.ts`, `vectors/control/`                                                  | fixtures parse on both sides; supervisor: backoff, jitter, crash-loop window, idle shutdown, version mismatch, missed pongs (fake child, injected clock) | none                                                                         |
| **R1** Packaging                     | `tools/release/src/ace-media.ts`, `apps/desktop/scripts/package.ts` (media folder), licences, signing lists                           | staged binary reports the release version; a wrong version is refused; `ldd` check on Linux                                                              | binary ≤ 8 MB                                                                |

### Wave 2 (parallel)

| PR                                | Needs      | Owns                                                                                                                                    | Tests                                                                                                                                                                         | Bench and acceptance                                                                    |
| --------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **M7** ace-media core             | M1, M5, M6 | `crates/ace-media` (runtime, stdio control, ingest socket/pipe, loopback WS ingest with origin and token checks, sources, health, idle) | one process test: `@ace/media` supervises the real binary; a fake producer streams; kill -9 → restart within backoff, sources replayed, `source.status` retrying then playing | idle RSS ≤ 15 MB; ingest 60 fps 33 KB units ≤ 1 % of a core                             |
| **B1** VideoToolbox backend       | M5         | `media-vt`                                                                                                                              | encode H.264/HEVC at 1280×800 and 2560×1600, forced keyframe, rate change in place, decode back to size; transcode (decode → scale → encode)                                  | `bench/encode --backend vt`: 2560×1600 HEVC ≥ 100 fps, 1080p H.264 ≥ 240 fps (M-series) |
| **B2** Media Foundation backend   | M5         | `media-mf`                                                                                                                              | the same on the Windows VM (software MFT) and with no MFT reported                                                                                                            | VM: 1080p30 software H.264 ≥ 30 fps; hardware numbers recorded per GPU                  |
| **B3** VA-API backend + bitstream | M5         | `media-vaapi`, `media-bitstream`                                                                                                        | SPS/PPS/VPS writer vectors; on an Intel or AMD host: encode → decode round trip; with `libva` absent: reports no encoder, no crash                                            | 1080p60 H.264 ≥ 60 fps at ≤ 10 % of a core on Intel iHD                                 |
| **B4** Last-resort encoder        | M5         | `media-chrome` (Chrome for Testing over its own `--remote-debugging-pipe`, the video extension's `openPictures`)                        | JPEG pictures in → H.264 units out; Chrome crash → restarted, encode resumes at a keyframe                                                                                    | parity with today's encoder Chrome (60 fps at 1280×800)                                 |

### Wave 3: phase 1 (parallel)

The daemon tees the frames it already has into ace-media's ingest, so phase 1 doesn't wait for
the producers' move in phase 2.

| PR                | Needs     | Owns                                                                                                                                                                                                                                                                         | Tests                                                                                                                                                                                                                                                            | Bench and acceptance                                                                                                   |
| ----------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **F1** Recordings | M3, M7    | recorder in `ace-media`; daemon wiring in `packages/screen` (`session-recording.ts`), `packages/devices` (`recording-feed.ts`, `video.ts`), `packages/browser` (`session-recording.ts`, video-fed recording with privacy cuts and pointer track), setting `media.recordings` | a screen, device and browser recording each play in QuickTime, Chrome and Windows' player; a private transition makes a cut with no frame from before it after it; kill ace-media mid-recording → parts up to the last fragment kept and the recording continues | 1080p60 recording ≤ 2 % of a core end to end; no ffmpeg on PATH needed                                                 |
| **F2** Stills     | M7, B1–B3 | `still.take` in `ace-media`; daemon wiring in `packages/devices` (`simulator-frames.ts`, `h264-jpeg.ts`, `android-screenrecord.ts`, `one-off-screenshot.ts`), `packages/screen/src/model-capture.ts`, setting `media.stills`                                                 | stills from H.264, HEVC and JPEG sources at the requested box; deadline exceeded → legacy path returns the still; ace-media down → legacy                                                                                                                        | Simulator still p95 ≤ 15 ms; daemon RSS flat over 10 min of stills at 2 fps from three simulators (the 11-02 workload) |

### Wave 4: phase 2 (parallel)

| PR                                        | Needs      | Owns                                                                                                                                                                                                                                                                                                                                                          | Tests                                                                                                                               | Bench and acceptance                                                                                                                  |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **E1** Windows helper encodes             | B2, M1, M7 | `native/screen-helper-windows`                                                                                                                                                                                                                                                                                                                                | VM: software MFT stream decodes in the web client's WebCodecs; no-MFT VM falls back to the last-resort encoder                      | 1080p60: ≥ 58 fps, helper ≤ 10 % of a core, no per-viewer encode (today: JPEG + encoder Chrome at 30–60 % per viewer)                 |
| **E2** Linux helper encodes               | B3, M1, M7 | `native/screen-helper-linux`                                                                                                                                                                                                                                                                                                                                  | GNOME and Hyprland on Intel or AMD; DMA-BUF and shared-memory paths; no VA-API → fallback                                           | 1080p60: ≥ 58 fps, helper ≤ 10 % of a core                                                                                            |
| **E3** Mac and device producers to ingest | B1, M7     | `native/screen-helper` (ingest writer), `packages/devices` (serve-sim, scrcpy and emulator sources opened in ace-media), Simulator transcode in `media-vt`                                                                                                                                                                                                    | Mac screen, Simulator (passthrough and transcode) and Android stream through ace-media with the same headers as today               | Simulator 59 fps passthrough, ace-media ≤ 1 % of a core, daemon 0 video bytes                                                         |
| **E4** Browser producers to ingest        | B1–B4, M7  | `packages/browser/video-extension/offscreen.ts` (MediaFrame over loopback WS), `apps/desktop/src/main/browser/video-encoder.ts` + preload, `chrome-video.ts` (start args carry ingest URL and token), private-context `source.picture` forwarding, `packages/browser-extension` native host → ingest, JPEG-source encode in ace-media, setting `media.encode` | tab, embedded, private-context and "Use my Chrome" tabs stream through ace-media; ingest refused for a wrong origin or reused token | `video-link.ts` unchanged or better (median 60, p10 ≥ 59); "Use my Chrome" 1280×800 at 60 fps with no encoder Chrome running on a Mac |

### Wave 5: phase 3

| PR                           | Needs             | Owns                                                                                                                                                                                                                                                                                                                                               | Tests                                                                                                                                                                                                                                                                                                                       | Bench and acceptance                                                                                                                                                                          |
| ---------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** Delivery in ace-media | M2, M7, E3, E4    | viewers, plans and `source.want` in `ace-media`; direct listener (loopback, TLS from `listen`); `media.connect` and `media.ticket` in the daemon; `viewer.*` wiring in `packages/browser` (`live-video.ts` becomes a thin driver), `packages/screen` (`bridge.ts`), `packages/devices` (`bridge.ts`); protocol additions; setting `media.delivery` | a web client watching a tab, a screen and a device gets all three on one media connection; revoke closes it at once; ace-media restart → picture back within 2 s p95                                                                                                                                                        | new `packages/browser/bench/media-link.ts` beside `video-link.ts`, in `check:perf`: median ≥ 59 fps, p10 ≥ 55 on the default link; daemon `bytesOut` for video = 0; local hop adds ≤ 2 ms p95 |
| **D2** Relay media streams   | D1, M4            | `apps/relay` (self-hosted) and `apps/cloud` (Worker): `media` purpose and tickets, `media` host feature; `apps/daemon/src/files-relay.ts` handshake through ace-media and `relay.keys`; relay streams in `ace-media`                                                                                                                               | process test with the real self-hosted relay: handshake through ace-media, keys handed over mid-stream with no frame lost or duplicated, a rekey crossed, revocation closes within 100 ms, ace-media kill → client reconnects and resumes at a keyframe; keys never appear in logs or stdout after `relay.keys` (scan test) | 10 relay viewers at 16 Mbit/s: ace-media ≤ 15 % of a core total, daemon CPU within 1 % of no viewers                                                                                          |
| **C1** Web media connection  | D1 (D2 for relay) | `apps/web/src/lib/video/*`, `packages/client*` media connection, HEVC pictures                                                                                                                                                                                                                                                                     | reconnect and resubscribe; acks routed; legacy delivery still works against a daemon with `media.delivery: legacy`                                                                                                                                                                                                          | `media-link.ts` numbers hold with the web client                                                                                                                                              |
| **C2** iOS media connection  | D1, D2, I1        | `apps/ios/**` media socket in Swift, bridge routing                                                                                                                                                                                                                                                                                                | the same as C1 on a simulator over the relay                                                                                                                                                                                                                                                                                | 60 fps median on the phone-link profile of `video-link.ts`                                                                                                                                    |

### Wave 6: deletion (one PR per phase, after a release ships with `auto` as the default and needs no fallback)

| PR             | Deletes                                                                                                                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **X1** phase 1 | ffmpeg recording and still paths, `Bun.Image` frame transcodes, JPEG-file browser recordings                                                                                                                                                         |
| **X2** phase 2 | CDP base64 chunk path in `chrome-video.ts`, daemon-run encoder Chrome, `picture-video.ts`, Swift `--transcode`, frame packets from helpers to the daemon                                                                                             |
| **X3** phase 3 | `video-fanout.ts`, `link-rate.ts`, `video-scale.ts`, `video-policy.ts`, `picture-viewer.ts`, `picture-channel.ts`, the daemon's stream sends and relay sends of video; clients' legacy delivery. The vectors are frozen into `native/media/vectors`. |

## Benchmarks

- **`native/media/bench/`** has `envelope`, `fanout`, `seal`, `mux`, `still`, `encode
--backend {vt,mf,vaapi,chrome}`, `ingest` and `size`.
  - Each prints one JSON line in the format `video-link.ts` uses, and fails below its acceptance
    number unless `ACE_MEDIA_BENCH_REPORT_ONLY=1`.
  - Run them with `bun run bench:media`.
- **`packages/browser/bench/media-link.ts`** runs the whole pipeline (real Chrome, ace-media, a
  simulated link) beside `video-link.ts`. It joins `check:perf` with D1. While the legacy path
  exists, `video-link.ts` keeps running against it.
- **Load.** Benches record load average at start and refuse to enforce above 2 × the core count,
  so a loaded machine reports instead of failing.
