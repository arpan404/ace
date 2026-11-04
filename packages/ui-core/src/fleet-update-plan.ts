import { joinNames } from "./join-names.ts";
import {
  isUpdating,
  updateBlocker,
  type UpdateBlocker,
  type UpdateMachine,
} from "./machine-update-words.ts";

/*
 * Updating the whole fleet at once: which machines Update all asks (the one this window runs on
 * last, so the window stays up to watch the others), the one line that offers it, and the one
 * sentence naming every machine it can't reach and why.
 */

export interface UpdateTarget {
  id: string;
  name: string;
  primary: boolean;
  /** The release on offer for its platform. */
  version: string;
  /** Agents at work there: what Update now stops, and what it confirms. */
  busy: number;
}

export interface FleetUpdatePlan {
  /** The machines Update all asks, in order: every other machine, then this window's. */
  targets: readonly UpdateTarget[];
  /** Machines Update all can't ask, and why. Offline ones are listed whatever they last said. */
  cannot: readonly { id: string; name: string; why: UpdateBlocker; version: string | null }[];
  /** The release every target gets, when they all agree. */
  version: string | null;
}

/** Who Update all asks, and who it can't, from what every machine last reported. */
export function fleetUpdatePlan(machines: readonly UpdateMachine[]): FleetUpdatePlan {
  const targets: UpdateTarget[] = [];
  const cannot: FleetUpdatePlan["cannot"][number][] = [];
  for (const machine of machines) {
    const update = machine.update;
    const blocker = updateBlocker(machine);
    const version = update?.available ?? null;
    if (blocker === "offline") {
      cannot.push({ id: machine.id, name: machine.name, why: blocker, version });
      continue;
    }
    if (blocker === "checking") continue;
    if (update && isUpdating(update)) continue;
    if (blocker === "unsupported" || blocker === "read-only") {
      // Nothing known to offer, but the person would expect it to update: say why it won't.
      if (blocker === "unsupported" || version)
        cannot.push({ id: machine.id, name: machine.name, why: blocker, version });
      continue;
    }
    if (!version) continue;
    if (blocker) cannot.push({ id: machine.id, name: machine.name, why: blocker, version });
    else
      targets.push({
        id: machine.id,
        name: machine.name,
        primary: machine.primary,
        version,
        busy: update?.busy ?? 0,
      });
  }
  targets.sort((a, b) => Number(a.primary) - Number(b.primary));
  const versions = new Set(targets.map((target) => target.version));
  return {
    targets,
    cannot,
    version: versions.size === 1 ? (targets[0]?.version ?? null) : null,
  };
}

/**
 * The plan narrowed to the machines a person picked: Update all's order and rules, for only
 * those. Offline picks stay among `cannot`, so a run that waits for idle still asks them when
 * they're back; anything not picked is left out entirely.
 */
export function pickedUpdatePlan(
  plan: FleetUpdatePlan,
  picked: ReadonlySet<string>,
): FleetUpdatePlan {
  const targets = plan.targets.filter((target) => picked.has(target.id));
  const versions = new Set(targets.map((target) => target.version));
  return {
    targets,
    cannot: plan.cannot.filter((machine) => picked.has(machine.id)),
    version: versions.size === 1 ? (targets[0]?.version ?? null) : null,
  };
}

/**
 * The machines a person can pick to update: every target, then offline machines with a known
 * release (they update once back, when waiting for idle). What's ticked to start with: all.
 */
export function updateChoices(plan: FleetUpdatePlan): {
  id: string;
  name: string;
  version: string;
  busy: number;
  primary: boolean;
  offline: boolean;
}[] {
  return [
    ...plan.targets.map((target) => ({ ...target, offline: false })),
    ...plan.cannot.flatMap((machine) =>
      machine.why === "offline" && machine.version
        ? [{ ...machine, version: machine.version, busy: 0, primary: false, offline: true }]
        : [],
    ),
  ];
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** "7 machines can update to 0.0.19", or without a version when platforms got different ones. */
export function fleetUpdateOffer(plan: FleetUpdatePlan): string | null {
  const count = plan.targets.length;
  if (count === 0) return null;
  const who = count === 1 ? (plan.targets[0]?.name ?? "1 machine") : plural(count, "machine");
  return plan.version ? `${who} can update to ${plan.version}` : `${who} can update`;
}

/** The clause after a group of names, singular and plural. */
const clauses: Record<UpdateBlocker, (many: boolean) => string> = {
  offline: (many) => (many ? "are offline" : "is offline"),
  "read-only": () => "",
  "release-page": (many) =>
    many ? "update from their release page" : "updates from its release page",
  "app-closed": (many) => (many ? "need the ace app open" : "needs the ace app open"),
  source: (many) => (many ? "run from source" : "runs from source"),
  unknown: (many) => (many ? "haven't checked for updates yet" : "hasn't checked for updates yet"),
  unsupported: (many) =>
    many ? "run an ace too old to update from here" : "runs an ace too old to update from here",
  checking: () => "",
};

const order: readonly UpdateBlocker[] = [
  "offline",
  "release-page",
  "app-closed",
  "source",
  "unsupported",
  "unknown",
  "read-only",
];

/**
 * Every machine Update all can't ask, in one sentence: "Old laptop is offline, Deb box updates
 * from its release page and this window can only read Kitchen Mac." Null when there are none.
 */
export function cannotUpdateSentence(cannot: FleetUpdatePlan["cannot"]): string | null {
  const parts = order.flatMap((why) => {
    const names = cannot.filter((entry) => entry.why === why).map((entry) => entry.name);
    if (!names.length) return [];
    if (why === "read-only") return [`this window can only read ${joinNames(names)}`];
    return [`${joinNames(names)} ${clauses[why](names.length > 1)}`];
  });
  if (!parts.length) return null;
  const sentence = joinNames(parts);
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
