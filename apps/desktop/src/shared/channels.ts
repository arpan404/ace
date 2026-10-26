import { BrowserPlacementReceipt } from "./contract.ts";
import { z } from "zod";
import {
  AbsolutePath,
  AppInfo,
  AppIdentity,
  AppIdentityRequest,
  BrowserPlacement,
  BrowserSnapshot,
  BrowserThread,
  BrowserShortcut,
  BrowserPageAction,
  BrowserContextAction,
  ClipboardImage,
  DaemonConnection,
  DaemonStatus,
  DeepLink,
  DesktopSettings,
  DesktopSettingsPatch,
  EditorIconImage,
  EditorIconRequest,
  NativeAppearance,
  NotifyRequest,
  OpenInEditor,
  PermissionPane,
  Permissions,
  RevealPath,
  ThemeSource,
  WindowBackground,
  VisualizationWindow,
  SocketUrl,
  SandboxNotice,
  TerminalCommand,
  UpdateStatus,
  WindowAction,
  WindowState,
} from "./contract.ts";
import { DiagnosticReport } from "./diagnostics.ts";
import { DoctorReport, ProviderSummary, Toolchain } from "./onboarding.ts";

const None = z.undefined();
const Count = z.number().int().min(0).max(100_000);
const ExternalUrl = z
  .url()
  .refine((value) => ["https:", "http:", "mailto:"].includes(new URL(value).protocol));

/** Renderer → main requests. Every request and result is parsed on both sides. */
export const requests = {
  "keymap.update": {
    request: z
      .record(z.string().max(64), z.string().max(64))
      .refine((entries) => Object.keys(entries).length <= 128),
    result: None,
  },
  "app.info": { request: None, result: AppInfo },
  /** Quit ace (the daemon this app started stops with it). */
  "app.quit": { request: None, result: None },
  /** Reload the window with a fresh daemon connection; restarts a daemon that failed. */
  "app.reload": { request: None, result: None },
  "daemon.connection": { request: None, result: DaemonConnection },
  "daemon.authorize": { request: SocketUrl, result: None },
  "daemon.status": { request: None, result: DaemonStatus },
  "daemon.restart": { request: None, result: DaemonStatus },
  /** `ace doctor --json` with the bundled daemon: the "repair" flow and onboarding. */
  "daemon.diagnose": { request: None, result: DoctorReport },
  /** Opens the local daemon's log folder in the file manager; false when there is none. */
  "daemon.showLogs": { request: None, result: z.boolean() },
  "onboarding.providers": { request: None, result: z.array(ProviderSummary) },
  "system.toolchains": { request: None, result: z.array(Toolchain) },
  "daemon.pause": { request: z.boolean(), result: DaemonStatus },
  "shell.openInEditor": { request: OpenInEditor, result: z.boolean() },
  "shell.reveal": { request: RevealPath, result: z.boolean() },
  /** An installed editor's icon from the OS, for "Open in" (never a bundled logo). */
  "shell.appIdentity": { request: AppIdentityRequest, result: AppIdentity },
  "shell.editorIcon": { request: EditorIconRequest, result: EditorIconImage },
  "shell.openExternal": { request: ExternalUrl, result: z.boolean() },
  /**
   * The native folder picker, for Add project: the absolute path chosen, or null when the
   * person cancels. Nothing else about the folder crosses; the daemon checks it.
   */
  "dialog.openFolder": { request: None, result: AbsolutePath.nullable() },
  /** Puts a PNG or JPEG on the system clipboard; the page needs no focus or user activation. */
  "clipboard.writeImage": { request: ClipboardImage, result: None },
  "notify.show": { request: NotifyRequest, result: z.boolean() },
  "badge.set": { request: Count, result: None },
  "window.action": { request: WindowAction, result: WindowState },
  "window.state": { request: None, result: WindowState },
  "theme.appearance": { request: None, result: NativeAppearance },
  "theme.setSource": { request: ThemeSource, result: NativeAppearance },
  /** The page's theme colours, painted behind it from the next launch's first frame on. */
  "theme.setWindowBackground": { request: WindowBackground, result: None },
  /** Opens a chat visualization's sandboxed document in its own locked-session window. */
  "visualization.open": { request: VisualizationWindow, result: None },
  "settings.get": { request: None, result: DesktopSettings },
  "settings.update": { request: DesktopSettingsPatch, result: DesktopSettings },
  /**
   * What the quick-thread shortcut still needs from the person on this desktop, in a sentence
   * (Hyprland: the hyprland.conf line that gives it keys); null when nothing.
   */
  "settings.shortcutHint": { request: None, result: z.string().max(500).nullable() },
  "permissions.status": { request: None, result: Permissions },
  "permissions.open": { request: PermissionPane, result: z.boolean() },
  "browser.place": { request: BrowserPlacement, result: BrowserPlacementReceipt },
  /** The shown view's picture, held in its place while an app overlay covers it. */
  "browser.snapshot": { request: BrowserThread, result: BrowserSnapshot },
  /**
   * The page focused one of its own fields (the address bar): the OS focus leaves any native
   * browser view, and keys typed there since a ⌘L or ⌘F are typed into the field.
   */
  "browser.focus-app": { request: None, result: None },
  /** Print or developer tools for the thread's shown native tab; false: no such view here. */
  "browser.page": { request: BrowserPageAction, result: z.boolean() },
  /** Whether a terminal runs `ace`; waits for the launch's own install to finish. */
  "cli.status": { request: None, result: TerminalCommand },
  /** Turn the `ace` command on the terminal's PATH on or off, and save the choice. */
  "cli.setOnPath": { request: z.boolean(), result: TerminalCommand },
  "updates.check": { request: None, result: UpdateStatus },
  /** A page diagnostic for the desktop log, rate-limited there; the page never waits on it. */
  "diagnostics.report": { request: DiagnosticReport, result: None },
  /** Where the app's update stands now, for a page that loaded after the last event. */
  "updates.current": { request: None, result: UpdateStatus },
  /** Download the update on offer. */
  "updates.download": { request: None, result: UpdateStatus },
  /** Restart into the downloaded update now, stopping the agents still at work. */
  "updates.install": { request: None, result: UpdateStatus },
  /** How many agents Restart would stop; null when the daemon could not say. */
  "updates.busy": { request: None, result: z.number().int().min(0).nullable() },
  /** Chromium's sandbox setup on a Linux AppImage or tar.gz, for a page that loaded late. */
  "sandbox.current": { request: None, result: SandboxNotice },
  /** Run the one-time setup; resolves once the person answered the password prompt. */
  "sandbox.setup": { request: None, result: SandboxNotice },
  /** Hide the notice until the app starts again. */
  "sandbox.hide": { request: None, result: SandboxNotice },
  /** Start the app again through its launcher, so its sandbox turns on. */
  "sandbox.restart": { request: None, result: None },
} as const;
export type RequestChannel = keyof typeof requests;
export type RequestOf<C extends RequestChannel> = z.input<(typeof requests)[C]["request"]>;
export type ResultOf<C extends RequestChannel> = z.output<(typeof requests)[C]["result"]>;

/** Main → renderer events. */
export const events = {
  "daemon.status": DaemonStatus,
  "deep-link": DeepLink,
  "keymap.action": z.string().min(1).max(64),
  "theme.changed": NativeAppearance,
  "window.changed": WindowState,
  "settings.changed": DesktopSettings,
  "browser.visibility": z.object({
    threadId: z.string(),
    tabId: z.string().optional(),
    visible: z.boolean(),
  }),
  "browser.shortcut": BrowserShortcut,
  "browser.context": BrowserContextAction,
  "updates.status": UpdateStatus,
  /** The outcome of the menu's Check for Updates…, for the page to answer with a toast. */
  "updates.checked": UpdateStatus,
  "sandbox.status": SandboxNotice,
  /** The machine woke up; the renderer should reconnect now rather than wait for backoff. */
  "system.resumed": None,
} as const;
export type EventChannel = keyof typeof events;
export type EventOf<C extends EventChannel> = z.output<(typeof events)[C]>;

/** IPC channel names are namespaced so nothing else on the bus can collide. */
export function requestChannel(name: RequestChannel): string {
  return `ace:request:${name}`;
}
export function eventChannel(name: EventChannel): string {
  return `ace:event:${name}`;
}
