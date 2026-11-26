# The Rust daemon, built directly

ADR 0226's amendment of 2026-11-26 drops per-piece TypeScript bridges. ace's daemon becomes
`ace-daemon-bin`, a Rust program composed from the Rust crates. This file orders the work in
slices. Each slice is a daemon a real client can use for more than the slice before.

## What exists

| Area                   | Rust crate                                          | State (2026-11-26)                                             |
| ---------------------- | --------------------------------------------------- | -------------------------------------------------------------- |
| Store and writer       | `ace-store`, `ace-projection`                       | phases 1–3, 5.1–5.5 merged                                     |
| Wire schema            | `ace-protocol` (+ `ace-protocol-gen`)               | generated, checked fresh                                       |
| Reducer and validation | `ace-core`                                          | merged (E4)                                                    |
| Engine                 | `ace-engine`                                        | E5.1–E5.4c merged; E5.4d–f, E5.5–E5.10 to come                 |
| Processes              | `ace-supervisor`                                    | merged (E2a, E2b)                                              |
| Transport              | `ace-transport`                                     | T1a, T1b merged: loopback and remote listeners, TLS, WebSocket |
| Provider translators   | `ace-adapter-{claude,codex,cursor,opencode,acp,pi}` | E1 merged for all six                                          |
| Provider sessions      | same crates, `session/`                             | Pi, Codex .1–.4, ACP .1–.2, OpenCode .1, Claude .1–.3 merged   |
| Claude stream-json     | `agent-stream-json`                                 | merged                                                         |
| Git                    | `ace-git`                                           | G0–G2b merged, G2c in progress                                 |
| Devices                | `ace-devices`                                       | D1–D3.2 merged, D3.3–D3.4 in review                            |
| Media                  | `native/media` (`ace-media`, its own process)       | shipped                                                        |
| JSON exactness         | `ace-json`                                          | merged                                                         |
| CLI                    | `native/cli`                                        | the management CLI is Rust (ADR 0221)                          |

`ace-daemon-node` (the addon) and the TypeScript facades stay only until their TypeScript is
deleted; nothing new is added to them.

## What `ace-daemon-bin` must do that no crate does yet

From `apps/daemon/src/index.ts` and `services/service-order.ts` (about 60 services):
configuration, the home and its locks, the endpoint and token files, signals and shutdown, and the
service start order. The services split into these groups:

- **The wire to clients:** hello and authentication (T2), subscriptions and fan-out (T3), reads to
  the wire (T4), command lanes, HTTP routes (T5), relay (T6).
- **Threads and agents:** engine, sessions, transitions, agent registry, agent control, history,
  context, review, usage, notifications, thread address, thread organization, sidebar placement,
  activity reads, storage.
- **The person's setup:** settings, accounts, account management, provider statuses, provider
  login and installs, Cursor auth, models, commands, plugins, Suits, marketplace, Spade.
- **Projects and files:** projects, files, workspace actions, verify, source control (git),
  utility, icons, preview client, background ports.
- **Machines and tools:** MCP server and external MCP, machines, transfers, parcels, devices,
  screen, browser, user browser, browsing, media, automations.

## Slices

Each slice names what it adds, the TypeScript test files that prove it against `ace-daemon-bin`
(they drive a daemon over its endpoint), and what it needs. A slice starts when what it needs is
merged.

1. **The program and the wire's front door.**
   - Adds: configuration and environment, the home, its single-instance lock and stop ownership
     (ADR 0186, behaviour as the TS), the endpoint and token files, signals and shutdown, the
     store's open (`ace-store`, ADR 0170: no history-sized work at open) and its schema,
     generated from `apps/daemon/src/migrations.ts` so a home either daemon writes opens in the
     other, the process journal and its recovery (`ace-supervisor`: a previous run's verified
     orphans ended by evidence, what can't be proven left alone and counted), the transport's
     listeners serving in-process (no proxy), hello, authentication and device identity (T2), and
     `ace serve --json`.
   - Proof: `cold-start`, `remote-restart`, `late-setup`, the hello and auth server files, the
     exit codes, and `cross-mode.process` (one home booted alternately by both daemons).
     `daemon-unverified-startup` runs against the binary up to its `ace project list` line, which
     needs slice 2's command lanes and slice 5's projects; its stranded-group case is ported as
     this crate's program test, named for it.
   - Needs: what exists.
2. **A client can see its threads.**
   - Adds: subscriptions and fan-out (T3), sidebar placement, activity reads, reads to the wire
     (T4), thread address, and storage.
   - Proof: `subscription-*`, `subscription.process`, `sidebar-*`, `wire-*`, `frame-packing.process`.
     This is a read-only daemon over an existing home, booted alternately with the Bun daemon (the
     cross-mode run).
   - Needs: slice 1.
3. **A client can run an agent.**
   - Adds: the engine through E5.10, the provider sessions with their Rust shells (Pi, Codex, ACP,
     OpenCode, Cursor's host link, Claude), transitions, the agent registry, history, context,
     usage, and the command lanes.
   - Proof: the engine's process files, the adapters' session process files (with ace's fake
     CLIs), and the restart and recovery files.
   - Needs: slice 2 and E5.10.
4. **The person's setup.**
   - Adds: settings, accounts, account management, provider statuses, login and installs, models
     (including OpenCode's effort levels, see the fix on main), commands, plugins, Suits,
     marketplace, notifications.
   - Proof: their server and process files.
   - Needs: slice 1.
5. **Projects, files and git.**
   - Adds: projects, files, workspace actions, verify, source control on `ace-git` (G2c–G7),
     review, utility, icons, preview, background ports.
   - Needs: slice 1, and G-items as they land.
6. **Tools and machines.**
   - Adds: the MCP server (M1–M5), agent control, external MCP, devices (D4–D5), screen, browser and
     browsing, automations (A1–A4), machines, transfers, parcels, Spade.
   - Needs: slices 3 and 5.
7. **HTTP and relay.**
   - Adds: T5's routes and T6's relay.
   - Needs: slice 1.
8. **Default on.** ADR 0226's amended gate: every server and process file passes against
   `ace-daemon-bin` on macOS, Linux and the Windows VM, the cross-mode runs pass both ways,
   `bench:daemon` is no worse, and §8's rollback runs pass.

Slices 4, 5 and 7 only need slice 1, so they run in parallel with 2 and 3.

## Rules for every slice

- Port behaviour from the TypeScript, including today's error texts, codes and limits, and rule 17
  for every length.
- One responsibility per crate or module; the daemon crate composes, it doesn't hold logic.
- Prove with the TypeScript files above run against `ace-daemon-bin`, plus Rust tests ported from
  the TypeScript unit cases. A TypeScript file that can't run against a daemon has its cases ported
  as Rust tests, listed by name.
- No history-sized work at startup or on the main loop (ADR 0170).
- A home is never migrated by switching daemons. The Bun daemon and `ace-daemon-bin` must both open
  any home the other wrote.
