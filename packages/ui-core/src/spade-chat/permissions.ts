import { z } from "zod";
import { spadeRecord } from "./json.ts";

/*
 * A bot's Permissions as Spade's API sends them (ADR 0171, amendment 7): one switch per kind of
 * reach, each with the plain line the Permissions tab shows, and the apps bots never use through
 * Computer use. Parsed leniently: a switch this client doesn't know is left out, one it knows
 * that Spade didn't send reads as off.
 */

export type SpadePermissionKey =
  | "computer_use"
  | "browser"
  | "devices"
  | "apps"
  | "commands"
  | "network"
  | "send"
  | "pay";

/** Each switch, in the order the tab lists them, with its title and one plain line. */
export const spadePermissionSwitches: readonly {
  key: SpadePermissionKey;
  title: string;
  line: string;
}[] = [
  {
    key: "computer_use",
    title: "Computer use",
    line: "The screen and apps on this computer. On, every step runs without asking.",
  },
  {
    key: "browser",
    title: "Browser",
    line: "Pages in ace's browser. On, every step runs without asking.",
  },
  {
    key: "devices",
    title: "Simulators and devices",
    line: "Simulators, emulators and connected devices. On, every step runs without asking.",
  },
  { key: "apps", title: "Apps", line: "The tools of the apps you connected." },
  {
    key: "commands",
    title: "Commands outside the sandbox",
    line: "Its commands run outside the sandbox, each one reviewed.",
  },
  {
    key: "network",
    title: "Network beyond listed sites",
    line: "Its commands can reach any public site, not only the listed ones.",
  },
  {
    key: "send",
    title: "Send as you",
    line: "Mail, messages, comments and pushes in your name. Each one still asks you.",
  },
  { key: "pay", title: "Payments", line: "Spending money. Each payment still asks you." },
];

export type SpadePermissionValues = Record<SpadePermissionKey, boolean>;

export interface SpadePermissions {
  /** What holds: the bot's own, else the bot above it's, else the default. */
  on: SpadePermissionValues;
  /** Which the bot sets itself; the machine's view has none. */
  own: SpadePermissionValues;
  /** The apps no bot uses through Computer use. */
  neverApps: string[];
}

const flags = z.record(z.string(), z.unknown()).catch({});

function values(raw: unknown): SpadePermissionValues {
  const read = flags.parse(raw ?? {});
  const all = {} as SpadePermissionValues;
  for (const each of spadePermissionSwitches) all[each.key] = read[each.key] === true;
  return all;
}

/** The `permissions` of a bot's or the machine's security view; undefined from a Spade before. */
export function parseSpadePermissions(raw: unknown): SpadePermissions | undefined {
  const record = spadeRecord(raw);
  if (!record) return undefined;
  const apps = Array.isArray(record.never_apps) ? record.never_apps : [];
  return {
    on: values(record.on),
    own: values(record.own),
    neverApps: apps.filter((app): app is string => typeof app === "string"),
  };
}
