<!-- SPDX-License-Identifier: Apache-2.0 -->

# media-mf

The Media Foundation backend (ADR 0148, docs/media/plan.md B2). Bindings come from the
`windows` crate (MIT or Apache-2.0); the code is written from Microsoft's documentation. On
other platforms only the pure modules build: `nal` (Annex B ↔ length-prefixed, `avcC`/`hvcC`
records, codec strings), `rank` (encoder MFT order) and `color` (CPU BGR repack for WIC).

## Pieces

- **`MfDevice`.** The first DXGI adapter, opened with `D3D11_CREATE_DEVICE_VIDEO_SUPPORT`
  (it falls back to a device without video support), `SetMultithreadProtected(TRUE)` and an
  `IMFDXGIDeviceManager`. `Adapter` carries vendor, device id, LUID and the UMD version: the
  key the ranking cache needs.
- **`MfScaler`.** One `VideoProcessorBlt` converts BGRA or NV12 and scales into a texture
  ring. RGB is full range; NV12 is BT.709 studio range, and encoder types are tagged the same.
  CPU input costs one counted upload.
- **`MfEncoder`.** `MFTEnumEx` lists hardware MFTs (`HARDWARE | SORTANDFILTER`), then
  synchronous software ones. `order_encoders` puts the MFT from the device's adapter vendor
  first. On an NVIDIA adapter that makes the NVIDIA MFT the deterministic choice. Replacing
  it with NVENC is the ranking benchmark's decision in `ace-media`, not this crate's.
  - **Hardware MFTs.** They are unlocked with `MF_TRANSFORM_ASYNC_UNLOCK`, get
    `MFT_MESSAGE_SET_D3D_MANAGER`, and are driven by `METransformNeedInput` /
    `METransformHaveOutput`. Input is the NV12 texture through `MFCreateDXGISurfaceBuffer`,
    with no copy.
  - **Software MFT.** It takes system-memory NV12, so a texture costs one counted readback.
    It reports `hardware: false`.
  - **Settings.** Low-latency mode, no B-frames, a GOP of an hour, low-delay VBR (CBR where
    refused) or QP through `CODECAPI_AVEncVideoEncodeQP` where the MFT has it.
  - **Keyframes and rate.** `CODECAPI_AVEncVideoForceKeyFrame` forces a key; an MFT that
    refuses gets a new session, which opens on a key. A rate-only change goes through
    `CODECAPI_AVEncCommonMeanBitRate` and keeps the stream.
  - **Output.** Length-prefixed NALs with the `avcC`/`hvcC` record on keyframes, as the other
    backends write. Parameter sets come from in-band NALs or `MF_MT_MPEG_SEQUENCE_HEADER`.
  - **Start-up.** A fresh async MFT gets up to 1 s to ask for its first input; one that
    never asks is skipped for the next candidate. `encode` waits at most one frame (50 ms
    cap) for an input request before backpressure.
  - **Replacing a session.** This happens on a codec or size change, a keyframe the MFT
    can't force, or a stall. The new session is opened first, then the old one is drained
    into the queue, then they swap. If the new one fails to open, the old one stays.
  - **In flight.** Inputs are tracked by their buffer: a slot (and its texture) is free once
    the MFT has released the sample, even for a frame it dropped. An async MFT that holds
    input for 1 s with no output and no input request is replaced (`stalls()` counts it).
- **`MfDecoder`.** The first decoder MFT that takes the stream, given the device when it's
  D3D11-aware. It is low latency, with NV12 out to textures or to the CPU.
  - **`hardware`.** True only for a hardware-listed MFT, or for DXVA texture output on an
    adapter that isn't software.
  - **Pool.** With a device, pictures land in a pool of `IN_FLIGHT + 4` textures (a caller
    may hold the encoder's in-flight depth, 8). A slot is reserved before the unit goes in,
    so a full pool returns backpressure without consuming the unit. Extra output waits in a
    queue and is never dropped.
  - **No waiting.** Live decode never blocks on an async MFT.
  - **`drain()`.** Returns pictures a decoder held back; the HEVC Video Extension holds one.
    It waits up to 2 s, keeps what it collected if it fails partway, and returns the error
    from the next `decode`.
- **`WicJpeg`.** `JpegCodec` and `StillCodec` on WIC. It runs on the CPU and is always
  reported as not hardware.
- **`probe()`.** Bounded, cancellable trials in parallel, one thread per chain: H.264 encode
  then decode, HEVC encode then decode, JPEG encode then decode, and scale. They share a 2 s
  deadline, and late results arrive on `late`.
  - **Encode limit.** The trial reports the size it ran at. The largest session the MFT
    opens is searched after that, smallest size first, and cached for the process. Its
    entry replaces the first one: in the report if it beats the deadline, otherwise on
    `late`.
- **Shared device and runtime.** Multi-call context sequences (map, copy, unmap; video
  processor set-up and blit; the decoder's copy-out) hold `ID3D11Multithread::Enter` and
  `Leave`. Every encoder, decoder and device holds its own `MFStartup`, and ends its MFT
  before its device and runtime drop.
- **DLL search.** The first runtime start calls
  `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)`. `ace-media` and this crate's
  test and example binaries link with `/DEPENDENTLOADFLAG:0x800`.

## Measured

On the Windows 11 Pro ARM64 VM (build 26300, VMware Fusion, "VMware SVGA 3D" adapter, no
hardware encoder), natively, 2026-11-14:

- **Tests.** The pure tests and all eleven `tests/windows.rs` tests pass. The newest is a
  pool test: it holds every picture until backpressure, then hands them back; all 40
  pictures arrive exactly once, in order.
- **Encode.** The encoder is "H264 Encoder MFT" (software, `hardware: false`); HEVC is
  "HEVCVideoExtensionEncoder" (software). Decoders are "Microsoft H264 Video Decoder MFT"
  and "HEVCVideoExtension", both `hardware: false`.
- **Round trip.** Encode → decode is at least 32 dB luma PSNR on every frame. A forced key
  lands on exactly the asked frame. A change from 150 kbit/s to 3 Mbit/s keeps the stream
  (no key) and goes from 244 to 8362 bytes a frame.
- **Copies.** A BGRA texture → GPU scale → software MFT costs 1 readback and 0 uploads.
- **Probe.** The first run took 227–237 ms with the steps in sequence; in parallel it takes
  124–440 ms. The refined H.264 limit is 4096×2304. avc1 and hvc1 encode and decode are `ok` with
  `hardware: false`, JPEG is `ok` with `hardware: false`, and scale is `ok` and on the
  adapter (VMware's virtual GPU, backed by the host).
- **Speed.** `examples/mf_encode` runs 1080p30 H.264 on the software MFT at 311 fps, from a
  CPU NV12 gradient. Easy content, so this is an upper bound. The VM's throughput is noisy:
  back to back, the first commit ran at 194 and 179 fps and the review fixes at 99 and
  236 fps.

## Not yet tested

- **Async paths.** The async start-up wait, the stall watchdog and freeing slots by buffer
  identity run only with async (hardware) MFTs. The VM has none, so they are untested.
- **`ace-media` link flag.** Its `/DEPENDENTLOADFLAG` build script is not yet checked on a
  native build (`ring` stops a cross-check).
- **Hardware.** No GPU hardware has been tested: Intel, AMD, NVIDIA and Qualcomm MFTs, async
  MFTs, the zero-copy texture path (0 readbacks), DXVA decode reporting `hardware: true`, and
  driver quirks such as output types offered only after the first input, or QP being ignored.
  The x64 build is checked by compiling only.
- **Not built.** These are left for later:
  - the hardware MJPEG decoder and encoder MFTs (stills use WIC everywhere);
  - the N-edition (no MFT) path. That machine just lists no MFT, and the probe reports
    `failed`.
- **Quirk.** The HEVC Video Extension writes `level_idc` 12 for 1280×720 at 60 fps, so the
  probe's codec string is `hvc1.1.2.L12.B0`. It is reported as written.
