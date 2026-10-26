# Linux screen helper

The agent computer-use engine (`--computer`: `screen_apps`, `screen_state`, `screen_act`) is
described in [COMPUTER.md](COMPUTER.md). The rest of this file covers the live-view session mode.

Rust helper for protocol v2, with v1 command compatibility. One process owns capture, input, a bounded AT-SPI ref cache and the private binary frame connection. No action invokes an executable. The daemon keeps the helper alive through stop/start and target inspection. One active capture is allowed per host helper.

It runs in Wayland sessions only: GNOME (Ubuntu 24.04+, Fedora, Debian 12/13), Hyprland (Omarchy) and KDE Plasma. An X11 session is refused with a sentence asking the person to log in to a Wayland session ([ADR 0049](../../docs/adr/0049-linux-screen-helper.md)).

## Build and install

On Debian or Ubuntu, install a Rust toolchain plus `build-essential libpipewire-0.3-dev libspa-0.2-dev`. Run `./build.sh` on x86_64 or aarch64 Linux. It produces one ELF executable that links glibc dynamically (release builds run in a Debian 12 container, so glibc 2.36 or newer). PipeWire is loaded from the session's installed `libpipewire-0.3.so.0`; its SPA modules must be installed. D-Bus, JPEG and Rust dependencies live in the binary. Do not claim portability to musl-only systems.

Install the release binary once at `DATA/helpers/screen-linux/x64/ace-screen-helper-linux` or `DATA/helpers/screen-linux/arm64/ace-screen-helper-linux`. Do not rebuild or overwrite it during daemon startup. `installedLinuxHelper()` resolves that stable path; `ACE_SCREEN_HELPER` can point at an explicitly installed development binary. Run `cargo test` for policy, protocol and token tests, and `cargo check --target x86_64-unknown-linux-gnu` for Linux Rust code from another host. A macOS cross-check does not link the C ABI shell; release linking occurs on Linux.

Launch with `--endpoint unix:/private/directory/frames.sock --restore-token DATA/screen-artifacts/portal/restore-token`. The daemon creates the directory with mode 0700 and socket with mode 0600; the helper rejects a non-private endpoint or another owner's socket. `--socket PATH` remains a v1 alias. Stdin/stdout carry newline JSON, at most 64 KiB per command/reply. `hello` negotiates capabilities. `start` supplies a session id, target, allowlist and fps 1..30. Only independently decodable JPEG is currently negotiated. Packet headers include v2 `seq`, `ts`, `scale`, dimensions, codec and payload length, plus v1 session/sequence/timestamp aliases for existing recordings. Stop releases the portal and PipeWire session; the daemon also stops capture after its last viewer leaves and queued input drains, unless agent control or recording remains active; stdin EOF shuts down the process.

## Session behavior

The helper needs `WAYLAND_DISPLAY`. No session produces a headless error, rather than an empty successful screenshot.

It uses one combined RemoteDesktop/ScreenCast session where the person can be given control (GNOME), and a watch-only ScreenCast session elsewhere (ADR 0049, Live view by desktop). The chooser controls the source and may prompt on first use, after revocation, or when the prior source disappears. Mode-0600 restore tokens are atomically replaced after every successful start. RemoteDesktop v2 or newer can persist consent; older backends are reported as nonpersistent. ScreenCast source bits report whether a backend supports windows and displays; granted device bits determine input support. GNOME and KDE differ by installed portal version, so the helper reports version, desktop, restoration and source/device support instead of promising identical behavior. KDE Plasma's RemoteDesktop portal ignores the source type and shares whole screens, so on KDE every capture is asked of ScreenCast alone: the person picks the window or screen in its chooser (with its own restore token, `screencast-restore-token` beside `restore-token`), only that is shown, and the session has no portal input, so the person watches and the agent acts through AT-SPI. Portals without RemoteDesktop (xdg-desktop-portal-hyprland) get the same ScreenCast-only session. Either way capabilities say `watchOnly` with the reason, and person input is refused with it. A stream whose `source_type` differs from what was asked for (a screen for a window, or a window for a screen) is refused. Accessibility is turned on for the session (`org.a11y.Status.IsEnabled`, as a screen reader does) when the helper connects, because Qt apps expose nothing until it is; their AT-SPI properties are read uncached, since Qt answers `GetAll` with an empty body. Idle PipeWire frames are compared before encoding, and no unchanged frame is emitted. The PipeWire loop blocks on session events and a stop pipe without a periodic wakeup.

Portals do not expose a window id or authenticate a source's application identity. Capture ids are therefore chooser hints, never claims of enforced target identity. AT-SPI independently scopes to the exact approved executable basename or desktop id, with one accessible application and one accessible window. This scope is reported in portal capabilities and can differ from the source the human selects. Multiple windows return a typed unsupported/ambiguous error; native semantic actions remain scoped to the approved application. A screen picked in the sharing dialog takes only the person's input.

AT-SPI refs use D-Bus unique names plus object paths. Cache size is 4096 refs with FIFO eviction; each action reads fresh properties. Traversal has depth 32, node 512, response 60 KiB and command deadline caps, and uses indexed children rather than fetching an unbounded subtree. `ui.find` visits at most 512 nodes and returns at most 128 results. `setValue` uses EditableText; `text.type` inserts Unicode at the focused editable element's caret without key simulation. Applications that expose no EditableText return `not_supported`. Password values are omitted. An action the element doesn't offer fails; there is no pointer fallback.

## Tests

- `cargo test`: protocol caps, the session check, portal source/device masks and versions, restore-token rotation, tree caps, endpoint ownership.
- `tests/computer/run-wayland.sh`, `run-live.sh`, `run-client-e2e.sh` and `run-kde.sh`: the helper against real GTK and Qt apps in throwaway headless GNOME Shell and KDE Plasma Wayland sessions (see COMPUTER.md).
- `apps/daemon/scripts/linux-e2e/run.sh [wayland|kde|hyprland|headless|all]`: the daemon's live view and computer use end to end, decoding what a viewer receives.

Real GNOME and KDE machines still need a person for first consent, restore, revocation, chooser cancel, display scaling (100%, 150%, 200%) and a PipeWire restart.
