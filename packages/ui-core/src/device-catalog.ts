import type { DeviceRow } from "./devices.ts";

/*
 * The Devices list as a pure function of the inventory: what kind each device is, which ones
 * are running, which ones this person used lately, and the rest grouped by kind, all narrowed by
 * the search text and the platform filter. No clock, storage or React: callers pass `now` and
 * the remembered uses.
 */

export type DeviceKind =
  | "iphone"
  | "ipad"
  | "watch"
  | "tv"
  | "vision"
  | "android-phone"
  | "android-tablet";

/** Group order in the list, and each group's heading. */
export const deviceKinds: readonly { kind: DeviceKind; label: string }[] = [
  { kind: "iphone", label: "iPhone" },
  { kind: "ipad", label: "iPad" },
  { kind: "watch", label: "Apple Watch" },
  { kind: "tv", label: "Apple TV" },
  { kind: "vision", label: "Apple Vision" },
  { kind: "android-phone", label: "Android phone" },
  { kind: "android-tablet", label: "Android tablet" },
];

const androidTablet = /\b(tablet|tab|pad|nexus (7|9|10)|fold)\b/i;

/** The kind of device a simulator or emulator stands for, from its platform and name. */
export function deviceKind(device: Pick<DeviceRow, "name" | "platform">): DeviceKind {
  const name = device.name;
  if (device.platform === "android")
    return androidTablet.test(name) ? "android-tablet" : "android-phone";
  if (/\bipad\b/i.test(name)) return "ipad";
  if (/\bwatch\b/i.test(name)) return "watch";
  if (/\bapple tv\b/i.test(name)) return "tv";
  if (/\bvision\b/i.test(name)) return "vision";
  return "iphone";
}

/**
 * How an iPhone's screen is cut: a Dynamic Island (14 Pro and every iPhone from 15 on, except
 * the "e" models), a notch (X to 14, 16e), or the older home-button face (SE, 8 and earlier).
 */
export function iphoneCutout(name: string): "island" | "notch" | "none" {
  if (/\bSE\b|iPhone [5-8]\b/i.test(name)) return "none";
  if (/iPhone Air\b/i.test(name)) return "island";
  const generation = /iPhone (\d+)/i.exec(name)?.[1];
  if (!generation) return /iPhone X/i.test(name) ? "notch" : "island";
  const number = Number(generation);
  if (/\d+e\b/i.test(name)) return "notch";
  if (number >= 15) return "island";
  if (number === 14 && /\bPro\b/i.test(name)) return "island";
  return number >= 10 ? "notch" : "none";
}

/**
 * Whether an iPhone has the Action button (15 Pro, every iPhone from 16 on and the Air) or the
 * older ring/silent switch in its place.
 */
export function iphoneHasActionButton(name: string): boolean {
  if (/iPhone Air\b/i.test(name)) return true;
  const generation = /iPhone (\d+)/i.exec(name)?.[1];
  if (!generation) return iphoneCutout(name) === "island";
  const number = Number(generation);
  return number >= 16 || (number === 15 && /\bPro\b/i.test(name));
}

export type PlatformFilter = "all" | "ios" | "android";

/** One use of a device, remembered on this machine. */
export interface DeviceUse {
  id: string;
  at: number;
}

/** How many recent devices the list remembers and shows. */
export const recentLimit = 5;

/** The uses after opening `id` at `at`: newest first, each device once, at most `limit`. */
export function rememberUse(
  uses: readonly DeviceUse[],
  id: string,
  at: number,
  limit = recentLimit,
): DeviceUse[] {
  return [{ id, at }, ...uses.filter((use) => use.id !== id)].slice(0, limit);
}

/** Whether a row matches every word of the search, by name, OS version or kind. */
export function matchesSearch(row: DeviceRow, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const kind = deviceKinds.find((entry) => entry.kind === deviceKind(row))?.label ?? "";
  const haystack = `${row.name} ${row.detail} ${kind} ${row.platform}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface DeviceGroup {
  kind: DeviceKind;
  label: string;
  rows: DeviceRow[];
}

export interface DeviceCatalog {
  /** Booted devices, the live ones first. */
  running: DeviceRow[];
  /** Devices used lately that aren't running, newest first, with when. */
  recent: { row: DeviceRow; at: number }[];
  /** Every matching device by kind, in `deviceKinds` order; empty kinds are left out. */
  groups: DeviceGroup[];
  /** How many devices match the search and filter. */
  matches: number;
}

/** The Devices list for these rows, search and filter, and this person's remembered uses. */
export function deviceCatalog(
  rows: readonly DeviceRow[],
  options: { query: string; platform: PlatformFilter; uses: readonly DeviceUse[] },
): DeviceCatalog {
  const shown = rows.filter(
    (row) =>
      (options.platform === "all" || row.platform === options.platform) &&
      matchesSearch(row, options.query),
  );
  const byId = new Map(shown.map((row) => [row.id, row]));
  const running = shown
    .filter((row) => row.running)
    .toSorted((a, b) => Number(b.live) - Number(a.live));
  const recent = options.uses
    .toSorted((a, b) => b.at - a.at)
    .flatMap((use) => {
      const row = byId.get(use.id);
      return row && !row.running ? [{ row, at: use.at }] : [];
    })
    .slice(0, recentLimit);
  const groups = deviceKinds.flatMap(({ kind, label }) => {
    const members = shown.filter((row) => deviceKind(row) === kind);
    return members.length ? [{ kind, label, rows: members }] : [];
  });
  return { running, recent, groups, matches: shown.length };
}
