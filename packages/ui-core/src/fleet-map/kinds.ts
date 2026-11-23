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

function computerKind(name: string): Exclude<MachineKind, "phone"> | undefined {
  const lower = name.toLowerCase();
  if (/laptop|macbook|notebook/.test(lower)) return "laptop";
  if (/server|box|nas|runner|\bci\b/.test(lower)) return "server";
  if (/studio|desktop|imac|mini|tower|workstation|\bpc\b/.test(lower)) return "desktop";
  if (/computer/.test(lower)) return "laptop";
  return undefined;
}

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
  return (
    computerKind(input.name) ?? (input.platform?.toLowerCase() === "linux" ? "server" : "laptop")
  );
}

/** The mark for a fleet node. A paired computer keeps its device role and its computer mark. */
export function markOf(input: {
  kind: "machine" | "device";
  name: string;
  icon?: MachineIconKind | undefined;
  platform?: string | undefined;
}): MachineKind | DeviceKind {
  if (input.kind === "device") {
    const device = deviceKind(input.name);
    return device === "browser" ? (computerKind(input.name) ?? device) : device;
  }
  if (input.icon === "phone") return computerKind(input.name) ?? "phone";
  return machineKind(input);
}
