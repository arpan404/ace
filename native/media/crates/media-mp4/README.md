<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fragmented MP4

M3 writes init segments, one moof+mdat per GOP, and a video tfra/mfra at clean
stop. It has no dependencies or I/O. The recorder writes and flushes each returned
buffer once. Pointer and lease events remain a JSONL sidecar, as the media plan
requires. No metadata track is inserted.

Sources: ISO/IEC 14496-12 (movie, track, sample table, movie fragment and random
access boxes), ISO/IEC 14496-15 (avc1/avcC and hvc1/hvcC sample entries), and
[Opus in ISOBMFF](https://opus-codec.org/docs/opus_in_isobmff.html), sections
4.3 and 4.4. No implementation code from other media projects is used.

`Muxer::new` takes encoder configuration records. The caller supplies valid,
unchanging avcC/hvcC payloads and matching length-prefixed access units; codec
parsing and Annex B conversion belong to media-bitstream. Samples are in decode
order with no B pictures. Video timestamps use the supplied nonzero timescale;
Opus always uses 48 kHz. Timestamp origins are shared across tracks after scaling.

Call `fragment` with a complete GOP. The recorder keeps a GOP until the next
keyframe supplies its end timestamp, then flushes it. At stop it supplies an
explicit end timestamp. Durations come from consecutive timestamps, including
the explicit endpoint for the last sample. The API rejects interior keyframes,
so callers must split at every keyframe. Gaps retain their timestamps; every GOP,
including the first in a new part, must start with a keyframe. Errors leave the
part unchanged. `PartFull` means finish this part and retry the GOP in a new muxer.
The 512 MiB limit reserves space for the final index. The index uses absolute
file offsets, so the init segment must be written exactly once at offset zero.

Opus supports mapping family zero (mono/stereo), packets of at least 2.5 ms,
an explicit priming edit, and a conservative 32-packet roll recovery group
covering at least 80 ms. All audio packets are sync samples. Audio submitted
with a GOP must belong to that GOP; the recorder owns inter-track alignment.
Cuts after a complete moof+mdat keep all earlier fragments playable. On restart,
call `recovery_prefix` and truncate the file to that length before playback.
AVFoundation rejects an attached partial final mdat; recovery removes that pair. Clean stop requires `finish` once.

Public-API integration tests use an independent bounded reader. Fixed MP4 layout
vectors live in `tests/vectors`, inside M3's ownership boundary. There is no
TypeScript muxer to export vectors from. These tests check container structure
and payload preservation. Small H.264 and HEVC fixtures were generated from a
64 by 64 constant picture with VideoToolbox on this Mac, using the retained
`tests/vectors/generate.swift` script. The decoder smoke verifies all three
frames at clean stop and two retained frames after recovery of a cut third GOP.

The plan's `bench/mux` is the `mux` example, inside this crate's owned directory:

```sh
cd native/media
cargo run --release -p media-mp4 --example mux
```

It muxes 1,200 simulated seconds of 1080p60 at 16 Mbit/s, including part rollover.
It prints one JSON line and fails above 0.5% of a core. Busy single-thread wall
time conservatively bounds CPU use. It records initial load and core count;
load above twice the core count or `ACE_MEDIA_BENCH_REPORT_ONLY=1` disables
failure. Windows reports only because it has no portable load-average API.
The repository benchmark runner can invoke this example when that runner lands.

To repeat the native decoder smoke on macOS (no external media tools):

```sh
mkdir -p /tmp/ace-mp4-playback
ACE_MP4_PLAYBACK_DIR=/tmp/ace-mp4-playback cargo test -p media-mp4 platform_encoder_vectors
swift crates/media-mp4/tests/vectors/playback.swift /tmp/ace-mp4-playback
```
