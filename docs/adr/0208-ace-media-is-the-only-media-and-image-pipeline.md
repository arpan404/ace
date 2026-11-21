# 0208: ace-media is the only media and image pipeline

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
   - **The settings go entirely (owner, 2026-11-20).** The video pipeline is fully Rust. The
     settings keys `media.encode`, `media.delivery`, `media.recordings` and `media.stills`, the
     Settings › Beta media opt-in (web and iOS) and the setting-driven route table are removed,
     not just their `legacy` values; stored values are ignored. A separate cleanup (X5) does
     this once X2 and X3 have merged. Image jobs never depended on these settings, and never
     will: the image process starts on the first image job whatever is stored.
2. **ace-media also owns still images (X4).** Resizing and fitting, format conversion, decoding
   JPEG (baseline and progressive, with EXIF orientation), PNG, WebP, GIF (first frame), ICO
   (PNG entries and 24/32-bit bitmaps) and static SVG, compositing (device chrome, skins and body
   pieces, with masks), skin alpha, and icon images all move into ace-media. sharp and `Bun.Image`
   leave the code, every `package.json`, `bun.lock`, the desktop native-module lists and release
   staging. No TypeScript decodes or encodes pixels.
3. **Image work runs in a process of its own (owner, 2026-11-20, on review).** Image work must
   never be able to take down live video or recordings. One-shot jobs run in ace-media's image
   process, `ace-media --images --root <data dir>`, never in the media process: that one
   answers `image.job` with `unsupported`. The image process holds no sockets, secrets or video;
   its stdin and stdout are its only lane.
   - `image.job` carries one operation (`probe`, `fit`, `alpha` or `compose`) and its inputs:
     bytes in the frame's payload, a file ace wrote, or raw RGBA. The process answers once, with
     `image.done` (the image as its payload) or `image.failed` with a reason.
   - `image.cancel` withdraws a job: it leaves the queue at once, or stops at its next step.
   - The types are `media_wire::image` and `packages/media/src/image-wire.ts`, with shared
     fixtures in `native/media/vectors/control` and op vectors in `native/media/vectors/image`.
4. **Where the work runs.** The pure `media-image` crate decodes and encodes on M5's CPU codecs:
   ace's JPEG decoder and encoder (with `zune-jpeg` for streams it doesn't take), the SIMD
   resampler, `png`, `image-webp`, `gif` and `resvg` (scripts, text, raster images and outside
   references off). Every one passes `cargo deny` under the existing `deny.toml`, with no
   IJG-licensed or libjpeg code. A JPEG to JPEG fit with no turn and no alpha takes M5's planar
   transcode, never leaving YCbCr. The image process runs jobs on up to four threads sharing one
   queue. One-shot jobs don't use the hardware still paths: their inputs aren't video, and at
   these sizes an upload costs more than M5's CPU path takes.
5. **Bounds, and refusals with a reason.** Never filled with grey.
   - **Pixels**, from real callers: at most 50 million an input and 16,384 px a side (a
     48-megapixel phone photo is the largest picture ace is sent). Attachments are held to the
     40 million an upload may have, screenshots and frames to 16 Mi. Past its job's bound an
     input is refused (`too-large`) before its pixels are decoded, from its header.
   - **Memory.** Each job reserves what it will hold at its peak from a 768 MiB budget shared
     by the threads, before it decodes anything, and waits for room within its deadline. The
     estimate comes from headers alone: the decoded picture (an icon's largest entry, read from
     each entry's own header and refused where it disagrees with the directory), the scaler's
     rows and output, and the encoder's copies. A picture is scaled before it is turned upright,
     so a turn copies only the small result. A test measures real peaks against the
     reservation with a counting allocator. Codec buffers stay on a thread for the next job
     only for pictures up to 4 Mi pixels (about 15 MiB a thread). The process has a 1.5 GiB data
     limit (`RLIMIT_DATA`, on Linux), and the daemon kills it past 1.5 GiB resident on every OS
     where it can read another process's memory. Either ends the image process only.
   - **Queues.** The process holds at most 64 jobs, 32 of them waiting with at most 64 MiB of
     inputs, and at most 48 MiB of answers waiting for the daemon to read them. The daemon holds
     at most 32 MiB of inputs for jobs not yet answered. Past any of these a job is refused
     `busy`, never queued without bound.
   - **Files.** The root the daemon names is opened once, at start, and its handle kept. Every
     file input is walked from that handle one name at a time without following a link
     (`openat` with `O_NOFOLLOW`; on Windows `NtCreateFile` relative to the parent's handle,
     never following a reparse point), opened without blocking, and read only if it is a
     regular file. Each name must be plain: no `/`, `\`, `:` (a drive or an alternate data
     stream) or NUL, and not `.` or `..`: at most 32 MiB a file and 64 MiB a job. Hard links are not
     refused: inputs are files ace itself wrote under its data directory, and only ace writes
     there, so that is the accepted limit.
   - **Containers.** A JPEG with more than one frame header is refused, and its decoder must read
     the size its header was checked at. A JPEG without its end marker or with its entropy data
     cut short, a PNG that ends before IEND (one that ends after IHDR included), a GIF that ends
     before its trailer (one cut after a whole first frame included), and a WebP or ICO that
     ends early fail `truncated`, at probe as at decode. Bytes no decoder takes fail
     `unsupported`, and a decode error fails `decode-failed`.
   - An SVG over 4 MiB or rendered past 4,096 px a side is refused, and so is any output that
     wouldn't fit one frame.
   - A decoder that panics fails its job (`decode-failed`). A step that runs 10 s past its
     job's deadline ends the image process, which restarts.
   - Every refusal carries a sentence the caller can show.
6. **Supervision, on every OS.** The daemon supervises the image process on its own
   (`ImageProcess` in `@ace/media`), apart from the media process and whatever that one does on
   a platform: Windows included. One-shot jobs never block agent state.
   - **Lazy start.** The first image job starts it, and it stops 60 s after the last one.
   - **Unavailable** (no binary, or five failures in two minutes). Jobs fail at once with
     `unavailable` and the reason, for ten minutes.
   - **Exited mid-job.** Every job it held fails `exited`, and is not retried: an input that
     crashed it must not crash the next process too. Jobs that hadn't reached it wait for the
     restart (0.5 s backoff, doubling) within their deadlines.
   - **Deadlines and cancellation.** A frame carries only the time its job has left when it
     is sent, so a job that waited never reaches the process with a fresh deadline. The process
     checks it before every step, including before reading a file, probing or the planar path.
     At the deadline, or when the caller's `AbortSignal` fires, the job settles at once
     (`deadline` or `cancelled`). Its frame is taken off the lane if none of it was written;
     if part was, its bytes stay charged until it is written, and then `image.cancel` follows
     it. A result that arrives after that is dropped.
   - **Environment.** The image process gets none of the daemon's environment (its
     credentials, tokens and settings): only what the OS needs to start it (`SystemRoot`,
     `SystemDrive`, `windir`, `TEMP`, `TMP` on Windows; nothing elsewhere).
   - **What callers do.**
     - An attachment preview answers `unsupported` or `busy`, as an image it can't preview did.
     - An icon is "ask again later" (`later`) for any failure that may pass, and `none` for
       bytes refused for good.
     - A device screenshot fails with a stated `DeviceError`. Device chrome falls back to the
       plain screen, and a filmstrip is left out of the measurement.
     - An oversized model attachment goes as a file path with the reason, as it did when it
       couldn't be inlined. A turn's images share one 15 s fitting deadline; past it the rest
       go as paths, so slow fits never hold a turn up.
7. **Model attachments arrive within bounds.** An image attachment over an inline provider's
   remaining budget, or past the 8,000 px a side providers refuse, is fitted by ace-media (JPEG,
   at most 1,568 px a side, then smaller and coarser until it fits the remaining inline bytes)
   and inlined as that copy. The stored original is untouched. When no copy fits, or
   ace-media can't make one, the image goes as its path, as before. Path-reading providers
   (Codex, OpenCode) read the original.
8. **Tests and tools** decode through the same code: `ace-media --image [--root <dir>]` runs one
   job from stdin to stdout (the `image.job` frame in, the `image.done` or `image.failed` frame out). Tests
   that need real pixels run against the built binary (`ACE_MEDIA_TEST_BINARY`) from
   `check:media`.

## Consequences

- One decoder per format, in Rust, with bounds and refusals the daemon can state. The daemon's
  JavaScript thread does no pixel work at all, so a large image can't hold it up.
- The desktop app and releases ship no sharp or libvips. Packaging's native-module list loses an
  entry, and so do `verify-natives` and release staging.
- Every image feature needs ace-media's binary, not the media process: previews, icons, device
  chrome and screenshot fitting work on Windows even where the daemon doesn't run the media
  process there.
- A crash, a memory runaway or a hung decoder in image work costs the jobs in flight and a
  restart of the image process, never a live view or a recording.
- Text in a composite comes from a built-in bitmap font (digits, Latin capitals and a few
  signs): enough for the filmstrip's timings, and no system font lookup.
