<!-- SPDX-License-Identifier: Apache-2.0 -->

# media-vt

The macOS backend (ADR 0148, build plan row B1). It implements media-codec's
`Encoder`, `Decoder`, `Scaler` and `JpegCodec` on VideoToolbox, plus the
backend's availability trial. On other platforms the crate is empty.

Bindings are `objc2-video-toolbox`, `objc2-core-media`, `objc2-core-video`,
`objc2-io-surface` and `objc2-core-foundation` (MIT OR Apache-2.0 OR Zlib).
Each `unsafe` block states why it holds.

## Pictures

A `PlatformPicture` holds a `VtSurface`, an owned IOSurface-backed
`CVPixelBuffer`. `PixelPool` wraps a `CVPixelBufferPool`, so released buffers
are reused. `VtFormat::Nv12` is video-range `420v` (what ScreenCaptureKit hands
over); `VtFormat::Bgra` is `32BGRA`. A CPU picture costs exactly one upload
into a pooled buffer. `read_back` is the one GPU→CPU copy. Every session type
reports its per-call `Copies { readbacks, uploads }`.

## Encode

`VtEncoder` opens a `VTCompressionSession` with hardware **required** and
low-latency rate control. It falls back to a plain hardware real-time session
where the OS has no low-latency mode for the codec. Frame reordering is off,
and the profile is H.264 High or HEVC Main (auto level). Output is
length-prefixed (`Avcc`/`Hvcc`). Every keyframe carries the `avcC`/`hvcC`
record from the format description.

- `encode(picture, force_key)`: a `VtSurface` goes to the session as is (zero
  copy); a CPU picture costs one upload. `force_key` sets
  `kVTEncodeFrameOptionKey_ForceKeyFrame`.
- `configure` with only the rate or fps changed updates the open session in
  place: same stream, no keyframe. A codec or size change opens the new
  session first, then drains the old one; the new stream starts at a
  keyframe.
- Configuration is all or nothing. If a setting is refused, the previous
  settings are applied again and the error is returned; a new stream that
  fails to open leaves the old session running. The plan and its rollback
  live in `settings.rs`, which is unit-tested with a failing sink.
- `Bitrate` sets `AverageBitRate`; `Quantizer` sets min/max allowed frame QP.
  Leaving a mode resets it: the QP bounds open to 0–51, or the bitrate goes
  back to 0 (the encoder's choice). VideoToolbox refuses NULL here.
- Every output unit carries the codec, size and format of the stream that
  produced it, so units still queued across a reconfigure keep their own.
- At most 8 pictures may be in flight or unpolled before `encode` returns
  `Backpressure`. A slot is reserved only once a picture is ready to submit,
  so a refused picture never holds one.
- Output callbacks catch panics instead of unwinding into VideoToolbox: a
  panic becomes a backend error from `poll_result`, and the in-flight count
  is still released.
- `poll_into(&mut unit)` swaps the next frame's bytes into the caller's unit
  and recycles the caller's old buffer. The output slots are sized at
  configure time, so a stream makes no heap allocations per frame. The
  trait's `poll` hands out an owned unit and so allocates.

## Decode, scale, transcode

`VtDecoder` takes `Avcc`/`Hvcc` units: the first must carry the
configuration record, and a changed record reopens the session. Every unit
is checked before it reaches CoreMedia: Annex B is refused as unsupported,
and a unit of another codec than the open stream is refused as invalid. Its output is NV12 or BGRA at a destination
size, scaled by the decoder session itself. When the destination changes
mid-stream, pictures are scaled with `VTPixelTransferSession` until the next
keyframe reopens the session at the new size, so no keyframe has to be forced.

`VtScaler` converts and scales between pixel buffers with
`VTPixelTransferSession`, writing into pooled destinations.

`VtTranscoder` decodes at the encode size and hands the IOSurface straight to
the encoder: 0 readbacks and 0 uploads. It reports backpressure before
decoding, so a unit is never lost.

## JPEG

`VtJpeg` decodes `kCMVideoCodecType_JPEG` at the requested size and encodes
JPEG from a `VtSurface`, through VideoToolbox only where its session reports
hardware. Otherwise, including when no VideoToolbox JPEG session opens at
all, it uses media-codec's cached CPU codec and never another VideoToolbox
session:

- decode runs on the CPU codec, followed by one upload;
- encode reads back once, converting NV12 (BT.709) or BGRA to RGB while
  copying, then runs the CPU encoder into the caller's buffer.

`VtJpeg::without_hardware` never opens a JPEG session; it suits machines
whose probe found no hardware JPEG.

`last_path()` says which path ran and what it copied. A CPU picture is
encoded on the CPU directly.

## What "hardware" means

`hardware` is the session's `UsingHardwareAccelerated…` property. On macOS
27.0.1, low-latency encode sessions and JPEG encode and decode sessions don't
report it (`kVTPropertyNotSupportedErr`). Those sessions are opened with
hardware _required_ first, and a session that opens under that requirement
counts as the session's answer. A session opened without the requirement,
and not reporting the property, is not hardware. This is never inferred from
the chip. `VTPixelTransferSession` has no such property, so the probe reports
`scale` as `hardware: false`. The still and transcode paths scale inside the
decoder session instead.

## Probe

`probe(&ProbeOptions)` runs its trials on one worker thread. Each trial
opens a session and pushes one 1280×720 frame. The probe waits at most
`deadline` (2 s by default) for:

- H.264 and HEVC encode and decode;
- JPEG encode and decode;
- scale.

It returns one `media_wire::capability::Capability` per step, in a fixed
order. Codec strings are WebCodecs strings built from the trial's own
`avcC`/`hvcC`. `maxWidth`/`maxHeight` for video are the largest candidate size
a hardware session opens and prepares at. `TrialInput::Cpu` feeds the encode
trial a CPU picture, which must show up as `zeroCopy: false`.

- **Deadline and cancellation.** The worker checks both before every
  operation and stops starting work once either closes. A trial already
  inside a VideoToolbox call finishes; its result arrives on
  `ProbeReport::late`, which closes when the worker stops. Unfinished steps
  are `timed-out`. A probe cancelled before it starts returns at once and
  starts nothing.
- **One worker.** At most one worker is in flight per process. A probe with
  the same input joins it, reusing a late result and extending its
  deadline. A probe with another input waits for it, within its own
  deadline. A joined worker that stopped short is replaced by a fresh one.

On the Mac (M4 Max) the probe takes 450–730 ms and reports:

| Step                     | Codec              | Hardware | Zero copy | Max       |
| ------------------------ | ------------------ | -------- | --------- | --------- |
| encode, decode           | `avc1.640020`      | yes      | yes       | 4096×2304 |
| encode, decode           | `hvc1.1.6.L120.B0` | yes      | yes       | 8192×4320 |
| jpeg-encode, jpeg-decode | `jpeg`             | yes      | yes       | 8192×8192 |
| scale                    | —                  | no       | yes       | 8192×8192 |

## Benchmarks

From `native/media`:

```sh
cargo run --release -p media-vt --example encode -- --backend vt [--case NAME] [--seconds 30]
cargo run --release -p media-vt --example vt_still -- --path gpu
cargo run --release -p media-vt --example vt_alloc
cargo run --release -p media-vt --example vt_probe
```

Each prints one JSON line with the load average, machine and OS build. A
bench fails below its acceptance number unless `ACE_MEDIA_BENCH_REPORT_ONLY=1`
is set or the load is above 2 × cores. Path and allocation checks don't
depend on load, so `vt_still` fails on a path or copy regression and
`vt_alloc` on any allocation beyond the expected ones, at any load.

- **Source frames.** Encode benches cycle a ring of pre-filled IOSurface
  frames: a scrolling text-like pattern, as a capture source would hand them
  over.
- **CPU.** This process's user + system time over the run, as % of one core,
  median of 3 runs, each 30 s after a 5 s warm-up.
- **XPC services.** VideoToolbox does part of its work in its XPC services.
  `xpcServicesCpuPercent` sums every `VT*XPCService` on the machine, other
  clients included, so it is context, not this stream's cost.

Mac16,5 (M4 Max), macOS 27.0.1 (26A434), 16 cores, 2026-11-14. The Mac was
shared and loaded, with six other VideoToolbox encode clients running.

| Measure                                           | Result                                                                        | Target | Load |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | ------ | ---- |
| 2560×1600 HEVC encode, unpaced                    | 110.3 fps                                                                     | ≥ 100  | 12.9 |
| 1920×1080 H.264 encode, unpaced                   | 217.9 fps (236 fps without low-latency rate control)                          | ≥ 240  | 12.9 |
| 1080p60 H.264 encode, CPU per stream              | 1.96 % (XPC services 4.5 %)                                                   | ≤ 3 %  | 54.3 |
| 4K30 HEVC encode, CPU per stream                  | 0.55 % (XPC services 3.5 %)                                                   | ≤ 4 %  | 19.6 |
| Transcode 1206×2622 HEVC → 588×1280 H.264, 60 fps | 2.72 % (XPC services 7.1 %)                                                   | ≤ 3 %  | 13.2 |
| Still: HEVC → 722×1568 JPEG, p95                  | 5.71 ms (median 5.42; decode 3.91, JPEG 1.79 p95)                             | ≤ 8 ms | 13.7 |
| Still path and copies (fails on any regression)   | 0 readbacks, 0 uploads (H → H → H); rerun after the review fixes: p95 6.84 ms | 0 / 0  | 10.2 |
| Heap allocations, steady-state encode             | 0 in 600 frames                                                               | 0      | 51.7 |
| Heap allocations, decode                          | 1 per frame: the trait's `PlatformPicture` box (enforced as the maximum)      | ≤ 1    | 10.2 |
| Heap allocations, JPEG still (either path)        | 0 per still                                                                   | 0      | 10.2 |

1080p H.264 throughput misses its target. Low-latency rate control keeps
about one frame in the engine at a time, roughly 4.6 ms per frame here.
Without it the session reaches 236 fps on the same loaded machine. The
Constrained High profile measured the same.
