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
    id: "threads.followUpBehavior",
    page: "/settings/general",
    title: "Messages sent while the agent works",
    keywords: ["queue", "steer", "follow up"],
  },
  {
    id: "threads.continueAfterRestart",
    page: "/settings/general",
    title: "Continue threads after a restart",
    keywords: ["resume", "reboot", "update"],
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
    id: "permissions.providerModes",
    page: "/settings/general",
    title: "Default permissions",
    keywords: ["approval", "native", "project"],
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
    id: "appearance.theme",
    page: "/settings/appearance",
    title: "Theme",
    keywords: ["dark", "light", "mode", "colour", "color"],
  },
  {
    id: "appearance.themeEditor",
    page: "/settings/appearance",
    title: "Theme editor",
    keywords: ["tokens", "custom theme", "import", "export"],
  },
  {
    id: "appearance.glass",
    page: "/settings/appearance",
    title: "Glass intensity",
    keywords: ["transparency", "frosted", "solid"],
  },
  {
    id: "appearance.accent",
    page: "/settings/appearance",
    title: "Accent colour",
    keywords: ["color", "highlight", "focus"],
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
    id: "host.displayName",
    page: "/settings/remote",
    title: "Machine name and icon",
    keywords: ["host", "rename", "computer", "icon", "emoji"],
  },
  {
    id: "remote.pair",
    page: "/settings/remote",
    title: "Pair a device",
    keywords: ["phone", "qr", "remote", "mobile"],
  },
  // Advanced
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
