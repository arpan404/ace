import {
  ArchiveIcon,
  BoxesIcon,
  GlobeIcon,
  InfoIcon,
  type LucideIcon,
  MessageSquareIcon,
  MonitorSmartphoneIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  SquareCodeIcon,
  WrenchIcon,
} from "lucide-react";

export type SettingsNavGroup = "general" | "workspace" | "system" | "archive";
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
  readonly icon: LucideIcon;
};

export const SETTINGS_NAV_GROUPS = [
  { id: "general", label: "General" },
  { id: "workspace", label: "Workspace" },
  { id: "system", label: "System" },
  { id: "archive", label: "Archive" },
] as const satisfies ReadonlyArray<{
  id: SettingsNavGroup;
  label: string;
}>;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    group: "general",
    label: "General",
    description: "Appearance, time, and thread defaults",
    to: "/settings/general",
    icon: SlidersHorizontalIcon,
  },
  {
    group: "general",
    label: "Chat",
    description: "Streaming, notifications, and confirmation behavior",
    to: "/settings/chat",
    icon: MessageSquareIcon,
  },
  {
    group: "general",
    label: "Browser",
    description: "Search engine and mounted browser limits",
    to: "/settings/browser",
    icon: GlobeIcon,
  },
  {
    group: "general",
    label: "Editor",
    description: "Workspace editor and language servers",
    to: "/settings/editor",
    icon: SquareCodeIcon,
  },
  {
    group: "workspace",
    label: "Environment",
    description: "Worktrees, linked chats, and cleanup",
    to: "/settings/environment",
    icon: BoxesIcon,
  },
  {
    group: "workspace",
    label: "Providers",
    description: "Models, provider CLI status, installs, and custom configurations",
    to: "/settings/providers",
    icon: PlugIcon,
  },
  {
    group: "system",
    label: "Devices",
    description: "Remote host control and pairing",
    to: "/settings/devices",
    icon: MonitorSmartphoneIcon,
  },
  {
    group: "system",
    label: "Advanced",
    description: "Git credentials, keybindings, and cache controls",
    to: "/settings/advanced",
    icon: WrenchIcon,
  },
  {
    group: "system",
    label: "About",
    description: "Version details, CLI install, and desktop updates",
    to: "/settings/about",
    icon: InfoIcon,
  },
  {
    group: "archive",
    label: "Archived",
    description: "Recover archived projects and threads",
    to: "/settings/archived",
    icon: ArchiveIcon,
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
