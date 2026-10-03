export type PaletteIcon = "thread" | "project" | "view" | "action" | "settle" | "theme";
export interface PaletteCommand {
  id: string;
  label: string;
  /** Muted text after the label (the project on a thread). Also searched. */
  detail?: string;
  /** Shown after the detail only on the highlighted row (a thread's branch). Also searched. */
  more?: string;
  /** Keymap notation, shown at the right. */
  keys?: string;
  icon: PaletteIcon;
  run(): void;
}
export interface PaletteGroup {
  value: string;
  items: PaletteCommand[];
}
