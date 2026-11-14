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

- zune-jpeg 0.5 decodes with runtime-selected NEON/AVX2 support. Full decodes use
  reusable RGBA storage, avoiding intermediate RGB packing before SIMD resize.
- Where both requested sides fit a reduced DCT, jpeg-decoder uses 1/2, 1/4 or 1/8
  output. Reduced RGB storage stays RGB. The 1206×2622 to 722×1568 case exceeds
  half-size output, so it retains full decode resolution rather than upscaling.
- fast_image_resize 5 uses its detected CPU extensions and bilinear convolution.
  `CpuScaler::scale_reusing` recycles output storage and the resizer's scratch.
- libjpeg-turbo-rs 0.9.0 provides MIT/Apache-2.0 JPEG encoding with default integer
  DCT, runtime NEON/AVX2 dispatch and 4:2:0 output. The version is pinned. No C codec
  is linked. This replaces jpeg-encoder; the workspace license policy is unchanged.

`CpuJpegCodec::transcode_into` retains decode/resize scratch and caller-owned JPEG
capacity. Alpha is discarded during JPEG encoding. NV12 and platform surfaces need
backend colour conversion/readback. JPEG input is limited to 8192 per side and
32 Mi pixels before decoded allocation; EXIF orientation is not applied. Quality
accepts 1 through 100.

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

## Benchmarks and remaining gate

From native/media:

```sh
cargo run --release -p media-codec --example still -- --path cpu
cargo run --release -p media-codec --example still -- --path cpu --input capture.jpg
cargo run --release -p media-codec --example alloc
```

Both CPU benches use the same fixed 1206×2622 gradient JPEG as the original M5
measurement, output 722×1568 at q80, five warmups per worker and 50 samples. They
run on the fixed worker pool, count all Rust alloc/realloc calls across threads,
and fail on nonzero allocations or p95 above 20 ms on macOS (30 ms elsewhere).
The still bench additionally reports the native macOS comparison. The counting
allocator lives only in bench code; it cannot see mallocs inside OS frameworks.

Latest Mac16,5 result, eight workers, NEON resize and SIMD JPEG enabled:

| Path | Median | p95 | Mean decode / scale / encode |
| --- | --- | --- | --- |
| CPU | 12.676 ms | 19.509 ms | 6.978 / 3.794 / 2.332 ms |
| ImageIO | 29.139 ms | 76.782 ms | 12.025 / 18.142 / 5.315 ms |

The host was heavily contended (load averages above 600 on 16 logical cores), so
these are not quiet-host measurements. CPU p95 passes the revised 20 ms target;
the old 6 ms target was not met. F2's GPU target is not measured here.

**The zero-allocation acceptance gate still fails.** There are 2325 Rust allocations
per CPU frame after warm-up: 17 in decode, 2297 in resize, 11 in encode, zero outside
those stages. Frame slabs and inline plane metadata are reused, but the codec and
resize libraries still allocate internally. Output reuse alone cannot make this
pipeline allocation-free. A reusable decoder/encoder workspace and cached resize
plans (or replacement implementations with those public APIs) remain necessary.
`check:media` passes; that does not substitute for the failing allocation bench.
