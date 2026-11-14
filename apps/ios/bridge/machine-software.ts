import type { ClientCore } from "@ace/client";
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
import { readMachineUpdate, startMachineUpdate } from "./fleet-updates.ts";

/*
 * A machine page's Software on the phone, as web's: the ace version it runs, the release on
 * offer and the update's progress, with Update when idle, Update now (asked first, naming the
 * agents it stops), Cancel and Check. Words and the actions allowed are `@ace/ui-core`'s; this
 * runtime reads and acts on its own machine (`machineUpdate.request`).
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
  /** Why the last action didn't start, in the person's words. */
  problem: string | null;
}

function screen(
  update: MachineUpdate | null,
  request: MachineSoftwareRequest,
  problem: string | null,
): MachineSoftwareScreen {
  const view = machineSoftware({
    id: "",
    name: request.name,
    primary: false,
    online: true,
    access: request.access,
    update,
  });
  return {
    line: view.line,
    progress: view.progress,
    progressTone: view.progressTone,
    actions: view.actions.map((action) => ({ action, label: softwareActionWords[action] })),
    link: view.link,
    note: view.note,
    confirm: update?.available
      ? {
          ...updateNowConfirm({ name: request.name, version: update.available, busy: update.busy }),
          agents: update.busy,
        }
      : null,
    updating: !!update && isUpdating(update),
    problem,
  };
}

/** Reads the machine's update, or acts on it and answers the page after. */
export async function answerMachineSoftware(
  owner: ClientCore,
  request: MachineSoftwareRequest,
  signal: AbortSignal,
): Promise<MachineSoftwareScreen> {
  const before = (await readMachineUpdate(owner, signal)).update;
  if (request.type === "machine.software") return screen(before, request, null);
  const { action } = request;
  if (action === "cancel" || action === "check") {
    const reply = MachineUpdateResult.parse(
      await owner.request(
        { type: "machineUpdate.request", operation: action },
        { signal, timeoutMs: 15_000 },
      ),
    );
    const after = reply.update ?? (await readMachineUpdate(owner, signal)).update;
    const refused = reply.ok ? null : updateRefusal(reply.error, request.name, reply.update);
    return screen(after, request, refused);
  }
  const version = before?.available;
  if (!version)
    return screen(before, request, `${request.name} has no update to install right now.`);
  const started = await startMachineUpdate(
    owner,
    {
      type: "machineUpdate.start",
      name: request.name,
      mode: action === "now" ? "now" : "idle",
      version,
      agents: action === "now" ? (request.agents ?? 0) : 0,
    },
    signal,
  );
  return screen(started.update ?? before, request, started.words);
}
