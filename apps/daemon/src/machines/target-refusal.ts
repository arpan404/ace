import type { MachineRefusal } from "@ace/protocol";

const statuses: Record<MachineRefusal["error"], number> = {
  machine_opted_out: 403,
  machine_forbidden: 403,
  unauthorized: 401,
  not_found: 404,
  invalid: 400,
  unavailable: 503,
  too_late: 409,
  not_supported: 501,
};
/** A refusal this machine authored, with words the calling agent may read. */
export class TargetRefusal extends Error {
  readonly code: MachineRefusal["error"];
  readonly status: number;
  /** The answer recorded for its request id: every copy gets it (MachineRefusal.final). */
  readonly final: boolean;
  constructor(code: MachineRefusal["error"], message?: string, final = false) {
    super(message ?? code);
    this.code = code;
    this.status = statuses[code];
    this.final = final;
  }
  body(): MachineRefusal {
    return {
      error: this.code,
      ...(this.message !== this.code ? { message: this.message } : {}),
      ...(this.final ? { final: true } : {}),
    };
  }
}
