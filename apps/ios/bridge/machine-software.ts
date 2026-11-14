import { ClientError, type ClientCore } from "@ace/client";
import { MachineUpdateResult, type MachineUpdate } from "@ace/protocol";
import {
  isUpdating,
  machineSoftware,
  softwareActionWords,
  updateNowConfirm,
  updateRefusal,
  type SoftwareAction,
  type UpdateConfirm,
} from "@ace/ui-core";
import { z } from "zod";
import { startMachineUpdate } from "./fleet-updates.ts";

/*
 * A machine page's Software on the phone, as web's: the ace version it runs, the release on
 * offer and the update's progress, with Update when idle, Update now (asked first, naming the
 * agents it stops), Cancel and Check. Words and the actions allowed are `@ace/ui-core`'s; this
 * runtime reads and acts on its own machine (`machineUpdate.request`). An update restarts the
 * machine's ace, so reads time out or find it offline part way: the last status it gave is kept
 * then, still updating, and only a daemon that refuses the request outright is too old.
 */

const Access = z.enum(["admin", "read", "unknown"]);
const name = z.string().min(1).max(128);
export const MachineSoftwareRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("machine.software"), name, access: Access }),
  z.object({
    type: z.literal("machine.software.act"),
    name,
    access: Access,
    action: z.enum(["idle", "now", "cancel", "retry", "check"]),
    /** Update now: the working agents the person agreed to stop. */
    agents: z.number().int().nonnegative().optional(),
  }),
]);
export type MachineSoftwareRequest = z.infer<typeof MachineSoftwareRequest>;

export interface MachineSoftwareScreen {
  line: string;
  progress: string | null;
  progressTone: "on" | "warn" | "off";
  actions: { action: SoftwareAction; label: string }[];
  link: { words: string; url: string } | null;
  note: string | null;
  /** Asked before Update now; null when there's no release to update to. */
  confirm: (UpdateConfirm & { agents: number }) | null;
  /** An update is under way: the page reads again until it ends. */
  updating: boolean;
  /** False when the machine didn't answer and this is the last status it gave. */
  reachable: boolean;
  /** Why the last action didn't start, in the person's words. */
  problem: string | null;
}

type Owner = Pick<ClientCore, "request">;
type Status = { reached: true; update: MachineUpdate | null } | { reached: false };

/** The machine's update status, or that it didn't answer (as opposed to refusing to say). */
async function readStatus(owner: Owner, signal: AbortSignal): Promise<Status> {
  try {
    const reply = MachineUpdateResult.parse(
      await owner.request(
        { type: "machineUpdate.request", operation: "status" },
        { signal, timeoutMs: 15_000 },
      ),
    );
    return { reached: true, update: reply.update ?? null };
  } catch (error) {
    if (signal.aborted) throw error;
    // An older daemon refuses the request type itself: it has no remote updates. A timeout or a
    // dropped connection (ace restarting to update) says nothing about it.
    if (error instanceof ClientError && error.code === "daemon")
      return { reached: true, update: null };
    return { reached: false };
  }
}

function screen(
  update: MachineUpdate | null | undefined,
  request: MachineSoftwareRequest,
  problem: string | null,
  reachable = true,
): MachineSoftwareScreen {
  const view = machineSoftware({
    id: "",
    name: request.name,
    primary: false,
    online: true,
    access: request.access,
    update,
  });
  const updating = !!update && isUpdating(update);
  return {
    line: view.line,
    progress: view.progress,
    progressTone: view.progressTone,
    actions: reachable
      ? view.actions.map((action) => ({ action, label: softwareActionWords[action] }))
      : [],
    link: view.link,
    note:
      !reachable && updating
        ? `Waiting for ${request.name} to answer. ace restarts there to finish updating.`
        : view.note,
    confirm: update?.available
      ? {
          ...updateNowConfirm({ name: request.name, version: update.available, busy: update.busy }),
          agents: update.busy,
        }
      : null,
    updating,
    reachable,
    problem,
  };
}

/**
 * One runtime's Software page: reads and actions on its machine, keeping the last status the
 * machine gave so a read it doesn't answer shows that, still updating, instead of losing it.
 */
export class MachineSoftware {
  #last: MachineUpdate | null | undefined;
  readonly #owner: Owner;
  constructor(owner: Owner) {
    this.#owner = owner;
  }

  async #status(signal: AbortSignal): Promise<Status> {
    const status = await readStatus(this.#owner, signal);
    if (status.reached) this.#last = status.update;
    return status;
  }

  /** Reads the machine's update, or acts on it and answers the page after. */
  async answer(
    request: MachineSoftwareRequest,
    signal: AbortSignal,
  ): Promise<MachineSoftwareScreen> {
    const status = await this.#status(signal);
    if (!status.reached)
      return screen(
        this.#last,
        request,
        request.type === "machine.software" ? null : `Couldn't reach ${request.name}. Try again.`,
        false,
      );
    const before = status.update;
    if (request.type === "machine.software") return screen(before, request, null);
    const { action } = request;
    if (action === "cancel" || action === "check") {
      const reply = MachineUpdateResult.parse(
        await this.#owner.request(
          { type: "machineUpdate.request", operation: action },
          { signal, timeoutMs: 15_000 },
        ),
      );
      if (reply.update) this.#last = reply.update;
      else await this.#status(signal);
      const after = reply.update ?? this.#last;
      const refused = reply.ok ? null : updateRefusal(reply.error, request.name, reply.update);
      return screen(after, request, refused);
    }
    const version = before?.available;
    if (!version)
      return screen(before, request, `${request.name} has no update to install right now.`);
    const started = await startMachineUpdate(
      this.#owner,
      {
        type: "machineUpdate.start",
        name: request.name,
        mode: action === "now" ? "now" : "idle",
        version,
        agents: action === "now" ? (request.agents ?? 0) : 0,
      },
      signal,
    );
    if (started.update) this.#last = started.update;
    return screen(started.update ?? before, request, started.words);
  }
}
