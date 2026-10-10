import { ClockIcon, CubeIcon } from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";
import type { KeymapId } from "@/lib/keymap.ts";

/** The app's views (DESIGN-fable.md, Principle 4). Projects and machines are never views. */
export interface View {
  id: "home" | "activity" | "automations" | "skills";
  label: string;
  to: "/" | "/activity" | "/automations" | "/skills";
  /** Path prefixes that belong to this view. */
  matches: readonly string[];
  shortcut?: KeymapId;
}

/** A view listed in the profile dropdown, with its icon. */
export interface MenuView extends View {
  icon: IconGlyph;
}

/** The profile dropdown's views, top to bottom. */
export const menuViews: readonly MenuView[] = [
  {
    id: "automations",
    label: "Automations",
    icon: ClockIcon,
    to: "/automations",
    matches: ["/automations"],
    shortcut: "goAutomations",
  },
  {
    id: "skills",
    label: "Skills",
    icon: CubeIcon,
    to: "/skills",
    matches: ["/skills"],
    shortcut: "goSkills",
  },
];

/**
 * Every view, in the palette's order. Home is the thread list the sidebar always shows;
 * Activity is available through the palette and its keyboard shortcut.
 */
export const views: readonly View[] = [
  { id: "home", label: "Home", to: "/", matches: ["/t/", "/new"], shortcut: "goHome" },
  {
    id: "activity",
    label: "Activity",
    to: "/activity",
    matches: ["/activity"],
    shortcut: "goActivity",
  },
  ...menuViews,
];

export function activeView(pathname: string): View["id"] | "settings" | undefined {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname === "/") return "home";
  return views.find((view) => view.matches.some((prefix) => pathname.startsWith(prefix)))?.id;
}
