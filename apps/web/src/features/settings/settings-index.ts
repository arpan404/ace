import { hasDesktopPreferences } from "@/boot/desktop-settings.ts";
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
}

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
  // General
  {
    id: "profile.name",
    page: "/settings/general",
    title: "Your name",
    keywords: ["initials", "avatar", "account"],
  },
  {
    id: "app.openAtLogin",
    page: "/settings/general",
    title: "Open ace at login",
    keywords: ["startup", "launch"],
  },
  {
    id: "providers.default",
    page: "/settings/general",
    title: "Default provider for new threads",
    keywords: ["agent", "claude", "codex", "model"],
  },
  {
    id: "threads.useWorktree",
    page: "/settings/general",
    title: "New threads use a worktree",
    keywords: ["git", "branch", "checkout"],
  },
  {
    id: "threads.sortBy",
    page: "/settings/general",
    title: "Sort threads",
    keywords: ["order", "sidebar", "manual", "newest", "activity"],
  },
  {
    id: "threads.autoSettleAfter",
    page: "/settings/general",
    title: "Settle done threads",
    keywords: ["archive", "auto settle", "cleanup"],
  },
  {
    id: "threads.settleOnMerge",
    page: "/settings/general",
    title: "Settle when the PR merges",
    keywords: ["pull request", "merge"],
  },
  {
    id: "threads.forkOnSwitch",
    page: "/settings/general",
    title: "Fork when switching providers",
    keywords: ["provider", "account", "switch", "fork", "preserve", "history"],
  },
  {
    id: "threads.followUpBehavior",
    page: "/settings/general",
    title: "Messages sent while the agent works",
    keywords: ["queue", "steer", "follow up"],
  },
  {
    id: "generation.model",
    page: "/settings/general",
    title: "Titles and commit messages",
    keywords: ["utility model", "thread title", "commit message", "pull request", "haiku", "luna"],
  },
  {
    id: "generation.autoDraftCommits",
    page: "/settings/general",
    title: "Auto-draft commit messages",
    keywords: ["commit", "draft", "generate"],
  },
  {
    id: "browser.userChrome.storageReads",
    page: "/settings/computer-use",
    title: "Let agents read cookies and site storage",
    keywords: ["use my chrome", "evaluate", "localStorage", "privacy", "browser"],
  },
  {
    id: "automations.enabled",
    page: "/settings/general",
    title: "Run automations",
    keywords: ["schedule", "cron"],
  },
  {
    id: "daemon.connection",
    page: "/settings/advanced",
    title: "Connection",
    keywords: ["server", "url", "disconnect"],
  },
  {
    id: "threads.settleOnClose",
    page: "/settings/general",
    title: "Settle when the PR closes",
    keywords: ["pull request", "closed"],
  },
  {
    id: "access.defaultMode",
    page: "/settings/general",
    title: "Access",
    keywords: ["permissions", "approval", "read-only", "ask", "auto review", "full access"],
  },
  {
    id: "projects.roots",
    page: "/settings/general",
    title: "Project folders",
    keywords: ["allow", "folder", "roots"],
  },
  { id: "app.background", page: "/settings/general", title: "Keep running in background" },
  { id: "app.preventSleep", page: "/settings/general", title: "Prevent sleep while agents work" },
  { id: "app.globalShortcut", page: "/settings/general", title: "Quick-thread global shortcut" },
  { id: "app.attention", page: "/settings/general", title: "Bounce dock icon for attention" },
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
    title: "Notifications on this computer",
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
  // Remote devices
  {
    id: "remote.enabled",
    page: "/settings/remote",
    title: "Remote access",
    keywords: ["lan", "tailscale", "relay"],
  },
  {
    id: "remote.transport",
    page: "/settings/remote",
    title: "Transport",
    keywords: ["lan", "tailscale", "relay"],
  },
  {
    id: "remote.agentAccess",
    page: "/settings/remote",
    title: "Agents on other devices can use this machine",
    keywords: ["machines", "delegate", "cross-device", "mcp", "agents", "browser"],
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
    page: "/settings/browser",
    title: "Device toolbar in new tabs",
    keywords: ["responsive", "mobile", "emulation", "viewport"],
  },
  {
    id: "browser.pip",
    page: "/settings/browser",
    title: "Picture in picture",
    keywords: ["pip", "floating", "mini player", "video", "float"],
  },
  {
    id: "host.displayName",
    page: "/settings/remote",
    title: "Machine name and icon",
    keywords: ["host", "rename", "computer", "icon", "machine icon"],
  },
  {
    id: "remote.pair",
    page: "/settings/remote",
    title: "Pair a device",
    keywords: ["phone", "qr", "remote", "mobile"],
  },
  // Advanced
  {
    id: "advanced.worktreeTimeout",
    page: "/settings/advanced",
    title: "Worktree preparation timeout",
    keywords: ["worktree", "timeout", "preparation", "git", "environment"],
  },
  {
    id: "advanced.diagnostics",
    page: "/settings/advanced",
    title: "App diagnostics",
    keywords: ["memory", "debug", "health", "doctor", "checks", "support", "export"],
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
export function settingRow(id: SettingId): { id: string; title: string } {
  const entry = byId.get(id);
  return { id, title: entry?.title ?? id };
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
      matches(entry, text),
  );
  return found.toSorted(
    (a, b) =>
      Number(!a.title.toLowerCase().startsWith(text)) -
      Number(!b.title.toLowerCase().startsWith(text)),
  );
}
