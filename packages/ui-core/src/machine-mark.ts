import type { MachineIcon, MachineIconKind } from "@ace/protocol";

/** Each curated machine mark's Phosphor icon name, for clients that draw icons by name. */
export const machineIconGlyphs: Readonly<Record<MachineIconKind, string>> = {
  laptop: "laptop",
  desktop: "desktop-tower",
  monitor: "desktop",
  server: "hard-drives",
  cloud: "cloud",
  cpu: "cpu",
  terminal: "terminal-window",
  phone: "device-mobile",
};

/** The icon a machine's mark draws: the one it chose, else a laptop (`MachineIcon`). */
export function machineGlyph(icon: MachineIcon | undefined): string {
  return machineIconGlyphs[icon?.kind ?? "laptop"];
}
