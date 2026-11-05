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
  later work. Two exceptions:
  - Terminals: node-pty's addon needs Node's libuv loop and reports neither output nor exit
    under Bun, so the terminal backends (POSIX and Windows ConPTY) spawn through
    `Bun.spawn({ terminal })`. node-pty is a development dependency, loaded only when a test
    opens a terminal on Node; releases and the desktop app ship none of it.
  - Native calls: C and Win32 functions are bound with `bun:ffi` through
    `@ace/provider-kit/bun-ffi`, not koffi. Two provider-kit files the desktop main process
    also bundles (`process-owner.ts`, `process-containment.ts`) keep a lazy koffi path for
    runtimes that are not Bun; the daemon never loads koffi, and the desktop bundle refuses a
    static `bun:ffi` import. bun:ffi has no variadic calls, so the one `openat` with `O_CREAT`
    goes through `@ace/workspace`'s add-on. bun:ffi calls run on the calling thread, so command
    discovery's filesystem calls run in their own worker (`packages/commands/src/posix-worker.ts`),
    where a stuck mount blocks only that worker.
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
  - Bun's `node:https` server ignores `SNICallback`, `addContext` and `setSecureContext`, and
    serves only its default certificate. Its `node:tls` server honours `SNICallback`. The remote
    listener therefore ends TLS in a `node:tls` server and hands each socket to a plain
    `node:http` server (`apps/daemon/src/sni-listener.ts`), so a ts.net name gets the Tailscale
    certificate and a renewed one applies to the next connection without a restart. That HTTP
    server never listens, so its own timeouts never run: the listener bounds the handshake, the
    first request and idle keep-alive connections itself, and destroys sockets whose handshake
    fails or stalls (neither runtime does that unasked). `Bun.serve`
    accepts a per-name `tls` array, but using it would mean leaving `node:http`'s request and
    upgrade handling, and a certificate change would mean restarting the server.
  - Bun reads a socket up to 512 KiB at a time whatever its high-water mark (Node: 64 KiB), and
    a paused socket can hold one such read. The preview relay splits reads larger than its
    window before they reach the stream mux.
  - Bun serves its own built-in `ws` in place of the npm package. It has no `maxFragments` or
    `maxBufferedChunks`; `maxPayload` still caps a message's size.
  - An error thrown in a worker reaches the parent with its `code` but without its name or other
    fields. A worker reports a failure the parent must recognise as a message.
  - Bun ignores a Worker's `resourceLimits`. The history reader's 128 MB heap limit holds only
    on Node, so on Bun a transcript that exhausts the reader grows the daemon instead. Not yet
    fixed.
  - Bun's `node:sqlite` cannot open a closed WAL database `readOnly`: it creates the missing
    `-shm` but not the `-wal`, where Node creates both. `@ace/provider-kit/sqlite`'s
    `DatabaseSync` probes a read-only open and, only after that failure, creates the empty `-wal`
    with the database's mode and retries; read-only opens go through it. It never opens the
    database file itself: closing any descriptor of it drops this process's POSIX locks on it.
  - After a failed spawn, the `close` event's signal is `undefined` rather than `null`; the
    spawn wrappers report `null`, so a probe of a missing command settles.
  - An error thrown inside an `unhandledRejection` listener, a `setImmediate` or a
    `process.nextTick` callback is reported but does not end the process; one thrown from a
    timer does. The daemon's rejection guard rethrows from a timer.
  - `realpath` of a Unix socket fails with `EOPNOTSUPP`.
  - `fs.promises.access` resolves `null`, not `undefined`.
  - A listen error keeps `code: "EADDRINUSE"` but has a different message.
  - There is no `gc` global behind `--expose-gc`; `Bun.gc(true)` collects.
  - `node:v8` has no `queryObjects`, and there is no `worker_threads` diagnostics channel.
    Workers don't inherit `--import` or `execArgv` preloads; Bun's Worker takes `preload`.
  - A `--` right after the script path is dropped from `process.argv`.
  - Stack frames of Bun's built-in code are named `native`.
  - A pending top-level await keeps a Bun process alive, so `beforeExit` never fires.
  - Replacing a function on a builtin module's object does not reach named imports
    (`syncBuiltinESMExports` does nothing), and plugins cannot replace builtin modules.
  - `net.Socket({ fd })` on a pipe descriptor writes without polling it: on a blocking
    descriptor a full pipe freezes the whole process, on a non-blocking one the write fails with
    `EAGAIN`. Pipes ace feeds itself are non-blocking on its side and written through Bun's
    `FileSink` (`Bun.file(fd).writer()`) on Bun, which does not close a descriptor it was given.
  - `fs.realpath` opens the final component, so it fails with `EACCES` on a file or folder the
    process can't read (mode 000, write- or execute-only) where `realpath(3)` resolves it. The
    workspace resolves such a leaf itself (`packages/workspace/src/realpath.ts`).
  - A child's stdin takes about 500 KB in one write before holding it back (Node: one 64 KB pipe
    buffer), reports `writableLength` 0, and has no `ref()` or `unref()`. Small writes to a child
    that has closed its stdin report success and are lost; only one too large for that buffer
    fails with `EPIPE`, so a JSON-RPC request to such a peer waits for its timeout rather than
    failing at once.
  - `node:sqlite`'s `backup()` copies the whole database in one synchronous step, so the event
    loop does not run until it finishes. Only the updater, a separate process from the daemon,
    takes such copies.
  - `process.getActiveResourcesInfo()` is always empty. Daemon health counts open file
    descriptors instead (`packages/diagnostics/src/open-resources.ts`).
  - An Error's `stack` is a data property formatted on first access, so even reading its
    descriptor runs `Error.prepareStackTrace` and can throw.
  - `fs.readdir` with `recursive: true` lists entries in no fixed order.
  - A Bun process whose stdout is a socket keeps a duplicate of it, so `closeSync(1)` alone does
    not end the stream its parent reads.
- **Tests on Bun.** `bun run test` and every tier run Vitest on Bun, then run the projects in
  `nodeProjects` (`scripts/test-tiers.ts`) in a second pass on Node and merge the timings: the
  `web` and `client-react` jsdom projects, whose code runs in browsers, and the suites in
  `nodeOnlySuites`. Those cover code that doesn't run on Bun in production (the Cloudflare
  Worker, whose wrangler test harness refuses Bun; the self-hosted relay server and the e2e
  launcher, which run on Node), or rely on hooks and limits only Node has. A single test that
  needs a Node-only API skips on Bun with a comment saying why; a whole file that does goes in
  `nodeOnlySuites`. Under Bun, test isolates drop
  `native` stack frames: Vitest looks them up as files and would read the repository's
  `native/` folder.
- **Measured** on the release bundle with the daemon benchmark's standard workload, two runs
  each on the same (shared) machine. Daemon CPU per turn is about the same (new thread 180–199
  vs 175–184 ms, same thread 107–111 vs 111–128 ms, long text 1,671–1,998 vs 1,553–1,915 ms).
  The footprint settles lower: 195–216 vs 163–182 MB after a minute idle, 286–287 vs 247–254 MB
  after same-thread turns. Idle CPU is a little higher (0.8–0.9% vs 1.0%), and so is the
  footprint just after start (209–228 vs 222–254 MB). `ace version` starts in 232 ms against
  Node's 323 ms.
- **Not compiled yet.** `bun build --compile` (with or without `--bytecode`) builds, but the
  binary cannot run: native addons (`descriptor.node`) are not found inside its embedded file
  system, and helpers launched through `process.execPath` and the worker files would need
  Bun-specific handling. That is part of the Bun-native follow-up.
