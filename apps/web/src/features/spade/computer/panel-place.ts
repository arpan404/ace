import type { SpadeSurfaceKind } from "@ace/ui-core/spade-chat";

/*
 * A bot's profile, the side panel beside its conversation: its tabs, the computer's views, and
 * what this browser remembers of it per bot (open or closed, its tab, the computer's view, its
 * width), kept in localStorage.
 */

/**
 * The profile's tabs: what the bot is, what it works toward (only while it has a goal, workers
 * or decisions), what it keeps, what it drives.
 */
export type ProfileTab = "details" | "work" | "library" | "computer";

export const profileTabs: readonly ProfileTab[] = ["details", "work", "library", "computer"];

export const profileTabNames: Record<ProfileTab, string> = {
  details: "Details",
  work: "Work",
  library: "Library",
  computer: "Computer",
};

/** What Computer shows: one of the surfaces it used, or what it did. */
export type ComputerView = SpadeSurfaceKind | "activity";

export const computerViews: readonly ComputerView[] = [
  "browser",
  "screen",
  "terminal",
  "files",
  "activity",
];

export const computerViewNames: Record<ComputerView, string> = {
  browser: "Browser",
  screen: "Screen",
  terminal: "Terminal",
  files: "Files",
  activity: "Activity",
};

/** `--spade-profile-width` to start; the person drags it between these. */
export const panelWidth = { initial: 360, min: 320, max: 900 };

export interface PanelMemory {
  open: boolean;
  tab: ProfileTab;
  /** Computer's view, once the person picked one. */
  view: ComputerView | undefined;
  width: number;
}

const keyOf = (bot: string) => `ace.spade.profile.${bot}`;
const isTab = (value: unknown): value is ProfileTab =>
  typeof value === "string" && (profileTabs as readonly string[]).includes(value);
const isView = (value: unknown): value is ComputerView =>
  typeof value === "string" && (computerViews as readonly string[]).includes(value);

/** What was remembered for `bot` (`machine/id`), or the profile closed on Details. */
export function readPanel(storage: Storage | undefined, bot: string): PanelMemory {
  const fallback: PanelMemory = {
    open: false,
    tab: "details",
    view: undefined,
    width: panelWidth.initial,
  };
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(keyOf(bot)) ?? "null");
  } catch {
    return fallback;
  }
  if (typeof raw !== "object" || raw === null) return fallback;
  const fields = raw as Record<string, unknown>;
  const width =
    typeof fields.width === "number" && Number.isFinite(fields.width)
      ? fields.width
      : fallback.width;
  return {
    open: fields.open === true,
    tab: isTab(fields.tab) ? fields.tab : fallback.tab,
    view: isView(fields.view) ? fields.view : undefined,
    width: Math.min(panelWidth.max, Math.max(panelWidth.min, width)),
  };
}

export function writePanel(storage: Storage | undefined, bot: string, memory: PanelMemory) {
  try {
    storage?.setItem(keyOf(bot), JSON.stringify(memory));
  } catch {
    // Storage full or off: the profile just isn't remembered.
  }
}
