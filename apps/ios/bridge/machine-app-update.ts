import type { ClientCore } from "@ace/client";
import type { AppUpdate } from "@ace/protocol";
import { appUpdateWords } from "@ace/ui-core/host-care";
import { host } from "./host.ts";
import type { PatchPump } from "./patch-pump.ts";

/*
 * The desktop app's update on this machine, read-only: read on every ready connection and kept
 * current by the daemon's `appUpdate.changed`. Swift shows the version and one quiet line on the
 * machine's page; installing and restarting stay on the computer.
 */

export type AppUpdateOwner = Pick<ClientCore, "request" | "connectionState" | "onMessage">;

export type AppUpdatePatch = {
  type: "machine.appUpdate";
  /** False when this machine's ace predates the report. */
  known: boolean;
  version: string;
  line: string | null;
  /** Restart required: the one state shown as needing the person. */
  needsYou: boolean;
};

export function appUpdatePatch(update: AppUpdate | undefined): AppUpdatePatch {
  if (!update)
    return { type: "machine.appUpdate", known: false, version: "", line: null, needsYou: false };
  return { type: "machine.appUpdate", known: true, ...appUpdateWords(update) };
}

export class MachineAppUpdate {
  #owner: AppUpdateOwner;
  #pump: PatchPump;
  #stop: () => void;
  constructor(owner: AppUpdateOwner, pump: PatchPump) {
    this.#owner = owner;
    this.#pump = pump;
    const connection = owner.connectionState();
    const stopConnection = connection.subscribe(() => {
      if (connection.getSnapshot() === "ready") void this.#read();
    });
    const stopEvents = owner.onMessage((message) => {
      if (message.type === "appUpdate.changed") this.#show(message.update);
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
  async #read(): Promise<void> {
    try {
      const reply = await this.#owner.request(
        { type: "appUpdate.request", requestId: host.uuid() },
        { timeoutMs: 15_000 },
      );
      this.#show(reply.ok ? reply.update : undefined);
    } catch {
      // An older daemon doesn't know the request: no row, rather than a wrong one.
      this.#show(undefined);
    }
  }
  #show(update: AppUpdate | undefined): void {
    this.#pump.put("machine:appUpdate", () => appUpdatePatch(update));
  }
}
