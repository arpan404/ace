# ace

A multi-agent coding environment. ace drives the coding-agent CLIs you already have installed (Claude Code, Codex, OpenCode, Cursor, Antigravity, Pi) and gives them one interface on desktop, in the browser and on your phone.

Status: early development. The local daemon can store events and serve snapshots and replay over WebSocket. Provider execution and clients are still to come.

## How it fits together

- **Daemon** runs on the machine that has your code and your logged-in agent CLIs. It owns every agent process, the event log, git worktrees and terminals.
- **Clients** (desktop app, web app, mobile app) are views over the daemon's event log. They can connect locally or from another device.
- **Protocol**: every provider is translated into one canonical model. Agents form a tree, status is derived from the whole tree, and tool calls, approvals and background tasks are typed. See [docs/adr](docs/adr) and [docs/research/providers](docs/research/providers).

ace never asks for or stores your provider credentials. Each agent CLI uses the login you set up in that CLI.

## Repository layout

| Path                      | Purpose                                                                 |
| ------------------------- | ----------------------------------------------------------------------- |
| `apps/relay`              | Self-hosted WebSocket relay with encrypted outbound host/client streams |
| `packages/secure-channel` | Portable Noise XX handshake, ordered transport and static identity      |
| `apps/daemon`             | Local SQLite event store and authenticated WebSocket server             |
| `apps/web`                | React web client; the same bundle runs in the desktop app               |
| `apps/desktop`            | Electron shell: daemon supervision, notifications, in-app browser       |
| `packages/projection`     | Pure shared event folds for thread and sidebar views                    |
| `packages/git`            | Local Git worktrees, checkpoints, diffs and safe restore                |
| `packages/orchestrator`   | Multi-provider fan-out, races, pipelines and coordinator lanes          |
| `packages/review`         | Local diff comments, persistent anchors and structured agent fixes      |
| `packages/protocol`       | Canonical protocol: Zod schemas and types, no runtime logic             |
| `packages/agent-registry` | Official ACP catalog, approved local installations and source profiles  |
| `packages/provider-kit`   | Supervised provider processes, JSON-RPC, SSE and local CLI discovery    |
| `packages/workspace`      | Workspace file listing, reads, search and change subscriptions          |
| `packages/files`          | Streamed transfers, atomic workspace mutations, trash and artifacts     |
| `tools/recorder`          | Records raw provider sessions as fixtures for adapter contract tests    |
| `tools/dev`               | The development process runner behind `bun run dev`                     |
| `docs/adr`                | Architecture decision records                                           |
| `docs/research`           | Primary-source research behind the decisions                            |

The generated [protocol reference](docs/protocol/README.md) covers WebSocket messages, canonical events and built-in MCP tools. Regenerate it with `bun run docs:protocol`.

## Development

### Prerequisites

- **Bun** 1.3+ (package manager and script runner) and **Node 24+** (the daemon runtime).
- **macOS:** the Xcode Command Line Tools (`xcode-select --install`) for git, `cc` and `swiftc`
  (native addons and the screen helper). Full Xcode only for the iOS Simulator.
- **Optional:** the Android SDK (`ANDROID_HOME`) for emulators; Rust (`cargo`) to build the
  Windows or Linux screen helper.
- The provider CLIs you want to use, installed and logged in on their own (`claude`, `codex`,
  `opencode`, `agent`, …). ace never handles their credentials.

```sh
bun install
bun run check   # merge gate only: includes tests
```

### Commands

Every development command runs its processes side by side with prefixed logs (`daemon │`,
`web │`, `desktop │`). Ctrl-C stops all of them; a second Ctrl-C kills them.

| Command                          | What runs                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bun run dev`                    | The daemon in watch mode, the web Vite server, and Electron on the Vite URL (renderer HMR; main restarts)   |
| `bun run dev:web`                | The daemon and the web app in your browser; prints a `#token=` link for the dev daemon                      |
| `bun run dev:fake`               | The web app against the in-page fake daemon. No daemon, no providers                                        |
| `bun run dev:desktop:fake`       | Electron against the fake daemon                                                                            |
| `bun run daemon`                 | Only the daemon, in watch mode                                                                              |
| `bun run doctor`                 | The daemon's doctor checks against the dev data dir                                                         |
| `bun run desktop:build`          | An unsigned (ad-hoc signed) local app for this machine: macOS `.app` and dmg in `apps/desktop/dist/release` |
| `bun run desktop:package`        | The full platform package (see Packaging)                                                                   |
| `bun run desktop:rebuild-native` | node-pty compiled for Electron with `@electron/rebuild`                                                     |
| `bun run desktop:e2e`            | Playwright-for-Electron smoke test against the fake daemon (`ACE_E2E_ELECTRON=1`)                           |

**Dev data is isolated.** The dev daemon uses `ACE_HOME=.ace-dev/home` on port 4343, and
Electron keeps its window state, sessions and settings in `.ace-dev/electron`. Both are
git-ignored and never touch `~/.ace` or an installed app. Set `ACE_DEV_SEED=1` to copy the fake
daemon's demo threads into an empty dev store before the daemon starts
(`ACE_DEV_SEED=1 bun run dev`). Reset everything with `rm -rf .ace-dev`.

**Pointing the app at another daemon.** `bun run dev` attaches to the dev daemon and never
spawns one. The packaged app reuses a daemon already serving `ACE_HOME` (the CLI, or the login
service from `ace service install`) and only starts its bundled daemon when none answers. To use
a daemon on another machine, start the app with `ACE_DAEMON_URL=wss://host:port/` and
`ACE_DAEMON_TOKEN=<64 hex>` (or `ACE_DAEMON_TOKEN_FILE`); in the browser build, enter the
address and a paired-device token on the connection screen.

**node-pty and Electron.** node-pty 1.x is a Node-API addon, so its npm prebuilds load in
Electron's Node (ABI 149 in Electron 44) as well as in Node 24. The desktop app runs the daemon
with Electron's own Node (`ELECTRON_RUN_AS_NODE`), never inside the Electron main process. Linux
has no prebuilds: run `bun run desktop:rebuild-native` before `desktop:build` there, or whenever
`bun run doctor` reports that node-pty cannot load.

### Troubleshooting

- **Electron starts as plain Node** (`Cannot read properties of undefined (reading 'setPath')`):
  your shell exports `ELECTRON_RUN_AS_NODE=1` (some Electron-based terminals and tools do). The
  dev scripts strip it; unset it when you launch Electron yourself.
- **Port 4343 or 5173 is busy:** set `ACE_DEV_DAEMON_PORT` / `ACE_DEV_WEB_PORT`.
- **"Cannot acquire daemon lock":** another dev daemon owns `.ace-dev/home`. Stop it, or use
  `ACE_DEV_DIR=/tmp/ace-dev-2`.
- **The desktop window shows the connection screen:** the daemon had not published
  `.ace-dev/home/daemon-endpoint` within 15 seconds. The window reloads by itself once the daemon
  is up; check the `daemon │` lines meanwhile.
- **Screen helper skipped during a build:** the Swift (macOS) or Rust (Windows, Linux) toolchain
  is missing. The app works without it; screen and computer use stay off.

Tests run in separate unit and process projects with bounded concurrency. See
[process test reliability](docs/testing/process-tests.md) for the real-I/O suite
inventory, shared fixtures and validation record. The owner requires tests to
run only at merge; development verification uses the permitted static checks.

The daemon prints its URL and token-file path. See [startup and degraded services](docs/daemon/startup.md) for readiness and service diagnostics. Remote access is off by default. See [remote access](docs/daemon/remote-access.md) for LAN/Tailscale pairing, device scopes and the `ace` CLI. See [store and sync](docs/daemon/store-and-sync.md) for configuration, the development creator, the command port, and replay behavior.

Local generic ACP launch and registry wire APIs are described in [agent registry](packages/agent-registry/README.md). Arbitrary agents retain unknown authentication and limited visibility; compatibility profiles are source-based until separately approved recordings establish behavior.

Remote access relay setup and APIs are described in [encrypted relay](docs/relay/README.md).

### Packaging

`apps/desktop` is the Electron shell (ADR 0054). `bun run desktop:package` builds one
architecture, the host's, for the platform it runs on. `--arch arm64|x64` may name it and must
match the host: native code is built for the host, so release CI runs once per architecture on a
matching runner. The build stops, listing each problem, if a required native piece is missing or
any staged binary is built for another architecture.

- **macOS:** dmg and zip. Signed with `CSC_LINK`/`CSC_NAME` and notarized when `APPLE_API_KEY`,
  `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set. The screen helper ships as
  `Contents/Helpers/AceScreenHelper.app` (`dev.ace.screen-helper`), signed by
  `native/screen-helper/build.sh` and left untouched by the app's signing; its manifest is
  `Contents/Resources/screen-helper-manifest.json`. A full package signs the helper with the
  Developer ID Application identity named by `ACE_SCREEN_SIGN_IDENTITY` (or `CSC_NAME`) and a
  secure timestamp, and fails without one. That identity must already be in a keychain on the
  search list when the package command starts: the helper is signed during the build, before
  electron-builder imports `CSC_LINK` into its own temporary keychain. In CI, import the
  certificate first (`security create-keychain`, `security import … -T /usr/bin/codesign`,
  `security set-key-partition-list`, `security list-keychains -s`), then run
  `bun run desktop:package --full`.
- **Windows:** NSIS, with an "Open in ace" folder entry in Explorer. Windows runs no local daemon
  yet; it connects to a remote one.
- **Linux:** AppImage and deb. Launch at login is not available on Linux yet.

Each package carries the daemon bundle from `tools/release` (`Resources/daemon`), the pinned Node
runtime it runs on (`Resources/runtime`, the same one as the standalone archive), node-pty, koffi
and the other staged runtime packages, `rg` from `@vscode/ripgrep`, and the platform's screen
helper. Electron's `runAsNode` fuse is off. `ACE_RELEASE_PUBLIC_KEY_FILE` embeds the release
authority's Ed25519 key for update checks (ADR 0041); without it, update checks fail closed.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
