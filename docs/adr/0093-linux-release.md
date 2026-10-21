# 0093: Linux release, browser use and computer use

Date: 2026-10-20. Status: accepted, in progress.

## Context

ace has Linux code paths in most places (systemd user service, `/proc` process inspection,
XDG folders, a Rust screen helper), but nothing has shipped or run end to end on Linux:

- No workflow builds, smoke-tests or publishes a release for any platform. Linux natives
  (node-pty, the workspace addon, the terminal guardian, the screen helper) have never been
  built as release inputs, and a build on a current runner would require a recent glibc.
- Agent computer use on Linux falls back to the older session tools. The background engine
  (`screen_apps`, `screen_state`, `screen_act`, ADR 0087) exists only for macOS.
- Browser use works on Linux x64 only with system libraries installed by hand and the
  Ubuntu 23.10+ AppArmor user-namespace restriction switched off. Linux arm64 has no headless
  Chromium. The desktop's hidden "parking" window for unseen agent tabs is visible on Linux.
- Several desktop features do nothing or look wrong on Linux (login launch, tray icon, global
  shortcut on Wayland, the `ace` CLI shim under AppImage).

## Decision

### Targets and artifacts

Ship linux-x64 and linux-arm64, glibc only. Natives are built inside a Debian 11 (glibc 2.31)
container so one artifact runs on Ubuntu 20.04+, Debian 11+, Fedora, Arch and their
derivatives (Omarchy included). Musl is out of scope.

- Daemon archive (ADR 0041), now including the Linux screen helper at
  `helpers/ace-screen-helper-linux` beside the daemon bundle. The daemon uses
  `ACE_SCREEN_HELPER` when set (the desktop app sets it to its bundled copy), else that
  bundled path, so computer use works without the desktop app.
- Desktop app: AppImage, deb and tar.gz. The GUI executable is `ace-desktop` so it never
  collides with the `ace` CLI. The deb installs an AppArmor profile so Electron's and ace's
  Chromium sandbox work on Ubuntu 23.10+ without disabling the kernel restriction.
- The screen helper links glibc dynamically (static glibc plus `dlopen` of PipeWire is not
  reliable) and keeps PipeWire optional: computer use on X11 and accessibility never need it.
- A release workflow builds every target on its native runner (`ubuntu-24.04`,
  `ubuntu-24.04-arm`, macOS), runs the artifact smoke test, and uploads unsigned artifacts.
  Signing stays an offline step (ADR 0041). Publication accepts any non-empty subset of
  targets, so Linux can ship without waiting for macOS signing.

### Service

The systemd user unit (ADR 0041) is the Linux supervisor. The daemon reads the graphical
session's `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` from
the user manager at use time, so a service started before login still reaches the desktop.
Without a session, browser use runs headless and computer use reports that no desktop
session is available.

### Browser use

ace's Chrome stays the headless engine, pinned to Chrome for Testing on both Linux x64 and
arm64 (Chrome for Testing publishes linux-arm64 for the pinned version). A person may point
`ACE_CHROMIUM_PATH` at any Chromium on every platform; ace never picks a personal install
silently (ADR 0055).

Launch failures are reported with their cause: missing shared libraries (with the install
command for the detected distro), a blocked sandbox (with the one-time fix), running as root,
and a too-small `/dev/shm` (`--disable-dev-shm-usage`). Disabling the sandbox is an explicit
opt-in, never a silent fallback. `ace doctor` launches the real engine to check this.

The desktop parks unseen agent tabs without a visible window on Linux: parked views render
offscreen instead of in a transparent window, because Linux window managers ignore opacity
and off-screen positions.

### Computer use

The Linux screen helper gains a `--computer` mode that speaks the engine wire of ADR 0087
(`hello`, `apps`, `resolve`, `state`, `act`, `cancel`; `{id, op}` requests and
`{id, ok, result|error}` replies as JSON lines). The daemon starts `ComputerClient` on Linux
and registers the same three tools as on macOS.

- **App identity** is the desktop-file id (`org.gnome.TextEditor`, a Flatpak app id), taken
  from the process (`GIO_LAUNCHED_DESKTOP_FILE`, the systemd scope, `/.flatpak-info`), else
  matched through `StartupWMClass`/`WM_CLASS`, else the executable name. It fills the
  `bundleId` field. Installed apps come from `.desktop` files; launch uses `gio launch`.
- **Semantics first.** The tree, element ids and actions come from AT-SPI2, which works on
  X11 and Wayland and on covered windows: `DoAction`, `GrabFocus`, `EditableText`, `Text`
  selection, `Value`, `Selection`, menus pressed by path. The helper turns on
  `org.a11y.Status.IsEnabled` as screen readers do, so GTK, Qt, Chromium and Electron apps
  started afterwards expose their trees.
- **Raw input needs the window in front.** Linux has no reliable way to post keys or pointer
  events to a background window. Key presses, x,y clicks, drags and pixel scrolls are
  delivered with XTest on X11 or the RemoteDesktop portal on Wayland, only while the target
  window is active. Otherwise the step fails with a message telling the agent to add an
  `activate` step. Typing into a field uses AT-SPI text insertion and needs no focus.
  The `cmd` modifier means Control on Linux, so shortcuts keep their intent across
  platforms.
- **Screenshots.** X11 captures the target window (Composite when available, so covered
  windows still capture), scaled to the engine's 1568 px / 1.15 MP limit with id marks.
  Wayland uses the ScreenCast portal with a persisted restore token; until the person has
  granted it, `state` returns the outline with a `screenshotError` explaining how to grant it.
- **Policy.** The built-in block list gains Linux terminals, password managers, polkit and
  pinentry prompts, and ace's own desktop app.

The session tools stay for the person's live view and remain the fallback on Windows.

### Desktop

Login launch writes an XDG autostart entry. The tray uses a colour icon on Linux. The global
shortcut uses the GlobalShortcuts portal on Wayland. The `ace` CLI shim detects AppImage and
points at the stable AppImage path, not its temporary mount.

**Releases and updates.** Linux desktop releases go through the same `release.ts build` and
`publish` as macOS (ADR 0091), run in the Debian 11 container on a host of each
architecture, unsigned. They publish an AppImage, a deb and a tar.gz under one naming
scheme (`ace-<version>-<arch>.<ext>`) with `latest-linux.yml` / `latest-linux-arm64.yml`.

- The AppImage updates itself in place through electron-updater, like macOS and Windows.
- A deb install is offered the release page (`inPlace: false`): replacing files that dpkg
  owns from inside the app would leave the package database wrong. It updates by installing
  the new deb; an apt repository can make that automatic later.
- A tar.gz install is offered the release page too: it has no installer to update through.

## Testing

Linux verification runs in a local Ubuntu 26.04 arm64 VM (Lima) and on CI's x64 and arm64
runners: the helper against Xvfb, Openbox and GTK apps with the accessibility bus; the
browser engine with and without the sandbox restriction; the daemon archive smoke test; and
the desktop AppImage under a headless GNOME Wayland session. Arch with Hyprland (Omarchy)
is checked manually before the first release: AT-SPI outline and actions, portal capture,
and the AppImage.

## Consequences

- Linux computer use is weaker than macOS for apps with poor accessibility: raw keys and
  clicks interrupt the person because they need the window in front.
- On Wayland the person grants screen capture once per session type through the portal
  chooser; ace never bypasses it.
- First releases are unsigned on Linux; integrity comes from the Ed25519-signed manifest
  (ADR 0041) and pinned checksums.
