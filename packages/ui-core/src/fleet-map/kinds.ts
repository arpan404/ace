import type { MachineIconKind } from "@ace/protocol";

/*
 * What a machine or device is, for its glyph and its artwork on the map, from what it tells us:
 * the mark the person picked, the name it gives, the platform it runs.
 */

export type DeviceKind = "phone" | "tablet" | "browser";
export type MachineKind = "laptop" | "desktop" | "server" | "phone";

/** A paired device from the name it gives: phones, tablets, else a browser. */
export function deviceKind(name: string): DeviceKind {
  const lower = name.toLowerCase();
  if (/ipad|tablet|tab s/.test(lower)) return "tablet";
  if (/iphone|pixel|android|phone|galaxy/.test(lower)) return "phone";
  return "browser";
}

const iconKinds: Record<MachineIconKind, MachineKind> = {
  laptop: "laptop",
  desktop: "desktop",
  monitor: "desktop",
  server: "server",
  cloud: "server",
  cpu: "server",
  terminal: "server",
  phone: "phone",
};

/**
 * A machine from its mark, else its name ("Build server", "Studio"), else its platform (Linux is
 * most often a server); a laptop when nothing says.
 */
export function machineKind(input: {
  icon?: MachineIconKind | undefined;
  name: string;
  platform?: string | undefined;
}): MachineKind {
  if (input.icon) return iconKinds[input.icon];
  const name = input.name.toLowerCase();
  if (/laptop|macbook|notebook/.test(name)) return "laptop";
  if (/server|box|nas|runner|\bci\b/.test(name)) return "server";
  if (/studio|desktop|imac|mini|tower|workstation|\bpc\b/.test(name)) return "desktop";
  if (input.platform?.toLowerCase() === "linux") return "server";
  return "laptop";
}
