import { CardsIcon, ClockIcon, CubeIcon } from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";
import type { KeymapId } from "@/lib/keymap.ts";

/** The app's views (DESIGN-fable.md, Principle 4). Projects and machines are never views. */
export interface View {
  // `deck` is Offsets in the UI: Deck is called Offset there, and its routes are `/offsets…`.
  id: "home" | "activity" | "deck" | "automations" | "skills";
  label: string;
  to: "/" | "/activity" | "/offsets" | "/automations" | "/skills";
  /** Path prefixes that belong to this view. */
  matches: readonly string[];
  shortcut?: KeymapId;
}

/** A view listed in the sidebar's group under New thread, with its icon. */
export interface NavView extends View {
  icon: IconGlyph;
}

/** The sidebar's places under New thread, top to bottom. */
export const navViews: readonly NavView[] = [
  {
    id: "deck",
    label: "Offsets",
    icon: CardsIcon,
    to: "/offsets",
    matches: ["/offsets"],
    shortcut: "goDeck",
  },
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
 * Every view, in the palette's order. Home is the thread list the sidebar always shows; Activity
 * is the sidebar's bell, with its needs-you count.
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
  ...navViews,
];

export function activeView(pathname: string): View["id"] | "settings" | undefined {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname === "/") return "home";
  return views.find((view) => view.matches.some((prefix) => pathname.startsWith(prefix)))?.id;
}
