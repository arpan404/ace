import {
  FileTextIcon,
  BellIcon,
  CodeIcon,
  CursorClickIcon,
  KeyboardIcon,
  LaptopIcon,
  PaletteIcon,
  PlugIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";

export type SettingsPath =
  | "/settings/prompts"
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/providers"
  | "/settings/notifications"
  | "/settings/remote"
  | "/settings/computer-use"
  | "/settings/keyboard"
  | "/settings/advanced";

export const settingsPages: readonly { to: SettingsPath; title: string; icon: IconGlyph }[] = [
  { to: "/settings/general", title: "General", icon: SlidersHorizontalIcon },
  { to: "/settings/appearance", title: "Appearance", icon: PaletteIcon },
  { to: "/settings/prompts", title: "Prompts", icon: FileTextIcon },
  { to: "/settings/providers", title: "Providers", icon: PlugIcon },
  { to: "/settings/notifications", title: "Notifications", icon: BellIcon },
  { to: "/settings/remote", title: "Remote devices", icon: LaptopIcon },
  { to: "/settings/computer-use", title: "Computer use", icon: CursorClickIcon },
  { to: "/settings/keyboard", title: "Keyboard", icon: KeyboardIcon },
  { to: "/settings/advanced", title: "Advanced", icon: CodeIcon },
];
