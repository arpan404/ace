# 0003: Runtime and tooling

Date: 2026-10-02. Status: accepted.

## Decision

| Concern                  | Choice                                                                                       | Reason                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon runtime           | Node 24+                                                                                     | Electron ships Node, so the desktop app runs the daemon with no extra runtime. Built-in `node:sqlite`, mature `node-pty`, native TypeScript type stripping |
| Package manager, scripts | Bun                                                                                          | Fast installs and workspace scripts                                                                                                                        |
| Language                 | TypeScript, erasable syntax only                                                             | Node runs `.ts` directly; no build step for internal packages                                                                                              |
| Schemas                  | Zod 4                                                                                        | Works in Node, browsers and React Native; exports JSON Schema for non-TS consumers                                                                         |
| Effect                   | Not used                                                                                     | Heavy in mobile bundles and raises the bar for contributors. Process supervision uses plain TypeScript with `AbortController`                              |
| Tests                    | Vitest                                                                                       |                                                                                                                                                            |
| Lint, format             | oxlint, oxfmt                                                                                |                                                                                                                                                            |
| Clients                  | React (web and Electron share one bundle), Expo for mobile, a shared headless client package | Decided in detail when the clients are built                                                                                                               |

## Consequences

- Native modules (`node-pty`) must be built for Electron's Node ABI in desktop builds.
- Without Effect, structured concurrency is our own responsibility: every spawned process and stream gets an owner that cancels it.
