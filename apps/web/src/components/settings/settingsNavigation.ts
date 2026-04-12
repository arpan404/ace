import type { ComponentType } from "react";
import {
  ArchiveIcon,
  BotIcon,
  GlobeIcon,
  InfoIcon,
  MessageCircleIcon,
  ServerIcon,
  Settings2Icon,
  SquarePenIcon,
  TerminalSquareIcon,
  WrenchIcon,
} from "lucide-react";

export type SettingsNavGroup = "workspace" | "ai" | "system" | "data";

export const SETTINGS_NAV_GROUPS = [
  { id: "workspace", label: "Workspace" },
  { id: "ai", label: "AI" },
  { id: "system", label: "System" },
  { id: "data", label: "Data" },
] as const satisfies ReadonlyArray<{
  id: SettingsNavGroup;
  label: string;
}>;

export const SETTINGS_NAV_ITEMS = [
  {
    group: "workspace",
    label: "General",
    description: "Appearance, time, and thread defaults",
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
    description: "Workspace editor and diff preferences",
    to: "/settings/editor",
    icon: SquarePenIcon,
  },
  {
    group: "workspace",
    label: "Browser",
    description: "Search defaults for in-app browsing",
    to: "/settings/browser",
    icon: GlobeIcon,
  },
  {
    group: "ai",
    label: "Models",
    description: "Text generation model overrides",
    to: "/settings/models",
    icon: BotIcon,
  },
  {
    group: "ai",
    label: "Providers",
    description: "CLI status, installs, and custom models",
    to: "/settings/providers",
    icon: TerminalSquareIcon,
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
    description: "Keybindings and cache controls",
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
] as const satisfies ReadonlyArray<{
  group: SettingsNavGroup;
  label: string;
  description: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
}>;

export type SettingsSectionPath = (typeof SETTINGS_NAV_ITEMS)[number]["to"];

export function getSettingsNavItem(pathname: string) {
  return SETTINGS_NAV_ITEMS.find((item) => item.to === pathname) ?? SETTINGS_NAV_ITEMS[0];
}
