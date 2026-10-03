import {
  BellIcon,
  CardsIcon,
  ClockIcon,
  CubeIcon,
  DotsThreeIcon,
  HouseIcon,
} from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";
import type { KeymapId } from "@/lib/keymap.ts";

/** The rail's views (DESIGN-fable.md, Principle 4). Projects and machines are never views. */
export interface RailView {
  id: "home" | "activity" | "deck" | "automations" | "skills" | "more";
  label: string;
  icon: IconGlyph;
  to: "/" | "/activity" | "/deck" | "/automations" | "/skills" | "/more";
  /** Path prefixes that belong to this view. */
  matches: readonly string[];
  shortcut?: KeymapId;
}

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
  { id: "more", label: "More", icon: DotsThreeIcon, to: "/more", matches: ["/more"] },
];

export function activeView(pathname: string): RailView["id"] | "settings" | undefined {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname === "/") return "home";
  return railViews.find((view) => view.matches.some((prefix) => pathname.startsWith(prefix)))?.id;
}
