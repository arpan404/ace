# 0148: ace-media is GPU-accelerated end to end

Status: accepted. Amended by [ADR 0149](0149-media-holds-up-on-3g.md) (keyframe cap). Date:
2026-11-14. Decided by: the owner (2026-11-14: "Make sure we have
gpu/cpu accelerated media pipeline"). Amends [ADR 0147](0147-ace-media-rust-media-pipeline.md)
§3 (encoders, decoders, licences) and §6 (stills). The build plan is
[docs/media/plan.md](../media/plan.md).

## Context

ADR 0147 puts every video byte in ace-media and prefers hardware encoders. It leaves three
gaps:

- **NVIDIA on Linux** has no VA-API encode, so it fell to the last-resort encoder Chrome, which
  is the slow path that ace-media exists to replace.
- **Pixels move on the CPU.** Colour conversion, scaling, JPEG decode for ace-media's own
  producers, and every still are CPU work.
- **Nothing makes acceleration testable.** No machine is told when it runs a fallback, and no
  benchmark fails when a hardware path quietly turns into a CPU one.

## Decision

1. **The hardware path is the rule; the CPU path is the exception.** On a machine with a GPU,
   every encode, decode, colour conversion and scale runs on it, and stills too where the OS
   offers hardware JPEG. A step runs on the CPU only when the probe found no hardware for it on
   that machine. When that leaves a source degraded, the machine says so (decision 8).

2. **An NVENC/NVDEC backend, `media-nv`.**
   - **Where it runs.** On Linux it is the encoder for NVIDIA GPUs, and the decoder for stills.
     On Windows, Media Foundation's NVIDIA MFT is the deterministic first choice. `media-nv`
     replaces it only where a ranking benchmark has measured the MFT worse (lower fps, or more
     CPU per stream) on that adapter, driver and encode settings (decision 8).
   - **What it loads.** The NVIDIA driver's own libraries, opened at run time:
     - Linux: `libnvidia-encode.so.1`, `libnvcuvid.so.1` and `libcuda.so.1` (CUDA's driver
       API, which NVDEC needs for its context);
     - Windows: `nvEncodeAPI64.dll`, `nvcuvid.dll` and `nvcuda.dll`.

     Without them, or with a driver whose `NvEncodeAPIGetMaxSupportedVersion` is below the
     pinned API version, it reports no backend. ace ships no NVIDIA binary.

   - **What it never uses:** the CUDA toolkit's libraries (NPP, nvJPEG, the CUDA runtime).
     Encoder input is a GL texture on Linux (NVENC's OpenGL resource type) and a D3D11 texture
     on Windows, in a 32-bit RGB format that NVENC converts to YUV itself. Scaling happens
     before NVENC, on the GPU: a GL blit from the capture's DMA-BUF (Linux) or the D3D11
     video processor (Windows). For stills, NVDEC's own output scaling is used.
   - **NVDEC decodes H.264 and HEVC, never JPEG.** NVIDIA describes NVDEC's JPEG support as
     "Hybrid (CUDA + CPU)" and has announced its removal (Video Codec SDK 13.1 deprecation
     notices). ace treats it as neither hardware nor available. On NVIDIA, JPEG decode and
     encode run on ace's CPU path.
   - **Presets.** `media-nv` uses only the P1–P7 presets with tuning info. NVIDIA removed driver
     support for the older presets and rate-control modes from driver 590.
3. **The licence of NVIDIA's interface, checked and recorded.**
   - **The headers.** NVIDIA's interface headers (`nvEncodeAPI.h`, `cuviddec.h`, `nvcuvid.h`)
     carry a per-file MIT notice ("This copyright notice applies to this header file only"),
     followed by the MIT permission text. That is the case in the copies NVIDIA has published
     since Video Codec SDK 7.0. The same notice is why other open projects carry the headers.
   - **The SDK package.** The Video Codec SDK package as a whole is under NVIDIA's DesignWorks
     SDK licence (the version of 10 May 2022). That licence:
     - limits distribution;
     - forbids making the SDK subject to an open-source licence;
     - requires a notice on distributed sample code;
     - and its samples include LGPL-3 FFmpeg code.
   - **The tension.** How the per-file MIT grant sits with that package licence isn't settled
     by anything NVIDIA publishes.
   - **What ace does.** It avoids the question rather than relying on either reading.
     - **Nothing is copied.** It doesn't vendor, copy or generate from the SDK package, its
       headers or its samples, or from any other project's copy of them.
     - **Own bindings.** `media-nv` declares its own `#[repr(C)]` types and function tables for
       one pinned API version, written from NVIDIA's public API documentation and programming
       guides on docs.nvidia.com.
     - **A local layout check.** It is developer-only and never in CI or the repo: a developer
       who has the SDK installed under their own acceptance of its licence can point
       `ACE_NV_HEADERS` at it, to compare our sizes and offsets.
   - **Shipping.** Nothing NVIDIA's ships with ace. The driver's libraries are the person's
     own install, loaded at run time. They are proprietary but not GPL, and ace links no GPL
     code, so loading them raises no GPL question. ace redistributes nothing proprietary.
4. **Zero-copy from capture to encoder inside the helpers.** The picture stays a GPU surface
   from capture to the encoder: IOSurface-backed `CVPixelBuffer`s on macOS, D3D11 textures on
   Windows, DMA-BUF imported as VA surfaces or GL textures on Linux. A copy to CPU memory on a
   hardware path is a bug, and benches count it.
5. **ace-media's own producers decode JPEG on the GPU.** "Use my Chrome" and private-context
   screencasts arrive as JPEG. ace-media decodes them into encoder surfaces on hardware:
   - VideoToolbox's JPEG decoder on Apple silicon;
   - Media Foundation's hardware MJPEG decoder MFT where one exists, otherwise WIC on the CPU;
   - VA-API's JPEG decoder on Intel and AMD, where the driver lists it;
   - the CPU on NVIDIA (decision 2), with one upload to the encoder's texture.

   "Where it exists" always means observed on the machine: the trial session reports that it
   used hardware (for VideoToolbox, `UsingHardwareAcceleratedVideoDecoder` /
   `UsingHardwareAcceleratedVideoEncoder` on the session). A chip family is never assumed to
   have it. From there the picture goes straight to the encoder.

6. **Stills on the GPU** (amends ADR 0147 §6). A still is the current picture:
   - **Decode** it on the GPU: VideoToolbox, Media Foundation (DXVA), VA-API or NVDEC.
   - **Scale** it on the GPU: the decoder's own output size where it has one, otherwise the
     platform's video processor.
   - **Encode** the JPEG on hardware where the machine is observed to have it:
     VideoToolbox's JPEG encoder (`kCMVideoCodecType_JPEG`) when its session reports hardware,
     a hardware MJPEG MFT on Windows, VA-API's JPEG encoder where the driver lists it.
     Elsewhere, including every NVIDIA machine, one readback of the scaled picture and
     M5's CPU encoder.

7. **The CPU paths that remain are fast and allocation-free.**
   - **SIMD.** Scaling and JPEG use NEON or AVX2, detected at run time.
   - **Workers.** CPU media work runs on a fixed worker pool sized to the machine, never on the
     control, delivery or relay threads.
   - **Buffers.** Every per-frame buffer comes from a pool, so a stream in steady state
     allocates nothing per frame.
   - **AEAD.** Relay AEAD is native ChaCha20-Poly1305 with SIMD.
8. **ace-media probes and says what it found.**
   - **The probe at start does bounded availability trials only.** Each backend opens a
     session and pushes one frame on a thread of its own, under a deadline (2 s, which covers a
     cold driver start). A trial past its deadline is cancelled and recorded as `timed-out`,
     and a late success is reported with `capabilities.changed`. `ready.capabilities` lists
     every step and codec with its backend, whether it is hardware, and whether its input is
     zero-copy. The probe never ranks backends.
   - **Ranking is a separate benchmark.** Choosing between two hardware encoders for the same
     GPU (Media Foundation's NVIDIA MFT or NVENC on Windows) uses a short benchmark. It runs
     only while nothing is being captured, is cancelled the moment a source opens, and its
     result is cached per adapter, driver version and encode settings. Until a result exists
     the choice is deterministic: the MFT on Windows, NVENC on Linux NVIDIA.
   - **Per source.** Each source reports each step's backend, whether it is hardware, and the
     copies it makes.
   - **Visible.** The live view carries one sentence only when a source is degraded: its video
     encode isn't on hardware, or a step that the probe found hardware for is running on the
     CPU. A step on the CPU because the machine has no hardware for it, such as JPEG on NVIDIA,
     is the expected path, not a fallback. `ace doctor` lists the whole table.
9. **Acceleration has acceptance numbers per platform,** in the plan's Benchmarks section.
   They are measured on the owner's Mac, on the Windows test VM (whose numbers are for the
   software fallback and are labelled as such), and on Linux machines with Intel, AMD and
   NVIDIA GPUs where available. Each row states, per step, the expected path for the machine's
   observed capabilities and the picture readbacks and uploads it may make. A bench fails when
   a step runs below its expected path or makes more copies than allowed. Columns whose machine,
   GPU and driver aren't pinned yet are targets, not guarantees.

## Consequences

- **NVIDIA Linux machines** get hardware encode instead of an encoder Chrome. The Chrome
  encoder remains only for machines with no hardware encoder at all, such as VMs.
- **Two more native API surfaces** to keep correct: NVENC/NVDEC and the hardware JPEG paths.
  Each sits behind the existing traits with a probe and a watchdog, so a quirk falls back
  instead of failing.
- **Hand-written NVIDIA bindings** must track the pinned API version. A driver too old for it
  means no `media-nv`, and the machine says so.
- **New benchmarks gate PRs.** On a machine that has the hardware, a quietly lost GPU path fails
  them.
