import { LightningIcon, SparkleIcon } from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";
import type { KeymapId } from "@/lib/keymap.ts";

/** The app's views (DESIGN-fable.md, Principle 4). Projects and machines are never views. */
export interface View {
  id: "home" | "automations" | "skills" | "forge";
  label: string;
  to: "/" | "/automations" | "/skills" | "/pulls";
  /** Path prefixes that belong to this view. */
  matches: readonly string[];
  shortcut?: KeymapId;
}

/** A view the rail lists with its own glyph (Threads and GitHub draw theirs themselves). */
export interface RailView extends View {
  icon: IconGlyph;
}

/** The rail's places under GitHub, top to bottom. */
export const railViews: readonly RailView[] = [
  {
    id: "automations",
    label: "Automations",
    icon: LightningIcon,
    to: "/automations",
    matches: ["/automations"],
    shortcut: "goAutomations",
  },
  {
    id: "skills",
    label: "Skills",
    icon: SparkleIcon,
    to: "/skills",
    matches: ["/skills"],
    shortcut: "goSkills",
  },
];

/** GitHub in the rail: Inbox, Pull requests and Issues, opened on Pull requests. */
const forgeView: View = {
  id: "forge",
  label: "Pull requests",
  to: "/pulls",
  matches: ["/pulls", "/issues", "/inbox"],
  shortcut: "goPullRequests",
};

/**
 * Every view, in the palette's order. Home is the thread list the sidebar always shows.
 */
export const views: readonly View[] = [
  { id: "home", label: "Home", to: "/", matches: ["/t/", "/new"], shortcut: "goHome" },
  ...railViews,
  forgeView,
];

/** The rail's place for a path: Settings is one too; Usage and Archived belong to none. */
export function activeView(pathname: string): View["id"] | "settings" | undefined {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname === "/") return "home";
  return views.find((view) => view.matches.some((prefix) => pathname.startsWith(prefix)))?.id;
}
