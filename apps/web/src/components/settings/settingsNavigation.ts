import type { ComponentType } from "react";
import {
  IconAdjustmentsHorizontal,
  IconArchive,
  IconCode,
  IconDevices2,
  IconInfoCircle,
  IconKeyboard,
  IconMessageCircle,
  IconPalette,
  IconPlug,
  IconStack2,
  IconTool,
  IconWorld,
} from "@tabler/icons-react";

export type SettingsNavIcon = ComponentType<{
  className?: string;
  size?: number | string;
  stroke?: number;
}>;

export type SettingsNavGroup = "personal" | "coding" | "system" | "archive";
export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/browser"
  | "/settings/chat"
  | "/settings/editor"
  | "/settings/environment"
  | "/settings/providers"
  | "/settings/devices"
  | "/settings/advanced"
  | "/settings/keyboard-shortcuts"
  | "/settings/about"
  | "/settings/archived";

type SettingsNavItem = {
  readonly group: SettingsNavGroup;
  readonly label: string;
  readonly description: string;
  readonly to: SettingsSectionPath;
  readonly icon: SettingsNavIcon;
};

export const SETTINGS_NAV_GROUPS = [
  { id: "personal", label: "Personal" },
  { id: "coding", label: "Coding" },
  { id: "system", label: "System" },
  { id: "archive", label: "Archive" },
] as const satisfies ReadonlyArray<{
  id: SettingsNavGroup;
  label: string;
}>;

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = [
  {
    group: "personal",
    label: "General",
    description: "Time format and thread defaults",
    to: "/settings/general",
    icon: IconAdjustmentsHorizontal,
  },
  {
    group: "personal",
    label: "Appearance",
    description: "Theme, color palette, fonts, and sizing",
    to: "/settings/appearance",
    icon: IconPalette,
  },
  {
    group: "personal",
    label: "Chat",
    description: "Streaming, notifications, and confirmation behavior",
    to: "/settings/chat",
    icon: IconMessageCircle,
  },
  {
    group: "personal",
    label: "Browser",
    description: "Search engine and mounted browser limits",
    to: "/settings/browser",
    icon: IconWorld,
  },
  {
    group: "coding",
    label: "Editor",
    description: "Workspace editor and language servers",
    to: "/settings/editor",
    icon: IconCode,
  },
  {
    group: "coding",
    label: "Providers",
    description: "Models, provider CLI status, installs, and custom configurations",
    to: "/settings/providers",
    icon: IconPlug,
  },
  {
    group: "coding",
    label: "Environment",
    description: "Worktrees, linked chats, and cleanup",
    to: "/settings/environment",
    icon: IconStack2,
  },
  {
    group: "system",
    label: "Devices",
    description: "Remote host control and pairing",
    to: "/settings/devices",
    icon: IconDevices2,
  },
  {
    group: "system",
    label: "Advanced",
    description: "Git credentials and cache controls",
    to: "/settings/advanced",
    icon: IconTool,
  },
  {
    group: "system",
    label: "Keyboard shortcuts",
    description: "View and customize keyboard shortcuts",
    to: "/settings/keyboard-shortcuts",
    icon: IconKeyboard,
  },
  {
    group: "system",
    label: "About",
    description: "Version details, CLI install, and desktop updates",
    to: "/settings/about",
    icon: IconInfoCircle,
  },
  {
    group: "archive",
    label: "Archived",
    description: "Recover archived projects and threads",
    to: "/settings/archived",
    icon: IconArchive,
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

/** Case-insensitive filter over label + description, for the settings nav search field. */
export function filterSettingsNavItems(query: string): readonly SettingsNavItem[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return SETTINGS_NAV_ITEMS;
  }
  return SETTINGS_NAV_ITEMS.filter(
    (item) =>
      item.label.toLowerCase().includes(trimmed) ||
      item.description.toLowerCase().includes(trimmed),
  );
}
