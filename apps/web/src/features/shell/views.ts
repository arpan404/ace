import { BellIcon, CardsIcon, ClockIcon, CubeIcon } from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";
import type { KeymapId } from "@/lib/keymap.ts";

/** The app's views (DESIGN-fable.md, Principle 4). Projects and machines are never views. */
export interface View {
  id: "home" | "activity" | "deck" | "automations" | "skills" | "more";
  label: string;
  to: "/" | "/activity" | "/deck" | "/automations" | "/skills" | "/more";
  /** Path prefixes that belong to this view. */
  matches: readonly string[];
  shortcut?: KeymapId;
}

/** A view with a row of its own in the sidebar. */
export interface SidebarView extends View {
  icon: IconGlyph;
}

/** Home is the thread list itself, reached by New thread, the wordmark and the list. */
const home: View = {
  id: "home",
  label: "Home",
  to: "/",
  matches: ["/t/", "/new"],
  shortcut: "goHome",
};

/** The sidebar's rows under New thread and Search. */
export const sidebarViews: readonly SidebarView[] = [
  {
    id: "activity",
    label: "Activity",
    icon: BellIcon,
    to: "/activity",
    matches: ["/activity"],
    shortcut: "goActivity",
  },
  {
    id: "deck",
    label: "Deck",
    icon: CardsIcon,
    to: "/deck",
    matches: ["/deck"],
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

/** The less used places, a menu in the sidebar. */
const more: View = { id: "more", label: "More", to: "/more", matches: ["/more"] };

export const views: readonly View[] = [home, ...sidebarViews, more];

export function activeView(pathname: string): View["id"] | "settings" | undefined {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname === "/") return "home";
  return views.find((view) => view.matches.some((prefix) => pathname.startsWith(prefix)))?.id;
}
