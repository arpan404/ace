# 0054: Desktop shell

Date: 2026-10-03. Status: proposed.

## Context

ADR 0045 makes Electron a thin shell around the web bundle. ADR 0003 says Electron's own Node runs the daemon, so the desktop app needs no extra runtime. ADR 0041 later planned for Electron to launch the standalone release archive, with its vendored Node, as a child process. The owner asked for one self-contained desktop app: it starts or reuses the daemon by itself, runs it on Electron's Node, and bundles every native piece the daemon needs. The app also adds native notifications, OS integration and an in-app browser that agents drive.

## Decision

### Build and packaging

| Concern          | Choice                                                                                      | Reason                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Renderer         | `apps/web`'s own Vite build, unchanged                                                      | One bundle for browser and desktop (ADR 0045)                                                                                                                                                                                                                                                                                                                      |
| Main and preload | esbuild (already pinned by `tools/release`), two entry points                               | electron-vite would wrap the web app's Vite config in a second one, tying the desktop to its Vite major. Main and preload are two small Node and browser bundles; esbuild builds them in milliseconds, and its watch API drives the main-process restart in `bun run dev`                                                                                          |
| Packager         | electron-builder 26                                                                         | One declarative config covers dmg/zip, NSIS, AppImage and deb, `asarUnpack`, fuses, notarization and ad-hoc local signing. Forge needs a maker and a plugin per target and a separate signing setup                                                                                                                                                                |
| Renderer origin  | `app://ace/`, a privileged standard scheme with an SPA fallback                             | `file://` breaks history routing and gives every file its own origin. Responses carry the CSP                                                                                                                                                                                                                                                                      |
| Daemon runtime   | Electron's Node via `ELECTRON_RUN_AS_NODE`, with the `@ace/release` bundle                  | This follows ADR 0003 and refines ADR 0041: the archive's vendored Node is not shipped a second time. Electron 44 ships Node 24.21, which runs `node:sqlite`, workers and type stripping. The native addons (node-pty, `descriptor.node`, koffi) are all Node-API, so one binary serves both runtimes. `desktop:rebuild-native` covers Linux and missing prebuilds |
| Fuses            | `runAsNode` stays on; Node CLI inspect, `NODE_OPTIONS` off; asar integrity and only-asar on | The daemon depends on run-as-node. The other fuses close debugging and injection paths                                                                                                                                                                                                                                                                             |

### Process model

The main process supervises the daemon. It reuses a daemon that is already answering its authenticated `/v1/status` in `ACE_HOME`, whether that is the CLI, another app instance or the login service from `packages/service`. It starts the installed login service rather than a duplicate. Only when neither is available does it spawn the bundled daemon, with the login shell's `PATH` so that provider CLIs and git resolve. A crashed daemon restarts with exponential backoff capped at 30 s. After five crashes in a row it reports `failed`, and the repair flow (`window.ace.daemon.restart()` and `diagnose()`) takes over. On quit the app stops only a daemon it started. Before an update it closes admission with the ADR 0041 maintenance lease and waits for running work to finish. Development attaches to the dev daemon and never spawns one.

### Bridge

`window.ace` is generated from one channel table (`apps/desktop/src/shared/channels.ts`), whose Zod schemas are parsed on both sides. Requests are honoured only from the app's own top frame at its own origin. The renderer gets the daemon URL and token through the bridge, never through the URL. Two web-free hooks run in the preload: deep links become a history push plus `popstate`, and waking from sleep fires `online`. The web app needed one small hook (`apps/web/src/boot/desktop.ts`).

### Notifications

The main process connects to the daemon as its own `desktop` notification device over an `@ace/client` socket. The daemon delivers notifications over WebSocket first, so they keep arriving after the last window closes. A pure router decides what to show:

- It applies the master switch, per-category toggles and quiet hours.
- It suppresses alerts for the thread on screen in a focused window.
- A newer alert for a thread replaces that thread's earlier one, and bursts across threads collapse into a summary.

Approve, Deny and inline Reply become durable intents whose ids derive from the alert, so a repeat is the same command and the daemon's first answer wins. The daemon emits needs-you, done, failed, unresponsive and background-done today. The desktop derives "limited" from rate-limit waits. Deck, automation and CI categories exist, but nothing emits them until the daemon publishes those events. The daemon's `notifications.*` settings are not read by any code yet. The desktop's own toggles and quiet hours apply locally, and quiet hours are also sent as device preferences.

### Embedded browser backend

With the app running, agents browse in the app's own Chromium. Each workspace's views are `WebContentsView`s in their own `persist:ace-browser-<workspaceId>` partition. The views follow the browser service's policies:

- localhost is free;
- other origins need a per-site approval routed through the daemon;
- popups, downloads and permission prompts are denied.

The main process attaches CDP 1.3 and registers as the `embedded` backend on its authenticated daemon socket. It relays bounded calls and rate-limited events, and sends screencast frames with only the latest kept until the daemon acknowledges. Human input takes a controller lease, and agent input is refused until the person hands control back. On quit the app reports its sessions closed and unregisters, so the daemon can fail over to its headless backend. The frame names in `apps/desktop/src/main/browser/contract.ts` are a proposal: the daemon side (`feat/browser-backends`) owns the final schemas in `@ace/protocol`. No Chromium is downloaded into the desktop bundle.

### Bundled pieces

- **Screen helper (macOS):** `AceScreenHelper.app` with the stable id `dev.ace.screen-helper` in `Contents/Helpers`. The app's signing leaves it untouched.
  - Its manifest lives in `Contents/Resources`, because codesign rejects non-code files in `Contents/Helpers`. The daemon reads it from `ACE_SCREEN_HELPER_MANIFEST`.
  - The daemon still installs the helper once into `ACE_HOME`, as ADR 0011 requires.
- **Screen helpers (Windows, Linux):** built with cargo into `resources/helpers`.
- **ripgrep:** comes from `@vscode/ripgrep` (MIT) and goes first on the daemon's `PATH`.
- **git, Xcode and the Android SDK** are detected, not bundled, and missing ones get setup hints.

## Consequences

- The desktop app and the standalone archive share one daemon bundle but different runtimes. The doctor's node-pty check covers both.
- Two web hooks are injected as CSS by the main process; the web app may later replace them with platform tokens:
  - the macOS rail inset for the traffic lights;
  - the transparent wallpaper under vibrancy and Mica.
- Playwright cannot attach to a packaged build, because the inspect fuse is off. The smoke test therefore runs the unpackaged bundles against the fake daemon.
- Windows packages build, but the daemon needs `descriptor.node`, which supports only macOS and Linux. Until it gains a Windows backend, Windows users connect to a remote daemon.
- Desktop auto-update currently stops at a verified "update available": it checks the signed release feed and opens the release. Installing in place (Squirrel.Mac, NSIS) and drain-before-install are still to build.
