import { z } from "zod";

/**
 * The contract between the Electron main process and the renderer's `window.ace` bridge.
 * Both sides parse with these schemas: the preload before anything crosses into the page, and
 * the main process before it acts on a renderer request (a compromised page must not be able
 * to open arbitrary files or URLs).
 */

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const SocketUrl = z.url().refine((value) => /^wss?:$/.test(new URL(value).protocol));
const AbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value), "absolute path");

/** How the renderer reaches its daemon. The token never travels in a URL. */
export const DaemonConnection = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("daemon"), url: SocketUrl, token: Hex64 }),
  /** `dev:desktop:fake`: the renderer runs the in-page fake daemon. */
  z.object({ mode: z.literal("fake") }),
]);
export type DaemonConnection = z.infer<typeof DaemonConnection>;

export const DaemonState = z.enum([
  "starting",
  "running",
  "restarting",
  "unreachable",
  "failed",
  "stopping",
  "stopped",
]);
export type DaemonState = z.infer<typeof DaemonState>;
export const DaemonStatus = z.object({
  state: DaemonState,
  /** Who runs the daemon: this app (a supervised child), a login service, or someone else. */
  source: z.enum(["app", "service", "external", "remote", "fake"]),
  url: z.string().optional(),
  restarts: z.number().int().min(0),
  paused: z.boolean(),
  message: z.string().max(2000).optional(),
});
export type DaemonStatus = z.infer<typeof DaemonStatus>;

export const AppInfo = z.object({
  version: z.string(),
  platform: z.enum(["darwin", "win32", "linux"]),
  arch: z.string(),
  electron: z.string(),
  packaged: z.boolean(),
});
export type AppInfo = z.infer<typeof AppInfo>;

export const EditorId = z.enum(["system", "vscode", "cursor", "zed", "xcode", "idea"]);
export const OpenInEditor = z.object({
  path: AbsolutePath,
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  editor: EditorId.optional(),
});
export type OpenInEditor = z.infer<typeof OpenInEditor>;
export const RevealPath = z.object({ path: AbsolutePath });

export const NotifyRequest = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(1000).default(""),
  threadId: z.string().min(1).max(200).optional(),
});
export type NotifyRequest = z.infer<typeof NotifyRequest>;

export const WindowAction = z.enum(["minimize", "maximize", "close", "fullscreen"]);
export type WindowAction = z.infer<typeof WindowAction>;
export const WindowState = z.object({
  focused: z.boolean(),
  maximized: z.boolean(),
  fullScreen: z.boolean(),
});
export type WindowState = z.infer<typeof WindowState>;

export const ThemeSource = z.enum(["system", "light", "dark"]);
export const NativeAppearance = z.object({
  dark: z.boolean(),
  highContrast: z.boolean(),
  reducedTransparency: z.boolean(),
  source: ThemeSource,
});
export type NativeAppearance = z.infer<typeof NativeAppearance>;

/** `ace://` links, parsed by `parseDeepLink`. */
export const DeepLink = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1), itemId: z.string().optional() }),
  z.object({ kind: z.literal("deck"), runId: z.string().optional() }),
  z.object({ kind: z.literal("settings"), page: z.string().optional() }),
  z.object({ kind: z.literal("new-thread") }),
  z.object({ kind: z.literal("open-folder"), path: AbsolutePath }),
]);
export type DeepLink = z.infer<typeof DeepLink>;

/** The route a deep link opens in the web app. */
export function deepLinkRoute(link: DeepLink): string {
  switch (link.kind) {
    case "thread":
      return `/t/${encodeURIComponent(link.threadId)}`;
    case "deck":
      return link.runId ? `/deck/${encodeURIComponent(link.runId)}` : "/deck";
    case "settings":
      return `/settings/${link.page ?? "general"}`;
    case "new-thread":
      return "/new";
    case "open-folder":
      return `/new?folder=${encodeURIComponent(link.path)}`;
  }
}

/** Notification categories; kept in step with the web's Settings › Notifications. */
export const NotificationCategory = z.enum([
  "needsYou",
  "finished",
  "failed",
  "limited",
  "deck",
  "automation",
  "ci",
]);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

const Minute = z.number().int().min(0).max(24 * 60 - 1);
export const DesktopSettings = z.object({
  /** Keep the daemon and tray running after the last window closes. */
  background: z.boolean().default(true),
  openAtLogin: z.boolean().default(false),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      categories: z.partialRecord(NotificationCategory, z.boolean()).default({}),
      /** Minutes after local midnight; `start > end` wraps past midnight. */
      quietHours: z.object({ start: Minute, end: Minute }).nullable().default(null),
    })
    .prefault({}),
  /** Bounce the dock icon or flash the taskbar when something needs you. */
  attention: z.boolean().default(true),
  /** Electron accelerator for the quick composer; off by default. */
  globalShortcut: z.string().max(64).nullable().default(null),
  /** Keep the machine awake while agents work. */
  preventSleep: z.boolean().default(false),
});
export type DesktopSettings = z.infer<typeof DesktopSettings>;
export const DesktopSettingsPatch = DesktopSettings.partial();

export const ScreenPermission = z.enum(["granted", "denied", "not-determined", "restricted", "unknown"]);
export const Permissions = z.object({
  screenRecording: ScreenPermission,
  accessibility: z.boolean(),
});
export type Permissions = z.infer<typeof Permissions>;
export const PermissionPane = z.enum(["screen-recording", "accessibility", "notifications"]);
export type PermissionPane = z.infer<typeof PermissionPane>;

/** Where the renderer wants an embedded browser view drawn, in CSS pixels of the window. */
export const BrowserPlacement = z.object({
  sessionId: z.string().min(1).max(200),
  bounds: z.object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().min(0).max(16384),
    height: z.number().min(0).max(16384),
  }),
  visible: z.boolean(),
});
export type BrowserPlacement = z.infer<typeof BrowserPlacement>;
export const BrowserController = z.object({
  sessionId: z.string(),
  controller: z.enum(["agent", "human"]),
});
export type BrowserController = z.infer<typeof BrowserController>;

export const UpdateStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({ state: z.literal("checking") }),
  z.object({ state: z.literal("current"), version: z.string() }),
  z.object({ state: z.literal("available"), version: z.string(), url: z.string() }),
  z.object({ state: z.literal("error"), message: z.string() }),
]);
export type UpdateStatus = z.infer<typeof UpdateStatus>;
