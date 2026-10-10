import { BrowserPlacementReceipt } from "./contract.ts";
import { z } from "zod";
import {
  AbsolutePath,
  AppInfo,
  AppIdentity,
  AppIdentityRequest,
  BrowserControlRequest,
  BrowserController,
  BrowserPlacement,
  BrowserWantsControl,
  BrowserShortcut,
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
  UpdateStatus,
  WindowAction,
  WindowState,
} from "./contract.ts";
import { DoctorReport, ProviderSummary, Toolchain } from "./onboarding.ts";

const None = z.undefined();
const Count = z.number().int().min(0).max(100_000);
const ExternalUrl = z
  .url()
  .refine((value) => ["https:", "http:", "mailto:"].includes(new URL(value).protocol));

/** Renderer → main requests. Every request and result is parsed on both sides. */
export const requests = {
  "app.info": { request: None, result: AppInfo },
  /** Quit ace (the daemon this app started stops with it). */
  "app.quit": { request: None, result: None },
  "daemon.connection": { request: None, result: DaemonConnection },
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
  "notify.show": { request: NotifyRequest, result: z.boolean() },
  "badge.set": { request: Count, result: None },
  "window.action": { request: WindowAction, result: WindowState },
  "window.state": { request: None, result: WindowState },
  "theme.appearance": { request: None, result: NativeAppearance },
  "theme.setSource": { request: ThemeSource, result: NativeAppearance },
  "settings.get": { request: None, result: DesktopSettings },
  "settings.update": { request: DesktopSettingsPatch, result: DesktopSettings },
  "permissions.status": { request: None, result: Permissions },
  "permissions.open": { request: PermissionPane, result: z.boolean() },
  "browser.place": { request: BrowserPlacement, result: BrowserPlacementReceipt },
  /** The new lease arrives as a `browser.controller` event once the daemon grants it. */
  "browser.control": { request: BrowserControlRequest, result: None },
  "updates.check": { request: None, result: UpdateStatus },
} as const;
export type RequestChannel = keyof typeof requests;
export type RequestOf<C extends RequestChannel> = z.input<(typeof requests)[C]["request"]>;
export type ResultOf<C extends RequestChannel> = z.output<(typeof requests)[C]["result"]>;

/** Main → renderer events. */
export const events = {
  "daemon.status": DaemonStatus,
  "deep-link": DeepLink,
  "theme.changed": NativeAppearance,
  "window.changed": WindowState,
  "settings.changed": DesktopSettings,
  "browser.controller": BrowserController,
  "browser.visibility": z.object({ threadId: z.string(), visible: z.boolean() }),
  "browser.wants-control": BrowserWantsControl,
  "browser.shortcut": BrowserShortcut,
  "updates.status": UpdateStatus,
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
