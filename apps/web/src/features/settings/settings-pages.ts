import {
  BellSimpleIcon,
  ChatsCircleIcon,
  DatabaseIcon,
  DevicesIcon,
  GearSixIcon,
  GitBranchIcon,
  GlobeSimpleIcon,
  NotePencilIcon,
  KeyboardIcon,
  PaletteIcon,
  TerminalWindowIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { ComputerUseIcon } from "@/components/ace-icons.tsx";
import type { IconGlyph } from "@/components/icon.tsx";

export type SettingsPath =
  | "/settings/prompts"
  | "/settings/general"
  | "/settings/agents"
  | "/settings/appearance"
  | "/settings/providers"
  | "/settings/notifications"
  | "/settings/source-control"
  | "/settings/remote"
  | "/settings/computer-use"
  | "/settings/browser"
  | "/settings/keyboard"
  | "/settings/advanced"
  | "/settings/storage";

/**
 * Where a page's settings live. `machine`: on the environment picked at the top of the Settings
 * sidebar, for every device that uses it. `device`: only on the screen in use, whatever
 * environment is picked. `network`: how machines and devices reach each other.
 */
export type SettingsGroup = "machine" | "device" | "network";

export interface SettingsPage {
  to: SettingsPath;
  title: string;
  icon: IconGlyph;
  group: SettingsGroup;
}

export const settingsGroupTitles: Record<SettingsGroup, string | undefined> = {
  machine: undefined,
  device: "This device",
  network: undefined,
};

export const settingsPages: readonly SettingsPage[] = [
  { to: "/settings/agents", title: "Agents", icon: ChatsCircleIcon, group: "machine" },
  { to: "/settings/providers", title: "Providers", icon: TerminalWindowIcon, group: "machine" },
  { to: "/settings/prompts", title: "Prompts", icon: NotePencilIcon, group: "machine" },
  {
    to: "/settings/source-control",
    title: "Source control",
    icon: GitBranchIcon,
    group: "machine",
  },
  { to: "/settings/browser", title: "Browser", icon: GlobeSimpleIcon, group: "machine" },
  { to: "/settings/computer-use", title: "Computer use", icon: ComputerUseIcon, group: "machine" },
  { to: "/settings/storage", title: "Storage", icon: DatabaseIcon, group: "machine" },
  { to: "/settings/advanced", title: "Advanced", icon: WrenchIcon, group: "machine" },
  { to: "/settings/general", title: "General", icon: GearSixIcon, group: "device" },
  { to: "/settings/appearance", title: "Appearance", icon: PaletteIcon, group: "device" },
  { to: "/settings/notifications", title: "Notifications", icon: BellSimpleIcon, group: "device" },
  { to: "/settings/keyboard", title: "Keyboard", icon: KeyboardIcon, group: "device" },
  { to: "/settings/remote", title: "Fleet", icon: DevicesIcon, group: "network" },
];

export function visibleSettingsPages(): readonly SettingsPage[] {
  return settingsPages;
}

/** The page a path belongs to: itself, or the page it's a sub-page of. */
export function settingsPageOf(pathname: string): SettingsPage | undefined {
  const path = pathname.replace(/\/+$/, "");
  return settingsPages.find((page) => path === page.to || path.startsWith(`${page.to}/`));
}
