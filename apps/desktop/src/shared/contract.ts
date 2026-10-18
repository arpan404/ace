import { z } from "zod";

/**
 * The contract between the Electron main process and the renderer's `window.ace` bridge.
 * Both sides parse with these schemas: the preload before anything crosses into the page, and
 * the main process before it acts on a renderer request (a compromised page must not be able
 * to open arbitrary files or URLs).
 */

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const SocketUrl = z.url().refine((value) => /^wss?:$/.test(new URL(value).protocol));
export const AbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value), "absolute path");

/** How the renderer reaches its daemon. The token never travels in a URL. */
export const DaemonConnection = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("daemon"),
    url: SocketUrl,
    token: Hex64,
    pairedDeviceId: z.string().min(1).max(256).optional(),
    /**
     * Only for the daemon this app runs on this computer: the identity its current home names
     * (`<home>/host-id`), read with the token. The renderer trusts it over any identity it
     * remembered, so a fresh start's new daemon is this window's daemon. Never set for a
     * remote daemon, whose remembered identity stays the check.
     */
    localHostId: z.string().min(1).max(256).optional(),
  }),
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
  /** No local daemon on this platform and no remote one configured. */
  "unavailable",
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
  /** Why the daemon this app started last exited, when the daemon said so by its exit code. */
  cause: z.enum(["port-in-use"]).optional(),
  /** Set while the supervisor restarts a crashed daemon on its own: which try, of how many. */
  retry: z.object({ attempt: z.number().int().min(1), of: z.number().int().min(1) }).optional(),
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
export type EditorId = z.infer<typeof EditorId>;
export const OpenInEditor = z.object({
  path: AbsolutePath,
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  editor: EditorId.optional(),
});
export type OpenInEditor = z.infer<typeof OpenInEditor>;
export const RevealPath = z.object({ path: AbsolutePath });
/** An installed editor's icon as the OS draws it: a PNG data URL, or null when there is none. */
export const EditorIconRequest = z.object({ editor: EditorId });
export const EditorIconImage = z
  .string()
  .startsWith("data:image/png;base64,")
  .max(2_000_000)
  .nullable();

/** Arbitrary installed apps, resolved by the system's bundle-id registry. */
export const AppIdentityRequest = z.object({
  bundleId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
});
export const AppIdentity = z
  .object({
    bundleId: AppIdentityRequest.shape.bundleId,
    displayName: z.string().min(1).max(256),
    icon: z
      .string()
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
      .max(128 * 1024)
      .nullable(),
  })
  .nullable();

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

const HexColour = z.string().regex(/^#[0-9a-f]{6}$/i);
/**
 * The page colour of the theme the page applies, in each scheme, and which scheme its mode picks.
 * The window paints it behind the page before first paint and while resizing, so a theme other
 * than the default, or a mode other than the OS's, never flashes the wrong colour.
 */
export const WindowBackground = z.object({ mode: ThemeSource, light: HexColour, dark: HexColour });
export type WindowBackground = z.infer<typeof WindowBackground>;

/**
 * A chat visualization for its own window: the sandboxed `data:` document the transcript shows.
 * 4 MiB covers a 256 KiB page after escaping and URL encoding.
 */
/** Largest image the renderer may put on the clipboard, in bytes before base64. */
export const clipboardImageLimit = 8 * 1024 * 1024;
/** An image for the system clipboard (an annotated page's screenshot): PNG or JPEG bytes. */
export const ClipboardImage = z.object({
  mimeType: z.enum(["image/png", "image/jpeg"]),
  data: z
    .string()
    .min(1)
    .max(Math.ceil(clipboardImageLimit / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export const VisualizationWindow = z.object({
  title: z.string().trim().min(1).max(160),
  url: z
    .string()
    .max(4 * 1024 * 1024)
    .startsWith("data:text/html"),
});
export type VisualizationWindow = z.infer<typeof VisualizationWindow>;

/** `ace://` links, parsed by `parseDeepLink`. */
export const DeepLink = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("thread"),
    threadId: z.string().min(1),
    itemId: z.string().optional(),
  }),
  z.object({ kind: z.literal("settings"), page: z.string().optional() }),
  z.object({ kind: z.literal("new-thread") }),
  z.object({ kind: z.literal("open-folder"), path: AbsolutePath }),
]);
export type DeepLink = z.infer<typeof DeepLink>;

/** The route a deep link opens in the web app. */
export function deepLinkRoute(link: DeepLink): string {
  switch (link.kind) {
    case "thread":
      return `/t/${encodeURIComponent(link.threadId)}${link.itemId ? `?item=${encodeURIComponent(link.itemId)}` : ""}`;
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
  "agentSays",
  "needsYou",
  "finished",
  "failed",
  "limited",
  "automation",
  "ci",
]);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

const Minute = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 - 1);
/** Minutes after local midnight; `start > end` wraps past midnight. */
const QuietHours = z.object({ start: Minute, end: Minute });
const NotificationToggles = z.partialRecord(NotificationCategory, z.boolean());
export const DesktopSettings = z.object({
  /** Keep the daemon and tray running after the last window closes. */
  background: z.boolean().default(true),
  openAtLogin: z.boolean().default(false),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      categories: NotificationToggles.default({}),
      quietHours: QuietHours.nullable().default(null),
    })
    .prefault({}),
  /** Bounce the dock icon or flash the taskbar when something needs you. */
  attention: z.boolean().default(true),
  /** Electron accelerator for the quick composer; off by default. */
  globalShortcut: z.string().max(64).nullable().default(null),
  /** Keep the machine awake while agents work. */
  preventSleep: z.boolean().default(false),
  /**
   * Where this app's own browser saves downloads; null uses the system's Downloads folder
   * (`app.getPath("downloads")`, ~/Downloads on macOS). ace's Chrome on the daemon has its own
   * setting.
   */
  browserDownloads: z.string().min(1).max(4096).nullable().default(null),
});
export type DesktopSettings = z.infer<typeof DesktopSettings>;
/**
 * A change to some settings. It carries no defaults: a key the patch leaves out stays as it
 * was saved. (`DesktopSettings.partial()` would not do: Zod still applies each field's
 * default, so every patch would reset every setting it didn't name.)
 */
export const DesktopSettingsPatch = z.object({
  background: z.boolean().optional(),
  openAtLogin: z.boolean().optional(),
  notifications: z
    .object({
      enabled: z.boolean().optional(),
      categories: NotificationToggles.optional(),
      quietHours: QuietHours.nullable().optional(),
    })
    .optional(),
  attention: z.boolean().optional(),
  globalShortcut: z.string().max(64).nullable().optional(),
  preventSleep: z.boolean().optional(),
  browserDownloads: z.string().min(1).max(4096).nullable().optional(),
});
export type DesktopSettingsPatch = z.infer<typeof DesktopSettingsPatch>;

export const ScreenPermission = z.enum([
  "granted",
  "denied",
  "not-determined",
  "restricted",
  "unknown",
]);
export const Permissions = z.object({
  screenRecording: ScreenPermission,
  accessibility: z.boolean(),
});
export type Permissions = z.infer<typeof Permissions>;
export const PermissionPane = z.enum(["screen-recording", "accessibility", "notifications"]);
export type PermissionPane = z.infer<typeof PermissionPane>;

/** Where the renderer wants a thread's embedded browser view drawn, in CSS pixels. */
export const BrowserPlacement = z.object({
  device: z
    .object({
      width: z.number().positive().max(4096),
      height: z.number().positive().max(4096),
      mobile: z.boolean().optional(),
      deviceScaleFactor: z.number().min(0.5).max(4).optional(),
    })
    .optional(),
  threadId: z.string().min(1).max(256),
  /**
   * One tab of the thread, drawn here beside the shown one (split view). Omitted: whichever tab
   * the thread shows.
   */
  tabId: z.string().min(1).max(256).optional(),
  bounds: z.object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().min(0).max(16384),
    height: z.number().min(0).max(16384),
  }),
  visible: z.boolean(),
});
export type BrowserPlacement = z.infer<typeof BrowserPlacement>;
/** Names a thread's embedded browser view (one tab of it with `tabId`). */
export const BrowserThread = z.object({
  threadId: z.string().min(1).max(256),
  tabId: z.string().min(1).max(256).optional(),
});
export type BrowserThread = z.infer<typeof BrowserThread>;
/** A thread view's picture as a PNG `data:` URL; null while nothing shows it. */
export const BrowserSnapshot = z
  .string()
  .max(64 * 1024 * 1024)
  .nullable();
/** A toolbar shortcut from the thread's native page. */
export const BrowserShortcut = BrowserThread.extend({
  accelerator: z.enum([
    "CmdOrCtrl+T",
    "CmdOrCtrl+L",
    "CmdOrCtrl+F",
    "CmdOrCtrl+R",
    "CmdOrCtrl+[",
    "CmdOrCtrl+]",
    // Zoom in, out and back to 100% (the daemon keeps each tab's zoom).
    "CmdOrCtrl+=",
    "CmdOrCtrl+-",
    "CmdOrCtrl+0",
  ]),
});
export type BrowserShortcut = z.infer<typeof BrowserShortcut>;
/**
 * What the desktop does to a thread's shown native tab: the system print dialog, or the tab's
 * developer tools in their own window. `inspect` opens them at that point of the page.
 */
export const BrowserPageAction = BrowserThread.extend({
  action: z.enum(["print", "devtools"]),
  inspect: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
});
export type BrowserPageAction = z.infer<typeof BrowserPageAction>;
/**
 * The person picked an item in a native page's context menu that the app carries out through
 * the daemon (history, a new tab, annotate mode, the page source).
 */
export const BrowserContextAction = BrowserThread.extend({
  action: z.enum(["back", "forward", "reload", "openTab", "annotate", "viewSource"]),
  url: z.string().max(8192).optional(),
});
export type BrowserContextAction = z.infer<typeof BrowserContextAction>;

export const UpdateStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({ state: z.literal("checking") }),
  z.object({ state: z.literal("current"), version: z.string() }),
  z.object({ state: z.literal("available"), version: z.string(), url: z.string() }),
  z.object({ state: z.literal("error"), message: z.string() }),
]);
export type UpdateStatus = z.infer<typeof UpdateStatus>;

export const BrowserPlacementReceipt = z.enum(["shown", "hidden", "unavailable", "superseded"]);
export type BrowserPlacementReceipt = z.infer<typeof BrowserPlacementReceipt>;
