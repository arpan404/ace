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
- **`MfDecoder`.** The first decoder MFT that takes the stream, given the device when it's
  D3D11-aware. It is low latency, with NV12 out to textures or to the CPU.
  - **`hardware`.** True only for a hardware-listed MFT, or for DXVA texture output on an
    adapter that isn't software.
  - **`drain()`.** Returns pictures a decoder held back. The HEVC Video Extension holds one.
- **`WicJpeg`.** `JpegCodec` and `StillCodec` on WIC. It runs on the CPU and is always
  reported as not hardware.
- **`probe()`.** One bounded, cancellable trial per step on its own thread: encode and decode
  for H.264 and HEVC, JPEG encode and decode, and scale. It has a 2 s deadline, and late
  results arrive on `late`.

## Measured

On the Windows 11 Pro ARM64 VM (build 26300, VMware Fusion, "VMware SVGA 3D" adapter, no
hardware encoder), natively, 2026-11-14:

- **Tests.** The pure tests and all ten `tests/windows.rs` tests pass.
- **Encode.** The encoder is "H264 Encoder MFT" (software, `hardware: false`); HEVC is
  "HEVCVideoExtensionEncoder" (software). Decoders are "Microsoft H264 Video Decoder MFT"
  and "HEVCVideoExtension", both `hardware: false`.
- **Round trip.** Encode → decode is at least 32 dB luma PSNR on every frame. A forced key
  lands on exactly the asked frame. A change from 150 kbit/s to 3 Mbit/s keeps the stream
  (no key) and goes from 244 to 8362 bytes a frame.
- **Copies.** A BGRA texture → GPU scale → software MFT costs 1 readback and 0 uploads.
- **Probe.** It finishes in 227–237 ms. avc1 and hvc1 encode and decode are `ok` with
  `hardware: false`, JPEG is `ok` with `hardware: false`, and scale is `ok` and on the
  adapter (VMware's virtual GPU, backed by the host).
- **Speed.** `examples/mf_encode` runs 1080p30 H.264 on the software MFT at 311 fps, from a
  CPU NV12 gradient. Easy content, so this is an upper bound.

## Not yet tested

- **Hardware.** No GPU hardware has been tested: Intel, AMD, NVIDIA and Qualcomm MFTs, async
  MFTs, the zero-copy texture path (0 readbacks), DXVA decode reporting `hardware: true`, and
  driver quirks such as output types offered only after the first input, or QP being ignored.
  The x64 build is checked by compiling only.
- **Not built.** These are left for later:
  - the hardware MJPEG decoder and encoder MFTs (stills use WIC everywhere);
  - the 1 s no-output watchdog;
  - the N-edition (no MFT) path. That machine just lists no MFT, and the probe reports
    `failed`.
- **Quirk.** The HEVC Video Extension writes `level_idc` 12 for 1280×720 at 60 fps, so the
  probe's codec string is `hvc1.1.2.L12.B0`. It is reported as written.
