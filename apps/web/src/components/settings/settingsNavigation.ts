import { IconTerminal } from "@tabler/icons-react";
import type { ComponentType } from "react";
import {
  ArchiveIcon,
  InfoIcon,
  MessageCircleIcon,
  ServerIcon,
  Settings2Icon,
  SquarePenIcon,
  WrenchIcon,
} from "lucide-react";

export type SettingsNavGroup = "workspace" | "ai" | "system" | "data";
export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/chat"
  | "/settings/editor"
  | "/settings/providers"
  | "/settings/devices"
  | "/settings/advanced"
  | "/settings/about"
  | "/settings/archived";

type SettingsNavIcon = ComponentType<{ className?: string }>;
type SettingsNavItem = {
  readonly group: SettingsNavGroup;
  readonly label: string;
  readonly description: string;
  readonly to: SettingsSectionPath;
  readonly icon: SettingsNavIcon;
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
    description: "Appearance, time, thread defaults, and browser search",
    to: "/settings/general",
    icon: Settings2Icon,
  },
  {
    group: "workspace",
    label: "Chat",
    description: "Streaming, notifications, and confirmation behavior",
    to: "/settings/chat",
    icon: MessageCircleIcon,
  },
  {
    group: "workspace",
    label: "Editor",
    description: "Workspace editor, diffs, and language servers",
    to: "/settings/editor",
    icon: SquarePenIcon,
  },
  {
    group: "ai",
    label: "Providers",
    description: "Models, provider CLI status, installs, and custom configurations",
    to: "/settings/providers",
    icon: IconTerminal,
  },
  {
    group: "system",
    label: "Devices",
    description: "Remote host control and pairing",
    to: "/settings/devices",
    icon: ServerIcon,
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
    group: "data",
    label: "Archived",
    description: "Recover archived projects and threads",
    to: "/settings/archived",
    icon: ArchiveIcon,
  },
];

const DEFAULT_SETTINGS_NAV_ITEM = SETTINGS_NAV_ITEMS[0] as SettingsNavItem;

export function getSettingsNavItem(pathname: string) {
  return SETTINGS_NAV_ITEMS.find((item) => item.to === pathname) ?? DEFAULT_SETTINGS_NAV_ITEM;
}
