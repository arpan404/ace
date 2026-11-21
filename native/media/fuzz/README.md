<!-- SPDX-License-Identifier: Apache-2.0 -->

# media-codec and media-bitstream fuzzing

`transcode` feeds arbitrary bytes through `CpuJpegCodec` on one long-lived
instance. The first byte picks targets and quality. It checks that nothing
panics; that any accepted stream is also accepted by zune-jpeg (except valid
streams zune-jpeg 0.5 cannot read: header fill bytes, sampling factor 3); that output is a
JPEG of exactly the target size; that repeating a transcode after other work
gives identical bytes; and, for streams the baseline decoder owns, that luma
stays within 24 mean levels of zune-jpeg's.

Outside the media workspace, on nightly (pinned by `rust-toolchain.toml`):

```sh
cargo install cargo-fuzz
cargo run --bin seed_corpus            # rewrites corpus/transcode/seed-*
cargo fuzz run transcode corpus/transcode -- -max_total_time=600 -max_len=8192
```

Seeds cover grayscale, every sampling layout, odd edges, restart intervals,
progressive, arithmetic and CMYK fallbacks, malformed DHT/DQT/SOS, near-maximal
coefficients with impossible quantisers, and a truncated scan. Only `seed-*`
files are committed; libFuzzer's own discoveries stay local.

`bitstream` feeds arbitrary bytes to every media-bitstream reader (H.264 and HEVC parameter
sets and slice headers, `avcC`/`hvcC`, Annex B and length-prefixed framing). It checks that
nothing panics and that each accepted parameter set writes back to one that reads the same:

```sh
cargo fuzz run bitstream -- -max_total_time=600 -max_len=4096
```

The workspace tests run a seeded mutation sweep of the same property over the VideoToolbox
vectors (`crates/media-bitstream/tests/hostile.rs`) on every `check:media`.

`image` feeds arbitrary bytes to media-image (ADR 0208): probe, a fit and an alpha read under a
1 Mi-pixel bound. It checks that nothing panics, that probe never reports more than the bound
(so a crafted second frame header can't pass the check and size the decode), and that an
accepted fit fits its box. The image vectors make a good seed corpus:

```sh
cargo fuzz run image ../vectors/image/inputs -- -max_total_time=600 -max_len=65536
```
