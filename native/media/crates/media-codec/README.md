<!-- SPDX-License-Identifier: Apache-2.0 -->

# media-codec

Hardware-independent codec contracts and the CPU still fallback for M7 and the
platform backends. No runtime, device probing or clock reads in codec logic.

`Encoder` emits timestamped units at the configured size. Rate-only changes retain
queued output and the stream; codec/size changes owe a keyframe. Consumers call
`poll_result` to receive callback/process errors and `flush` to finish delayed
output. Backpressure means the picture was not accepted. `FakeEncoder` scripts
sizes and failures, emits requested keys, and sizes unscripted output from the
active rate. Its payload repeats the little-endian bitrate/QP, not playable video.
`FakeDecoder` returns black RGB pictures at the unit's size and PTS.

`PlatformPicture` owns its backend wrapper through `PlatformSurface`, including
any device/session needed to release it. The wrapper must uphold Send safely.
`CpuPicture` supports padded RGB, RGBA, BGRA and two-plane NV12; plane metadata is
inline. PTS and duration are caller-supplied microseconds. Source identity and
privacy epochs belong to the pipeline, outside the pixel buffer.

`JpegCodec` is the platform-capable JPEG trait for F2: decode can return a CPU or
platform picture at the requested dimensions. `StillCodec` provides full CPU
picture decoding and exact-size JPEG transcoding. `CpuJpegCodec` implements both.

## CPU path

The still path stays in YCbCr from decode to encode: no colour conversion, no
chroma upsampling or downsampling, no intermediate RGB copy.

- **Decode.** A baseline/extended-sequential Huffman decoder (1 or 3 components,
  any 1–4 sampling factors, restart intervals) writes Y, Cb and Cr planes directly.
  It picks the smallest of 1/8, 1/4 and 1/2 DCT output that still covers the target
  on both axes (`dct_scaled_size`), otherwise full size, so it never upscales. Full
  blocks use libjpeg-turbo-rs's runtime-selected NEON/AVX2 IDCT; reduced blocks use
  an N-point IDCT of the low-frequency coefficients. Progressive, arithmetic,
  12-bit, CMYK and multi-scan streams go to zune-jpeg instead (that fallback
  allocates).
- **Untrusted input.** Only bytes before the next marker count as entropy data.
  Running out early, an unexpected marker, data or non-one padding left before a
  restart, a wrong RSTn and a missing EOI are errors; a payload too small for the
  declared frame (two bits per block minimum) fails before any plane is sized.
  Coefficients keep baseline limits (DC category ≤ 11, AC ≤ 10, valid run/size,
  DC within ±2047) and a dequantised magnitude ≤ 2048, twice what 8-bit samples
  can produce. Zero quantisers, DC table symbols above 15, duplicate component
  ids, repeated scan selectors and partial spectra in sequential frames are
  rejected. Blocks decode in SOS order into SOF-ordered planes. `fuzz/` holds
  a cargo-fuzz target and seed corpus (see its README).
- **Resample.** Each plane is resampled separately with a triangle filter whose
  support widens with the scale. Taps are 14-bit fixed point, sum exactly to one
  and are rebuilt only when geometry changes. The vertical pass runs over whole
  rows, the horizontal pass over at most eight taps per sample. Chroma is mapped by
  its true extent, so odd sizes stay co-sited. On aarch64 the loops compile to NEON;
  on x86_64 both passes run inside an explicit AVX2 function when the CPU has it
  (`SimdKernel`); its assembly uses `vpmaddwd`/`vpmovzxbd` on ymm registers. A test
  checks the vector and scalar builds agree bit for bit.
- **Encode.** Baseline 4:2:0 (or grayscale) with the Annex K tables at the IJG
  quality scaling. Forward DCT and quantisation use libjpeg-turbo-rs's NEON/AVX2
  kernel with reciprocal divisors; the entropy coder writes into the caller's
  buffer. Tables are rebuilt only when quality changes. `jpeg_capacity` is the
  output bound the worker pool sizes its slabs with.

libjpeg-turbo-rs 0.9.0 is MIT OR Apache-2.0, pure Rust, no C linked; only its
public SIMD kernels, tables and marker writers are used, pinned at that version.
zune-jpeg is MIT OR Apache-2.0 OR Zlib. The workspace license policy is unchanged.

`CpuJpegCodec::encode_into` takes RGB, RGBA or BGRA pictures (alpha discarded),
converts them with full-range JFIF coefficients and averages each 2×2 block for
chroma. NV12 and platform surfaces need backend colour conversion/readback.
`CpuScaler` resamples packed pictures with the same filter; BGRA comes out as RGB.
JPEG input is limited to 8192 per side and 32 Mi pixels before any plane is sized;
EXIF orientation is not applied. Quality accepts 1 through 100.

`fit_size` uses nearest-even rounding (ties up, minimum two), no enlargement except
one pixel of rounding, and both side bounds. `fit_size_with_max_pixels` also honors
the still request's pixel budget. At extreme aspect ratios the minimum side is two
pixels. Adaptive scale, viewport policy and encode sharing remain in media-core.

## Workers and leases

`StillWorkers` is the thin I/O shell. M7 supplies physical core count and its
monotonic microsecond clock. It creates one worker per physical core minus one,
clamped to 1 through 8. Workers retain codec state. Work queues are bounded to one
waiting job per worker; input/output pools contain two slabs per worker. Input
leases reject growth past their configured capacity; submit rejects output sizes
that cannot fit the JPEG bound. Exhaustion returns backpressure and the caller
retains its input. Dropping leases returns slabs without growing the pool.

Jobs carry ids and deadlines. An expired queued job is skipped; an expired result
is discarded. A deadline does not interrupt a decoder already running. Results
include worker identity and optional stage timings from the injected clock. Drop
closes the queues and joins the fixed workers. All accepted jobs fit in the bounded
completion queue, so shutdown does not depend on a completion reader.

## macOS comparison

`MacJpegCodec` implements StillCodec using ImageIO/CoreGraphics. It can decode with
native DCT subsampling, resize in a reused bitmap context, and encode without a CPU
RGB readback; native JPEG output capacity is reused. Native objects stay owned.
The isolated unsafe boundary documents its lifetimes and exclusive mutable-buffer
Send implementation. This is not a hardware/GPU claim. Hardware JPEG belongs to F2.
The measured native path is slower here, so it is not the default CPU fallback.

## Benchmarks

From native/media:

```sh
cargo run --release -p media-codec --example still -- --path cpu
cargo run --release -p media-codec --example still -- --path cpu --input capture.jpg
cargo run --release -p media-codec --example alloc
```

Both CPU benches use the same fixed 1206×2622 gradient JPEG as the original M5
measurement, output 722×1568 at q80, five warmups per worker and 50 samples. They
run on the fixed worker pool, count every Rust alloc/realloc across threads, and
fail on any allocation after warm-up, on p95 above 20 ms on macOS (30 ms
elsewhere), or on scalar resampling where AVX2 exists. The still bench also runs
the native macOS comparison. The counting allocator lives only in bench code.

Mac16,5, eight workers, NEON, host load average about 20:

| Path    | Median    | p95       | Decode p50/p95 | Scale p50/p95 | Encode p50/p95   |
| ------- | --------- | --------- | -------------- | ------------- | ---------------- |
| CPU     | 6.176 ms  | 6.594 ms  | 2.621 / 2.779  | 1.720 / 1.779 | 1.835 / 2.059 ms |
| ImageIO | 16.865 ms | 20.851 ms | 6.170 mean     | 7.980 mean    | 3.044 mean       |

**Allocations: 0 per frame after warm-up** in every stage (decode, scale, encode)
and in the worker queues. The previous library-based path made 2325 per frame.
