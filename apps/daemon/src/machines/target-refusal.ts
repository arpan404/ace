import type { MachineRefusal } from "@ace/protocol";

const statuses: Record<MachineRefusal["error"], number> = {
  machine_opted_out: 403,
  machine_forbidden: 403,
  unauthorized: 401,
  not_found: 404,
  invalid: 400,
  unavailable: 503,
};
/** A refusal this machine authored, with words the calling agent may read. */
export class TargetRefusal extends Error {
  readonly code: MachineRefusal["error"];
  readonly status: number;
  constructor(code: MachineRefusal["error"], message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = statuses[code];
  }
  body(): MachineRefusal {
    return { error: this.code, ...(this.message !== this.code ? { message: this.message } : {}) };
  }
}
