import type { ProviderKind } from "@ace/protocol";
import { providerDisplayName } from "./providers.ts";
import { matchRank } from "./script-choices.ts";

/*
 * The `@` picker's one list (ADR 0194): who and what a message can name, in a fixed order of
 * sections, each row a name and one quiet line of context, filtered across every section by the
 * same forgiving match, with the best match first to be picked. Pure: a client brings the rows'
 * facts and draws each row's picture (`mention-marks.ts`).
 */

/** The sections, in the order the list shows them. */
export const pickerSections = [
  "Agents",
  "Spade bots",
  "Clubs",
  "Devices",
  "Apps",
  "Files",
  "Browser tabs",
  "Threads",
] as const;
export type PickerSection = (typeof pickerSections)[number];

/** Another thread's agent the message can go to: one working or waiting now. */
export interface PickerAgent {
  threadId: string;
  title: string;
  provider?: ProviderKind | undefined;
  state: "working" | "waiting";
}
export interface PickerBot {
  id: string;
  name: string;
  /** What it is for, in the person's words; the row shows its first line. */
  task: string;
  main: boolean;
}
export interface PickerClub {
  id: string;
  name: string;
  members: readonly string[];
}

/** What a device is, for its glyph and its words. */
export type PickerDeviceKind =
  | "laptop"
  | "desktop"
  | "server"
  | "phone"
  | "tablet"
  | "browser"
  | "simulator"
  | "emulator";

/** A machine of the fleet, or a device ace knows on one (a paired phone, a simulator). */
export interface PickerDevice {
  /** The machine's host id, or the device's id on its machine. */
  id: string;
  name: string;
  kind: PickerDeviceKind;
  /** The machine it is, or is on. */
  machine: { id: string; name: string; here: boolean };
  /** "Linux", "macOS", "iOS 18.4", "Android 15", when known. */
  os?: string | undefined;
  /** Reachable now: the machine online, a simulator running, a phone seen lately. */
  online: boolean;
  /** For a simulator or emulator, the hardware it is ("iPhone 17"). */
  model?: string | undefined;
}

/** One row of the list: its section, its words, and what picking it names. */
export interface PickerRow<Payload> {
  section: PickerSection;
  label: string;
  /** One quiet line of context; the chip's hover reads the same. */
  detail: string;
  payload: Payload;
  /** How well it matches what was typed: lower is better. */
  rank: number;
}

/** "working", "waiting for you". */
function agentState(state: PickerAgent["state"]): string {
  return state === "working" ? "working" : "waiting for you";
}

export function agentDetail(agent: PickerAgent): string {
  return [agent.provider ? providerDisplayName(agent.provider) : undefined, agentState(agent.state)]
    .filter(Boolean)
    .join(" · ");
}

export function botDetail(bot: PickerBot): string {
  if (bot.main) return "Your main bot";
  const first = bot.task.split("\n")[0]?.trim() ?? "";
  return first ? (first.length > 60 ? `${first.slice(0, 59)}…` : first) : "Spade bot";
}

export function clubDetail(club: PickerClub): string {
  const names = club.members;
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

const deviceWords: Record<PickerDeviceKind, string> = {
  laptop: "Laptop",
  desktop: "Desktop",
  server: "Server",
  phone: "Phone",
  tablet: "Tablet",
  browser: "Browser",
  simulator: "simulator",
  emulator: "emulator",
};

/**
 * A machine: "omarchy · Linux · online". A simulator or emulator: "iPhone 17 simulator · on this
 * machine". A paired device: "Phone · paired with omarchy". Offline reads last, always.
 */
export function deviceDetail(device: PickerDevice): string {
  const isMachine = device.machine.id === device.id;
  const state = device.online ? "online" : "offline";
  if (isMachine)
    return [device.machine.here ? "This machine" : device.name, device.os, state]
      .filter(Boolean)
      .join(" · ");
  const where = device.machine.here ? "this machine" : device.machine.name;
  if (device.kind === "simulator" || device.kind === "emulator") {
    const what = [device.model ?? device.os, deviceWords[device.kind]].filter(Boolean).join(" ");
    return [what, `on ${where}`, device.online ? undefined : "offline"].filter(Boolean).join(" · ");
  }
  return [deviceWords[device.kind], `paired with ${where}`, device.online ? undefined : "offline"]
    .filter(Boolean)
    .join(" · ");
}

/** The rank a row's name (or, a worse match, its context line) earns for `query`. */
function rankOf(label: string, detail: string, query: string): number | undefined {
  if (!query) return 0;
  const byName = matchRank(label, query);
  if (byName !== undefined) return byName;
  const byDetail = matchRank(detail, query);
  return byDetail === undefined ? undefined : byDetail + 3;
}

/**
 * Every row that answers `query`, sections in their order and, within each, best match first
 * (ties keep the order they came in). Nothing typed keeps every row, at most `perSection` each.
 */
export function pickerRows<Payload>(
  rows: readonly (Omit<PickerRow<Payload>, "rank"> & {
    /** Already matched elsewhere (a file the daemon's index found): kept, at this rank. */
    matched?: number | undefined;
  })[],
  query: string,
  perSection = 8,
): PickerRow<Payload>[] {
  const needle = query.trim().toLowerCase();
  const ranked = rows.flatMap(({ matched, ...row }, index) => {
    const rank = rankOf(row.label, row.detail, needle) ?? matched;
    return rank === undefined ? [] : [{ ...row, rank, index }];
  });
  return pickerSections.flatMap((section) =>
    ranked
      .filter((row) => row.section === section)
      .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
      .slice(0, perSection)
      .map(({ index: _index, ...row }) => row),
  );
}

/** The row the list highlights first: the best match anywhere, the first of its rank. */
export function bestRow(rows: readonly Pick<PickerRow<unknown>, "rank">[]): number {
  let best = 0;
  rows.forEach((row, index) => {
    if (row.rank < (rows[best]?.rank ?? Number.POSITIVE_INFINITY)) best = index;
  });
  return best;
}
