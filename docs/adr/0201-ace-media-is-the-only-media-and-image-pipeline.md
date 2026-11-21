# 0201: ace-media is the only media and image pipeline

Status: accepted. Date: 2026-11-20. Decided by: the owner. Amends
[ADR 0147](0147-ace-media-rust-media-pipeline.md) (its phases and the deletion gate) and
[ADR 0148](0148-ace-media-gpu-accelerated.md) (the CPU still path also serves one-shot images).
Builds on [ADR 0125](0125-validate-at-trust-boundaries.md). The build plan is
[docs/media/plan.md](../media/plan.md) (Wave 7 and "Images").

## Context

ADR 0147 shipped each phase behind a `media.*` setting with a `legacy` value, and the plan's
Wave 7 deleted the TypeScript paths only after a release had shipped with `auto` as the default,
needed no fallback, and passed Q1 on that release.

Apart from video, the daemon still had its own still-image pipeline in TypeScript:

- `Bun.Image` (`@ace/provider-kit/image`) fitted and re-encoded attachment previews, one-off
  device screenshots and Simulator frames. It fills a cut-short JPEG with grey, so every caller
  had to check for the end marker itself.
- sharp (libvips, a native module shipped in every desktop package and release) rasterised SVG
  device chrome and Simulator bodies, composited body pieces, read skin alpha for Android
  emulators, made icons (favicons, app icons) and drew the measurement filmstrip.
- `favicon-image.ts` decoded Windows icon bitmaps by hand.

Two image decoders, a third for video stills, and a native module with its own licence and
packaging rules, for work ace-media already does faster (F2: 6.2 ms for a 1206 × 2622 JPEG to
1568 px on M5's CPU path, against about 10 ms through `Bun.Image`).

## Decision

1. **The release gate is lifted (2026-11-20).** The owner decided not to wait for the Wave 7
   release: `legacy` is removed now for `media.encode`, `media.delivery`, `media.recordings` and
   `media.stills`, and a stored `legacy` reads as `auto`. ace-media is the only media path. The
   Wave 7 deletions (X1, X2, X3) land in one batch with this ADR. The acceptance tests each X row
   names still apply. Only the "after a release" condition is dropped.
2. **ace-media also owns still images (X4).** Resizing and fitting, format conversion, decoding
   JPEG (baseline and progressive, with EXIF orientation), PNG, WebP, GIF (first frame), ICO
   (PNG entries and 24/32-bit bitmaps) and static SVG, compositing (device chrome, skins and body
   pieces, with masks), skin alpha, and icon images all move into ace-media. sharp and `Bun.Image`
   leave the code, every `package.json`, `bun.lock`, the desktop native-module lists and release
   staging. No TypeScript decodes or encodes pixels.
3. **One-shot image jobs are control messages.** `image.job` (normal lane) carries one operation
   (`probe`, `fit`, `alpha` or `compose`) and its inputs: bytes in the frame's payload, a file
   ace wrote, or raw RGBA. ace-media answers once, with `image.done` (the encoded image as its
   payload) or `image.failed` with a reason. `image.cancel` withdraws a job; its result is
   dropped. The types are `media_wire::image` and `packages/media/src/image-wire.ts`, with shared
   fixtures in `native/media/vectors/control` and op vectors in `native/media/vectors/image`.
4. **Where the work runs.** The pure `media-image` crate decodes and encodes on M5's CPU codecs:
   ace's JPEG decoder and encoder (with `zune-jpeg` for streams it doesn't take), the SIMD
   resampler, `png`, `image-webp`, `gif` and `resvg` (scripts, text, raster images and outside
   references off). Every one passes `cargo deny` under the existing `deny.toml`, with no
   IJG-licensed or libjpeg code. A JPEG to JPEG fit with no turn and no alpha takes M5's planar
   transcode, never leaving YCbCr. Jobs run on a fixed pool of image threads, separate from the
   still makers and never on the tokio threads. One-shot jobs don't use the hardware still paths:
   their inputs aren't video, and at these sizes an upload costs more than M5's CPU path takes.
5. **Bounds, and refusals with a reason.** Never filled with grey.
   - An input over its byte bound (32 MiB for a file, the 8 MiB frame for a payload), over the
     job's `maxPixels`, over 16,384 px a side or over 64 Mi pixels is refused (`too-large`).
     It is refused before its pixels are decoded wherever the header gives the size.
   - An SVG over 4 MiB or rendered past 4,096 px a side is refused too, and so is any output
     that wouldn't fit one frame.
   - A JPEG without its end marker or with its entropy data cut short, or a PNG, GIF, WebP or ICO
     that ends early, fails `truncated`. Bytes no decoder takes fail `unsupported`, and a decode
     error fails `decode-failed`.
   - A decoder that panics is caught on its thread and fails the job (`decode-failed`). It never
     takes ace-media down.
   - Every refusal carries a sentence the caller can show.
6. **When ace-media is starting, unavailable or crashed.** The daemon's `MediaImages` client
   holds these rules. One-shot jobs never block agent state.
   - **Lazy start, regardless of settings.** A job takes a use of the supervisor
     (`MediaSupervisor.require()`), so ace-media starts on the first image even if nothing else
     wants it, and stops 60 s after the last use.
   - **Starting.** Jobs wait (at most 32) until both lanes are up. The job's own deadline covers
     the start, so a slow start shows up as `deadline`, never as a hang.
   - **Unavailable** (no binary, crash loop, exit 2, a platform where the daemon doesn't run
     ace-media yet). Jobs fail at once with `unavailable` and the supervisor's reason.
   - **Exited mid-job.** Every job ace-media held fails `exited`. It is not retried: an input
     that crashed ace-media must not crash the next process too.
   - **Deadlines and cancellation.** Each job carries `deadlineMs`, and ace-media checks it
     before each step. At the deadline, or when the caller's `AbortSignal` fires, the daemon
     sends `image.cancel` and settles the job at once (`deadline` or `cancelled`). A result
     that arrives after that is dropped.
   - **What callers do.**
     - An attachment preview answers `unsupported` or `busy`, as an image it can't preview did.
     - An icon is "ask again later" (`later`) for any failure that may pass, and `none` for
       bytes refused for good.
     - A device screenshot fails with a stated `DeviceError`. Device chrome falls back to the
       plain screen, and a filmstrip is left out of the measurement.
     - An oversized model attachment goes as a file path with the reason, as it did when it
       couldn't be inlined.
7. **Model attachments arrive within bounds.** An image attachment over an inline provider's
   remaining budget, or past the 8,000 px a side providers refuse, is fitted by ace-media (JPEG,
   at most 1,568 px a side, then smaller and coarser until it fits the remaining inline bytes)
   and inlined as that copy. The stored original is untouched. When no copy fits, or
   ace-media can't make one, the image goes as its path, as before. Path-reading providers
   (Codex, OpenCode) read the original.
8. **Tests and tools** decode through the same code: `ace-media --image` runs one job from
   stdin to stdout (the `image.job` frame in, the `image.done` or `image.failed` frame out). Tests
   that need real pixels run against the built binary (`ACE_MEDIA_TEST_BINARY`) from
   `check:media`.

## Consequences

- One decoder per format, in Rust, with bounds and refusals the daemon can state. The daemon's
  JavaScript thread does no pixel work at all, so a large image can't hold it up.
- The desktop app and releases ship no sharp or libvips. Packaging's native-module list loses an
  entry, and so do `verify-natives` and release staging.
- Every image feature now needs ace-media. Where the daemon doesn't run it (Windows, until
  `createMedia` starts it there), previews, icons, device chrome and screenshot fitting fail
  with `unavailable` and the reason, and the callers above degrade. Starting ace-media on Windows
  is the follow-up that closes this.
- Text in a composite comes from a built-in bitmap font (digits, Latin capitals and a few
  signs): enough for the filmstrip's timings, and no system font lookup.
