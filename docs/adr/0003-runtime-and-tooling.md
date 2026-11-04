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
- **Release builds still run on Node 26.12.1** (`nodeVersion`), which native addons are built
  against. They are Node-API, so the same binaries load in Bun.
- **Known Bun differences** that ace code has to respect:
  - `os.homedir()` keeps the `HOME` the process started with.
  - Run as `node`, Bun drops the first argument after `-e` code, so eval scripts take their
    inputs from the environment.
  - Bun's inspector speaks WebKit's protocol (`Heap.gc` rather than
    `HeapProfiler.collectGarbage`).
- **Measured** on the release bundle with the daemon benchmark's standard workload, on the same
  machine: daemon CPU per turn is the same within a few percent; memory footprint is about 25%
  lower idle and 12–24% lower under load. See the migration PR for the numbers.
