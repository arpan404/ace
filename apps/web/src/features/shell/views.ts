import { BellIcon, CardsIcon, ClockIcon, CubeIcon, HouseIcon } from "@phosphor-icons/react";
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

/** A view with an icon of its own on the rail. */
export interface RailView extends View {
  icon: IconGlyph;
}

/**
 * Activity: reached from the sidebar's bell (with its needs-you count), `g a` and the palette,
 * not the rail, so each place has one way in.
 */
export const activityView: RailView = {
  id: "activity",
  label: "Activity",
  icon: BellIcon,
  to: "/activity",
  matches: ["/activity"],
  shortcut: "goActivity",
};

/** The rail's views, top to bottom; More (a menu) follows them. */
export const railViews: readonly RailView[] = [
  {
    id: "home",
    label: "Home",
    icon: HouseIcon,
    to: "/",
    matches: ["/t/", "/new"],
    shortcut: "goHome",
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

/** The less used places, a menu on the rail. */
const more: View = { id: "more", label: "More", to: "/more", matches: ["/more"] };

/** Every view, in the palette's order. */
export const views: readonly View[] = [
  ...railViews.slice(0, 1),
  activityView,
  ...railViews.slice(1),
  more,
];

export function activeView(pathname: string): View["id"] | "settings" | undefined {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname === "/") return "home";
  return views.find((view) => view.matches.some((prefix) => pathname.startsWith(prefix)))?.id;
}
