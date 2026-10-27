import type { ClientCore } from "@ace/client";
import { Admission } from "@ace/protocol";
import { admissionWords } from "@ace/ui-core/host-care";
import { z } from "zod";
import { host } from "./host.ts";
import { HostProblem } from "./host-problem.ts";
import type { PatchPump } from "./patch-pump.ts";

/*
 * Whether this machine takes new work ("Pause new work", the desktop tray's control), read on
 * every ready connection and kept current by the daemon's `admission.changed`. Swift shows the
 * one quiet line wherever the machine appears and the Pause/Resume row on its page.
 */

export const AdmissionChange = z.object({
  type: z.literal("machine.admission.set"),
  paused: z.boolean(),
});

export type AdmissionOwner = Pick<ClientCore, "request" | "connectionState" | "onMessage">;

export type AdmissionPatch = {
  type: "machine.admission";
  /** False when this machine's ace predates pausing from a phone. */
  known: boolean;
  paused: boolean;
  /** "New work paused · 2 threads are finishing", or null while it takes new work. */
  line: string | null;
  action: string;
};

export function admissionPatch(admission: Admission | undefined): AdmissionPatch {
  if (!admission)
    return { type: "machine.admission", known: false, paused: false, line: null, action: "" };
  return {
    type: "machine.admission",
    known: true,
    paused: admission.paused,
    ...admissionWords(admission),
  };
}

export class MachineAdmission {
  #owner: AdmissionOwner;
  #pump: PatchPump;
  #stop: () => void;
  constructor(owner: AdmissionOwner, pump: PatchPump) {
    this.#owner = owner;
    this.#pump = pump;
    const connection = owner.connectionState();
    const stopConnection = connection.subscribe(() => {
      if (connection.getSnapshot() === "ready") void this.#ask("status");
    });
    const stopEvents = owner.onMessage((message) => {
      if (message.type === "admission.changed") this.#show(message.admission);
    });
    this.#stop = () => {
      stopConnection();
      stopEvents();
    };
    if (connection.getSnapshot() === "ready") void this.#ask("status");
  }
  /** Pause or resume; the answer is the state shown. Throws the person's words on refusal. */
  async set(paused: boolean, signal: AbortSignal): Promise<AdmissionPatch> {
    const admission = await this.#ask(paused ? "pause" : "resume", signal);
    if (!admission)
      throw new HostProblem(
        "This phone can view this computer but can't pause it. Pair it with full access.",
      );
    return admissionPatch(admission);
  }
  dispose(): void {
    this.#stop();
  }
  async #ask(
    operation: "status" | "pause" | "resume",
    signal?: AbortSignal,
  ): Promise<Admission | undefined> {
    try {
      const reply = await this.#owner.request(
        { type: "admission.request", operation, requestId: host.uuid() },
        { timeoutMs: 15_000, ...(signal ? { signal } : {}) },
      );
      if (reply.ok && reply.admission) {
        this.#show(reply.admission);
        return reply.admission;
      }
      return undefined;
    } catch (error) {
      // An older daemon doesn't know the request: no row, rather than a wrong one.
      if (operation === "status") this.#show(undefined);
      else throw error;
      return undefined;
    }
  }
  #show(admission: Admission | undefined): void {
    this.#pump.put("machine:admission", () => admissionPatch(admission));
  }
}
