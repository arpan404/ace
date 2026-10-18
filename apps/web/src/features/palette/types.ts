import type { IconGlyph } from "@/components/icon.tsx";

export type PaletteIcon = "thread" | "project" | "view" | "action" | "settle" | "theme";
export interface PaletteCommand {
  id: string;
  label: string;
  /** Muted text after the label (the project on a thread). Also searched. */
  detail?: string;
  /** Shown after the detail only on the highlighted row (a thread's branch). Also searched. */
  more?: string;
  /** Other words that find it, never shown ("approve" for Allow once, a thread's PR number). */
  keywords?: string;
  /** Keymap notation (a keymap default follows the user's rebinding), shown at the right. */
  keys?: string;
  /** A named glyph, or any icon (the thread menu's own). */
  icon: PaletteIcon | IconGlyph;
  /** A project's tint (`projectTint`): its glyph wears the project's colour, as on Home. */
  tint?: number;
  /** Destructive: drawn in the danger colour. */
  danger?: boolean;
  /** Why it can't run now; the row is shown dimmed with this as its detail. */
  disabled?: string;
  /**
   * What it is, when it isn't an action: a thread, a project, or a message found inside a
   * thread. A query starting with `>` lists actions only.
   */
  kind?: "thread" | "project" | "message";
  /** When it was last opened or run (ms): breaks ranking ties, newest first. */
  at?: number;
  /** The thread a message was found in. */
  threadId?: string;
  /** A message's matching text, its matched ranges marked. */
  snippet?: { text: string; highlights: readonly { start: number; end: number }[] };
  run(): void;
}
export interface PaletteGroup {
  value: string;
  items: PaletteCommand[];
}
