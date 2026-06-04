export type SettingsNavGroup = "workspace" | "ai" | "system" | "data";
export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/browser"
  | "/settings/chat"
  | "/settings/editor"
  | "/settings/environment"
  | "/settings/providers"
  | "/settings/devices"
  | "/settings/advanced"
  | "/settings/about"
  | "/settings/archived";

type SettingsNavItem = {
  readonly group: SettingsNavGroup;
  readonly label: string;
  readonly description: string;
  readonly to: SettingsSectionPath;
};

export const SETTINGS_NAV_GROUPS = [
  { id: "workspace", label: "Workspace" },
  { id: "ai", label: "AI" },
  { id: "system", label: "System" },
  { id: "data", label: "Data" },
] as const satisfies ReadonlyArray<{
  id: SettingsNavGroup;
  label: string;
}>;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    group: "workspace",
    label: "General",
    description: "Appearance, time, and thread defaults",
    to: "/settings/general",
  },
  {
    group: "workspace",
    label: "Browser",
    description: "Search engine and mounted browser limits",
    to: "/settings/browser",
  },
  {
    group: "workspace",
    label: "Chat",
    description: "Streaming, notifications, and confirmation behavior",
    to: "/settings/chat",
  },
  {
    group: "workspace",
    label: "Editor",
    description: "Workspace editor and language servers",
    to: "/settings/editor",
  },
  {
    group: "workspace",
    label: "Environment",
    description: "Worktrees, linked chats, and cleanup",
    to: "/settings/environment",
  },
  {
    group: "ai",
    label: "Providers",
    description: "Models, provider CLI status, installs, and custom configurations",
    to: "/settings/providers",
  },
  {
    group: "system",
    label: "Devices",
    description: "Remote host control and pairing",
    to: "/settings/devices",
  },
  {
    group: "system",
    label: "Advanced",
    description: "Git credentials, keybindings, and cache controls",
    to: "/settings/advanced",
  },
  {
    group: "system",
    label: "About",
    description: "Version details, CLI install, and desktop updates",
    to: "/settings/about",
  },
  {
    group: "data",
    label: "Archived",
    description: "Recover archived projects and threads",
    to: "/settings/archived",
  },
];

const DEFAULT_SETTINGS_NAV_ITEM = SETTINGS_NAV_ITEMS[0] as SettingsNavItem;

export function isSettingsNavItemActive(pathname: string, item: SettingsNavItem) {
  if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
    return true;
  }
  return (
    item.to === "/settings/environment" && pathname.startsWith("/settings/project-environment/")
  );
}

export function getSettingsNavItem(pathname: string) {
  return (
    SETTINGS_NAV_ITEMS.find((item) => isSettingsNavItemActive(pathname, item)) ??
    DEFAULT_SETTINGS_NAV_ITEM
  );
}
