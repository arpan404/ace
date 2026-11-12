import type { ClientCore } from "@ace/client";
import { MachineUpdate, MachineUpdateResult } from "@ace/protocol";
import {
  FleetUpdateRun,
  fleetMachineLine,
  fleetRunExpired,
  fleetRunFailed,
  fleetRunNextSends,
  fleetRunSent,
  fleetUpdateHeadline,
  fleetUpdateNowConfirm,
  fleetUpdatePlan,
  newFleetRun,
  updateRefusal,
  type UpdateMachine,
} from "@ace/ui-core";
import { z } from "zod";
import { host } from "./host.ts";

/*
 * Updating several machines from the phone, as Settings › Fleet does on the web (ADR 0113).
 * Each machine's runtime reads and starts its own update (`machineUpdate.status`,
 * `machineUpdate.start`); one runtime decides for all of them in shared code (`fleet.updates`:
 * the headline, each machine's line and who to ask now; `fleet.run`: the run as machines
 * answer). Swift keeps the run between visits and only routes. The phone runs on no machine,
 * so none is restarted last.
 */

const quiet = 15_000;

export const MachineUpdateStatusRequest = z.object({ type: z.literal("machineUpdate.status") });
export const MachineUpdateStartRequest = z.object({
  type: z.literal("machineUpdate.start"),
  name: z.string().min(1).max(128),
  mode: z.enum(["idle", "now"]),
  version: z.string().min(1).max(80),
  /** Working agents the person confirmed, for Update now. */
  agents: z.number().int().nonnegative(),
});
export type MachineUpdateStartRequest = z.infer<typeof MachineUpdateStartRequest>;

async function ask(
  owner: ClientCore,
  request:
    | { operation: "status" }
    | { operation: "start"; mode: "idle" | "now"; version: string; agents: number },
  signal: AbortSignal,
): Promise<MachineUpdateResult> {
  const reply = await owner.request(
    { type: "machineUpdate.request", ...request },
    { signal, timeoutMs: quiet },
  );
  return MachineUpdateResult.parse(reply);
}

/** This machine's update status; null when its ace predates remote updates. */
export async function readMachineUpdate(
  owner: ClientCore,
  signal: AbortSignal,
): Promise<{ type: "machineUpdate.status"; update: MachineUpdate | null }> {
  try {
    const result = await ask(owner, { operation: "status" }, signal);
    return { type: "machineUpdate.status", update: result.update ?? null };
  } catch (error) {
    if (signal.aborted) throw error;
    // An older daemon refuses the request type: it has no remote updates to report.
    return { type: "machineUpdate.status", update: null };
  }
}

/** Ask this machine to update; a refusal comes back in the person's words. */
export async function startMachineUpdate(
  owner: ClientCore,
  request: MachineUpdateStartRequest,
  signal: AbortSignal,
): Promise<{
  type: "machineUpdate.started";
  ok: boolean;
  words: string | null;
  update: MachineUpdate | null;
}> {
  const result = await ask(
    owner,
    { operation: "start", mode: request.mode, version: request.version, agents: request.agents },
    signal,
  );
  return {
    type: "machineUpdate.started",
    ok: result.ok,
    words: result.ok ? null : updateRefusal(result.error, request.name, result.update),
    update: result.update ?? null,
  };
}

const Machine = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  online: z.boolean(),
  access: z.enum(["admin", "read", "unknown"]),
  /** Its last reported status; null when its ace predates remote updates; absent until it answers. */
  update: MachineUpdate.nullable().optional(),
});
const Machines = z.array(Machine).max(32);
const facts = (machines: z.infer<typeof Machines>): UpdateMachine[] =>
  machines.map((machine) => ({ ...machine, primary: false, update: machine.update }));
/** A kept run that no longer reads (another build's, or damaged) is dropped, never fatal. */
const runOf = (value: unknown) => {
  const parsed = FleetUpdateRun.safeParse(value);
  return parsed.success ? parsed.data : null;
};
/**
 * A kept run that still reads and is under its seven days; an older one comes back null so
 * Swift clears its copy and stops watching (as `loadFleetRun` does on the web).
 */
const liveRunOf = (value: unknown, now: number) => {
  const run = runOf(value);
  return run && !fleetRunExpired(run, now) ? run : null;
};

export const FleetUpdatesRequest = z.object({
  type: z.literal("fleet.updates"),
  machines: Machines,
  run: z.unknown().optional(),
  now: z.number().nonnegative(),
});

export interface FleetUpdatesReply {
  type: "fleet.updates";
  headline: { title: string; note: string | null; actions: readonly ("all" | "all-now")[] } | null;
  lines: { id: string; words: string; tone: string; action: string | null }[];
  /** Who the run asks now, and for which release. */
  sends: { id: string; version: string; mode: "idle" | "now"; agents: number }[];
  /** Asked before Update all now. */
  confirm: { title: string; body: string; confirm: string };
  run: FleetUpdateRun | null;
}

/** The fleet's update headline, each machine's line, and who the run asks now. */
export function fleetUpdates(request: z.infer<typeof FleetUpdatesRequest>): FleetUpdatesReply {
  const machines = facts(request.machines);
  const run = liveRunOf(request.run, request.now);
  const plan = fleetUpdatePlan(machines);
  const sends = run
    ? fleetRunNextSends(run, machines, request.now).map((entry) => ({
        id: entry.id,
        version: entry.version,
        mode: run.mode === "now" ? ("now" as const) : ("idle" as const),
        agents: machines.find((machine) => machine.id === entry.id)?.update?.busy ?? 0,
      }))
    : [];
  return {
    type: "fleet.updates",
    headline: fleetUpdateHeadline(machines, run, request.now, plan),
    lines: machines.flatMap((machine) => {
      const line = fleetMachineLine(machine, run, request.now);
      return line
        ? [{ id: machine.id, words: line.words, tone: line.tone, action: line.action }]
        : [];
    }),
    sends,
    confirm: fleetUpdateNowConfirm(plan.targets),
    run,
  };
}

export const FleetRunRequest = z.discriminatedUnion("op", [
  z.object({
    type: z.literal("fleet.run"),
    op: z.literal("start"),
    mode: z.enum(["idle", "now"]),
    machines: Machines,
    now: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("fleet.run"),
    op: z.literal("sent"),
    run: z.unknown(),
    id: z.string().min(1).max(256),
    now: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal("fleet.run"),
    op: z.literal("failed"),
    run: z.unknown(),
    id: z.string().min(1).max(256),
    words: z.string().min(1).max(400),
  }),
]);

/** The run after Update all, or after a machine answered; null when the kept run is gone. */
export function fleetRun(request: z.infer<typeof FleetRunRequest>): {
  type: "fleet.run";
  run: FleetUpdateRun | null;
} {
  if (request.op === "start") {
    const plan = fleetUpdatePlan(facts(request.machines));
    return {
      type: "fleet.run",
      run: newFleetRun({ id: host.uuid(), plan, mode: request.mode, now: request.now }),
    };
  }
  const run = request.op === "sent" ? liveRunOf(request.run, request.now) : runOf(request.run);
  if (!run) return { type: "fleet.run", run: null };
  return {
    type: "fleet.run",
    run:
      request.op === "sent"
        ? fleetRunSent(run, request.id, request.now)
        : fleetRunFailed(run, request.id, request.words),
  };
}
