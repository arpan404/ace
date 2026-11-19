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

Ship linux-x64 and linux-arm64, glibc only. Natives are built inside a Debian 12 (glibc 2.36)
container so one artifact runs on every supported system. Musl is out of scope.

**Supported systems (revised 2026-10-25).** Modern Ubuntu (24.04 LTS and newer), Fedora,
Debian (12 and 13) and Omarchy (Arch with Hyprland), each in its default Wayland session:
GNOME on Ubuntu, Fedora and Debian, Hyprland on Omarchy. KDE Plasma on Wayland works too and
is tested, at lower priority. X11 sessions, Sway and other wlroots desktops, older releases
(Ubuntu 20.04 and 22.04, Debian 11) and other distribution families (openSUSE) are not
supported: their code, test sessions and install hints are removed rather than kept
untested. The first revision of this ADR built on Debian 11 for Ubuntu 20.04+; Debian 11 has
since left the regular mirrors, and none of the supported systems needs a glibc that old.

- Daemon archive (ADR 0041), now including the Linux screen helper at
  `helpers/ace-screen-helper-linux` beside the daemon bundle. The daemon uses
  `ACE_SCREEN_HELPER` when set (the desktop app sets it to its bundled copy), else that
  bundled path, so computer use works without the desktop app.
- Desktop app: AppImage, deb and tar.gz. The GUI executable is `ace-desktop` so it never
  collides with the `ace` CLI. The deb installs an AppArmor profile so Electron's and ace's
  Chromium sandbox work on Ubuntu 23.10+ without disabling the kernel restriction.
- The screen helper links glibc dynamically (static glibc plus `dlopen` of PipeWire is not
  reliable) and loads the session's PipeWire: accessibility never needs it, screenshots and
  live view do.
- A release workflow builds every target on its native runner (`ubuntu-24.04`,
  `ubuntu-24.04-arm`, macOS), runs the artifact smoke test, and uploads unsigned artifacts.
  Signing stays an offline step (ADR 0041). Publication accepts any non-empty subset of
  targets, so Linux can ship without waiting for macOS signing.

### Service

The systemd user unit (ADR 0041) is the Linux supervisor. The daemon reads the graphical
session's `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` (and
`DISPLAY` for XWayland apps) from the user manager at use time, so a service started before
login still reaches the desktop. Without a session, browser use runs headless and computer use
reports that no desktop session is available; in an X11 session it asks for a Wayland login.

### Browser use

ace's Chrome stays the headless engine. Linux x64 and arm64 both use the pinned Chrome for
Testing build: Chrome for Testing publishes `linux-arm64` from 153.0.8001.0, so the arm64 pin
is the same 153.0.8010.12 with the same checksum discipline (publisher MD5 plus immutable
Google Storage generation). Playwright 1.63 downloads this same object for arm64, and distro
packages were rejected: Debian's `chromium` is a moving security version, and Ubuntu's
`chromium-browser` is a snap whose confinement refuses hidden profile directories such as
`~/.ace`. A person may point `ACE_CHROMIUM_PATH` (the daemon's environment) at any Chromium on
every platform; the daemon never picks a personal installation by itself.

Launch failures are reported with their cause, to the agent as a public code and in the
daemon log with Chrome's own words: missing shared libraries (`browser_missing_libraries`,
naming them and the install command for the distribution family from `/etc/os-release`), a
blocked sandbox (`browser_sandbox_blocked`: AppArmor's user-namespace restriction, disabled
user namespaces, or running as root). `/dev/shm` under 512 MB adds `--disable-dev-shm-usage`.
Disabling the sandbox is an explicit opt-in, `ACE_CHROMIUM_NO_SANDBOX=1`, never a silent
fallback. The AppArmor profile (unconfined plus `userns`, attached to
`@{HOME}/.ace/chromium/*/chrome-linux{64,-arm64}/chrome`) is defined once in
`@ace/browser/linux-sandbox`; the deb installs it and `ace doctor --fix` installs it (see
below). `ace doctor` starts the real engine (`--version`, then a bounded headless start; the
`chromium` check's own budget is 25 s, above the 5 s default) to check all of this. The Chromium process guardian reads `/proc` on Linux, so it works
without procps.

The desktop parks unseen agent tabs without a visible window on Linux. A never-shown,
minimized or fully clipped window gets no frames on Linux, and offscreen rendering is fixed
when a tab is created, so parked views keep their full size inside a 1×1 parking window: a
view larger than its window is clipped but keeps rendering. Wayland has no window shapes, so
one pixel remains. macOS and Windows keep the transparent window.

### Computer use

The Linux screen helper gains a `--computer` mode that speaks the engine wire of ADR 0087
(`hello`, `apps`, `resolve`, `state`, `act`, `cancel`; `{id, op}` requests and
`{id, ok, result|error}` replies as JSON lines). The daemon starts `ComputerClient` on Linux
and registers the same three tools as on macOS.

- **App identity** is the desktop-file id (`org.gnome.TextEditor`, a Flatpak app id), taken
  from the process (`GIO_LAUNCHED_DESKTOP_FILE`, the systemd scope, `/.flatpak-info`), else
  matched through the accessible app name, else the executable name. It fills the
  `bundleId` field. Installed apps come from `.desktop` files; launch uses `gio launch`.
- **Semantics first.** The tree, element ids and actions come from AT-SPI2, which works on
  background and covered windows: `DoAction`, `GrabFocus`, `EditableText`, `Text`
  selection, `Value`, `Selection`, menus pressed by path. The helper turns on
  `org.a11y.Status.IsEnabled` as screen readers do, so GTK, Qt, Chromium and Electron apps
  started afterwards expose their trees.
- **No raw input, so accessibility stands in for it (revised 2026-10-26).** Wayland gives no
  program a way to send keys or pointer events to another app's window (the RemoteDesktop portal
  is the person's, granted in its dialog for a live view, and its input lands wherever the
  person's pointer would). So steps the macOS engine posts are done through AT-SPI, in the
  background: an x,y click is the clickable element under that screenshot pixel; an x,y scroll
  moves the scroll bar there; a shortcut presses the menu item whose accelerator it is; ctrl+C/X/V
  use the text's own clipboard calls; Tab inserts a tab or moves the focus. Hover and drags are
  refused with the steps that work. The `cmd` modifier means Control on Linux, so shortcuts keep
  their intent across platforms.
- **Typing in front (2026-10-26).** Chromium's Linux accessibility has no EditableText, so
  Chrome and Electron apps (VS Code, Slack) take no typed text in the background. A batch that
  starts with `activate` may type into them, and press keys with no accessible equivalent, with
  a keyboard-only RemoteDesktop portal session: the person allows the keyboard once in the
  portal's dialog (remembered with a restore token), the session is open only while that batch
  types, and before every few keys the app's window must be the active one with the field
  focused, so keys never reach another window. It never starts within 1.5 s of the person's own
  input. GNOME and KDE have the portal; Hyprland's has no RemoteDesktop, so there these apps stay
  untypable. Compositor IPC and virtual input devices (uinput) were rejected: both bypass the
  person's consent that the portal asks for. Chromium's remote debugging port was rejected too:
  any local program could drive the person's signed-in browser through it.
- **Apps that hide their tree.** Chromium-based apps (Chrome, Electron apps such as VS Code) show
  their tree only when started with `--force-renderer-accessibility`, so ace starts them with it
  and tells the agent to have the person quit one running without it. Apps that read the
  session's accessibility only at start (Firefox) are reported the same way, and the daemon turns
  accessibility on as soon as computer use is on. LibreOffice's modules, one process, are told
  apart by their windows' titles.
- **Screenshots** use the ScreenCast portal with a persisted restore token, scaled to the
  engine's 1568 px / 1.15 MP limit with id marks. Until the person has granted it, `state`
  returns the outline with a `screenshotError` explaining how to grant it.
- **The person wins (revised 2026-10-25).** As on macOS, an action is refused while the person
  is using that control or window (`person_active`), looks report a locked or absent session,
  and the desktop is kept awake during a batch and kept from suspending for a five-minute
  lease. Wayland allows neither the macOS Esc (GNOME's keyboard monitor serves only Orca's bus
  name) nor a marker over the target window, so both become one desktop notification, "ace is
  using <app>", whose Stop ends the agent's work (`stopped_by_person`). See the helper's
  COMPUTER.md, "The person".
- **Policy.** The built-in block list gains Linux terminals, password managers, polkit and
  pinentry prompts, and ace's own desktop app.

The session tools stay for the person's live view and remain the fallback on Windows.

### Desktop

**Chromium's sandbox without a package.** Ubuntu 23.10+ grants user namespaces only under an
AppArmor profile with `userns` (Ubuntu's 24.04 notes and Chromium's
`docs/security/apparmor-userns-restrictions.md` recommend an `unconfined` profile for this).
The deb installs one; an AppImage and an extracted tar.gz have no installer. The setuid
`chrome-sandbox` can't help them: a FUSE mount is `nosuid`, and Chromium ignores
`CHROME_DEVEL_SANDBOX` while a `chrome-sandbox` sits beside the executable
(`setuid_sandbox_host.cc`). So:

- Their launchers keep the app starting: the AppImage's AppRun and the tar.gz's own
  `ace-desktop` launcher (Electron is `ace-desktop-bin` beside it) probe `unshare -Ur` and add
  `--no-sandbox` only where it fails. Without the launcher Electron aborts at start there.
- The app then says in one sentence what is off and offers **Set up sandbox**: pkexec (or
  systemd's run0) runs a fixed root script that writes and loads a per-user profile attached
  to this copy, plus `ace-chromium` exactly as `ace doctor --fix` installs it (one root script
  in `@ace/browser/linux-sandbox` serves both). An AppImage's profile
  attaches to the AppImage file; everything it starts keeps that profile (an unconfined
  profile's children stay in it unless another attaches, `security/apparmor/domain.c`), so
  AppRun's probe passes. A versioned file name also covers `ace-*.AppImage` in its folder,
  the names electron-updater gives updates. A tar.gz's profile attaches to its launcher and
  Electron. After a restart (asked like an update's) the sandbox is on. The restart can't use
  `app.relaunch`: its waiting helper is the Electron binary, which in an AppImage is on the
  FUSE mount that disappears with the app. A detached shell from the host waits for the app's
  exit (EOF on a pipe only the app holds), closes every inherited descriptor above stderr
  (Chromium leaves IndexedDB locks, the old mount and the devtools socket open across exec),
  then starts the AppImage or the tar.gz launcher. Without a prompt, or if it fails, the same
  setup is offered as commands to copy. ace never disables the kernel restriction and never
  runs without the sandbox silently.
- Cursor's sandbox helper (`cursorsandbox`, Auto review) creates user namespaces too, so the
  same restriction blocks it whatever the glibc. Under the desktop app it inherits the app's
  profile (the deb's, or the one the setup installs). A standalone daemon has no app profile:
  `ace doctor` runs the helper's own `--preflight-only` there and offers `ace-cursor-sandbox`,
  attached to `ACE_HOME/releases/*/…/cursorsandbox` so updates keep it. The provider's
  refusal names AppArmor and both fixes.
- Doctor repairs these from the CLI (ADR 0092's repair list): **Install ace's AppArmor
  profiles** (`linux.apparmor`: `ace-chromium` and `ace-cursor-sandbox`, whichever is needed)
  and **Install the libraries ace's browser needs** (`linux.packages`: the distribution's
  install command, after `apt-get update` on Debian and Ubuntu). Both run through sudo, so the
  person's password is the consent; as root they run directly. Profiles go through the same
  root script the app uses, which has AppArmor parse each one before writing it.
  `ace doctor --dry-run` prints the exact commands, unredacted, on the person's own terminal.
  The report the app shows and support bundles carry says only "run `ace doctor --fix`":
  redaction would break the commands (home becomes a marker), and they are this machine's
  paths. Disabled user namespaces (`kernel.unprivileged_userns_clone=0`) and running as root
  stay advice: changing a kernel switch or the account ace runs as is the person's decision.
- Trade-off: these attachments are paths the person's account can write, so code running as
  that person could gain user namespaces by placing an executable there. Chromium's own
  guidance accepts the same for builds in a home folder; the alternative, a root-owned copy,
  would break the AppImage's self-update. The deb stays the strongest option on Ubuntu.

Login launch writes an XDG autostart entry. The tray uses a colour icon on Linux. The global
shortcut uses the GlobalShortcuts portal on Wayland. The `ace` CLI shim detects AppImage and
points at the stable AppImage path, not its temporary mount.

The app's Linux identity is `dev.ace.app` everywhere: the installed desktop entry
(`dev.ace.app.desktop`), the Wayland app id, and the autostart entry.
Portals need a reverse-DNS id; GNOME refuses global shortcuts to one like `ace-desktop`, and
Chromium only uses the shortcuts portal on GNOME with `GlobalShortcutsPortalPreferredTrigger`
on as well. The executable stays `ace-desktop`. An AppImage or extracted tar.gz installs
nothing, so its launch writes `dev.ace.app.desktop` (and the 512 px icon) into
`$XDG_DATA_HOME/applications`, pointing at the AppImage file or the tar.gz's launcher: without
it GNOME's portal refuses the shortcut ("An app id is required") and `ace://` links have no
handler. It removes an `ace-desktop.desktop` an earlier AppImage wrote, so ace is listed once,
and the deb's own launch removes an AppImage-written entry that would shadow the package's.
Hyprland's portal registers apps' shortcuts but never gives them keys; there Settings shows
the hyprland.conf line (`bind = MODS, KEY, global, dev.ace.app:<id>`), read back from
`hyprctl globalshortcuts` because Electron names the shortcut with a per-profile id.
Computer use refuses `dev.ace.app`, `ace-desktop` and the tar.gz's `ace-desktop-bin`. The app icon is installed at each size the
hicolor theme indexes (16 to 512 px); the theme has no 1024 px directory. Desktops without a
StatusNotifier host (stock GNOME, bare window managers) show no tray icon, so the first time
the window closes into the background there, a notification says ace is still running.

**Releases and updates.** Linux desktop releases go through the same `release.ts build` and
`publish` as macOS (ADR 0091), run in the Debian 12 container on a host of each
architecture, unsigned. They publish an AppImage, a deb and a tar.gz under one naming
scheme (`ace-<version>-<arch>.<ext>`) with `latest-linux.yml` / `latest-linux-arm64.yml`.

- The AppImage updates itself in place through electron-updater, like macOS and Windows.
- A deb install is offered the release page (`inPlace: false`): replacing files that dpkg
  owns from inside the app would leave the package database wrong. It updates by installing
  the new deb; an apt repository can make that automatic later.
- A tar.gz install is offered the release page too: it has no installer to update through.

## Testing

Linux verification runs in a local Ubuntu 26.04 arm64 VM (Lima) and on CI's x64 and arm64
runners: the helper against GTK and Qt apps in headless GNOME Shell and KDE Plasma Wayland
sessions with the accessibility bus; the browser engine with and without the sandbox
restriction; the daemon archive smoke test; and the desktop AppImage under a headless GNOME
Wayland session. The daemon's Linux end to end (`apps/daemon/scripts/linux-e2e/run.sh`) runs
GNOME, KDE Plasma 6, Hyprland (on a virtual KMS display, with the distro's
xdg-desktop-portal-hyprland or a build of Arch's version, waybar, mako and hypridle running
and a scripted screen-sharing chooser) and a headless machine. Hyprland's portal has no
RemoteDesktop, so there the live view is watch-only; ace never works around the portal with
compositor IPC or virtual input. KDE's live view is watch-only too. Person control in a live
view is GNOME only (ADR 0049, Live view by desktop), and clients say why elsewhere instead of
offering a take-over. The desktop app's e2e (`apps/desktop/scripts/linux-e2e.sh`) runs on
GNOME, KDE and Hyprland, with Electron Wayland-native. The tar.gz was smoke-tested by hand in
the VM as a fresh user on GNOME Wayland: self-registration, `ace://` links with the app running
and closed, the sandbox setup through run0 (the VM has no pkexec) then restart into a sandboxed
renderer, the autostart entry and the `ace` command after quitting. In that VM every Vulkan
client under KWin Wayland (on vgem, with only Mesa's software Vulkan) crashes in Mesa's
device-select layer, `vulkaninfo` included: headless Chrome's GPU process dumps core there and
falls back, and the GTK 4 fixture runs with `GSK_RENDERER=cairo`. Two Vitest workers running the
daemon died (a SIGSEGV on KDE, a SIGTRAP on Hyprland, 1 in 30-odd runs); the kept core of the
second is V8 13.6 aborting as it frees a tiered-up WebAssembly-to-JS wrapper whose code page a
worker isolate already released (nodejs/node#66366, not yet fixed in Node 24). The daemon now
keeps those wrappers generic for its whole process, and the e2e runner keeps core dumps. Arch with Hyprland
(Omarchy) on x86 is still checked by hand before the first release: AT-SPI outline and
actions, the real share picker, portal capture, and the AppImage.

## Consequences

- Linux computer use is weaker than macOS for apps with poor accessibility: agents get no raw
  keys or clicks, only what an app exposes through AT-SPI.
- On Wayland the person grants screen capture once per session type through the portal
  chooser; ace never bypasses it.
- First releases are unsigned on Linux; integrity comes from the Ed25519-signed manifest
  (ADR 0041) and pinned checksums.
