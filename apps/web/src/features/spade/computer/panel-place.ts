import type { SpadeSurfaceKind } from "@ace/ui-core/spade-chat";

/*
 * The right panel beside a bot's conversation: its sections and what this browser remembers of
 * it per bot (open or closed, its section, its width), kept in localStorage.
 */

/** The panel's sections: the computer's surfaces, then what the bot did and its helpers. */
export type PanelSection = SpadeSurfaceKind | "activity" | "helpers";

export const panelSections: readonly PanelSection[] = [
  "browser",
  "screen",
  "terminal",
  "files",
  "activity",
  "helpers",
];

export const panelSectionNames: Record<PanelSection, string> = {
  browser: "Browser",
  screen: "Screen",
  terminal: "Terminal",
  files: "Files",
  activity: "Activity",
  helpers: "Helpers",
};

export const panelWidth = { initial: 520, min: 320, max: 900 };

export interface PanelMemory {
  open: boolean;
  section: PanelSection;
  width: number;
}

const keyOf = (bot: string) => `ace.spade.panel.${bot}`;
const isSection = (value: unknown): value is PanelSection =>
  typeof value === "string" && (panelSections as readonly string[]).includes(value);

/** What was remembered for `bot` (`machine/id`), or the panel closed on Files at its width. */
export function readPanel(storage: Storage | undefined, bot: string): PanelMemory {
  const fallback: PanelMemory = { open: false, section: "files", width: panelWidth.initial };
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
    section: isSection(fields.section) ? fields.section : fallback.section,
    width: Math.min(panelWidth.max, Math.max(panelWidth.min, width)),
  };
}

export function writePanel(storage: Storage | undefined, bot: string, memory: PanelMemory) {
  try {
    storage?.setItem(keyOf(bot), JSON.stringify(memory));
  } catch {
    // Storage full or off: the panel just isn't remembered.
  }
}
