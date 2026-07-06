import { SETTINGS_NAV_ITEMS, type SettingsSectionPath } from "./settingsNavigation";

/** A single searchable setting entry (deep result within a page). */
export type SettingsSearchEntry = {
  readonly title: string;
  readonly to: SettingsSectionPath;
  /** Extra terms to match on that don't appear in the title. */
  readonly keywords?: string;
};

/**
 * Hand-curated index of the individual settings across every page, so search resolves to
 * specific controls (e.g. "Theme", "Translucent sidebar") — not just page names.
 */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  // Appearance
  { to: "/settings/appearance", title: "Theme", keywords: "light dark system appearance mode" },
  {
    to: "/settings/appearance",
    title: "Color preset",
    keywords:
      "palette accent ace dracula github nord monokai solarized xcode gruvbox tokyo catppuccin ayu",
  },
  {
    to: "/settings/appearance",
    title: "Translucent sidebar",
    keywords: "transparent glass vibrancy blur sidebar",
  },
  { to: "/settings/appearance", title: "UI font", keywords: "typeface sans interface font" },
  { to: "/settings/appearance", title: "Monospace font", keywords: "code font mono typeface" },
  { to: "/settings/appearance", title: "Text size", keywords: "scale ui font size zoom" },
  { to: "/settings/appearance", title: "Letter spacing", keywords: "tracking kerning" },

  // General
  { to: "/settings/general", title: "Time format", keywords: "clock 12 24 hour timestamp" },
  { to: "/settings/general", title: "New threads", keywords: "default workspace mode draft local" },
  {
    to: "/settings/general",
    title: "Workspace editor opening mode",
    keywords: "split view full editor",
  },

  // Chat
  {
    to: "/settings/chat",
    title: "Assistant streaming",
    keywords: "live output tokens response stream",
  },
  { to: "/settings/chat", title: "Tool streaming", keywords: "live output tool calls stream" },
  { to: "/settings/chat", title: "Thinking streaming", keywords: "reasoning live output stream" },
  { to: "/settings/chat", title: "Confirmations", keywords: "confirm prompts safety dialogs" },
  {
    to: "/settings/chat",
    title: "Background notifications",
    keywords: "notify alerts agent attention",
  },
  { to: "/settings/chat", title: "Comments", keywords: "inline comments review" },

  // Browser
  {
    to: "/settings/browser",
    title: "Search engine",
    keywords: "google bing duckduckgo default web search",
  },
  {
    to: "/settings/browser",
    title: "Max mounted browsers",
    keywords: "instances limit tabs mounted",
  },

  // Editor
  { to: "/settings/editor", title: "Workspace editor", keywords: "monaco code editor" },
  { to: "/settings/editor", title: "Language servers", keywords: "lsp intellisense tools" },
  { to: "/settings/editor", title: "Diff line wrapping", keywords: "word wrap diff" },
  { to: "/settings/editor", title: "Editor line numbers", keywords: "gutter numbers" },
  { to: "/settings/editor", title: "Editor whitespace", keywords: "render whitespace tabs spaces" },
  { to: "/settings/editor", title: "Editor sticky scroll", keywords: "sticky scroll header" },
  { to: "/settings/editor", title: "Editor line wrapping", keywords: "word wrap editor" },

  // Providers
  { to: "/settings/providers", title: "Models", keywords: "model selection provider llm" },
  { to: "/settings/providers", title: "Provider CLI status", keywords: "install cli codex claude" },
  {
    to: "/settings/providers",
    title: "Text generation model",
    keywords: "git commit writing model",
  },

  // Environment
  { to: "/settings/environment", title: "Worktrees", keywords: "git worktree cleanup" },
  { to: "/settings/environment", title: "Linked chats", keywords: "threads projects linked" },

  // Devices
  { to: "/settings/devices", title: "Remote host", keywords: "pairing connect device remote" },
  { to: "/settings/devices", title: "Pairing link", keywords: "one-time link connect device" },

  // Advanced
  { to: "/settings/advanced", title: "Git credentials", keywords: "auth token github credentials" },
  { to: "/settings/advanced", title: "Keybindings", keywords: "keyboard shortcuts hotkeys" },
  {
    to: "/settings/advanced",
    title: "Cache controls",
    keywords: "performance clear cache storage",
  },

  // About
  { to: "/settings/about", title: "Version", keywords: "app version build about" },
  { to: "/settings/about", title: "CLI install", keywords: "command line install path" },
  { to: "/settings/about", title: "Desktop updates", keywords: "auto update release" },

  // Archived
  { to: "/settings/archived", title: "Archived projects", keywords: "recover restore archive" },
  {
    to: "/settings/archived",
    title: "Archived threads",
    keywords: "recover restore archive chats",
  },
];

export type SettingsSearchGroup = {
  readonly item: (typeof SETTINGS_NAV_ITEMS)[number];
  readonly matches: readonly SettingsSearchEntry[];
};

/**
 * Search across page names and individual settings, returning results grouped by page
 * (page header + its matching settings), preserving nav order.
 */
export function searchSettings(query: string): readonly SettingsSearchGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [];
  }

  const matchesByPath = new Map<SettingsSectionPath, SettingsSearchEntry[]>();
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    const haystack = `${entry.title} ${entry.keywords ?? ""}`.toLowerCase();
    if (haystack.includes(q)) {
      const list = matchesByPath.get(entry.to) ?? [];
      list.push(entry);
      matchesByPath.set(entry.to, list);
    }
  }

  const groups: SettingsSearchGroup[] = [];
  for (const item of SETTINGS_NAV_ITEMS) {
    const matches = matchesByPath.get(item.to) ?? [];
    const pageMatches =
      item.label.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
    if (matches.length > 0 || pageMatches) {
      groups.push({ item, matches });
    }
  }
  return groups;
}
