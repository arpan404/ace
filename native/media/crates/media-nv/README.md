<!-- SPDX-License-Identifier: Apache-2.0 -->

# media-nv

NVIDIA hardware video for ace-media (ADR 0148): NVENC encode and NVDEC decode of H.264 and
HEVC behind `media-codec`'s `Encoder` and `Decoder`. Linux and Windows only; on macOS the
crate is empty.

## Off by default: unverified layout

The 12.0 layouts below are our own declaration and have not yet been checked against NVIDIA's
headers or run on an NVIDIA GPU. A wrong offset under a structure version the driver accepts
could corrupt memory, so `media-nv` never opens the driver by default. `probe()` reports
`NvProbe::Unavailable("unverified layout")` and `NvRuntime::load()` returns
`Unsupported("unverified layout")`, without loading any library.

The development opt-in is exactly `ACE_MEDIA_NV=1`. Nothing in a release build sets it.
Turning the backend on for everyone, by removing the gate, needs both of these first:

1. one run of the `ACE_NV_HEADERS` layout check below, passing against the SDK headers for the
   pinned version;
2. B5's acceptance on real NVIDIA hardware (docs/media/plan.md, wave table): the encode →
   decode round trip from a DMA-BUF GL texture with no CPU copy, NVDEC stills at the requested
   size, and a missing or too-old driver giving no backend and no crash.

## The driver, at run time

Nothing is linked. With the opt-in set, `NvRuntime::load` opens the driver's own libraries with `libloading`:

| Part  | Linux                   | Windows             |
| ----- | ----------------------- | ------------------- |
| NVENC | `libnvidia-encode.so.1` | `nvEncodeAPI64.dll` |
| NVDEC | `libnvcuvid.so.1`       | `nvcuvid.dll`       |
| CUDA  | `libcuda.so.1`          | `nvcuda.dll`        |

On Linux the sonames go through the dynamic loader's usual search. On Windows the DLLs are
loaded with `LOAD_LIBRARY_SEARCH_SYSTEM32` only, where the driver installs them, so a DLL of
the same name in the current directory or on `PATH` is never picked up.

A part that is missing, or an NVENC whose `NvEncodeAPIGetMaxSupportedVersion` is below the
pinned version, is absent and its reason is kept for `ace doctor`. Without the driver there is
no backend and no crash.

## Bindings

`enc_abi.rs` and `dec_abi.rs` are our own `#[repr(C)]` declarations for **NVENC API 12.0**
(drivers 520 and later), written from NVIDIA's public programming guides. They name only the
members ace sets or reads; every other member is a reserved tail kept at zero. Structures the
driver writes into (`NV_ENC_PRESET_CONFIG`, `NV_ENC_LOCK_BITSTREAM`) sit in storage with 4 KiB
of slack past our declared size. `enc_abi.rs` says, structure by structure, which numbers we
rely on and how sure each is: the guide gives member names and order, not byte sizes, so every
offset, size and revision is unverified until the `ACE_NV_HEADERS` check passes. Nothing is copied, vendored or generated from the Video Codec
SDK or any copy of its headers, and `tests/no_nvidia_files.rs` fails if an NVIDIA header or
library lands in `native/`.

**Developer-only layout check.** With the SDK installed under your own acceptance of its
licence, compare every size, offset and structure version we rely on:

```sh
ACE_NV_HEADERS=/path/to/Video_Codec_SDK/Interface \
ACE_CUDA_INCLUDE=/usr/local/cuda/include \
  cargo test -p media-nv layouts_match_nvidias_headers -- --nocapture
```

`ACE_CUDA_INCLUDE` is only needed for the NVDEC half (`cuviddec.h` includes `cuda.h`). Never in
CI; nothing of the SDK enters the repository.

## Encode (`NvEncoder`)

- **Devices.** `open_gl` (Linux, `NV_ENC_DEVICE_TYPE_OPENGL`), `open_d3d11` (Windows), and
  `open_cuda` (driver-allocated input buffers on a CUDA context of its own, for CPU pictures and
  the probe).
- **The GL thread contract.** A GL encoder needs its context current on the calling thread for
  every `configure` and `encode`, and must be finished with `close()` on that thread. Dropping
  it without `close()`, which might happen on a thread without the context, makes no driver
  call: it leaks the NVENC session and logs that it did. D3D11 and CUDA encoders may simply be
  dropped.
- **Input.** `GlTexture` and `D3d11Texture` platform pictures in `Bgra8` (NVENC ARGB) or `Rgba8`
  (ABGR): zero copy, NVENC converts to YUV. Each picture's texture is registered, mapped,
  encoded, unmapped and unregistered within its `encode` call, while the picture still owns the
  texture. Texture names and D3D11 addresses are reused once a producer releases a texture, so a
  registration never outlives its picture. That costs a registration per picture; keeping
  registrations across pictures would need the producer to name its texture ring and say when
  each texture is released. CPU pictures (NV12, BGRA, RGBA) are one upload into the session's input
  buffer.
- **Tuning.** Only the P1–P7 presets (default P3) with `ULTRA_LOW_LATENCY` tuning info, applied
  through `nvEncGetEncodePresetConfigEx`. Then: no B-frames, an infinite GOP and IDR period,
  `enablePTD`.
- **Keyframes.** The first picture of a session and every `force_key` picture are
  `FORCEIDR | OUTPUT_SPSPPS`, so each IDR carries its parameter sets. Output is Annex B.
- **Rate.** `Bitrate` is CBR with a one-frame VBV; `Quantizer` is constant QP. A rate or fps
  change is `nvEncReconfigureEncoder` on the running stream (no keyframe); a codec or size
  change opens a new session and starts at an IDR. A failed change keeps the previous
  configuration.
- **Errors.** An unknown structure version, missing device or codec is `Unsupported`; a busy
  encoder is `Backpressure` (the picture isn't consumed and a pending keyframe stays owed);
  other statuses are `Backend`, naming the call.
- **Teardown** follows the guide: end of stream, input and bitstream buffers, the session.

## Decode (`NvDecoder`)

H.264 and HEVC Annex B through NVIDIA's parser (no display delay, one picture per packet). The
decoder is created at the sequence with `ulTargetWidth/Height` set to the requested output
size, so NVDEC itself scales; each picture is then one readback of the scaled NV12 surface
(luma, then the chroma after the surface's luma rows) into a `CpuPicture`. 8-bit 4:2:0 only.
NVDEC's JPEG decoder is hybrid CUDA + CPU and deprecated, so it is never used: JPEG on NVIDIA
runs on `media-codec`'s CPU path.

## Probe

`probe(stop)` is the backend's availability trial for ace-media's `probe.rs`: per codec, open a
CUDA-device NVENC session, encode one 320×240 IDR, and decode it with NVDEC at 160×120. ace-media
runs it on a thread of its own under the trial deadline; `stop` is checked before each step, a
stopped step is `Cancelled`, and everything opened is closed on return. It never ranks.

## Tests

Everything except the driver itself runs anywhere Linux runs: a fake driver at the C boundary
(`src/fake.rs`) fills the same function tables, checks each structure's version as the driver
does, and counts handles, so the call sequence, keyframes, rate changes, registration, readback
offsets, teardown and error mapping are tested through the real FFI code. Layout tests pin the
offsets and sizes of every member the driver touches on 64-bit Linux.

**Neither can verify NVIDIA's real layout.** The fake driver is written against the same
declarations, so it agrees with them by construction, and the layout tests only pin where our
declaration puts each member, catching accidental changes. Whether that matches NVIDIA's
interface is checked by one thing: the `ACE_NV_HEADERS` comparison against the SDK headers.

Without the opt-in, the probe's output shows that the driver loader never ran (a fake loader
that would have produced a working backend is passed in and the result is still
`Unavailable`).

Not covered without NVIDIA hardware: that a real driver accepts these layouts and versions, the
GL texture → NVENC zero-copy path, NVDEC output scaling on a real stream, and the latency and
fps numbers in the plan's "Acceleration acceptance".
