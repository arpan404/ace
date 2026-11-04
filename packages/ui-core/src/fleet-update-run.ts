import { z } from "zod";
import type { FleetUpdatePlan } from "./fleet-update-plan.ts";
import {
  isUpdating,
  updateBlocker,
  updateProgressWords,
  type UpdateLine,
  type UpdateMachine,
} from "./machine-update-words.ts";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";

/*
 * A fleet update the person started: the machines it asks, what each was asked for, and how it
 * stands. It lives in the client (it must outlive the restart of the machine the window runs
 * on), so every machine's row and the summary are worked out again from what the machines
 * report. An offline machine joins later if the release it would get is still the latest for
 * it; after seven days a run asks nothing more.
 */

export const fleetUpdateRunDays = 7;
const runLifeMs = fleetUpdateRunDays * 24 * 60 * 60 * 1000;

const RunMachine = z.object({
  id: z.string().min(1),
  name: z.string(),
  primary: z.boolean(),
  /** The release it's asked to take (or will be, once it's back online). */
  version: z.string().min(1),
  /** When it accepted the request; null while it hasn't been asked. */
  sent: z.number().nullable(),
  /** Why asking it failed, in words; null when it hasn't. */
  failed: z.string().nullable(),
});
export type FleetRunMachine = z.infer<typeof RunMachine>;

export const FleetUpdateRun = z.object({
  id: z.string().min(1),
  mode: z.enum(["idle", "now"]),
  /** The release every machine was offered, when they all agreed. */
  version: z.string().nullable(),
  startedAt: z.number(),
  machines: z.array(RunMachine),
});
export type FleetUpdateRun = z.infer<typeof FleetUpdateRun>;

/** Start a run from the plan: its targets, and (when waiting for idle) its offline machines. */
export function newFleetRun(input: {
  id: string;
  plan: FleetUpdatePlan;
  mode: "idle" | "now";
  now: number;
}): FleetUpdateRun {
  const { plan } = input;
  const fallback = plan.version ?? plan.targets[0]?.version ?? null;
  const entry = (machine: { id: string; name: string; primary: boolean }, version: string) => ({
    id: machine.id,
    name: machine.name,
    primary: machine.primary,
    version,
    sent: null,
    failed: null,
  });
  const away =
    input.mode === "idle"
      ? plan.cannot.flatMap((machine) => {
          const version = machine.version ?? fallback;
          return machine.why === "offline" && version
            ? [entry({ ...machine, primary: false }, version)]
            : [];
        })
      : [];
  return {
    id: input.id,
    mode: input.mode,
    version: plan.version,
    startedAt: input.now,
    machines: [
      ...plan.targets
        .filter((target) => !target.primary)
        .map((target) => entry(target, target.version)),
      ...away,
      ...plan.targets
        .filter((target) => target.primary)
        .map((target) => entry(target, target.version)),
    ],
  };
}

const change = (run: FleetUpdateRun, id: string, patch: Partial<FleetRunMachine>) => ({
  ...run,
  machines: run.machines.map((machine) => (machine.id === id ? { ...machine, ...patch } : machine)),
});

/** The machine accepted the request at `at`. */
export const fleetRunSent = (run: FleetUpdateRun, id: string, at: number) =>
  change(run, id, { sent: at, failed: null });

/** Asking the machine failed, for `words`. */
export const fleetRunFailed = (run: FleetUpdateRun, id: string, words: string) =>
  change(run, id, { failed: words });

/** Ask the machine again (Try again, or Update to the newer release): `version` this time. */
export const fleetRunRetry = (run: FleetUpdateRun, id: string, version: string) =>
  change(run, id, { version, sent: null, failed: null });

export const fleetRunExpired = (run: FleetUpdateRun, now: number) =>
  now - run.startedAt > runLifeMs;

/** How one machine of a run stands. */
export type FleetRunState =
  | { kind: "updated" }
  | { kind: "failed"; words: string }
  /** No longer asked for: a newer release is out for it (`newer`), or the run is too old. */
  | { kind: "expired"; newer: string | null }
  /** To be asked now: just started, back online, or tried again. */
  | { kind: "send" }
  /** Asked; the machine's own state says how far it's got. */
  | { kind: "asked" }
  /** Offline: asked already (`sent`), or to be asked when it's back. */
  | { kind: "away"; sent: boolean };

export function fleetRunState(
  run: FleetUpdateRun,
  entry: FleetRunMachine,
  machine: UpdateMachine | undefined,
  now: number,
): FleetRunState {
  const update = machine?.update;
  if (update?.version === entry.version) return { kind: "updated" };
  if (entry.failed) return { kind: "failed", words: entry.failed };
  if (machine?.online && entry.sent !== null && update?.state === "failed")
    return {
      kind: "failed",
      words: (update.error ?? "the update didn't finish").replace(/\.$/, ""),
    };
  const newer =
    update?.available && update.available !== entry.version && update.ask?.version !== entry.version
      ? update.available
      : null;
  if (fleetRunExpired(run, now)) return { kind: "expired", newer };
  if (!machine?.online) return { kind: "away", sent: entry.sent !== null };
  if (newer) return { kind: "expired", newer };
  if (entry.sent !== null) return { kind: "asked" };
  if (!update) return { kind: "failed", words: "its ace is too old to update from here" };
  if (update.available !== entry.version) {
    // Its platform has no such release, or it updated some other way.
    return isUpdating(update) ? { kind: "asked" } : { kind: "expired", newer: null };
  }
  const blocker = updateBlocker(machine);
  if (blocker === "read-only") return { kind: "failed", words: "this window can only read it" };
  if (blocker === "checking") return { kind: "away", sent: false };
  if (blocker) return { kind: "failed", words: "it can't be updated from here" };
  return { kind: "send" };
}

const settled = (state: FleetRunState) =>
  state.kind === "updated" || state.kind === "failed" || state.kind === "expired";

const lookup = (machines: readonly UpdateMachine[]) => {
  const byId = new Map(machines.map((machine) => [machine.id, machine]));
  return (id: string) => byId.get(id);
};

/**
 * Who to ask now: every other machine due a request first, and this window's machine only once
 * none of the others still waits to be asked, so the window stays up while they're asked.
 */
export function fleetRunNextSends(
  run: FleetUpdateRun,
  machines: readonly UpdateMachine[],
  now: number,
): FleetRunMachine[] {
  const find = lookup(machines);
  const due = run.machines.filter(
    (entry) => fleetRunState(run, entry, find(entry.id), now).kind === "send",
  );
  const others = due.filter((entry) => !entry.primary);
  return others.length ? others : due;
}

export interface FleetRunSummary {
  /** "4 of 7 updated · 1 failed". */
  words: string;
  /** Nothing is left to happen: every machine updated, failed or dropped out. */
  done: boolean;
  updated: number;
  failed: number;
}

/** The run's summary line, counting down as machines report updated. */
export function fleetRunSummary(
  run: FleetUpdateRun,
  machines: readonly UpdateMachine[],
  now: number,
): FleetRunSummary {
  const find = lookup(machines);
  const states = run.machines.map((entry) => fleetRunState(run, entry, find(entry.id), now));
  const count = (kind: FleetRunState["kind"]) =>
    states.filter((state) => state.kind === kind).length;
  const updated = count("updated");
  const failed = count("failed");
  const waiting = states.filter((state) => state.kind === "away" && !state.sent).length;
  const total = run.machines.length;
  const done = states.every(settled);
  const head =
    updated === total
      ? total === 1
        ? `${run.machines[0]?.name ?? "The machine"} updated`
        : `All ${total} machines updated`
      : `${updated} of ${total} updated`;
  const tail = [
    failed ? `${failed} failed` : undefined,
    waiting && !done ? `${waiting} when back online` : undefined,
  ].filter(Boolean);
  return {
    words: [`${head}${updated === total && run.version ? ` to ${run.version}` : ""}`, ...tail].join(
      " · ",
    ),
    done,
    updated,
    failed,
  };
}

/** One machine's row words while it's in a run, with what the row can do. */
export function fleetRunLine(
  state: FleetRunState,
  entry: FleetRunMachine,
  machine: UpdateMachine | undefined,
): UpdateLine {
  switch (state.kind) {
    case "updated":
      return { words: `Updated to ${entry.version}`, tone: "on", action: null };
    case "failed":
      return {
        words: `Failed: ${state.words}`,
        tone: "warn",
        action: machine?.update?.available ? "retry" : null,
      };
    case "expired":
      return state.newer
        ? { words: `${state.newer} is out now`, tone: "off", action: "update" }
        : { words: `Not updated to ${entry.version}`, tone: "off", action: null };
    case "send":
      return { words: "Asking it to update", tone: "off", action: null };
    case "asked": {
      const update = machine?.update;
      return {
        words: (update && updateProgressWords(update)) ?? "Asked to update",
        tone: "off",
        action: null,
      };
    }
    case "away": {
      const last = machine?.update?.state;
      return state.sent
        ? {
            words:
              last === "installing" || last === "ready"
                ? "Restarting"
                : "Offline · asked to update",
            tone: "off",
            action: null,
          }
        : { words: `Updates to ${entry.version} when it's back online`, tone: "off", action: null };
    }
  }
}

const runKey = "ace.fleet.updateRun";

/** The run this window keeps, or null; one older than seven days is dropped. */
export function loadFleetRun(
  storage: KeyValueStorage | undefined,
  now: number,
): FleetUpdateRun | null {
  const run = readJson(storage, runKey, FleetUpdateRun.nullable(), null);
  if (run && fleetRunExpired(run, now)) {
    saveFleetRun(storage, null);
    return null;
  }
  return run;
}

export function saveFleetRun(
  storage: KeyValueStorage | undefined,
  run: FleetUpdateRun | null,
): void {
  if (run || !storage?.removeItem) writeJson(storage, runKey, run);
  else
    try {
      storage.removeItem(runKey);
    } catch {
      /* Private mode: the run stays until it expires. */
    }
}
