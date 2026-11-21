<!-- SPDX-License-Identifier: Apache-2.0 -->

# Image vectors (ADR 0201)

`cases.json` lists one-shot image jobs over the files in `inputs/` and what ace-media must
answer: `done` (size, format and source as `image.done` reports them, with `pixels` as
`[x, y, [r, g, b, a], tolerance]` and `alpha` as `[x, y, value]` checked on the output's
pixels) or `failed` (the `image.failed` reason). An input is a file name, or
`{rgba, width, height}` for raw pixels. `media-image`'s `tests/vectors.rs` replays every case,
and `packages/media/src/images.process.test.ts` replays them against the built binary.
`make.sh` regenerates `inputs/` with ImageMagick.
