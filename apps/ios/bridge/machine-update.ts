import type { ClientCore } from "@ace/client";
import type { MachineUpdate, MachineUpdateRequest } from "@ace/protocol";
import { z } from "zod";
import { host } from "./host.ts";
import { HostProblem } from "./host-problem.ts";
import type { PatchPump } from "./patch-pump.ts";

/*
 * This machine's own update (`machineUpdate.request`): read on every ready connection and kept
 * current by `machineUpdate.changed`, so the phone shows the running version, a check, the
 * download's progress, the restart and the new version. Check and start need administrator
 * access on the machine; the daemon's refusals come back as the person's words. An older daemon
 * doesn't know the request, so the patch says `known: false`.
 */

export const MachineUpdateChange = z.union([
  z.object({ type: z.literal("machine.update.check") }),
  z.object({
    type: z.literal("machine.update.start"),
    version: z.string().min(1),
    mode: z.enum(["idle", "now"]),
    agents: z.number().int().nonnegative().optional(),
  }),
]);
export type MachineUpdateChange = z.infer<typeof MachineUpdateChange>;

export type MachineUpdateOwner = Pick<ClientCore, "request" | "connectionState" | "onMessage">;

/** What the row is doing, so Swift draws it without knowing the daemon's states. */
export type UpdatePhase =
  | "current"
  | "checking"
  | "available"
  | "waiting"
  | "downloading"
  | "restarting"
  | "failed";

export type MachineUpdatePatch = {
  type: "machine.update";
  /** False when this machine's ace can't be updated from here (it predates the request). */
  known: boolean;
  version: string;
  available: string | null;
  line: string | null;
  phase: UpdatePhase;
  percent: number | null;
  error: string | null;
  /** `app-closed`, `release-page`, `source` or `unknown` when the update can't start here. */
  blocked: string | null;
  /** Threads at work or waiting on a person: an update now stops them. */
  busy: number;
};

const phases: Record<string, UpdatePhase> = {
  checking: "checking",
  available: "available",
  waiting: "waiting",
  downloading: "downloading",
  ready: "restarting",
  installing: "restarting",
  failed: "failed",
};

export function updatePatch(update: MachineUpdate | undefined): MachineUpdatePatch {
  if (!update)
    return {
      type: "machine.update",
      known: false,
      version: "",
      available: null,
      line: null,
      phase: "current",
      percent: null,
      error: null,
      blocked: null,
      busy: 0,
    };
  return {
    type: "machine.update",
    known: true,
    version: update.version,
    available: update.available,
    line: update.line ?? null,
    phase: phases[update.state] ?? "current",
    percent: update.percent,
    error: update.error,
    blocked: update.blocked,
    busy: update.busy,
  };
}

const refusals: Record<string, string> = {
  forbidden: "This phone can view this computer but can't update it. Pair it with full access.",
  blocked: "This computer can't update itself from here right now.",
  stale: "A different version is on offer now. Check again.",
  confirm: "More agents are working now than you confirmed. Review them and try again.",
  unavailable: "This computer's ace can't be updated from a phone.",
  invalid: "The update request was incomplete.",
};

export class MachineUpdateFollower {
  #owner: MachineUpdateOwner;
  #pump: PatchPump;
  #stop: () => void;
  constructor(owner: MachineUpdateOwner, pump: PatchPump) {
    this.#owner = owner;
    this.#pump = pump;
    const connection = owner.connectionState();
    const stopConnection = connection.subscribe(() => {
      if (connection.getSnapshot() === "ready") void this.#read();
    });
    const stopEvents = owner.onMessage((message) => {
      if (message.type === "machineUpdate.changed") this.#show(message.update);
    });
    this.#stop = () => {
      stopConnection();
      stopEvents();
    };
    if (connection.getSnapshot() === "ready") void this.#read();
  }
  dispose(): void {
    this.#stop();
  }
  /** Check the release feed, or start the update; the patch that follows is the state shown. */
  async answer(change: MachineUpdateChange, signal: AbortSignal): Promise<MachineUpdatePatch> {
    const request: MachineUpdateRequest =
      change.type === "machine.update.check"
        ? { type: "machineUpdate.request", requestId: host.uuid(), operation: "check" }
        : {
            type: "machineUpdate.request",
            requestId: host.uuid(),
            operation: "start",
            version: change.version,
            mode: change.mode,
            ...(change.agents === undefined ? {} : { agents: change.agents }),
          };
    const reply = await this.#owner.request(request, { timeoutMs: 30_000, signal });
    if (reply.update) this.#show(reply.update);
    if (!reply.ok) throw new HostProblem(refusals[reply.error ?? ""] ?? "The update didn't start.");
    return updatePatch(reply.update);
  }
  async #read(): Promise<void> {
    try {
      const reply = await this.#owner.request(
        { type: "machineUpdate.request", requestId: host.uuid(), operation: "status" },
        { timeoutMs: 15_000 },
      );
      this.#show(reply.ok ? reply.update : undefined);
    } catch {
      this.#show(undefined);
    }
  }
  #show(update: MachineUpdate | undefined): void {
    this.#pump.put("machine:update", () => updatePatch(update));
  }
}
