<!-- SPDX-License-Identifier: Apache-2.0 -->

# media-codec

Hardware-independent contracts for M7 and the platform backends. No runtime,
clock reads, device probing or hardware dependency.

`Encoder` accepts pictures at the configured size and emits timestamped units.
Rate-only changes retain queued output and the stream; codec/size changes owe a
keyframe. Call `poll_result` so callback and process failures can be reported.
`poll` is the plan's synchronous compatibility interface. `flush` finishes delayed
encoder output. Backends own their queue bounds and report `Backpressure` before
accepting a picture they cannot queue. No picture is accepted on an encode error.

`PlatformPicture` owns a backend resource wrapper through `PlatformSurface`.
Backends downcast their own wrappers; dropping them releases the resource. They
must implement Send safely, including device-thread dispatch where necessary.
The wrapper can retain the owning device/session for the surface's lifetime.
`CpuPicture` supports padded RGB, RGBA, BGRA and two-plane NV12. PTS is in
microseconds supplied by the caller. Encoded units additionally carry duration.
Epochs and source identities belong to the pipeline, outside the pixel buffer.

`FakeEncoder` scripts sizes and errors, emits the first frame and requested frames
as keys, and sizes unscripted units from the active rate. Its bytes repeat the
configured bitrate or QP in little-endian form. They are test data, not playable
H.264/HEVC. `FakeDecoder` returns black RGB pictures at the unit's size and PTS,
with optional injected errors.

Stills use zune-jpeg, fast_image_resize and jpeg-encoder. The CPU scaler returns
RGB, strips alpha and uses bilinear filtering. Platform surfaces and NV12 require
backend conversion/readback first. JPEG decoding ignores EXIF orientation; capture
sources supply oriented pixels. JPEG input is bounded to 8192 per side and 32 Mi
pixels before allocating decoded output. Quality accepts 1 through 100.
`fit_size` keeps the source aspect ratio within nearest-even rounding, avoids
upscaling except that an odd side may gain one pixel, and fits within both bounds.
`fit_size_with_max_pixels` also applies the still request's pixel budget.
At extreme aspect ratios the minimum side is two pixels. It does not implement
media-core's viewport, adaptive scale or encode-sharing policy.

From native/media:

```sh
cargo run --release -p media-codec --example still
cargo run --release -p media-codec --example still -- path/to/capture.jpg
```

`bench/still.rs` measures decode, scale to a 1568-pixel long side, and encode at
quality 80. With no path it generates a deterministic 1206 by 2622 gradient JPEG.
It warms up five times, then reports 50 samples and stage means. The M5 target is
6 ms; the current baseline on the build machine is 14.2 ms median (18.7 ms p95),
with means of 4.3 ms decode, 5.4 ms scale and 5.1 ms encode. This target is not met.
The shared K1 vectors are absent from the M0 base; geometry tests cover the
nearest-even rule and the portrait benchmark directly.
