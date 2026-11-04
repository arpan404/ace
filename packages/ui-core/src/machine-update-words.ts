import type { MachineUpdate } from "@ace/protocol";
import { joinNames } from "./join-names.ts";

/*
 * What a machine's update says, wherever it shows (Settings › Fleet, a machine's page, the
 * phone): the words for each state, why it can't be updated from here, and what may be done.
 * Pure: callers pass what the machine reported and what this window may do there. States and
 * reasons a newer daemon adds still read sensibly.
 */

/** A machine as the update rules see it. */
export interface UpdateMachine {
  id: string;
  name: string;
  /** The machine this window runs on: it restarts last, so the window can watch the others. */
  primary: boolean;
  online: boolean;
  /** `admin`: this window may update it. `read`: it only reads it. `unknown`: not known yet. */
  access: "admin" | "read" | "unknown";
  /**
   * Its last reported status, kept while it's offline (so it may be old). Null when its ace
   * predates remote updates; undefined while it hasn't answered yet.
   */
  update: MachineUpdate | null | undefined;
}

/** Why a machine can't be updated from this window. */
export type UpdateBlocker =
  | "offline"
  | "read-only"
  | "release-page"
  | "app-closed"
  | "source"
  | "unknown"
  | "unsupported"
  | "checking";

export type UpdateTone = "on" | "warn" | "off";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const inProgress = new Set(["waiting", "downloading", "ready", "installing"]);

/** Asked to update and not finished: waiting, downloading or restarting. */
export function isUpdating(update: MachineUpdate): boolean {
  return update.ask !== null || inProgress.has(update.state);
}

/** The machine's own reason a client can't start its update, as one of ours. */
function blockOf(blocked: string): UpdateBlocker {
  return blocked === "release-page" || blocked === "app-closed" || blocked === "source"
    ? blocked
    : "unknown";
}

/** Why `machine` can't be updated from here, or null when it can (offer or not). */
export function updateBlocker(machine: UpdateMachine): UpdateBlocker | null {
  if (!machine.online) return "offline";
  if (machine.access === "read") return "read-only";
  if (machine.update === null) return "unsupported";
  if (!machine.update) return "checking";
  if (machine.update.blocked) return blockOf(machine.update.blocked);
  if (machine.access === "unknown") return "checking";
  return null;
}

/** An update in progress, failed or just finished, in a few words; null when none is. */
export function updateProgressWords(update: MachineUpdate): string | null {
  switch (update.state) {
    case "waiting":
      return update.busy > 0
        ? `Waiting for ${plural(update.busy, "agent")} to finish`
        : "Waiting for agents to finish";
    case "downloading":
      return update.percent === null
        ? "Downloading"
        : `Downloading · ${Math.round(update.percent)}%`;
    case "ready":
      return "Downloaded · restarting soon";
    case "installing":
      return "Restarting";
    case "updated":
      return `Updated to ${update.version}`;
    case "failed":
      return `Failed: ${failureWords(update)}`;
    case "none":
    case "available":
      return update.ask ? "Asked to update" : null;
    default:
      // A newer daemon's own state: say it's on its way rather than nothing.
      return update.ask ? "Updating" : null;
  }
}

function failureWords(update: MachineUpdate): string {
  const reason = update.error ?? update.last?.error ?? "the update didn't finish";
  return reason.replace(/\.$/, "");
}

/** What a machine row can do about its update. */
export type UpdateRowAction = "update" | "retry";

export interface UpdateLine {
  words: string;
  tone: UpdateTone;
  action: UpdateRowAction | null;
}

/**
 * The update line under a machine's row outside a fleet update: in progress, failed, or
 * "Update available · 0.0.19" with Update when this window may start it. Null when there's
 * nothing to say (up to date, or never reported).
 */
export function machineUpdateLine(machine: UpdateMachine): UpdateLine | null {
  const update = machine.update;
  if (!update) return null;
  const may = updateBlocker(machine) === null;
  if (update.state === "failed")
    return {
      words: `Failed: ${failureWords(update)}`,
      tone: "warn",
      action: may && update.available ? "retry" : null,
    };
  const progress = isUpdating(update) ? updateProgressWords(update) : null;
  if (progress) return { words: progress, tone: "off", action: null };
  if (!update.available) return null;
  const blocker = updateBlocker(machine);
  const how =
    blocker === "release-page"
      ? " · from its release page"
      : blocker === "app-closed"
        ? " · open the ace app there to update"
        : "";
  return {
    words: `Update available · ${update.available}${machine.online ? how : ""}`,
    tone: "off",
    action: may ? "update" : null,
  };
}

/** What a machine's page offers for its update. */
export type SoftwareAction = "idle" | "now" | "cancel" | "retry" | "check";

export interface SoftwareView {
  /** "ace 0.0.18. 0.0.19 is available." */
  line: string;
  /** Progress, the failure, or the last update's outcome; null when there's none. */
  progress: string | null;
  progressTone: UpdateTone;
  actions: readonly SoftwareAction[];
  /** "Update from the release page", for an install that doesn't replace itself. */
  link: { words: string; url: string } | null;
  /** Why there are no actions, when that needs saying. */
  note: string | null;
}

const blockerNotes: Record<UpdateBlocker, string | null> = {
  offline: "It updates from here once it's back online.",
  "read-only":
    "This window can only read this machine. Pair it again as Administrator to update it.",
  "release-page": null,
  "app-closed": "Open the ace app on it to update.",
  source: "It runs from a source checkout. Update it with git there.",
  unknown: "It hasn't been able to check for updates yet.",
  unsupported: "Update it on the machine once; after that it updates from here.",
  checking: null,
};

/** The Software section of a machine's page: what it runs, what's on offer and what to do. */
export function machineSoftware(machine: UpdateMachine): SoftwareView {
  const update = machine.update;
  const blocker = updateBlocker(machine);
  if (!update)
    return {
      line:
        update === null
          ? "Its ace is too old to report its version."
          : machine.online
            ? "Reading its version…"
            : "Its version shows when it's back online.",
      progress: null,
      progressTone: "off",
      actions: [],
      link: null,
      note: update === null ? blockerNotes.unsupported : null,
    };
  const offer = update.available ? ` ${update.available} is available.` : "";
  const line = `ace ${update.version}.${offer || (update.checkedAt === null ? "" : " Up to date.")}`;
  const updating = isUpdating(update);
  const failed = update.state === "failed";
  const progress =
    failed || updating || update.state === "updated"
      ? updateProgressWords(update)
      : update.last && !update.available
        ? update.last.ok
          ? `Updated from ${update.last.from}`
          : `The update to ${update.last.to} failed: ${update.last.error ?? "it didn't finish"}`
        : null;
  const may = blocker === null;
  const actions: SoftwareAction[] = !may
    ? []
    : updating
      ? update.state === "installing"
        ? []
        : update.ask?.mode === "now"
          ? ["cancel"]
          : ["now", "cancel"]
      : failed && update.available
        ? ["retry", "now"]
        : update.available
          ? ["idle", "now"]
          : ["check"];
  const link =
    blocker === "release-page" && update.releaseUrl && update.available
      ? { words: "Update from the release page", url: update.releaseUrl }
      : null;
  const note =
    blocker && (update.available || blocker === "offline" || blocker === "read-only")
      ? blockerNotes[blocker]
      : null;
  return {
    line,
    progress,
    progressTone: failed ? "warn" : update.state === "updated" ? "on" : "off",
    actions,
    link,
    note,
  };
}

/** Text for each page action. */
export const softwareActionWords: Record<SoftwareAction, string> = {
  idle: "Update when idle",
  now: "Update now",
  cancel: "Cancel update",
  retry: "Try again",
  check: "Check for updates",
};

export interface UpdateConfirm {
  title: string;
  body: string;
  confirm: string;
}

/** Asked before updating one machine now: how many agents stop, and that they continue. */
export function updateNowConfirm(input: {
  name: string;
  version: string;
  busy: number;
}): UpdateConfirm {
  return {
    title: `Update ${input.name} now?`,
    body:
      input.busy > 0
        ? `${plural(input.busy, "agent is", "agents are")} working there. They stop while ace restarts to ${input.version} and continue after it.`
        : `Nothing is working there. ace restarts to ${input.version}.`,
    confirm: "Update now",
  };
}

/** Asked before updating every machine now: which machines have agents working, and how many. */
export function fleetUpdateNowConfirm(
  targets: readonly { name: string; busy: number }[],
): UpdateConfirm {
  const working = targets.filter((target) => target.busy > 0);
  const total = working.reduce((sum, target) => sum + target.busy, 0);
  const where = joinNames(working.map((target) => `${target.busy} on ${target.name}`));
  return {
    title: `Update ${plural(targets.length, "machine")} now?`,
    body:
      total === 0
        ? "No agents are working on them. Each one restarts to update."
        : `${plural(total, "agent is", "agents are")} working: ${where}. They stop while their machine restarts and continue after it.`,
    confirm: "Update all now",
  };
}

/** A machine's refusal to start, in words for the person (`machineUpdate.result` errors). */
export function updateRefusal(
  code: string | undefined,
  name: string,
  update?: MachineUpdate,
): string {
  switch (code) {
    case "forbidden":
      return `This window can only read ${name}. Pair it again as Administrator to update it.`;
    case "blocked":
      return update?.blocked === "app-closed"
        ? `Open the ace app on ${name} to update it.`
        : update?.blocked === "release-page"
          ? `${name} updates from its release page.`
          : `${name} can't be updated from here.`;
    case "stale":
      return `A newer release is out for ${name}. Try again.`;
    case "confirm":
      return `${plural(update?.busy ?? 0, "agent is", "agents are")} working on ${name} now. Try again to confirm.`;
    case "unavailable":
      return `${name}'s ace can't update itself.`;
    default:
      return `${name} didn't start the update.`;
  }
}
