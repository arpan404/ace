import type { ClientCore } from "@ace/client";
import { z } from "zod";
import { HostDiagnostics, HostDiagnosticsRequest } from "./host-diagnostics.ts";
import { HostStorage, HostStorageRequest } from "./host-storage.ts";
import { AdmissionChange, type MachineAdmission } from "./machine-admission.ts";
import { MachineUpdateChange, type MachineUpdateFollower } from "./machine-update.ts";
import { HostProblem } from "./host-problem.ts";

/*
 * Taking care of one machine from the phone: Storage, Diagnostics and "Pause new work". Native
 * service calls of these types are answered here (`native-services.ts`).
 */

export const HostCareRequest = z.union([
  HostStorageRequest,
  HostDiagnosticsRequest,
  AdmissionChange,
  MachineUpdateChange,
]);
export type HostCareRequest = z.infer<typeof HostCareRequest>;

export class HostCare {
  readonly storage: HostStorage;
  readonly diagnostics: HostDiagnostics;
  readonly admission: MachineAdmission;
  readonly update: MachineUpdateFollower | undefined;
  constructor(owner: ClientCore, admission: MachineAdmission, update?: MachineUpdateFollower) {
    this.update = update;
    this.storage = new HostStorage(owner);
    this.diagnostics = new HostDiagnostics(owner);
    this.admission = admission;
  }
  answer(request: HostCareRequest, signal: AbortSignal): Promise<unknown> {
    if (request.type === "machine.admission.set") return this.admission.set(request.paused, signal);
    if (request.type === "machine.update.check" || request.type === "machine.update.start") {
      if (!this.update) throw new HostProblem("This computer can't be updated from here.");
      return this.update.answer(MachineUpdateChange.parse(request), signal);
    }
    if (request.type.startsWith("host.storage")) {
      const storage = HostStorageRequest.safeParse(request);
      if (storage.success) return this.storage.answer(storage.data, signal);
    }
    return this.diagnostics.answer(HostDiagnosticsRequest.parse(request), signal);
  }
}
