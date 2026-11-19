# Computer-use host requirements

Permission replies retain `screenRecording` and `accessibility` for existing clients. New helpers
also report `platform` and `requirements`. Each requirement has a kind, state, title and sentence,
with an optional action. Unknown kinds, states and extra requirement fields survive decoding.
New clients accept replies without the new fields. macOS keeps its existing prompts and settings
panes. A reply without platform metadata remains a legacy reply, never evidence about the phone's OS.

Linux reports a Wayland connection, current AT-SPI accessibility flag and bus connection,
ScreenCast and RemoteDesktop portal availability, and consent for the active sharing session.
Enabling accessibility uses the existing native AT-SPI connection path. Sharing consent belongs
to the live view's source chooser, which can reuse its private restore token. Permission refreshes
do not restart Linux helpers or destroy that session. Missing session or portal connections are
reported as blocked host requirements. X11 is still refused before helper startup.

Windows checks the input desktop and rejects session 0. Locked workstations and secure desktops
need a sign-in, unlock or UAC dismissal, not a privacy grant. Target integrity and capture access
remain unverified until used. Input and semantic actions reject elevated targets using the existing
integrity-level check. Requesting permissions returns the current requirements and instructions;
it does not fabricate a TCC prompt or elevate anything.

The web settings and iOS remote screen use the remote reply's requirements. Older replies retain
the existing macOS view. Device permission replies use the same schema; Android's native device
transport does not acquire desktop privacy permissions.

Sources: [AT-SPI bus status](https://github.com/GNOME/at-spi2-core/blob/main/bus/README.md),
[RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html),
[SendInput and UIPI](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput),
[Windows capture interop](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow).

## VM verification

Use Bun 1.4.4. No provider sessions are needed. Only use throwaway test windows created for this
verification. Keep the VM's desktop visible to answer sharing dialogs.

On each OS, run:

```sh
bun --version
bun run --bun vitest run packages/protocol/src/screen-permissions.test.ts packages/screen/src/permission-model.test.ts packages/ui-core/src/computer-use.test.ts apps/daemon/src/doctor/computer-use.test.ts --project unit
node node_modules/vitest/vitest.mjs run apps/web/src/features/computer-use/computer-use.test.tsx --project web
bun run doctor --all
```

Expected: Bun 1.4.4; all listed tests pass; doctor describes that OS rather than macOS grants.
Web tests require the Markit submodule and built assets from `bun install`.

On Linux GNOME Wayland and Hyprland/Omarchy:

```sh
cargo check --locked --manifest-path native/screen-helper-linux/Cargo.toml
sh native/screen-helper-linux/build.sh
printf '%s\n' "$XDG_SESSION_TYPE" "$WAYLAND_DISPLAY"
gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Get org.a11y.Status IsEnabled
gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop
```

Expected: compilation succeeds, a Wayland display exists, accessibility is enabled, and ScreenCast
is advertised. In Settings > Computer use, check AT-SPI and portal requirement sentences. Turn
`IsEnabled` off with the following command, check again, and choose Enable accessibility:

```sh
gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus --method org.freedesktop.DBus.Properties.Set org.a11y.Status IsEnabled '<false>'
```

Expected: the accessibility row needs attention, the action restores it, and another check reports
ready. Start Share a window or screen, decline once, then accept. Check again during the live view:
the sharing session must remain live. Stop and start again to exercise restore-token reuse and
revoked consent. On GNOME, test person input only after granting it. On Hyprland, verify the live
view's watch-only explanation and separately exercise app screenshots through its compositor
backend. KDE is a secondary watch-only check. Log in to X11 and check again: the requirement
must say to log in to Wayland. With no session bus or a stopped portal, show the actual connection
failure, never a macOS prompt. Restore the desktop's services after each check.

On Windows, in PowerShell:

```powershell
cargo check --locked --manifest-path native/screen-helper-windows/Cargo.toml
cargo build --locked --manifest-path native/screen-helper-windows/Cargo.toml
query session
```

Expected: compilation succeeds and ace runs in the signed-in user's session, above session 0.
With the built helper configured, open Settings > Computer use: the interactive desktop is ready,
while target integrity and capture are unverified. Start a live view to verify capture. Request
permissions and confirm instructions return without a macOS call. Lock the workstation, dismiss
UAC after checking a secure desktop, and repeat the inspection from a paired client. Those states
must require unlocking or dismissing UAC. Run the helper from session 0: inspection must be blocked.
Try an elevated throwaway target from a non-elevated helper: input and semantic actions must refuse
with the UIPI fix. If Windows itself requests capture access, decline and then allow it, checking
that the capture operation reports the real failure and recovers. No test should elevate ace.

On macOS, use an agent-created TextEdit document or Calculator only. Confirm Screen Recording
and Accessibility still open their original settings panes; grant and revoke each independently.
No automated check should request a system permission. From iOS, connect to each VM and confirm
that the remote machine's requirements and actions appear, including after switching machines.

## Review regression checks

On GNOME, disable AT-SPI after starting a sharing session with pointer and keyboard consent.
Portal clicks and typing must still work; an AT-SPI semantic action must report the missing
accessibility requirement. Check pointer-only, keyboard-only and no-device portal grants:
`portalPointer` and `portalKeyboard` must report each actual grant independently. KDE's effective
ScreenCast-only route must remain watch-only even if RemoteDesktop is advertised.
Run the native requirement table on Linux:

```sh
cargo test --locked --manifest-path native/screen-helper-linux/Cargo.toml --test policy
```

On Windows, keep an RDP session connected: input should work if its desktop is Default and
other requirements are met. Disconnect that same session without signing out: inspection and
input must refuse it even if OpenInputDesktop returns Default. Reconnect and retry; it should
recover. Both live view and the computer-use engine use the same WTSActive check.
The connection-state table can also run on the development host:

```sh
cargo test --locked --manifest-path native/screen-helper-windows/Cargo.toml --lib session::tests
```

[Microsoft's connection-state contract](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ne-wtsapi32-wts_connectstate_class)
distinguishes WTSActive from WTSDisconnected. [OpenInputDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop)
can return the desktop that will become active on reconnection, so its name alone is insufficient.

Web and iOS must display unknown permission names but offer no unsupported request. Requirements
in ready, granted or not-applicable states must have no request action. On macOS, verify live-input
and share-picker permission failures retain Screen Recording and Accessibility guidance, including
legacy replies with no platform field. Linux and Windows recovery messages must name the host
computer rather than a Mac.

## Windows startup inspection in a service session

The live-view helper checks WTS connection state and the input desktop before DPI awareness,
COM, UI Automation or frame-pipe initialization. A non-interactive helper stays on stdio and
answers hello, permissions and permissions.request. Hello sets `inspectionOnly: true`; the
TypeScript owner does not connect a frame pipe. Other commands return the session's refusal.
Permission inspections release this helper so another check can recover after reconnection.
Interactive startup failures name the operation that failed.

On the ARM64 Windows VM, rebuild and run the following from both the signed-in session and
plain SSH/session 0. This inspects permissions only and does not enumerate or capture windows:

```powershell
cargo build --locked --manifest-path native/screen-helper-windows/Cargo.toml --target aarch64-pc-windows-msvc
$helper = '.\native\screen-helper-windows\target\aarch64-pc-windows-msvc\debug\ace-screen-helper-windows.exe'
$endpoint = 'pipe:\\.\pipe\ace-screen-inspection-' + $PID
@(
  '{"version":2,"id":"hello","op":"hello"}',
  '{"version":2,"id":"permissions","op":"permissions"}',
  '{"version":2,"id":"request","op":"permissions.request","permission":"accessibility"}'
) | & $helper --endpoint $endpoint
```

Signed-in, connected and unlocked: hello succeeds normally, interactiveDesktop is ready, and
targetIntegrity/desktopCapture remain unknown until used. Session 0: all three requests succeed,
hello says inspectionOnly, and both permission replies contain interactiveDesktop blocked with
"Run ace in your signed-in session, not as a service in session 0." There must be no startup
Access-is-denied exit or attempt to create a frame pipe. A disconnected session must say to
reconnect; an unavailable input desktop must say to unlock or dismiss UAC. In web/iOS, check
that the actual interactiveDesktop row appears rather than a generic desktopConnection error.
