import type { IconGlyph } from "@/components/icon.tsx";

export type PaletteIcon = "thread" | "project" | "view" | "action" | "settle" | "theme";
export interface PaletteCommand {
  id: string;
  label: string;
  /** Muted text after the label (the project on a thread). Also searched. */
  detail?: string;
  /** Shown after the detail only on the highlighted row (a thread's branch). Also searched. */
  more?: string;
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
  /** Keeps the palette open (the row changes what it lists). */
  stay?: boolean;
  run(): void;
}
export interface PaletteGroup {
  value: string;
  items: PaletteCommand[];
}
