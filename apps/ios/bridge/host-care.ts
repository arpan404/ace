import type { ClientCore } from "@ace/client";
import { z } from "zod";
import { HostDiagnostics, HostDiagnosticsRequest } from "./host-diagnostics.ts";
import { HostStorage, HostStorageRequest } from "./host-storage.ts";
import { AdmissionChange, type MachineAdmission } from "./machine-admission.ts";

/*
 * Taking care of one machine from the phone: Storage, Diagnostics and "Pause new work". Native
 * service calls of these types are answered here (`native-services.ts`).
 */

export const HostCareRequest = z.union([
  HostStorageRequest,
  HostDiagnosticsRequest,
  AdmissionChange,
]);
export type HostCareRequest = z.infer<typeof HostCareRequest>;

export class HostCare {
  readonly storage: HostStorage;
  readonly diagnostics: HostDiagnostics;
  readonly admission: MachineAdmission;
  constructor(owner: ClientCore, admission: MachineAdmission) {
    this.storage = new HostStorage(owner);
    this.diagnostics = new HostDiagnostics(owner);
    this.admission = admission;
  }
  answer(request: HostCareRequest, signal: AbortSignal): Promise<unknown> {
    if (request.type === "machine.admission.set") return this.admission.set(request.paused, signal);
    if (request.type.startsWith("host.storage")) {
      const storage = HostStorageRequest.safeParse(request);
      if (storage.success) return this.storage.answer(storage.data, signal);
    }
    return this.diagnostics.answer(HostDiagnosticsRequest.parse(request), signal);
  }
}
