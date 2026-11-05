# 0003: Runtime and tooling

Date: 2026-10-02. Status: accepted.

## Decision

| Concern                  | Choice                                                                                             | Reason                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon runtime           | Node 26+                                                                                           | Electron ships Node, so the desktop app runs the daemon with no extra runtime. Built-in `node:sqlite`, mature `node-pty`, native TypeScript type stripping |
| Package manager, scripts | Bun                                                                                                | Fast installs and workspace scripts                                                                                                                        |
| Language                 | TypeScript, erasable syntax only                                                                   | Node runs `.ts` directly; no build step for internal packages                                                                                              |
| Schemas                  | Zod 4                                                                                              | Works in Node, browsers and React Native; exports JSON Schema for non-TS consumers                                                                         |
| Effect                   | Not used                                                                                           | Heavy in mobile bundles and raises the bar for contributors. Process supervision uses plain TypeScript with `AbortController`                              |
| Tests                    | Vitest                                                                                             |                                                                                                                                                            |
| Lint, format             | oxlint, oxfmt                                                                                      |                                                                                                                                                            |
| Clients                  | React (web and Electron share one bundle), SwiftUI + shared @ace/client via JavaScriptCore for iOS | Native iOS decision and measured gate in ADR 0074                                                                                                          |

## Consequences

- Native modules (`node-pty`) must be built for Electron's Node ABI in desktop builds.
- Without Effect, structured concurrency is our own responsibility: every spawned process and stream gets an owner that cancels it.

## Amendment, 2026-10-12: native iOS spike

[ADR 0074](0074-native-ios-client.md) supersedes "Expo for mobile" with the requested
SwiftUI + shared `@ace/client` via JavaScriptCore architecture. This names the current
spike, not a passed shipping gate. Phase 1 remains held because stable 60/120 fps
rendering has not been established. An approach change requires the maintainer's
decision after reviewing the measurements.

2026-10-27: the minimum moves to Node 26, and releases pin Node 26.12.1
(then `tools/release/src/node-runtime.ts`). The pinned Node 24.13.0 crashed at exit with
0xC0000409 on Windows ARM64; Node 26 does not.

## Amendment, 2026-11-04: the daemon runs on Bun

Accepted by the owner. This supersedes the "Daemon runtime" row above.

- **The daemon runs on Bun 1.4.4.** Releases and the desktop app ship Bun
  (`bunVersion` in `tools/release/src/daemon-runtime.ts`) from Bun's pinned per-platform npm
  packages. x64 targets use Bun's baseline builds, which need no AVX2. Development starts the
  daemon with `bun --watch`.
- **Under Node's old names.** The runtime is installed as `bin/node` (`runtime/bin/node` in the
  desktop app) and `node.exe`. Launchers and updaters from earlier releases run
  `<release>/bin/node ace.mjs`, and Bun runs scripts the same way under that name.
- **Node code stays as it is.** The daemon keeps using `node:` modules; Bun-native APIs are
  later work. The one exception is terminals: node-pty's addon needs Node's libuv loop and
  reports neither output nor exit under Bun, so on Bun the terminal backends spawn through
  `Bun.spawn({ terminal })`. On Node they keep node-pty.
- **Images.** Raster images the daemon fits and re-encodes (Simulator frames, one-off device
  screenshots, attachment previews) go through Bun's own `Bun.Image`, behind
  `@ace/provider-kit/image`. Fitting a 1206×2622 Simulator frame to half size took 3.8–4.0 ms
  of CPU against sharp's 17.9–18.1 ms, with about 50 MiB less peak memory. sharp stays for what
  `Bun.Image` can't do: drawing SVG (icons, device art), raw pixel input and output (app icons,
  skin alpha masks) and compositing (device bodies, browser filmstrips).
  `Bun.Image` has no strict mode, so a JPEG cut short decodes to a partly grey picture. Device
  frames and screenshots an agent acts on are refused unless a marker walk finds every segment
  whole and the last scan running to the end-of-image marker that closes the bytes. That walk
  does not read coded data: a scan damaged inside whose end marker survives (cut, then closed
  with a fresh end marker) would still pass, and only a strict decoder could catch it.
  serve-sim's frames are cut at their advertised length and its encoder writes whole JPEGs, so
  that case needs a broken encoder, not a broken link. Attachment previews may show a partial
  picture.
- **Release builds still run on Node 26.12.1** (`nodeVersion`), which native addons are built
  against. They are Node-API, so the same binaries load in Bun.
- **Known Bun differences** that ace code has to respect:
  - `os.homedir()` keeps the `HOME` the process started with.
  - Run as `node`, Bun drops the first argument after `-e` code, so eval scripts take their
    inputs from the environment.
  - Bun's inspector speaks WebKit's protocol (`Heap.gc` rather than
    `HeapProfiler.collectGarbage`).
  - stdin destroyed in the same tick it was resumed keeps a Bun process alive, so helper
    processes exit with `process.exit` rather than by releasing stdin.
  - With `PATH=""`, Bun searches the system's default path where Node finds nothing.
  - After a spawn fails (ENOENT), Bun leaves `child.exitCode` null where Node sets the negative
    errno; code waits on the `error` or `close` event, never on `exitCode`.
  - A child's stdin reports `writableLength` as 0 however full its pipe is, emits `drain`
    before the callback of the write that drained, and may run a write's callback inside the
    write. Code counts unflushed bytes from write callbacks.
  - `Bun.Image` handles a JPEG cut short differently by version: 1.4.0 refuses it, 1.4.4 fills
    the missing data with grey and succeeds. Releases pin 1.4.4.
- **Measured** on the release bundle with the daemon benchmark's standard workload, two runs
  each on the same (shared) machine. Daemon CPU per turn is about the same (new thread 180–199
  vs 175–184 ms, same thread 107–111 vs 111–128 ms, long text 1,671–1,998 vs 1,553–1,915 ms).
  The footprint settles lower: 195–216 vs 163–182 MB after a minute idle, 286–287 vs 247–254 MB
  after same-thread turns. Idle CPU is a little higher (0.8–0.9% vs 1.0%), and so is the
  footprint just after start (209–228 vs 222–254 MB). `ace version` starts in 232 ms against
  Node's 323 ms.
- **Not compiled yet.** `bun build --compile` (with or without `--bytecode`) builds, but the
  binary cannot run: native addons (koffi, node-pty) are not found inside its embedded file
  system, and helpers launched through `process.execPath` and the worker files would need
  Bun-specific handling. That is part of the Bun-native follow-up.
