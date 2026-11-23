import { MachineAdmission, type AdmissionOwner } from "./machine-admission.ts";
import { MachineAppUpdate } from "./machine-app-update.ts";
import { MachineUpdateFollower } from "./machine-update.ts";
import type { PatchPump } from "./patch-pump.ts";

/**
 * The followers of one runtime's machine state ("Pause new work", the desktop app's update).
 * Each new connection replaces them, and the old ones stop listening, so a reconnected bridge
 * never keeps a previous client's listeners alive or draws its stale state.
 */
export class MachineFollowers {
  #admission: MachineAdmission | undefined;
  #appUpdate: MachineAppUpdate | undefined;
  #update: MachineUpdateFollower | undefined;
  /** This machine's own update, for check and start. */
  get update(): MachineUpdateFollower | undefined {
    return this.#update;
  }
  /** Follows `owner` from now on; returns its admission follower for pause and resume. */
  replace(owner: AdmissionOwner, pump: PatchPump): MachineAdmission {
    this.dispose();
    this.#admission = new MachineAdmission(owner, pump);
    this.#appUpdate = new MachineAppUpdate(owner, pump);
    this.#update = new MachineUpdateFollower(owner, pump);
    return this.#admission;
  }
  dispose(): void {
    this.#admission?.dispose();
    this.#appUpdate?.dispose();
    this.#update?.dispose();
    this.#update = undefined;
    this.#admission = undefined;
    this.#appUpdate = undefined;
  }
}
