export type PaletteIcon = "thread" | "project" | "view" | "action" | "settle" | "theme";
export interface PaletteCommand {
  id: string;
  label: string;
  /** Muted text after the label (project and branch on a thread). Also searched. */
  detail?: string;
  /** Keymap notation, shown at the right. */
  keys?: string;
  icon: PaletteIcon;
  run(): void;
}
export interface PaletteGroup {
  value: string;
  items: PaletteCommand[];
}
