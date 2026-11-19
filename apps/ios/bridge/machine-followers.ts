import { MachineAdmission, type AdmissionOwner } from "./machine-admission.ts";
import { MachineAppUpdate } from "./machine-app-update.ts";
import type { PatchPump } from "./patch-pump.ts";

/**
 * The followers of one runtime's machine state ("Pause new work", the desktop app's update).
 * Each new connection replaces them, and the old ones stop listening, so a reconnected bridge
 * never keeps a previous client's listeners alive or draws its stale state.
 */
export class MachineFollowers {
  #admission: MachineAdmission | undefined;
  #appUpdate: MachineAppUpdate | undefined;
  /** Follows `owner` from now on; returns its admission follower for pause and resume. */
  replace(owner: AdmissionOwner, pump: PatchPump): MachineAdmission {
    this.dispose();
    this.#admission = new MachineAdmission(owner, pump);
    this.#appUpdate = new MachineAppUpdate(owner, pump);
    return this.#admission;
  }
  dispose(): void {
    this.#admission?.dispose();
    this.#appUpdate?.dispose();
    this.#admission = undefined;
    this.#appUpdate = undefined;
  }
}
