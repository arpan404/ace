<!-- SPDX-License-Identifier: Apache-2.0 -->

# media-codec fuzzing

`transcode` feeds arbitrary bytes through `CpuJpegCodec` on one long-lived
instance. The first byte picks targets and quality. It checks that nothing
panics; that any accepted stream is also accepted by zune-jpeg; that output is a
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
