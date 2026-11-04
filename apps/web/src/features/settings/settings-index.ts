import { settingDescriptions } from "./setting-descriptions.ts";
import { agentSettingTitles } from "@ace/ui-core";
import { desktopCli } from "@/boot/desktop-cli.ts";
import { hasDesktopPreferences } from "@/boot/desktop-settings.ts";
import { hasDesktopUpdates } from "@/boot/desktop-updates.ts";
import { primaryMachineId } from "@/lib/machines.ts";
import { visibleSettingsPages, settingsPages, type SettingsPath } from "./settings-pages.ts";

/**
 * Every setting a person might look for, by page: the palette's Settings group and the
 * Settings sidebar's filter search it, and each row reads its title from here (`settingRow`),
 * so a search result and the row it opens can't drift apart. `id` is the row's anchor:
 * `/settings/general#threads.useWorktree`.
 */
export interface SettingEntry {
  readonly id: string;
  readonly page: SettingsPath;
  readonly title: string;
  /** Other words people use for it ("dark mode" for Theme). */
  readonly keywords?: readonly string[];
  /** Where it opens when that's a view inside its page (Fleet's Map, this computer), not the page itself. */
  readonly route?: "/settings/remote/map" | "/settings/remote/primary";
}

/** Where a setting opens, as link props: its view inside the page when it has one, else the page. */
export const entryRoute = (entry: SettingEntry) =>
  entry.route === "/settings/remote/primary"
    ? ({ to: "/settings/remote/$machine", params: { machine: primaryMachineId } } as const)
    : { to: entry.route ?? entry.page };

const entries = [
  {
    id: "storage",
    page: "/settings/storage",
    title: "Storage retention and cleanup",
    keywords: ["disk", "space", "clean", "worktrees", "attachments", "recordings", "logs", "cache"],
  },
  {
    id: "past-sessions",
    page: "/settings/providers",
    title: "Past sessions",
    keywords: [
      "history",
      "import",
      "continue",
      "claude",
      "codex",
      "opencode",
      "saved conversations",
    ],
  },
  {
    id: "source-control",
    page: "/settings/source-control",
    title: "Source control",
    keywords: ["github", "gh", "git", "enterprise", "account", "rescan"],
  },
  {
    id: "prompts",
    page: "/settings/prompts",
    title: "Prompt files",
    keywords: ["slash", "commands", "templates", "skills"],
  },
  // Profile
  {
    id: "account.signIn",
    page: "/settings/profile",
    title: "ace account",
    keywords: ["login", "sign in", "sign out", "email", "profile"],
  },
  {
    id: "profile.machines",
    page: "/settings/profile",
    title: "Machines on your account",
    keywords: ["account", "remote", "relay", "machine code"],
  },
  {
    id: "profile.name",
    page: "/settings/profile",
    title: "Your name",
    keywords: ["initials", "avatar", "account"],
  },
  // General
  {
    id: "app.openAtLogin",
    page: "/settings/general",
    title: "Open ace at login",
    keywords: ["startup", "launch"],
  },
  {
    id: "providers.default",
    page: "/settings/agents",
    title: agentSettingTitles["providers.default"],
    keywords: ["agent", "claude", "codex", "model"],
  },
  {
    id: "terminals.openIn",
    page: "/settings/general",
    title: "Terminals open in",
    keywords: ["terminal", "shell", "bottom panel", "side panel", "dock", "location"],
  },
  {
    id: "usage.railMeasure",
    page: "/settings/general",
    title: "Usage bars",
    keywords: ["usage", "rail", "limits", "session", "weekly", "week", "quota"],
  },
  {
    id: "editor.default",
    page: "/settings/general",
    title: "Open files in",
    keywords: ["editor", "vscode", "cursor", "zed", "ide", "open in"],
  },
  {
    id: "threads.limitPolicy",
    page: "/settings/agents",
    title: agentSettingTitles["threads.limitPolicy"],
    keywords: ["usage", "quota", "rate limit", "resume", "snooze", "migrate", "switch account"],
  },
  {
    id: "agents.maxRunningChildren",
    page: "/settings/agents",
    title: agentSettingTitles["agents.maxRunningChildren"],
    keywords: ["delegate", "children", "subagents", "parallel", "concurrency", "queue", "limit"],
  },
  {
    id: "threads.useWorktree",
    page: "/settings/agents",
    title: agentSettingTitles["threads.useWorktree"],
    keywords: ["git", "branch", "checkout"],
  },
  {
    id: "threads.sortBy",
    page: "/settings/agents",
    title: agentSettingTitles["threads.sortBy"],
    keywords: ["order", "sidebar", "manual", "newest", "activity"],
  },
  {
    id: "threads.autoSettleAfter",
    page: "/settings/agents",
    title: agentSettingTitles["threads.autoSettleAfter"],
    keywords: ["archive", "auto settle", "cleanup"],
  },
  {
    id: "threads.settleOnMerge",
    page: "/settings/agents",
    title: agentSettingTitles["threads.settleOnMerge"],
    keywords: ["pull request", "merge"],
  },
  {
    id: "threads.forkOnSwitch",
    page: "/settings/agents",
    title: agentSettingTitles["threads.forkOnSwitch"],
    keywords: ["provider", "account", "switch", "fork", "preserve", "history"],
  },
  {
    id: "threads.followUpBehavior",
    page: "/settings/agents",
    title: agentSettingTitles["threads.followUpBehavior"],
    keywords: ["queue", "steer", "follow up"],
  },
  {
    id: "generation.model",
    page: "/settings/agents",
    title: agentSettingTitles["generation.model"],
    keywords: ["utility model", "thread title", "commit message", "pull request", "haiku", "luna"],
  },
  {
    id: "roles.build",
    page: "/settings/agents",
    title: agentSettingTitles["roles.build"],
    keywords: ["roles", "runRole", "delegate", "coder", "implement"],
  },
  {
    id: "roles.judgment",
    page: "/settings/agents",
    title: agentSettingTitles["roles.judgment"],
    keywords: ["roles", "runRole", "delegate", "planner", "design"],
  },
  {
    id: "roles.review",
    page: "/settings/agents",
    title: agentSettingTitles["roles.review"],
    keywords: ["roles", "runRole", "delegate", "reviewer"],
  },
  {
    id: "roles.verify",
    page: "/settings/agents",
    title: agentSettingTitles["roles.verify"],
    keywords: ["roles", "runRole", "delegate", "verifier", "check"],
  },
  {
    id: "generation.autoDraftCommits",
    page: "/settings/agents",
    title: agentSettingTitles["generation.autoDraftCommits"],
    keywords: ["commit", "draft", "generate"],
  },
  {
    id: "computer.blockedApps",
    page: "/settings/computer-use",
    title: "Apps agents can't use",
    keywords: ["block", "deny", "computer use", "screen", "apps", "privacy"],
  },
  {
    id: "devices.emulatorWindow",
    page: "/settings/computer-use",
    title: "Show emulator window",
    keywords: ["android", "emulator", "window", "headless", "sensors", "fingerprint", "camera"],
  },
  {
    id: "browser.userChrome.connection",
    page: "/settings/computer-use",
    title: "Browser connection",
    keywords: ["use my chrome", "extension", "install", "browser", "chrome"],
  },
  {
    id: "browser.userChrome.storageReads",
    page: "/settings/computer-use",
    title: "Let agents read cookies and site storage",
    keywords: ["use my chrome", "evaluate", "localStorage", "privacy", "browser"],
  },
  {
    id: "automations.enabled",
    page: "/settings/agents",
    title: agentSettingTitles["automations.enabled"],
    keywords: ["schedule", "cron"],
  },
  {
    id: "daemon.connection",
    page: "/settings/general",
    title: "Connection",
    keywords: ["server", "url", "disconnect"],
  },
  {
    id: "threads.settleOnClose",
    page: "/settings/agents",
    title: agentSettingTitles["threads.settleOnClose"],
    keywords: ["pull request", "closed"],
  },
  {
    id: "access.defaultMode",
    page: "/settings/agents",
    title: agentSettingTitles["access.defaultMode"],
    keywords: ["permissions", "approval", "read-only", "ask", "auto review", "full access"],
  },
  {
    id: "projects.roots",
    page: "/settings/agents",
    title: "Project folders",
    keywords: ["allow", "folder", "roots"],
  },
  { id: "app.background", page: "/settings/general", title: "Keep running in background" },
  { id: "app.preventSleep", page: "/settings/general", title: "Prevent sleep while agents work" },
  { id: "app.globalShortcut", page: "/settings/general", title: "Quick-thread global shortcut" },
  {
    id: "app.attention",
    page: "/settings/general",
    title: "Bounce dock icon for attention",
    keywords: ["flash", "window", "taskbar", "urgent"],
  },
  {
    id: "app.terminalCommand",
    page: "/settings/general",
    title: "ace command in terminals",
    keywords: ["cli", "command line", "shell", "path", "install", "terminal"],
  },
  {
    id: "app.updates",
    page: "/settings/general",
    title: "Updates",
    keywords: ["check for updates", "download", "install", "version", "upgrade", "restart"],
  },
  // Appearance
  {
    id: "appearance.mode",
    page: "/settings/appearance",
    title: "Mode",
    keywords: ["dark", "light", "system", "night"],
  },
  {
    id: "appearance.theme",
    page: "/settings/appearance",
    title: "Theme",
    keywords: [
      "colour",
      "color",
      "palette",
      "contrast",
      "ace",
      "paper",
      "midnight",
      "grove",
      "harbor",
      "dusk",
    ],
  },
  {
    id: "appearance.accent",
    page: "/settings/appearance",
    title: "Accent",
    keywords: ["colour", "color", "accent", "highlight", "ink", "mono", "custom"],
  },
  {
    id: "appearance.translucency",
    page: "/settings/appearance",
    title: "Translucency",
    keywords: ["glass", "translucent", "transparency", "solid", "blur", "surfaces"],
  },
  {
    id: "appearance.reduceMotion",
    page: "/settings/appearance",
    title: "Reduce motion",
    keywords: ["animation", "motion", "accessibility"],
  },
  {
    id: "appearance.density",
    page: "/settings/appearance",
    title: "Density",
    keywords: ["compact", "comfortable", "spacing"],
  },
  {
    id: "appearance.transcriptSize",
    page: "/settings/appearance",
    title: "Transcript text size",
    keywords: ["font", "zoom", "bigger"],
  },
  // Notifications
  {
    id: "notifications.inApp",
    page: "/settings/notifications",
    title: "In-app toasts",
    keywords: ["alerts", "popups"],
  },
  {
    id: "notifications.system",
    page: "/settings/notifications",
    title: "Desktop notifications",
    keywords: ["os", "system", "alerts"],
  },
  {
    id: "notifications.quietHours",
    page: "/settings/notifications",
    title: "Quiet hours",
    keywords: ["do not disturb", "mute", "night"],
  },
  // Keyboard
  {
    id: "keyboard.shortcuts",
    page: "/settings/keyboard",
    title: "Keyboard shortcuts",
    keywords: ["keys", "hotkeys", "rebind", "keybindings"],
  },
  // Fleet
  {
    id: "remote.enabled",
    page: "/settings/remote",
    title: "Remote access",
    keywords: ["lan", "tailscale", "relay", "fleet", "network", "turn off", "disconnect"],
  },
  {
    id: "account.reach",
    page: "/settings/remote",
    title: "ace account on this computer",
    keywords: ["sign in", "sign out", "relay", "anywhere", "reach", "network"],
  },
  {
    id: "remote.lan",
    page: "/settings/remote",
    title: "Local network",
    keywords: ["lan", "wifi", "network", "transport"],
  },
  {
    id: "remote.tailscale",
    page: "/settings/remote",
    title: "Tailscale",
    keywords: ["tailscale", "tailnet", "vpn", "network", "transport"],
  },
  {
    id: "remote.relay",
    page: "/settings/remote",
    title: "Your own relay",
    keywords: ["relay", "self-hosted", "anywhere", "network", "transport"],
  },
  {
    id: "remote.hostedPairingLink",
    page: "/settings/remote",
    title: "Pairing links open app.acehq.dev",
    keywords: ["app.acehq.dev", "web", "browser", "pair", "phone", "hosted"],
  },
  {
    id: "remote.agentAccess",
    page: "/settings/remote",
    title: "Other machines' agents",
    keywords: ["machines", "delegate", "cross-device", "mcp", "agents", "fleet"],
  },
  {
    id: "fleet.grants",
    page: "/settings/remote",
    title: "What other machines' agents may use",
    keywords: [
      "permissions",
      "browser",
      "simulators",
      "emulators",
      "computer use",
      "commands",
      "fleet",
    ],
  },
  {
    id: "remote.agentTransfers",
    page: "/settings/remote",
    title: "Move threads between machines",
    keywords: [
      "transfer",
      "continue on",
      "open on",
      "machines",
      "agents",
      "move",
      "fleet",
      "gitignore",
      "ignored files",
      ".env",
    ],
  },
  {
    id: "fleet.link",
    page: "/settings/remote",
    title: "Machines",
    keywords: ["fleet", "machines", "link", "connect", "add machine", "servers"],
  },
  // Browser
  {
    id: "browser.engine",
    page: "/settings/browser",
    title: "Browser engine",
    keywords: ["chrome", "headless", "desktop", "native", "backend"],
  },
  {
    id: "browser.profile",
    page: "/settings/browser",
    title: "New browsers",
    keywords: ["profile", "cookies", "private", "incognito", "sign-ins"],
  },
  {
    id: "browser.profileScope",
    page: "/settings/browser",
    title: "Browser profile",
    keywords: ["profile", "cookies", "sign-ins", "project", "thread", "shared", "global"],
  },
  {
    id: "browser.loss",
    page: "/settings/browser",
    title: "When the desktop app goes away",
    keywords: ["fallback", "pause", "continue"],
  },
  {
    id: "browser.downloadDir",
    page: "/settings/browser",
    title: "Downloads folder",
    keywords: ["download", "save", "folder", "location"],
  },
  {
    id: "browser.deviceToolbar",
    page: "/settings/general",
    title: "Device toolbar in new tabs",
    keywords: ["responsive", "mobile", "emulation", "viewport"],
  },
  {
    id: "browser.pip",
    page: "/settings/general",
    title: "Picture in picture",
    keywords: ["pip", "floating", "mini player", "video", "float"],
  },
  {
    id: "browser.revealAgentPages",
    page: "/settings/general",
    title: "Open the browser panel when an agent opens a page",
    keywords: ["side panel", "auto open", "reveal", "browser_open", "sheet"],
  },
  {
    id: "host.displayName",
    page: "/settings/remote",
    title: "Machine name and icon",
    keywords: ["host", "rename", "computer", "icon", "machine icon"],
  },
  {
    id: "machine.pause",
    page: "/settings/remote",
    route: "/settings/remote/primary",
    title: "Pause new work",
    keywords: ["resume", "hold", "stop new work", "maintenance", "admission", "paused", "tray"],
  },
  {
    id: "fleet.map",
    page: "/settings/remote",
    route: "/settings/remote/map",
    title: "Fleet map",
    keywords: [
      "network",
      "diagram",
      "topology",
      "graph",
      "connections",
      "problems",
      "broken",
      "relay",
      "tailnet",
      "wi-fi",
    ],
  },
  {
    id: "remote.pair",
    page: "/settings/remote",
    title: "Pair a device",
    keywords: [
      "phone",
      "qr",
      "remote",
      "mobile",
      "devices",
      "pair",
      "ipad",
      "tablet",
      "pairing link",
      "revoke",
    ],
  },
  // Advanced
  {
    id: "advanced.worktreeTimeout",
    page: "/settings/advanced",
    title: "Worktree preparation timeout",
    keywords: ["worktree", "timeout", "preparation", "git"],
  },
  {
    id: "advanced.diagnostics",
    page: "/settings/advanced",
    title: "App diagnostics",
    keywords: [
      "memory",
      "debug",
      "health",
      "doctor",
      "checks",
      "support",
      "export",
      "fix",
      "repair",
    ],
  },
  {
    id: "advanced.reset",
    page: "/settings/advanced",
    title: "Reset all settings",
    keywords: ["defaults", "restore"],
  },
] as const satisfies readonly SettingEntry[];

export type SettingId = (typeof entries)[number]["id"];

export const settingsIndex: readonly SettingEntry[] = entries;

const byId = new Map<string, SettingEntry>(entries.map((entry) => [entry.id, entry]));

/** A row's anchor and title, from the index: `<SettingRow {...settingRow("…")} />`. */
export function settingRow(id: SettingId): {
  id: string;
  title: string;
  description: string | undefined;
} {
  const entry = byId.get(id);
  return { id, title: entry?.title ?? id, description: settingDescriptions[id] };
}

/** The page a setting lives on, by its title in the nav. */
export function pageTitle(page: SettingsPath): string {
  return settingsPages.find((entry) => entry.to === page)?.title ?? "Settings";
}

const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** Every word of `query` starts a word of the entry's title, page or keywords. */
function matches(entry: SettingEntry, query: string): boolean {
  const haystack = words([entry.title, pageTitle(entry.page), ...(entry.keywords ?? [])].join(" "));
  return words(query).every((word) => haystack.some((candidate) => candidate.startsWith(word)));
}

/** Settings rows matching `query`, titles that start with it first. Empty for an empty query. */
export function searchSettings(query: string): SettingEntry[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const visible = visibleSettingsPages();
  const found = settingsIndex.filter(
    (entry) =>
      visible.some((page) => page.to === entry.page) &&
      (hasDesktopPreferences() ||
        ![
          "notifications.system",
          "notifications.quietHours",
          "app.openAtLogin",
          "app.background",
          "app.preventSleep",
          "app.globalShortcut",
          "app.attention",
        ].includes(entry.id)) &&
      (entry.id !== "app.updates" || hasDesktopUpdates()) &&
      (entry.id !== "app.terminalCommand" || desktopCli() !== undefined) &&
      matches(entry, text),
  );
  return found.toSorted(
    (a, b) =>
      Number(!a.title.toLowerCase().startsWith(text)) -
      Number(!b.title.toLowerCase().startsWith(text)),
  );
}
