import { StackIcon, TimerIcon } from "@phosphor-icons/react";
import type { IconGlyph } from "@/components/icon.tsx";
import { chatChoice } from "@/lib/chat-choice.ts";
import type { KeymapId } from "@/lib/keymap.ts";

/** The app's views (DESIGN-fable.md, Principle 4). Projects and machines are never views. */
export interface View {
  id: "home" | "chats" | "automations" | "skills" | "forge";
  label: string;
  to: "/" | "/chats" | "/automations" | "/skills" | "/pulls";
  /** Path prefixes that belong to this view. */
  matches: readonly string[];
  shortcut?: KeymapId;
}

/** A view the rail lists with its own glyph (Threads, Chats and GitHub draw theirs themselves). */
export interface RailView extends View {
  icon: IconGlyph;
}

/** The rail's places under GitHub, top to bottom. */
export const railViews: readonly RailView[] = [
  {
    id: "automations",
    label: "Automations",
    icon: TimerIcon,
    to: "/automations",
    matches: ["/automations"],
    shortcut: "goAutomations",
  },
  {
    id: "skills",
    label: "Skills",
    icon: StackIcon,
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
  {
    id: "home",
    label: "Home",
    to: "/",
    matches: ["/t/", "/new", "/history"],
    shortcut: "goHome",
  },
  // Chats (ADR 0099): a chat opens at its thread's own address, so `railPlace` tells them apart.
  { id: "chats", label: "Chats", to: "/chats", matches: ["/chats"], shortcut: "goChats" },
  ...railViews,
  forgeView,
];

/** The rail's place for a path: Settings and Usage are ones too; Archived belongs to none. */
export function activeView(pathname: string): View["id"] | "settings" | "usage" | undefined {
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname === "/usage" || pathname.startsWith("/usage/")) return "usage";
  if (pathname === "/") return "home";
  return views.find((view) => view.matches.some((prefix) => pathname.startsWith(prefix)))?.id;
}

/** The rail's current place. */
export type RailPlace = ReturnType<typeof activeView>;

/**
 * The rail's place, with what is open: a chat's thread and New thread for a chat belong to Chats,
 * every other thread to Threads. `openIsChat` is undefined while the open thread isn't known yet
 * (a thread just started, or the list still loading): a chat just sent from New chat stays in
 * Chats, so the panel never flickers; otherwise no place is current until the thread is known.
 */
export function railPlace(input: {
  pathname: string;
  /** New thread's `?project=`. */
  newProject?: string | undefined;
  openIsChat: boolean | undefined;
  /** The place and path just before this one. */
  previous?: { place: RailPlace; pathname: string } | undefined;
}): RailPlace {
  const view = activeView(input.pathname);
  if (view !== "home") return view;
  if (input.pathname.startsWith("/t/")) {
    if (input.openIsChat !== undefined) return input.openIsChat ? "chats" : "home";
    const started = input.previous?.place === "chats" && input.previous.pathname === "/new";
    return started ? "chats" : undefined;
  }
  return input.pathname === "/new" && input.newProject === chatChoice ? "chats" : "home";
}
