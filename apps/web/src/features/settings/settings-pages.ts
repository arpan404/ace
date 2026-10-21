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
  SquaresFourIcon,
  TerminalWindowIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { ComputerUseIcon } from "@/components/ace-icons.tsx";
import type { IconGlyph } from "@/components/icon.tsx";

export type SettingsPath =
  | "/settings/overview"
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
 * Where a page's settings live. `device`: only on the screen in use. `machine`: on the machine
 * picked in the Settings sidebar, for every device that uses it. `network`: how machines and
 * devices reach each other. `overview` heads the list on its own.
 */
export type SettingsGroup = "overview" | "device" | "machine" | "network";

export interface SettingsPage {
  to: SettingsPath;
  title: string;
  icon: IconGlyph;
  group: SettingsGroup;
}

export const settingsGroupTitles: Record<Exclude<SettingsGroup, "overview">, string> = {
  device: "This device",
  machine: "Machine",
  network: "Network",
};

export const settingsPages: readonly SettingsPage[] = [
  { to: "/settings/overview", title: "Overview", icon: SquaresFourIcon, group: "overview" },
  { to: "/settings/general", title: "General", icon: GearSixIcon, group: "device" },
  { to: "/settings/appearance", title: "Appearance", icon: PaletteIcon, group: "device" },
  { to: "/settings/notifications", title: "Notifications", icon: BellSimpleIcon, group: "device" },
  { to: "/settings/keyboard", title: "Keyboard", icon: KeyboardIcon, group: "device" },
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
  { to: "/settings/remote", title: "Machines and devices", icon: DevicesIcon, group: "network" },
];

export function visibleSettingsPages(): readonly SettingsPage[] {
  return settingsPages;
}

/** The page a path belongs to: itself, or the page it's a sub-page of. */
export function settingsPageOf(pathname: string): SettingsPage | undefined {
  const path = pathname.replace(/\/+$/, "");
  return settingsPages.find((page) => path === page.to || path.startsWith(`${page.to}/`));
}
